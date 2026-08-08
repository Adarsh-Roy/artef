//! `artef ls`, `pull`, `rm` and `share` against a mock server (spec §5.1, §5.2, §5.3, §7.2).

mod common;

use common::{calls, content_path, gzip, only_request, Cli, ID};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const OTHER_ID: &str = "3c9a7b21-5555-6666-7777-888888888888";

#[tokio::test]
async fn ls_prints_one_row_per_artifact() {
    let server = MockServer::start().await;
    let cli = Cli::new();

    Mock::given(method("GET"))
        .and(path("/api/artifacts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [
                { "id": ID, "name": "Q3 infra report", "visibility": "workspace",
                  "version": 3, "updated_at": "2026-08-08T10:12:33.000Z" },
                { "id": OTHER_ID, "name": null, "visibility": "private",
                  "version": 1, "updated_at": "2026-08-07T09:00:00.000Z" },
            ],
            "next_cursor": null,
        })))
        .mount(&server)
        .await;

    let run = cli.run(&server, &["ls"]);

    run.ok();
    let lines: Vec<&str> = run.stdout.lines().collect();
    assert_eq!(lines.len(), 2, "stdout was:\n{}", run.stdout);
    assert!(
        lines[0].starts_with("8f14e45f")
            && lines[0].contains("Q3 infra report")
            && lines[0].contains("workspace")
            && lines[0].contains("v3")
            && lines[0].contains("2026-08-08T10:12:33.000Z"),
        "row was {:?}",
        lines[0]
    );
    // An artifact with no name still shows a placeholder, so the columns line up.
    assert!(
        lines[1].starts_with("3c9a7b21") && lines[1].contains('—'),
        "row was {:?}",
        lines[1]
    );
}

#[tokio::test]
async fn ls_reports_a_rejected_token_rather_than_printing_nothing() {
    let server = MockServer::start().await;
    let cli = Cli::new();

    Mock::given(method("GET"))
        .and(path("/api/artifacts"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({ "error": "invalid token" })))
        .mount(&server)
        .await;

    let run = cli.run(&server, &["ls"]);

    run.failed();
    assert!(
        run.stderr.contains("401") && run.stderr.contains("invalid token"),
        "stderr was:\n{}",
        run.stderr
    );
}

#[tokio::test]
async fn pull_writes_the_document_to_stdout_byte_for_byte() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    let doc = "<!doctype html><html><body>no trailing newline</body></html>";

    Mock::given(method("GET"))
        .and(path(content_path(ID)))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("Content-Encoding", "gzip")
                .insert_header("Content-Type", "application/octet-stream")
                .set_body_bytes(gzip(doc)),
        )
        .mount(&server)
        .await;

    let run = cli.run(&server, &["pull", ID]);

    run.ok();
    assert_eq!(run.stdout, doc, "pull must not add or drop bytes");
}

#[tokio::test]
async fn pull_accepts_a_file_path_and_looks_the_id_up_locally() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write_state("reports/q3.html", ID, "abc");

    Mock::given(method("GET"))
        .and(path(content_path(ID)))
        .respond_with(ResponseTemplate::new(200).set_body_string("<h1>Q3</h1>"))
        .mount(&server)
        .await;

    let run = cli.run(&server, &["pull", "reports/q3.html"]);

    run.ok();
    assert_eq!(run.stdout, "<h1>Q3</h1>");
}

#[tokio::test]
async fn pull_of_an_untracked_file_explains_itself_without_calling_the_server() {
    let server = MockServer::start().await;
    let cli = Cli::new();

    let run = cli.run(&server, &["pull", "never-pushed.html"]);

    run.failed();
    assert!(
        run.stderr.contains("never-pushed.html"),
        "stderr was:\n{}",
        run.stderr
    );
    assert_eq!(calls(&server).await, Vec::<(String, String)>::new());
}

#[tokio::test]
async fn rm_deletes_the_artifact_and_forgets_it_locally() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write_state("status.html", ID, "abc");

    Mock::given(method("DELETE"))
        .and(path(format!("/api/artifacts/{ID}")))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;

    let run = cli.run(&server, &["rm", "status.html"]);

    run.ok();
    assert_eq!(
        cli.state()["artifacts"].as_object().map(|m| m.len()),
        Some(0),
        "state was {}",
        cli.state()
    );
}

#[tokio::test]
async fn share_public_patches_the_visibility() {
    let server = MockServer::start().await;
    let cli = Cli::new();

    Mock::given(method("PATCH"))
        .and(path(format!("/api/artifacts/{ID}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": ID })))
        .mount(&server)
        .await;

    let run = cli.run(&server, &["share", ID, "--public"]);

    run.ok();
    let patch = only_request(&server, "PATCH").await;
    let body: serde_json::Value = patch.body_json().expect("PATCH body is json");
    assert_eq!(body, json!({ "visibility": "public" }));
    assert!(
        run.stdout.contains(&format!("{}/{ID}", server.uri())),
        "stdout was {:?}",
        run.stdout
    );
}

#[tokio::test]
async fn share_by_email_sends_the_server_side_role_name() {
    let server = MockServer::start().await;
    let cli = Cli::new();
    cli.write_state("status.html", ID, "abc");

    Mock::given(method("POST"))
        .and(path(format!("/api/artifacts/{ID}/grants")))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({ "role": "editor" })))
        .mount(&server)
        .await;

    let run = cli.run(
        &server,
        &[
            "share",
            "status.html",
            "--email",
            "priya@company.com",
            "--role",
            "update",
        ],
    );

    run.ok();
    let post = only_request(&server, "POST").await;
    let body: serde_json::Value = post.body_json().expect("POST body is json");
    // The CLI speaks "view"/"update"; the API speaks "viewer"/"editor" (spec §3, §5.3).
    assert_eq!(
        body,
        json!({ "email": "priya@company.com", "role": "editor" })
    );
}

#[tokio::test]
async fn share_needs_to_be_told_who_to_share_with() {
    let server = MockServer::start().await;
    let cli = Cli::new();

    let run = cli.run(&server, &["share", ID]);

    run.failed();
    assert_eq!(calls(&server).await, Vec::<(String, String)>::new());
}
