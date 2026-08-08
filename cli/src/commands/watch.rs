//! `artef watch` and `artef daemon` — regenerate a document on a timer, push it when it
//! changed (spec §7.4).
//!
//! Everything here prints one JSON object per line on stdout, because what runs it is
//! systemd or a CI sidecar rather than a person watching a terminal. For the same
//! reason almost nothing stops the loop: a generator that exits non-zero, a document
//! the artifact CSP would break, an artifact somebody deleted — each is logged, backed
//! off, and tried again on the next tick. A dashboard that goes stale at 3am should
//! come back on its own.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::task::JoinSet;

use crate::api::{ApiClient, PutOutcome};
use crate::commands::lint::format_violation;
use crate::commands::push::{apply_asset_extraction, gzip, sha256_hex, upload_assets};
use crate::commands::{state_key, track};
use crate::config::GlobalConfig;
use crate::interval::parse_interval;
use crate::lint::{lint_html, Severity};
use crate::state::State;

/// Where `artef daemon` reads its entries from (spec §7.4).
pub const CONFIG_FILE: &str = "artef.toml";

/// The longest a failing entry waits, as a multiple of its own interval.
const MAX_BACKOFF: u32 = 10;

/// How much of a failed command's stderr goes in the log line.
const STDERR_LOG_CHARS: usize = 500;

/// `.artef.json` is one file shared by every entry, so it is read and written under
/// this lock: two tasks each holding their own copy of it would drop each other's rows.
static STATE_LOCK: Mutex<()> = Mutex::new(());

/// One file the daemon keeps fresh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchEntry {
    pub file: PathBuf,
    pub every: Duration,
    pub command: Option<String>,
}

/// How one pass over one entry ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TickOutcome {
    /// The server already had this document.
    Unchanged,
    /// The server took a new version.
    Pushed { version: i64 },
    /// The generator command exited non-zero, so nothing was uploaded.
    CommandFailed { code: i32 },
    /// The document would render broken under the artifact CSP, so it was not uploaded.
    LintRejected { rejected: usize },
    /// The artifact this file is tracked against is not on the server any more.
    ArtifactMissing { id: String },
}

impl TickOutcome {
    /// Whether the server ended the tick holding what the file says. Everything else —
    /// including a tick that never got as far as an upload — counts as a failure and
    /// backs the entry off.
    fn is_success(&self) -> bool {
        matches!(self, Self::Unchanged | Self::Pushed { .. })
    }
}

/// Everything `artef watch` was asked to do.
pub struct Options<'a> {
    pub file: &'a Path,
    pub every: &'a str,
    pub command: Option<&'a str>,
}

/// `artef.toml` as it is on disk (spec §7.4). Unknown keys are refused rather than
/// ignored, so a `cmd =` that would have silently done nothing is a startup error.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigFile {
    #[serde(default)]
    watch: Vec<RawEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEntry {
    file: PathBuf,
    every: String,
    #[serde(default)]
    command: Option<String>,
}

pub fn parse_artef_toml(text: &str) -> Result<Vec<WatchEntry>> {
    let config: ConfigFile = toml::from_str(text).context("reading the watch config")?;

    config
        .watch
        .into_iter()
        .map(|raw| {
            let every = parse_interval(&raw.every)
                .with_context(|| format!("the interval for {}", raw.file.display()))?;
            Ok(WatchEntry {
                file: raw.file,
                every,
                command: raw.command,
            })
        })
        .collect()
}

/// One pass over one entry: regenerate, check, and upload if it changed (spec §7.4).
pub async fn run_tick(
    api: &ApiClient,
    state_dir: &Path,
    entry: &WatchEntry,
) -> Result<TickOutcome> {
    let path = state_dir.join(&entry.file);

    if let Some(command) = entry.command.as_deref() {
        // Commands are written as if you had cd'd to the document, so `> status.html`
        // in artef.toml means the status.html this entry watches (spec §7.4).
        let dir = path.parent().unwrap_or(state_dir);
        if let Some(failure) = run_command(command, dir).await? {
            // Nothing is uploaded, so the last good version stays live and the next
            // tick tries again with whatever the generator manages to write then.
            log(
                &entry.file,
                "command_failed",
                json!({ "code": failure.code, "stderr": failure.stderr }),
            );
            return Ok(TickOutcome::CommandFailed { code: failure.code });
        }
    }

    let html =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;

    // The daemon must not push a document that renders broken, and must not die over
    // one either: a generator that started emitting CDN tags is a bug to be logged and
    // survived, not a reason to stop updating every other dashboard (spec §7.1).
    let rejected: Vec<String> = lint_html(&html)
        .iter()
        .filter(|violation| violation.severity == Severity::Reject)
        .map(format_violation)
        .collect();
    if !rejected.is_empty() {
        log(
            &entry.file,
            "lint_rejected",
            json!({ "rejected": rejected.len(), "violations": rejected }),
        );
        return Ok(TickOutcome::LintRejected {
            rejected: rejected.len(),
        });
    }

    let (html, assets) = apply_asset_extraction(&html, false)?;
    let sha = sha256_hex(html.as_bytes());
    let gz = gzip(html.as_bytes())?;

    let key = state_key(&entry.file);
    let (id, was_tracked) = match tracked_id(state_dir, &key)? {
        Some(id) => (id, true),
        None => {
            let created = api.create_artifact(None, None).await?;
            // Saved before the upload: if the PUT fails, the next tick updates this
            // artifact instead of leaving an empty one behind and making another.
            remember(state_dir, &key, &created.id, "")?;
            log(
                &entry.file,
                "created",
                json!({ "id": created.id, "url": api.share_url(&created.id) }),
            );
            (created.id, false)
        }
    };

    // Ask before uploading: an unchanged dashboard costs one small round trip a minute
    // instead of a megabyte (spec §5.2 hash-first push). The extracted images wait
    // behind this check too, so a chart that has not changed is not re-shipped 1,440
    // times a day (spec §6).
    if api
        .head_content(&id)
        .await?
        .is_some_and(|remote| remote.etag_hex == sha)
    {
        remember(state_dir, &key, &id, &sha)?;
        log(&entry.file, "unchanged", json!({ "id": id }));
        return Ok(TickOutcome::Unchanged);
    }

    upload_assets(api, &assets).await?;

    // No X-Base-Version. The daemon owns this artifact, so the newest render wins
    // rather than a version number racing itself into a conflict (spec §5.2).
    match api.put_content(&id, gz, &sha, None).await? {
        PutOutcome::Changed { version } => {
            remember(state_dir, &key, &id, &sha)?;
            log(
                &entry.file,
                "pushed",
                json!({ "id": id, "version": version, "url": api.share_url(&id) }),
            );
            Ok(TickOutcome::Pushed { version })
        }
        PutOutcome::Unchanged => {
            remember(state_dir, &key, &id, &sha)?;
            log(&entry.file, "unchanged", json!({ "id": id }));
            Ok(TickOutcome::Unchanged)
        }
        // Deliberately not recreated. A 404 is also what the API answers when an
        // artifact stopped being ours (spec §2.3), so a replacement would fork a
        // document people are still reading, under an id nobody has been given.
        PutOutcome::Missing if was_tracked => {
            log(
                &entry.file,
                "artifact_missing",
                json!({
                    "id": id,
                    "hint": format!(
                        "run `artef rm {key}` to forget it, and the next tick makes a new one"
                    ),
                }),
            );
            Ok(TickOutcome::ArtifactMissing { id })
        }
        PutOutcome::Missing => {
            bail!("the server lost artifact {id} between creating it and uploading to it")
        }
        PutOutcome::Conflict { version } => bail!(
            "the server reported a conflict at v{version} for a write that named no base version"
        ),
    }
}

/// A generator command that exited non-zero.
struct CommandFailure {
    code: i32,
    stderr: String,
}

/// Run the generator through `sh -c`, in `dir`.
///
/// Its output is captured rather than inherited: stdout here is a stream of JSON log
/// lines, and one chatty script would corrupt every one of them.
async fn run_command(command: &str, dir: &Path) -> Result<Option<CommandFailure>> {
    let output = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .with_context(|| format!("running {command:?}"))?;

    if output.status.success() {
        return Ok(None);
    }
    Ok(Some(CommandFailure {
        // A command killed by a signal has no exit code of its own.
        code: output.status.code().unwrap_or(-1),
        stderr: tail(&String::from_utf8_lossy(&output.stderr)),
    }))
}

/// The end of a failed command's stderr, which is where the reason usually is.
fn tail(text: &str) -> String {
    let text = text.trim();
    let length = text.chars().count();
    if length <= STDERR_LOG_CHARS {
        return text.to_string();
    }
    let cut = text
        .char_indices()
        .nth(length - STDERR_LOG_CHARS)
        .map_or(0, |(at, _)| at);
    format!("…{}", &text[cut..])
}

fn tracked_id(dir: &Path, key: &str) -> Result<Option<String>> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|held| held.into_inner());
    Ok(State::load(dir)?
        .artifacts
        .get(key)
        .map(|entry| entry.id.clone()))
}

fn remember(dir: &Path, key: &str, id: &str, hash: &str) -> Result<()> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|held| held.into_inner());
    let mut state = State::load(dir)?;
    track(&mut state, dir, key, id, hash)
}

/// One log line: the shape from spec §7.4, plus whatever the event needs after it.
#[derive(Serialize)]
struct LogLine<'a> {
    ts: String,
    file: &'a str,
    event: &'a str,
    #[serde(flatten)]
    fields: Map<String, Value>,
}

fn log(file: &Path, event: &str, fields: Value) {
    let file = file.to_string_lossy();
    let line = LogLine {
        ts: rfc3339(now_secs()),
        file: &file,
        event,
        fields: match fields {
            Value::Object(fields) => fields,
            _ => Map::new(),
        },
    };
    // `println!` holds stdout for the whole line, so entries logging at the same
    // moment cannot interleave into something no parser can read.
    println!(
        "{}",
        serde_json::to_string(&line).expect("a log line serializes")
    );
}

fn now_secs() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_secs() as i64,
        Err(before) => -(before.duration().as_secs() as i64),
    }
}

/// `2026-08-08T20:30:00Z`, in UTC. Hand-rolled: one timestamp format is not worth a
/// date-time dependency, and the calendar arithmetic below is Howard Hinnant's
/// `civil_from_days`, which is where every implementation of this gets it from.
fn rfc3339(epoch_secs: i64) -> String {
    let days = epoch_secs.div_euclid(86_400);
    let seconds = epoch_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

/// The calendar date `days` days after 1970-01-01, counting from a March-based year so
/// the leap day lands at the end and needs no special case.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let march_month = (5 * day_of_year + 2) / 153;

    let day = day_of_year - (153 * march_month + 2) / 5 + 1;
    let month = if march_month < 10 {
        march_month + 3
    } else {
        march_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);

    (year, month, day)
}

/// How long to wait before the next tick: the interval, doubled for each consecutive
/// failed tick and never more than ten intervals (spec §7.4).
fn backoff(interval: Duration, failures: u32) -> Duration {
    let factor = 1_u32
        .checked_shl(failures)
        .unwrap_or(u32::MAX)
        .min(MAX_BACKOFF);
    interval.checked_mul(factor).unwrap_or(Duration::MAX)
}

/// One entry, for as long as the process lives.
async fn watch_loop(api: Arc<ApiClient>, state_dir: PathBuf, entry: WatchEntry) {
    log(
        &entry.file,
        "watching",
        json!({ "every_s": entry.every.as_secs(), "command": entry.command }),
    );

    let mut failures: u32 = 0;
    loop {
        let succeeded = match run_tick(&api, &state_dir, &entry).await {
            Ok(outcome) => outcome.is_success(),
            Err(err) => {
                log(&entry.file, "error", json!({ "error": format!("{err:#}") }));
                false
            }
        };

        failures = if succeeded {
            0
        } else {
            failures.saturating_add(1)
        };
        let sleep = backoff(entry.every, failures);
        if failures > 0 {
            log(
                &entry.file,
                "backoff",
                json!({ "failures": failures, "retry_in_s": sleep.as_secs() }),
            );
        }
        tokio::time::sleep(sleep).await;
    }
}

/// `artef watch <file>` — one entry, named on the command line.
pub async fn run(config: &GlobalConfig, options: &Options<'_>) -> Result<i32> {
    let entry = WatchEntry {
        file: options.file.to_path_buf(),
        every: parse_interval(options.every)?,
        command: options.command.map(str::to_string),
    };
    let dir = std::env::current_dir().context("finding the working directory")?;

    watch_loop(Arc::new(ApiClient::from_config(config)?), dir, entry).await;
    Ok(0)
}

/// `artef daemon` — every entry in `artef.toml`, each on its own timer.
pub async fn run_daemon(config: &GlobalConfig) -> Result<i32> {
    let dir = std::env::current_dir().context("finding the working directory")?;
    let entries = read_config(&dir)?;
    let api = Arc::new(ApiClient::from_config(config)?);

    // One task per entry, so a slow generator delays its own file and nothing else.
    let mut watches = JoinSet::new();
    for entry in entries {
        watches.spawn(watch_loop(Arc::clone(&api), dir.clone(), entry));
    }
    while let Some(finished) = watches.join_next().await {
        if let Err(err) = finished {
            eprintln!("error: a watch stopped: {err}");
        }
    }

    // Every loop runs until the process is stopped, so getting here means they all
    // died. Exit non-zero, and let whatever supervises this start it again.
    Ok(1)
}

fn read_config(dir: &Path) -> Result<Vec<WatchEntry>> {
    let path = dir.join(CONFIG_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => bail!(
            "there is no {CONFIG_FILE} in {}: the daemon needs one, \
             with a [[watch]] entry per file",
            dir.display()
        ),
        Err(err) => return Err(err).with_context(|| format!("reading {}", path.display())),
    };

    let entries = parse_artef_toml(&text).with_context(|| format!("reading {}", path.display()))?;
    if entries.is_empty() {
        bail!(
            "{} has no [[watch]] entries, so there is nothing to keep fresh",
            path.display()
        );
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    use base64::Engine;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    use crate::commands::push::sha256_hex;

    const ID: &str = "8f14e45f-1111-2222-3333-444444444444";
    const DOC: &str = "<h1>hi</h1>";
    /// A command that writes `DOC` into the file the entry names.
    const WRITE_DOC: &str = "printf '<h1>hi</h1>' > out.html";

    /// The §7.4 example, verbatim.
    const SPEC_TOML: &str = r#"
[[watch]]
file    = "status.html"
every   = "60s"
command = "python gen_status.py > status.html"

[[watch]]
file    = "build-health.html"
every   = "5m"
command = "./scripts/build_report.sh"
"#;

    fn content_path() -> String {
        format!("/api/artifacts/{ID}/content")
    }

    fn client(server: &MockServer) -> ApiClient {
        ApiClient::new(&server.uri(), "art_live_test").unwrap()
    }

    fn entry(file: &str, command: Option<&str>) -> WatchEntry {
        WatchEntry {
            file: PathBuf::from(file),
            every: Duration::from_secs(60),
            command: command.map(str::to_string),
        }
    }

    /// Pretend an earlier tick already created and tracked the artifact.
    fn already_tracked(dir: &Path, key: &str) {
        let body = json!({ "artifacts": { key: { "id": ID, "hash": "" } } });
        std::fs::write(dir.join(".artef.json"), body.to_string()).unwrap();
    }

    fn state_of(dir: &Path, key: &str) -> serde_json::Value {
        let raw = std::fs::read_to_string(dir.join(".artef.json")).unwrap();
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["artifacts"][key].clone()
    }

    async fn mock_create(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/api/artifacts"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({ "id": ID })))
            .mount(server)
            .await;
    }

    async fn mock_asset(server: &MockServer, sha_hex: &str) {
        Mock::given(method("POST"))
            .and(path("/api/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(
                json!({ "sha256": sha_hex, "url": format!("/assets/{sha_hex}"), "byte_size": 0 }),
            ))
            .mount(server)
            .await;
    }

    async fn mock_head(server: &MockServer, etag_hex: &str, version: i64) {
        Mock::given(method("HEAD"))
            .and(path(content_path()))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("ETag", format!("\"{etag_hex}\"").as_str())
                    .insert_header("X-Artef-Version", version.to_string().as_str()),
            )
            .mount(server)
            .await;
    }

    async fn mock_head_missing(server: &MockServer) {
        Mock::given(method("HEAD"))
            .and(path(content_path()))
            .respond_with(ResponseTemplate::new(404))
            .mount(server)
            .await;
    }

    async fn mock_put(server: &MockServer, version: i64) {
        Mock::given(method("PUT"))
            .and(path(content_path()))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "version": version, "changed": true })),
            )
            .mount(server)
            .await;
    }

    async fn mock_put_missing(server: &MockServer) {
        Mock::given(method("PUT"))
            .and(path(content_path()))
            .respond_with(ResponseTemplate::new(404))
            .mount(server)
            .await;
    }

    async fn calls(server: &MockServer) -> Vec<(String, String)> {
        server
            .received_requests()
            .await
            .expect("request recording is on")
            .iter()
            .map(|r| (r.method.to_string(), r.url.path().to_string()))
            .collect()
    }

    async fn only_request(server: &MockServer, wanted: &str) -> Request {
        let mut found: Vec<Request> = server
            .received_requests()
            .await
            .expect("request recording is on")
            .into_iter()
            .filter(|r| r.method.as_str() == wanted)
            .collect();
        assert_eq!(found.len(), 1, "expected exactly one {wanted}");
        found.remove(0)
    }

    fn gunzip(bytes: &[u8]) -> String {
        let mut out = String::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_string(&mut out)
            .expect("gunzipping");
        out
    }

    #[test]
    fn the_spec_config_parses_into_its_two_entries() {
        let entries = parse_artef_toml(SPEC_TOML).unwrap();

        assert_eq!(
            entries,
            vec![
                WatchEntry {
                    file: PathBuf::from("status.html"),
                    every: Duration::from_secs(60),
                    command: Some("python gen_status.py > status.html".to_string()),
                },
                WatchEntry {
                    file: PathBuf::from("build-health.html"),
                    every: Duration::from_secs(300),
                    command: Some("./scripts/build_report.sh".to_string()),
                },
            ]
        );
    }

    #[test]
    fn an_entry_without_a_command_just_watches_the_file() {
        let entries =
            parse_artef_toml("[[watch]]\nfile = \"status.html\"\nevery = \"30s\"\n").unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command, None);
        assert_eq!(entries[0].every, Duration::from_secs(30));
    }

    #[test]
    fn a_config_with_no_watch_entries_parses_as_none() {
        assert_eq!(parse_artef_toml("").unwrap(), vec![]);
    }

    #[test]
    fn a_bad_interval_says_which_entry_it_came_from() {
        let err =
            parse_artef_toml("[[watch]]\nfile = \"status.html\"\nevery = \"90x\"\n").unwrap_err();
        let message = format!("{err:#}");

        assert!(message.contains("status.html"), "error was {message}");
        assert!(message.contains("90x"), "error was {message}");
    }

    #[test]
    fn a_misspelled_key_is_reported_instead_of_ignored() {
        let err =
            parse_artef_toml("[[watch]]\nfile = \"a.html\"\nevery = \"30s\"\ncmd = \"true\"\n")
                .unwrap_err();

        assert!(format!("{err:#}").contains("cmd"), "error was {err:#}");
    }

    #[tokio::test]
    async fn a_tick_runs_the_command_then_uploads_what_it_wrote() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        mock_create(&server).await;
        mock_head_missing(&server).await;
        mock_put(&server, 1).await;

        let outcome = run_tick(
            &client(&server),
            dir.path(),
            &entry("out.html", Some(WRITE_DOC)),
        )
        .await
        .unwrap();

        assert_eq!(outcome, TickOutcome::Pushed { version: 1 });
        assert_eq!(
            calls(&server).await,
            vec![
                ("POST".to_string(), "/api/artifacts".to_string()),
                ("HEAD".to_string(), content_path()),
                ("PUT".to_string(), content_path()),
            ]
        );

        let put = only_request(&server, "PUT").await;
        assert_eq!(gunzip(&put.body), DOC);
        // The daemon owns its artifact: last write wins, so no base version (spec §5.2).
        assert!(put.headers.get("x-base-version").is_none());

        assert_eq!(state_of(dir.path(), "out.html")["id"], ID);
        assert_eq!(
            state_of(dir.path(), "out.html")["hash"],
            sha256_hex(DOC.as_bytes())
        );
    }

    /// Extraction is not a `push` feature bolted onto one command: a dashboard that
    /// re-renders the same logo every minute is exactly what §6 is for, and the daemon
    /// goes through the same hook.
    #[tokio::test]
    async fn a_tick_pulls_large_inline_images_out_the_way_a_push_does() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = (0..20 * 1024).map(|i| (i % 251) as u8).collect();
        let sha = sha256_hex(&bytes);
        std::fs::write(
            dir.path().join("out.html"),
            format!(
                r#"<img src="data:image/png;base64,{}">"#,
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            ),
        )
        .unwrap();
        already_tracked(dir.path(), "out.html");
        mock_asset(&server, &sha).await;
        mock_head_missing(&server).await;
        mock_put(&server, 4).await;

        let outcome = run_tick(&client(&server), dir.path(), &entry("out.html", None))
            .await
            .unwrap();

        assert_eq!(outcome, TickOutcome::Pushed { version: 4 });
        // Ask first, then the image, then the document that names it.
        assert_eq!(
            calls(&server).await,
            vec![
                ("HEAD".to_string(), content_path()),
                ("POST".to_string(), "/api/assets".to_string()),
                ("PUT".to_string(), content_path()),
            ]
        );
        let pushed = gunzip(&only_request(&server, "PUT").await.body);
        assert_eq!(pushed, format!(r#"<img src="/assets/{sha}">"#));
        assert_eq!(
            state_of(dir.path(), "out.html")["hash"],
            sha256_hex(pushed.as_bytes())
        );
    }

    /// The one that costs real money: a dashboard on a 60s timer whose chart has not
    /// changed must not re-`POST` the chart 1,440 times a day (spec §6).
    #[tokio::test]
    async fn a_tick_that_changed_nothing_does_not_re_ship_its_images() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = (0..20 * 1024).map(|i| (i % 251) as u8).collect();
        let sha = sha256_hex(&bytes);
        std::fs::write(
            dir.path().join("out.html"),
            format!(
                r#"<img src="data:image/png;base64,{}">"#,
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            ),
        )
        .unwrap();
        already_tracked(dir.path(), "out.html");
        // The server already holds the extracted document. Neither /api/assets nor PUT
        // is mounted, so either call would fail the tick as well as the assertion.
        let extracted = format!(r#"<img src="/assets/{sha}">"#);
        mock_head(&server, &sha256_hex(extracted.as_bytes()), 9).await;

        let outcome = run_tick(&client(&server), dir.path(), &entry("out.html", None))
            .await
            .unwrap();

        assert_eq!(outcome, TickOutcome::Unchanged);
        assert_eq!(
            calls(&server).await,
            vec![("HEAD".to_string(), content_path())],
            "an unchanged tick must not re-upload its assets"
        );
    }

    #[tokio::test]
    async fn a_document_the_server_already_has_is_not_uploaded_again() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        already_tracked(dir.path(), "out.html");
        mock_head(&server, &sha256_hex(DOC.as_bytes()), 7).await;

        let outcome = run_tick(
            &client(&server),
            dir.path(),
            &entry("out.html", Some(WRITE_DOC)),
        )
        .await
        .unwrap();

        assert_eq!(outcome, TickOutcome::Unchanged);
        assert_eq!(
            calls(&server).await,
            vec![("HEAD".to_string(), content_path())]
        );
    }

    #[tokio::test]
    async fn a_command_that_fails_keeps_the_last_good_version() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        already_tracked(dir.path(), "out.html");
        std::fs::write(dir.path().join("out.html"), DOC).unwrap();

        let outcome = run_tick(
            &client(&server),
            dir.path(),
            &entry("out.html", Some("echo nope >&2; exit 3")),
        )
        .await
        .unwrap();

        assert_eq!(outcome, TickOutcome::CommandFailed { code: 3 });
        // Nothing was uploaded, so whatever the server holds stays the live version.
        assert_eq!(calls(&server).await, Vec::new());
    }

    #[tokio::test]
    async fn the_command_runs_in_the_directory_of_the_file_it_generates() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("reports")).unwrap();
        mock_create(&server).await;
        mock_head_missing(&server).await;
        mock_put(&server, 1).await;

        // The redirect is relative, so this only lands in reports/ if that is the cwd.
        let outcome = run_tick(
            &client(&server),
            dir.path(),
            &entry("reports/out.html", Some(WRITE_DOC)),
        )
        .await
        .unwrap();

        assert_eq!(outcome, TickOutcome::Pushed { version: 1 });
        assert_eq!(
            std::fs::read_to_string(dir.path().join("reports/out.html")).unwrap(),
            DOC
        );
    }

    #[tokio::test]
    async fn a_document_the_csp_would_break_is_not_pushed_and_does_not_stop_the_daemon() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        already_tracked(dir.path(), "out.html");
        std::fs::write(
            dir.path().join("out.html"),
            r#"<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>"#,
        )
        .unwrap();

        let outcome = run_tick(&client(&server), dir.path(), &entry("out.html", None))
            .await
            .unwrap();

        assert_eq!(outcome, TickOutcome::LintRejected { rejected: 1 });
        assert_eq!(calls(&server).await, Vec::new());
    }

    #[tokio::test]
    async fn an_artifact_that_is_gone_is_reported_not_silently_recreated() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        already_tracked(dir.path(), "out.html");
        std::fs::write(dir.path().join("out.html"), DOC).unwrap();
        mock_head_missing(&server).await;
        mock_put_missing(&server).await;

        let outcome = run_tick(&client(&server), dir.path(), &entry("out.html", None))
            .await
            .unwrap();

        assert_eq!(outcome, TickOutcome::ArtifactMissing { id: ID.to_string() });
        // A replacement under a new id would fork the document readers already have.
        assert!(
            !calls(&server)
                .await
                .contains(&("POST".to_string(), "/api/artifacts".to_string())),
            "the tick made a new artifact"
        );
    }

    #[tokio::test]
    async fn the_loop_ticks_again_after_the_interval() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        already_tracked(dir.path(), "out.html");
        std::fs::write(dir.path().join("out.html"), DOC).unwrap();
        mock_head(&server, &sha256_hex(DOC.as_bytes()), 1).await;

        let task = tokio::spawn(watch_loop(
            Arc::new(client(&server)),
            dir.path().to_path_buf(),
            WatchEntry {
                file: PathBuf::from("out.html"),
                every: Duration::from_millis(5),
                command: None,
            },
        ));

        let mut ticks = 0;
        for _ in 0..500 {
            ticks = calls(&server).await.len();
            if ticks >= 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        task.abort();

        assert!(ticks >= 3, "the loop stopped after {ticks} ticks");
    }

    #[test]
    fn a_failing_entry_backs_off_by_doubling_up_to_ten_intervals() {
        let every = Duration::from_secs(60);

        assert_eq!(backoff(every, 0), every);
        assert_eq!(backoff(every, 1), Duration::from_secs(120));
        assert_eq!(backoff(every, 2), Duration::from_secs(240));
        assert_eq!(backoff(every, 3), Duration::from_secs(480));
        // 16 intervals would be next, so the cap takes over and stays there.
        assert_eq!(backoff(every, 4), Duration::from_secs(600));
        assert_eq!(backoff(every, 40), Duration::from_secs(600));
        assert_eq!(backoff(every, u32::MAX), Duration::from_secs(600));
    }

    #[test]
    fn log_timestamps_are_rfc3339_in_utc() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_754_680_245), "2025-08-08T19:10:45Z");
        assert_eq!(rfc3339(4_102_444_800), "2100-01-01T00:00:00Z");
    }
}
