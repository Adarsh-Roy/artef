//! `artef push <file>` — create or update an artifact from a file (spec §5.2, §7.2).
//!
//! The order of the steps is the whole design. Lint first, on the document as written,
//! so one that would render broken never reaches the server (§7.1). Then pull the large
//! inline images out (§6), locally, because that is what decides the bytes everything
//! downstream is about. Hash and compress those bytes. Then `HEAD`, so an unchanged
//! document costs one small round trip instead of an upload (§5.2 hash-first push) —
//! and so the extracted images are only uploaded when there is a new document to point
//! at them. Only then `PUT`, carrying the version we based the write on so a second
//! pusher cannot silently overwrite us.

use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use url::Url;

use crate::api::{self, ApiClient, PutOutcome};
use crate::commands::lint::format_violation;
use crate::commands::{state_key, track};
use crate::config::GlobalConfig;
use crate::extract::{extract_assets, ExtractedAsset};
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
    let (html, assets) = apply_asset_extraction(&html, options.no_extract)?;
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

    upload_assets(&api, &assets).await?;

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

/// Spec §6 asset extraction: hand back the document with its large inline `data:` images
/// replaced by `/assets/<sha>`, and the images those paths now depend on.
///
/// Local and pure — nothing is uploaded here, and nothing needs a server to decide. The
/// rewritten paths are relative, which the artifact CSP allows, so the document stays
/// lint-clean by construction and is not checked again.
///
/// The daemon goes through here too (spec §7.4), so both paths extract.
pub(crate) fn apply_asset_extraction(
    html: &str,
    no_extract: bool,
) -> Result<(String, Vec<ExtractedAsset>)> {
    if no_extract {
        return Ok((html.to_string(), Vec::new()));
    }
    extract_assets(html)
}

/// `POST` the extracted images, immediately before the document that names them.
///
/// Called only once the `HEAD` has said the document changed. Uploading earlier would
/// re-ship every chart on every tick — a dashboard on a 60s timer would send the same
/// 20KB image 1,440 times a day, which is the exact cost §6 exists to remove. Skipping
/// them on the unchanged path is safe because a document the server already holds was
/// put there by a push that uploaded its assets first.
///
/// Failing here stops the push before the `PUT`: half an extraction is a live document
/// with broken images in it.
pub(crate) async fn upload_assets(api: &ApiClient, assets: &[ExtractedAsset]) -> Result<()> {
    for asset in assets {
        let stored = api.upload_asset(&asset.bytes, &asset.media_type).await?;
        // Content addressing is the whole contract here: the document already points at
        // `/assets/<sha>`, so a server that filed the bytes under another name would
        // leave a broken image behind. Say so rather than push one. A duplicate that
        // told us nothing (`None`) is the server confirming it already has these exact
        // bytes, and there is nothing left to check.
        if let Some(stored) = stored {
            if !is_asset_path_for(&stored, &asset.sha_hex) {
                bail!(
                    "the server stored an asset at {stored}, but the document points at \
                     /assets/{}",
                    asset.sha_hex
                );
            }
        }
    }
    Ok(())
}

/// Whether a URL the server handed back names the asset we rewrote the document to.
///
/// The path has to match exactly; the origin in front of it does not have to be there.
/// A server that answers with an absolute URL is describing the same asset, but one that
/// answers with a different path is describing a different one.
fn is_asset_path_for(stored: &str, sha_hex: &str) -> bool {
    let path = match Url::parse(stored) {
        Ok(url) => url.path().to_string(),
        // A relative path has no base to parse against, which is the common answer.
        Err(_) => stored
            .split(['?', '#'])
            .next()
            .unwrap_or(stored)
            .to_string(),
    };
    path == format!("/assets/{sha_hex}")
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

    use base64::Engine;

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

    #[test]
    fn no_extract_leaves_the_document_alone_and_finds_nothing_to_upload() {
        let big = base64::engine::general_purpose::STANDARD
            .encode((0..20 * 1024).map(|i| (i % 251) as u8).collect::<Vec<u8>>());
        let html = format!("<img src=\"data:image/png;base64,{big}\">");

        assert_eq!(
            apply_asset_extraction(&html, true).unwrap(),
            (html.clone(), vec![])
        );
        // Without the flag the same document has one image to upload.
        assert_eq!(apply_asset_extraction(&html, false).unwrap().1.len(), 1);
    }

    #[test]
    fn a_document_with_nothing_over_the_threshold_has_nothing_to_upload() {
        let html = "<img src=\"data:image/png;base64,iVBORw0K\"><h1>small</h1>";

        assert_eq!(
            apply_asset_extraction(html, false).unwrap(),
            (html.to_string(), vec![])
        );
    }

    #[tokio::test]
    async fn nothing_to_upload_means_no_call_at_all() {
        // A server that is not listening: one request would fail the call.
        let api = ApiClient::new("http://127.0.0.1:1", "art_live_x").unwrap();
        upload_assets(&api, &[]).await.unwrap();
    }

    #[test]
    fn a_stored_asset_url_has_to_name_the_path_the_document_points_at() {
        let sha = "ab12";
        assert!(is_asset_path_for("/assets/ab12", sha));
        // An absolute URL describes the same asset.
        assert!(is_asset_path_for(
            "https://cdn.example.com/assets/ab12",
            sha
        ));
        assert!(is_asset_path_for("/assets/ab12?v=1", sha));

        // A different path is a different asset, however it ends.
        assert!(!is_asset_path_for("/files/ab12", sha));
        assert!(!is_asset_path_for("/assets/other/ab12", sha));
        assert!(!is_asset_path_for("/assets/ab1234", sha));
        assert!(!is_asset_path_for("", sha));
    }
}
