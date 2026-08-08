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
use std::process::Command;

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

    pub fn run(&self, server: &MockServer, args: &[&str]) -> Run {
        self.run_inner(server, args, Some(TOKEN))
    }

    /// Run with no token configured anywhere, the way a fresh machine looks.
    pub fn run_without_token(&self, server: &MockServer, args: &[&str]) -> Run {
        self.run_inner(server, args, None)
    }

    fn run_inner(&self, server: &MockServer, args: &[&str], token: Option<&str>) -> Run {
        let home = self.dir.path().join("home");
        std::fs::create_dir_all(&home).expect("creating fake home");

        let mut command = Command::new(env!("CARGO_BIN_EXE_artef"));
        command
            .current_dir(self.dir.path())
            .args(args)
            .env("ARTEF_SERVER", server.uri())
            // Keep the run away from the developer's own ~/.config/artef/config.toml.
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env_remove("ARTEF_TOKEN");
        if let Some(token) = token {
            command.env("ARTEF_TOKEN", token);
        }

        let out = command.output().expect("running artef");
        Run {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }
    }
}

pub fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
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
