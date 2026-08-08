//! `artef watch` and `artef daemon` against a mock server (spec §7.4).
//!
//! These drive the real binary, so they cover the parts unit tests cannot: the command
//! line, `artef.toml`, one task per entry, and the promise that everything the daemon
//! prints is one JSON object per line.

mod common;

use common::{gunzip, mock_create, mock_head_missing, mock_put, only_request, Cli, ID};
use wiremock::MockServer;

const DOC: &str = "<h1>hi</h1>";
const WRITE_DOC: &str = "printf '<h1>hi</h1>' > out.html";

#[tokio::test]
async fn a_watch_regenerates_the_file_and_pushes_it() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    mock_create(&server, ID).await;
    mock_head_missing(&server, ID).await;
    mock_put(&server, ID, 1).await;

    let mut watching = cli.spawn(
        &server,
        &["watch", "out.html", "--every", "1h", "--cmd", WRITE_DOC],
    );
    let pushed = cli.wait_for_logs("pushed", 1).await;

    assert_eq!(pushed[0]["file"], "out.html");
    assert_eq!(pushed[0]["version"], 1);
    assert_eq!(pushed[0]["url"], format!("{}/{ID}", server.uri()));
    assert!(pushed[0]["ts"].is_string(), "no timestamp: {}", pushed[0]);

    let put = only_request(&server, "PUT").await;
    assert_eq!(gunzip(&put.body), DOC);
    assert_eq!(cli.state()["artifacts"]["out.html"]["id"], ID);

    // One tick an hour, so it is still there waiting for the next one.
    assert!(watching.is_running(), "the watch stopped after one tick");
}

#[tokio::test]
async fn the_daemon_runs_every_watch_entry_in_artef_toml() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write(
        "artef.toml",
        r#"
[[watch]]
file    = "status.html"
every   = "1h"
command = "printf '<h1>status</h1>' > status.html"

[[watch]]
file    = "build-health.html"
every   = "1h"
command = "printf '<h1>build</h1>' > build-health.html"
"#,
    );
    mock_create(&server, ID).await;
    mock_head_missing(&server, ID).await;
    mock_put(&server, ID, 1).await;

    let mut daemon = cli.spawn(&server, &["daemon"]);
    let pushed = cli.wait_for_logs("pushed", 2).await;

    let mut files: Vec<String> = pushed
        .iter()
        .map(|line| line["file"].as_str().unwrap().to_string())
        .collect();
    files.sort();
    assert_eq!(files, vec!["build-health.html", "status.html"]);

    // Both entries generated their file, and both rows survived being written at once.
    assert_eq!(
        std::fs::read_to_string(cli.dir().join("status.html")).unwrap(),
        "<h1>status</h1>"
    );
    assert_eq!(cli.state()["artifacts"]["status.html"]["id"], ID);
    assert_eq!(cli.state()["artifacts"]["build-health.html"]["id"], ID);

    assert!(daemon.is_running(), "the daemon stopped after one round");
}

#[tokio::test]
async fn a_generator_that_fails_is_logged_and_the_daemon_carries_on() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write(
        "artef.toml",
        r#"
[[watch]]
file    = "status.html"
every   = "1h"
command = "echo broken >&2; exit 3"
"#,
    );

    let mut daemon = cli.spawn(&server, &["daemon"]);
    let failed = cli.wait_for_logs("command_failed", 1).await;
    let backoff = cli.wait_for_logs("backoff", 1).await;

    assert_eq!(failed[0]["file"], "status.html");
    assert_eq!(failed[0]["code"], 3);
    // Two intervals after the first failure, so the next try is in two hours.
    assert_eq!(backoff[0]["retry_in_s"], 7200);
    // Nothing was uploaded, so whatever the artifact holds stays the live version.
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        0,
        "a failed generator must not reach the server"
    );
    assert!(
        daemon.is_running(),
        "a failing command must not take the daemon down"
    );
}

#[tokio::test]
async fn a_daemon_with_no_config_says_what_to_write() {
    let server = MockServer::start().await;
    let cli = Cli::new();

    let run = cli.run(&server, &["daemon"]);

    run.failed();
    assert!(
        run.stderr.contains("artef.toml"),
        "stderr was {}",
        run.stderr
    );
}
