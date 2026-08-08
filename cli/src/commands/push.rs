//! `artef push <file>` — create or update an artifact from a file (spec §5.2, §7.2).
//!
//! The order of the steps is the whole design. Lint first, so a document that would
//! render broken never reaches the server (§7.1). Hash and compress next. Then `HEAD`,
//! so an unchanged document costs one small round trip instead of an upload (§5.2
//! hash-first push). Only then `PUT`, carrying the version we based the write on so a
//! second pusher cannot silently overwrite us.

use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};

use crate::api::{self, ApiClient, PutOutcome};
use crate::commands::lint::format_violation;
use crate::commands::{state_key, track};
use crate::config::GlobalConfig;
use crate::lint::{lint_html, Severity};
use crate::state::State;

/// Everything `artef push` was asked to do.
pub struct Options<'a> {
    pub file: &'a Path,
    pub name: Option<&'a str>,
    pub visibility: Option<&'a str>,
    pub force: bool,
    pub no_preflight: bool,
    pub no_extract: bool,
}

pub async fn run(config: &GlobalConfig, options: &Options<'_>) -> Result<i32> {
    let html = std::fs::read_to_string(options.file)
        .with_context(|| format!("reading {}", options.file.display()))?;

    if !options.no_preflight {
        preflight(&html)?;
    }

    let api = ApiClient::from_config(config)?;
    let html = apply_asset_extraction(&html, &api, options.no_extract).await?;
    let sha = sha256_hex(html.as_bytes());
    let gz = gzip(html.as_bytes())?;

    let dir = std::env::current_dir().context("finding the working directory")?;
    let mut state = State::load(&dir)?;
    let key = state_key(options.file);

    let (id, was_tracked) = match state.artifacts.get(&key) {
        Some(entry) => {
            // Both flags describe an artifact being created (spec §7.2). Saying so is
            // better than printing "pushed" and letting the user believe they took.
            if options.name.is_some() || options.visibility.is_some() {
                eprintln!(
                    "note: --name and --visibility only apply when the artifact is created, \
                     and {key} already has one"
                );
            }
            (entry.id.clone(), true)
        }
        None => {
            let created = api
                .create_artifact(options.name, options.visibility)
                .await?;
            // Saved before the upload: if the `PUT` fails, the next push updates this
            // artifact instead of leaving an empty one behind and making another.
            track(&mut state, &dir, &key, &created.id, "")?;
            (created.id, false)
        }
    };
    let url = api::share_url(&config.server, &id);

    let remote = api.head_content(&id).await?;
    if remote.as_ref().is_some_and(|r| r.etag_hex == sha) {
        track(&mut state, &dir, &key, &id, &sha)?;
        println!("unchanged  {url}");
        return Ok(0);
    }

    // `--force` omits the header, which is a last-write-wins push (spec §5.2).
    let base_version = if options.force {
        None
    } else {
        remote.map(|r| r.version)
    };

    match api.put_content(&id, gz, &sha, base_version).await? {
        PutOutcome::Changed { version } => {
            track(&mut state, &dir, &key, &id, &sha)?;
            println!("pushed v{version}  {url}");
            Ok(0)
        }
        PutOutcome::Unchanged => {
            track(&mut state, &dir, &key, &id, &sha)?;
            println!("unchanged  {url}");
            Ok(0)
        }
        PutOutcome::Conflict { version } => bail!(
            "someone else updated this artifact (server has v{version}); \
             re-run with --force to overwrite"
        ),
        // Deliberately not auto-recreated. A 404 is also what the API returns when an
        // artifact is no longer ours to write to — it never confirms that something
        // exists (spec §2.3) — so creating a replacement would silently fork a document
        // other people are still reading, under a new id nobody has been given.
        PutOutcome::Missing if was_tracked => bail!(
            "the artifact {id} tracked for {key} is not on the server any more \
             (it was deleted, or it is no longer yours to write to); \
             run `artef rm {key}` to forget it, then push again to make a new one"
        ),
        PutOutcome::Missing => {
            bail!("the server lost artifact {id} between creating it and uploading to it")
        }
    }
}

/// Refuse documents the artifact CSP would break, and say what is wrong with them.
/// Warnings are printed and then ignored — they render, they just do less (spec §7.1).
fn preflight(html: &str) -> Result<()> {
    let violations = lint_html(html);
    for violation in &violations {
        eprintln!("{}", format_violation(violation));
    }

    let rejected = violations
        .iter()
        .filter(|v| v.severity == Severity::Reject)
        .count();
    if rejected > 0 {
        bail!(
            "{rejected} of these would render broken under the artifact CSP; \
             fix them, or push anyway with --no-preflight"
        );
    }
    Ok(())
}

/// Where spec §6 asset extraction will happen, between the lint and the upload.
///
/// Task 17 fills this in: it will pull large inline `data:` images out of the document,
/// `POST` them to `/api/assets`, and rewrite the attributes to `/assets/<sha>`. Until
/// then the document is uploaded exactly as it was written.
///
/// The daemon goes through here too, so filling it in fixes both paths at once.
pub(crate) async fn apply_asset_extraction(
    html: &str,
    api: &ApiClient,
    no_extract: bool,
) -> Result<String> {
    let _ = (api, no_extract);
    Ok(html.to_string())
}

/// SHA-256 of the document as written, which is what the server compares against.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn gzip(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(bytes)
        .context("compressing the document")?;
    encoder.finish().context("compressing the document")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn the_hash_is_of_the_document_not_the_compressed_bytes() {
        // sha256("") — the value the server stores for a freshly created artifact.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn gzip_round_trips() {
        let doc = "<h1>hello</h1>";
        let mut out = String::new();
        flate2::read::GzDecoder::new(&gzip(doc.as_bytes()).unwrap()[..])
            .read_to_string(&mut out)
            .unwrap();
        assert_eq!(out, doc);
    }

    #[test]
    fn a_rejected_document_stops_the_push_and_a_warned_one_does_not() {
        let err = preflight(r#"<script src="https://cdn/x.js"></script>"#).unwrap_err();
        assert!(
            format!("{err:#}").contains("--no-preflight"),
            "error was {err:#}"
        );

        preflight(r#"<script>fetch('/a')</script>"#).unwrap();
        preflight("<h1>clean</h1>").unwrap();
    }

    #[tokio::test]
    async fn the_extraction_hook_leaves_the_document_alone_for_now() {
        let api = ApiClient::new("http://localhost:8080", "art_live_x").unwrap();
        let html = "<img src=\"data:image/png;base64,iVBORw0K\">";
        assert_eq!(
            apply_asset_extraction(html, &api, false).await.unwrap(),
            html
        );
        assert_eq!(
            apply_asset_extraction(html, &api, true).await.unwrap(),
            html
        );
    }
}
