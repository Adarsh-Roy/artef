//! `artef push` against a mock server (spec §5.2, §7.1, §7.2).

mod common;

use common::{
    calls, gunzip, header, mock_create, mock_head, mock_head_missing, mock_put, mock_put_conflict,
    only_request, sha256_hex, Cli, ID, TOKEN,
};
use wiremock::MockServer;

const DOC: &str = "<!doctype html><html><body><h1>Q3</h1></body></html>";
const CDN_DOC: &str =
    r#"<html><body><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></body></html>"#;

#[tokio::test]
async fn a_first_push_creates_the_artifact_then_uploads_it_gzipped() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write("report.html", DOC);

    mock_create(&server, ID).await;
    mock_head(
        &server,
        ID,
        &sha256_hex("<h1>whatever was there before</h1>"),
        1,
    )
    .await;
    mock_put(&server, ID, 2).await;

    let run = cli.run(&server, &["push", "report.html"]);

    run.ok();
    assert_eq!(run.stdout, format!("pushed v2  {}/{ID}\n", server.uri()));
    assert_eq!(run.stderr, "");

    // Create, then look before uploading, then upload (spec §5.2 hash-first push).
    assert_eq!(
        calls(&server).await,
        vec![
            ("POST".to_string(), "/api/artifacts".to_string()),
            ("HEAD".to_string(), format!("/api/artifacts/{ID}/content")),
            ("PUT".to_string(), format!("/api/artifacts/{ID}/content")),
        ]
    );

    let put = only_request(&server, "PUT").await;
    assert_eq!(header(&put, "content-encoding").as_deref(), Some("gzip"));
    assert_eq!(
        header(&put, "if-none-match").as_deref(),
        Some(format!("\"{}\"", sha256_hex(DOC)).as_str())
    );
    assert_eq!(header(&put, "x-base-version").as_deref(), Some("1"));
    assert_eq!(
        header(&put, "authorization").as_deref(),
        Some(format!("Bearer {TOKEN}").as_str())
    );
    assert_eq!(gunzip(&put.body), DOC);

    assert_eq!(cli.state()["artifacts"]["report.html"]["id"], ID);
    assert_eq!(
        cli.state()["artifacts"]["report.html"]["hash"],
        sha256_hex(DOC)
    );
}

#[tokio::test]
async fn pushing_an_unchanged_file_again_uploads_nothing() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write("report.html", DOC);

    mock_create(&server, ID).await;
    mock_head(&server, ID, &sha256_hex("<h1>old</h1>"), 1).await;
    mock_put(&server, ID, 2).await;
    cli.run(&server, &["push", "report.html"]).ok();

    // Second run: the server now holds exactly what we have, and no PUT is mounted,
    // so a wasted upload would fail the run as well as the assertion below.
    server.reset().await;
    mock_head(&server, ID, &sha256_hex(DOC), 2).await;

    let run = cli.run(&server, &["push", "report.html"]);

    run.ok();
    assert_eq!(run.stdout, format!("unchanged  {}/{ID}\n", server.uri()));
    assert_eq!(
        calls(&server).await,
        vec![("HEAD".to_string(), format!("/api/artifacts/{ID}/content"))],
        "the second push must reuse the tracked id and skip the upload"
    );
}

#[tokio::test]
async fn a_push_that_lost_the_race_says_so_and_fails() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write("report.html", DOC);
    cli.write_state("report.html", ID, &sha256_hex("<h1>mine</h1>"));

    mock_head(&server, ID, &sha256_hex("<h1>theirs</h1>"), 5).await;
    mock_put_conflict(&server, ID, 5).await;

    let run = cli.run(&server, &["push", "report.html"]);

    run.failed();
    assert!(
        run.stderr
            .contains("someone else updated this artifact (server has v5)")
            && run.stderr.contains("re-run with --force"),
        "stderr was:\n{}",
        run.stderr
    );
    assert_eq!(run.stdout, "");

    let put = only_request(&server, "PUT").await;
    assert_eq!(header(&put, "x-base-version").as_deref(), Some("5"));
}

#[tokio::test]
async fn a_document_the_csp_would_break_never_reaches_the_network() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write("bad.html", CDN_DOC);

    let run = cli.run(&server, &["push", "bad.html"]);

    run.failed();
    assert!(
        run.stderr.contains("https://cdn.jsdelivr.net/npm/chart.js"),
        "stderr was:\n{}",
        run.stderr
    );
    assert_eq!(
        calls(&server).await,
        Vec::<(String, String)>::new(),
        "the preflight must refuse before anything is uploaded"
    );
    assert!(!cli.has_state(), "a refused push must not track anything");
}

#[tokio::test]
async fn force_omits_the_base_version_so_the_last_write_wins() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write("report.html", DOC);
    cli.write_state("report.html", ID, "");

    mock_head(&server, ID, &sha256_hex("<h1>theirs</h1>"), 5).await;
    mock_put(&server, ID, 6).await;

    let run = cli.run(&server, &["push", "report.html", "--force"]);

    run.ok();
    assert_eq!(run.stdout, format!("pushed v6  {}/{ID}\n", server.uri()));

    let put = only_request(&server, "PUT").await;
    assert_eq!(header(&put, "x-base-version"), None);
}

#[tokio::test]
async fn no_preflight_pushes_what_the_lint_would_have_refused() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write("bad.html", CDN_DOC);
    cli.write_state("bad.html", ID, "");

    // Nothing has ever been pushed to this artifact, so HEAD is a 404.
    mock_head_missing(&server, ID).await;
    mock_put(&server, ID, 1).await;

    let run = cli.run(&server, &["push", "bad.html", "--no-preflight"]);

    run.ok();
    assert_eq!(run.stdout, format!("pushed v1  {}/{ID}\n", server.uri()));
    assert_eq!(run.stderr, "");

    let put = only_request(&server, "PUT").await;
    assert_eq!(header(&put, "x-base-version"), None);
    assert_eq!(gunzip(&put.body), CDN_DOC);
}

#[tokio::test]
async fn warnings_are_printed_but_never_block_a_push() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    let doc = r#"<html><body><script>fetch('/api/x')</script></body></html>"#;
    cli.write("live.html", doc);
    cli.write_state("live.html", ID, "");

    mock_head(&server, ID, &sha256_hex("<h1>old</h1>"), 3).await;
    mock_put(&server, ID, 4).await;

    let run = cli.run(&server, &["push", "live.html"]);

    run.ok();
    assert_eq!(run.stdout, format!("pushed v4  {}/{ID}\n", server.uri()));
    assert!(
        run.stderr.starts_with("warn: fetch("),
        "stderr was:\n{}",
        run.stderr
    );
}

#[tokio::test]
async fn a_name_and_visibility_are_sent_when_the_artifact_is_created() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write("report.html", DOC);

    mock_create(&server, ID).await;
    mock_head_missing(&server, ID).await;
    mock_put(&server, ID, 1).await;

    cli.run(
        &server,
        &[
            "push",
            "report.html",
            "--name",
            "Q3 Report",
            "--visibility",
            "workspace",
        ],
    )
    .ok();

    let post = only_request(&server, "POST").await;
    let body: serde_json::Value = post.body_json().expect("POST body is json");
    assert_eq!(body["name"], "Q3 Report");
    assert_eq!(body["visibility"], "workspace");
}

#[tokio::test]
async fn flags_that_only_apply_at_creation_say_so_instead_of_being_dropped() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write("report.html", DOC);
    cli.write_state("report.html", ID, "");

    mock_head(&server, ID, &sha256_hex("<h1>old</h1>"), 1).await;
    mock_put(&server, ID, 2).await;

    let run = cli.run(
        &server,
        &[
            "push",
            "report.html",
            "--name",
            "Renamed",
            "--visibility",
            "public",
        ],
    );

    run.ok();
    assert!(
        run.stderr.contains("--name") && run.stderr.contains("already"),
        "stderr was:\n{}",
        run.stderr
    );
    // Nothing was renamed behind the user's back either.
    assert_eq!(
        calls(&server).await,
        vec![
            ("HEAD".to_string(), format!("/api/artifacts/{ID}/content")),
            ("PUT".to_string(), format!("/api/artifacts/{ID}/content")),
        ]
    );
}

#[tokio::test]
async fn a_push_without_a_token_says_how_to_get_one() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write("report.html", DOC);

    let run = cli.run_without_token(&server, &["push", "report.html"]);

    run.failed();
    assert!(
        run.stderr.contains("artef login"),
        "stderr was:\n{}",
        run.stderr
    );
    assert_eq!(calls(&server).await, Vec::<(String, String)>::new());
}

#[tokio::test]
async fn a_server_error_is_reported_with_its_status() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write("report.html", DOC);
    cli.write_state("report.html", ID, "");

    mock_head(&server, ID, &sha256_hex("<h1>old</h1>"), 1).await;
    wiremock::Mock::given(wiremock::matchers::method("PUT"))
        .respond_with(
            wiremock::ResponseTemplate::new(413)
                .set_body_json(serde_json::json!({ "error": "artifact too large" })),
        )
        .mount(&server)
        .await;

    let run = cli.run(&server, &["push", "report.html"]);

    run.failed();
    assert!(
        run.stderr.contains("413") && run.stderr.contains("artifact too large"),
        "stderr was:\n{}",
        run.stderr
    );
}
