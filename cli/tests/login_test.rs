//! `artef login` through the real binary (spec §7.2).
//!
//! The browser round-trip is tested in `src/commands/login.rs`, where the browser can be
//! handed in and no window opens. What the binary adds is the flags, the config file it
//! writes, and what it says when it has no server to log in to — so that is what this
//! file checks.

mod common;

use common::{Cli, TOKEN};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// The one call that proves a token works (spec §7.2).
async fn mock_check(server: &MockServer, status: u16) {
    let body = if status == 200 {
        json!({ "items": [], "next_cursor": null })
    } else {
        json!({ "error": "invalid token" })
    };
    Mock::given(method("GET"))
        .and(path("/api/artifacts"))
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .expect(1)
        .mount(server)
        .await;
}

#[tokio::test]
async fn a_token_the_server_accepts_is_checked_and_then_saved() {
    let server = MockServer::start().await;
    mock_check(&server, 200).await;
    let uri = server.uri();
    let cli = Cli::new();

    let run = cli.run_unconfigured(&["login", "--server", &uri, "--token", TOKEN]);

    run.ok();
    assert!(
        run.stdout.contains(&format!("logged in to {uri}")),
        "stdout was {}",
        run.stdout
    );
    let saved = cli.saved_config().expect("login writes a config file");
    assert!(saved.contains(TOKEN), "config was {saved}");
    assert!(saved.contains(&uri), "config was {saved}");

    let request = &server.received_requests().await.unwrap()[0];
    assert_eq!(request.url.query(), Some("limit=1"));
    assert_eq!(
        common::header(request, "authorization").as_deref(),
        Some(format!("Bearer {TOKEN}").as_str())
    );
}

#[tokio::test]
async fn a_token_the_server_rejects_is_not_saved() {
    let server = MockServer::start().await;
    mock_check(&server, 401).await;
    let uri = server.uri();
    let cli = Cli::new();

    let run = cli.run_unconfigured(&["login", "--server", &uri, "--token", "art_live_stale"]);

    run.failed();
    assert!(run.stderr.contains("token"), "stderr was {}", run.stderr);
    assert!(
        cli.saved_config().is_none(),
        "a rejected token was written to the config file"
    );
}

#[tokio::test]
async fn the_server_may_come_from_the_environment_instead_of_the_flag() {
    let server = MockServer::start().await;
    mock_check(&server, 200).await;
    let cli = Cli::new();

    let run = cli.run_without_token(&server, &["login", "--token", TOKEN]);

    run.ok();
    let saved = cli.saved_config().expect("login writes a config file");
    assert!(saved.contains(TOKEN), "config was {saved}");
}

#[test]
fn with_no_server_named_anywhere_it_says_to_name_one() {
    let cli = Cli::new();

    let run = cli.run_unconfigured(&["login", "--token", TOKEN]);

    run.failed();
    assert!(run.stderr.contains("--server"), "stderr was {}", run.stderr);
    assert!(
        cli.saved_config().is_none(),
        "a login with no server wrote a config file"
    );
}

#[test]
fn a_server_that_is_not_a_url_is_refused_before_anything_opens() {
    let cli = Cli::new();

    let run = cli.run_unconfigured(&["login", "--server", "not a url", "--token", TOKEN]);

    run.failed();
    assert!(
        run.stderr.contains("not a url"),
        "stderr was {}",
        run.stderr
    );
    assert!(cli.saved_config().is_none());
}
