//! Shared plumbing for the CLI integration tests.
//!
//! Every test runs the real `artef` binary against a wiremock server, in a temporary
//! directory that stands in for the user's working directory and home. No real server
//! is ever started, and the tests cannot see the developer's own config.

// Each integration test binary compiles this module separately, so helpers used by
// one test file look unused to the other.
#![allow(dead_code)]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use flate2::read::GzDecoder;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

/// The artifact id every mock hands back.
pub const ID: &str = "8f14e45f-1111-2222-3333-444444444444";
/// The token the tests run with.
pub const TOKEN: &str = "art_live_test";

/// What one `artef` run produced.
pub struct Run {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Run {
    /// Assert the command succeeded, showing stderr when it didn't.
    pub fn ok(&self) -> &Self {
        assert_eq!(self.code, Some(0), "stderr was:\n{}", self.stderr);
        self
    }

    pub fn failed(&self) -> &Self {
        assert_ne!(self.code, Some(0), "stdout was:\n{}", self.stdout);
        self
    }
}

/// A throwaway working directory plus a way to run the binary in it.
pub struct Cli {
    dir: TempDir,
}

impl Cli {
    pub fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("temp dir"),
        }
    }

    pub fn dir(&self) -> &Path {
        self.dir.path()
    }

    pub fn write(&self, name: &str, contents: &str) -> PathBuf {
        let path = self.dir.path().join(name);
        std::fs::write(&path, contents).expect("writing test file");
        path
    }

    /// Pretend an earlier push already tracked `key`.
    pub fn write_state(&self, key: &str, id: &str, hash: &str) {
        let body = json!({ "artifacts": { key: { "id": id, "hash": hash } } });
        self.write(".artef.json", &serde_json::to_string_pretty(&body).unwrap());
    }

    pub fn state(&self) -> Value {
        let raw = std::fs::read_to_string(self.dir.path().join(".artef.json"))
            .expect("reading .artef.json");
        serde_json::from_str(&raw).expect("parsing .artef.json")
    }

    pub fn has_state(&self) -> bool {
        self.dir.path().join(".artef.json").exists()
    }

    /// What the run left in `~/.config/artef/config.toml`, if it wrote one.
    pub fn saved_config(&self) -> Option<String> {
        std::fs::read_to_string(
            self.dir
                .path()
                .join("home")
                .join(".config")
                .join("artef")
                .join("config.toml"),
        )
        .ok()
    }

    /// The fake home directory this run sees as `$HOME`, created if it isn't there yet.
    pub fn home(&self) -> PathBuf {
        let home = self.dir.path().join("home");
        std::fs::create_dir_all(&home).expect("creating fake home");
        home
    }

    /// Make a directory under the fake home, e.g. `.claude/skills`.
    pub fn mkdir_home(&self, relative: &str) -> PathBuf {
        let path = self.home().join(relative);
        std::fs::create_dir_all(&path).expect("creating a directory under the fake home");
        path
    }

    pub fn run(&self, server: &MockServer, args: &[&str]) -> Run {
        self.run_inner(Some(server.uri()), args, Some(TOKEN))
    }

    /// Run with nothing configured, plus some extra environment variables.
    pub fn run_with_env(&self, args: &[&str], env: &[(&str, &str)]) -> Run {
        let mut command = self.command(None, args, None);
        for (key, value) in env {
            command.env(key, value);
        }
        let out = command.output().expect("running artef");
        Run {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }
    }

    /// Run with no token configured anywhere, the way a fresh machine looks.
    pub fn run_without_token(&self, server: &MockServer, args: &[&str]) -> Run {
        self.run_inner(Some(server.uri()), args, None)
    }

    /// Run with nothing configured at all: no server, no token, no config file. This is
    /// a machine that has never run `artef login`.
    pub fn run_unconfigured(&self, args: &[&str]) -> Run {
        self.run_inner(None, args, None)
    }

    /// Start a run that does not end on its own — `watch`, `daemon` — with its output
    /// going to files the test can read while it is still going.
    pub fn spawn(&self, server: &MockServer, args: &[&str]) -> Running {
        let mut command = self.command(Some(server.uri()), args, Some(TOKEN));
        let child = command
            .stdout(Stdio::from(
                std::fs::File::create(self.stdout_path()).expect("creating the stdout file"),
            ))
            .stderr(Stdio::from(
                std::fs::File::create(self.stderr_path()).expect("creating the stderr file"),
            ))
            .spawn()
            .expect("starting artef");
        Running { child: Some(child) }
    }

    fn stdout_path(&self) -> PathBuf {
        self.dir.path().join("artef.stdout")
    }

    fn stderr_path(&self) -> PathBuf {
        self.dir.path().join("artef.stderr")
    }

    /// Every log line a spawned run has printed so far, parsed. The daemon prints one
    /// JSON object per line (spec §7.4), so a line that is not one fails the test.
    pub fn logs(&self) -> Vec<Value> {
        std::fs::read_to_string(self.stdout_path())
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str(line).unwrap_or_else(|err| {
                    panic!("a log line was not one JSON object: {line:?} ({err})")
                })
            })
            .collect()
    }

    /// Wait for `count` log lines with this `event`, and hand them back.
    pub async fn wait_for_logs(&self, event: &str, count: usize) -> Vec<Value> {
        for _ in 0..200 {
            let found: Vec<Value> = self
                .logs()
                .into_iter()
                .filter(|line| line["event"] == event)
                .collect();
            if found.len() >= count {
                return found;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!(
            "waited for {count} {event:?} log lines and saw:\nstdout:\n{}\nstderr:\n{}",
            std::fs::read_to_string(self.stdout_path()).unwrap_or_default(),
            std::fs::read_to_string(self.stderr_path()).unwrap_or_default(),
        );
    }

    fn run_inner(&self, server: Option<String>, args: &[&str], token: Option<&str>) -> Run {
        let out = self
            .command(server, args, token)
            .output()
            .expect("running artef");
        Run {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }
    }

    fn command(&self, server: Option<String>, args: &[&str], token: Option<&str>) -> Command {
        let home = self.dir.path().join("home");
        std::fs::create_dir_all(&home).expect("creating fake home");

        let mut command = Command::new(env!("CARGO_BIN_EXE_artef"));
        command
            .current_dir(self.dir.path())
            .args(args)
            // Keep the run away from the developer's own ~/.config/artef/config.toml.
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env_remove("ARTEF_SERVER")
            .env_remove("ARTEF_TOKEN");
        if let Some(server) = server {
            command.env("ARTEF_SERVER", server);
        }
        if let Some(token) = token {
            command.env("ARTEF_TOKEN", token);
        }
        command
    }
}

/// A spawned `artef` that keeps going until the test stops it — and until it does, so
/// that a failed assertion never leaves a daemon behind.
pub struct Running {
    child: Option<Child>,
}

impl Running {
    /// Whether it is still going. A daemon that fell over is a failed test.
    pub fn is_running(&mut self) -> bool {
        match self.child.as_mut().expect("already stopped").try_wait() {
            Ok(status) => status.is_none(),
            Err(_) => false,
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn gzip(text: &str) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use std::io::Write;

    let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(text.as_bytes()).expect("gzipping");
    encoder.finish().expect("gzipping")
}

pub fn gunzip(bytes: &[u8]) -> String {
    let mut out = String::new();
    GzDecoder::new(bytes)
        .read_to_string(&mut out)
        .expect("gunzipping");
    out
}

pub fn header(request: &Request, name: &str) -> Option<String> {
    request
        .headers
        .get(name)
        .map(|value| value.to_str().expect("header is text").to_string())
}

/// Every request the mock server saw, in arrival order, as `("METHOD", "/path")`.
pub async fn calls(server: &MockServer) -> Vec<(String, String)> {
    server
        .received_requests()
        .await
        .expect("request recording is on")
        .iter()
        .map(|r| (r.method.to_string(), r.url.path().to_string()))
        .collect()
}

pub async fn only_request(server: &MockServer, wanted: &str) -> Request {
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

pub fn content_path(id: &str) -> String {
    format!("/api/artifacts/{id}/content")
}

pub async fn mock_create(server: &MockServer, id: &str) {
    Mock::given(method("POST"))
        .and(path("/api/artifacts"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "id": id,
            "url": format!("{}/a/{id}", server.uri()),
            "name": null,
            "visibility": "private",
            "version": 0,
        })))
        .mount(server)
        .await;
}

/// `POST /api/assets` answering the way spec §5.4 says it does.
pub async fn mock_asset(server: &MockServer, sha_hex: &str, byte_size: usize) {
    Mock::given(method("POST"))
        .and(path("/api/assets"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "sha256": sha_hex,
            "url": format!("/assets/{sha_hex}"),
            "byte_size": byte_size,
        })))
        .mount(server)
        .await;
}

pub async fn mock_head(server: &MockServer, id: &str, etag_hex: &str, version: i64) {
    Mock::given(method("HEAD"))
        .and(path(content_path(id)))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("ETag", format!("\"{etag_hex}\"").as_str())
                .insert_header("X-Artef-Version", version.to_string().as_str()),
        )
        .mount(server)
        .await;
}

pub async fn mock_head_missing(server: &MockServer, id: &str) {
    Mock::given(method("HEAD"))
        .and(path(content_path(id)))
        .respond_with(ResponseTemplate::new(404))
        .mount(server)
        .await;
}

pub async fn mock_put(server: &MockServer, id: &str, version: i64) {
    Mock::given(method("PUT"))
        .and(path(content_path(id)))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "version": version, "changed": true })),
        )
        .mount(server)
        .await;
}

pub async fn mock_put_conflict(server: &MockServer, id: &str, version: i64) {
    Mock::given(method("PUT"))
        .and(path(content_path(id)))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({
            "version": version,
            "hash": sha256_hex("<h1>someone else</h1>"),
        })))
        .mount(server)
        .await;
}
