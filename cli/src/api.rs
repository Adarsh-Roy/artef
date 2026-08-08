//! Every HTTP call the CLI makes (spec §5).
//!
//! The commands in `commands/` decide what to do and what to print; this module is the
//! only place that knows the wire format — routes, headers, and the shapes that come
//! back. The content protocol in particular (§5.2) lives here in one piece: a `PUT`
//! carries the client's hash in `If-None-Match` and, unless the caller is forcing the
//! write, the version it based the change on in `X-Base-Version`.

use anyhow::{anyhow, bail, Context, Result};
use reqwest::header::{CONTENT_ENCODING, ETAG, IF_NONE_MATCH};
use reqwest::{multipart, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::config::GlobalConfig;

/// Version of the stored document, returned by `HEAD` (spec §5.2).
const VERSION_HEADER: &str = "X-Artef-Version";
/// Version the client based this write on. Omitted = last write wins (spec §5.2).
const BASE_VERSION_HEADER: &str = "X-Base-Version";

const USER_AGENT: &str = concat!("artef/", env!("CARGO_PKG_VERSION"));

/// An authenticated connection to one artef server.
pub struct ApiClient {
    base: Url,
    token: String,
    http: Client,
}

/// What `POST /api/artifacts` gives back. Only the id is ours to keep — the URL the
/// CLI prints is built locally so it is the same string for a create and an update.
#[derive(Debug, Deserialize)]
pub struct CreatedArtifact {
    pub id: String,
}

/// What the server currently holds for an artifact (spec §5.2 `HEAD`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteContent {
    pub etag_hex: String,
    pub version: i64,
}

/// One row of `artef ls` (spec §5.1).
#[derive(Debug, Clone, Deserialize)]
pub struct ArtifactMeta {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub visibility: String,
    pub version: i64,
    pub updated_at: String,
}

/// How a `PUT` to the content endpoint ended (spec §5.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutOutcome {
    /// The server stored the document and bumped the version.
    Changed { version: i64 },
    /// The server already had these exact bytes and wrote nothing.
    Unchanged,
    /// Someone else pushed since the version we based this on.
    Conflict { version: i64 },
    /// There is no artifact at that id to write to — it was deleted, or it stopped
    /// being ours (the API answers 404 rather than 403 so it never confirms that
    /// something exists, spec §2.3).
    Missing,
}

/// What `DELETE` found (spec §5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteOutcome {
    Deleted,
    /// Nothing there to delete, which is the state the caller wanted anyway.
    AlreadyGone,
}

/// The optional fields of an artifact, for create and update.
#[derive(Debug, Serialize)]
struct ArtifactFields<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    visibility: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct GrantRequest<'a> {
    email: &'a str,
    role: &'a str,
}

#[derive(Debug, Deserialize)]
struct VersionBody {
    version: i64,
}

#[derive(Debug, Deserialize)]
struct ListPage {
    items: Vec<ArtifactMeta>,
}

#[derive(Debug, Deserialize)]
struct UploadedAsset {
    url: String,
}

impl ApiClient {
    pub fn new(server: &str, token: &str) -> Result<Self> {
        let mut base =
            Url::parse(server).with_context(|| format!("{server} is not a URL I can talk to"))?;

        // Endpoints are joined onto this base, and `Url::join` drops the last path
        // segment unless the base ends in a slash — so a server at
        // `https://host/artef` would otherwise lose its `/artef` prefix.
        if !base.path().ends_with('/') {
            let path = format!("{}/", base.path());
            base.set_path(&path);
        }

        Ok(Self {
            base,
            token: token.to_string(),
            http: Client::builder()
                .user_agent(USER_AGENT)
                .build()
                .context("building the HTTP client")?,
        })
    }

    /// The client the commands use: the configured server, and a token or an
    /// explanation of how to get one.
    pub fn from_config(config: &GlobalConfig) -> Result<Self> {
        let token = config.token.as_deref().ok_or_else(|| {
            anyhow!(
                "no token for {}: run `artef login`, or set ARTEF_TOKEN",
                config.server
            )
        })?;
        Self::new(&config.server, token)
    }

    /// The link to hand a reader, for callers that have a client but no config — the
    /// daemon logs one for every artifact it creates or updates (spec §7.4).
    pub fn share_url(&self, id: &str) -> String {
        share_url(self.base.as_str(), id)
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.base
            .join(path)
            .with_context(|| format!("building a URL for {path}"))
    }

    /// `POST /api/artifacts` — creates an artifact at version 0, with no content yet.
    pub async fn create_artifact(
        &self,
        name: Option<&str>,
        visibility: Option<&str>,
    ) -> Result<CreatedArtifact> {
        let response = self
            .http
            .post(self.endpoint("api/artifacts")?)
            .bearer_auth(&self.token)
            .json(&ArtifactFields { name, visibility })
            .send()
            .await
            .with_context(|| format!("reaching {}", self.base))?;

        checked(response, "creating the artifact")
            .await?
            .json()
            .await
            .context("reading the created artifact")
    }

    /// `HEAD /api/artifacts/:id/content` — what the server holds right now.
    /// `None` means the server has no such artifact.
    pub async fn head_content(&self, id: &str) -> Result<Option<RemoteContent>> {
        let response = self
            .http
            .head(self.endpoint(&content_path(id))?)
            .bearer_auth(&self.token)
            .send()
            .await
            .with_context(|| format!("reaching {}", self.base))?;

        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let response = checked(response, "asking what the server already has").await?;

        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(etag_hex)
            .ok_or_else(|| anyhow!("the server sent no ETag for {id}"))?;
        let version = response
            .headers()
            .get(VERSION_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<i64>().ok())
            .ok_or_else(|| anyhow!("the server sent no usable {VERSION_HEADER} for {id}"))?;

        Ok(Some(RemoteContent {
            etag_hex: etag,
            version,
        }))
    }

    /// `PUT /api/artifacts/:id/content` — upload gzipped HTML (spec §5.2).
    ///
    /// `sha_hex` is the hash of the *uncompressed* document, sent as `If-None-Match` so
    /// the server can answer 304 without reading the body. `base_version` is the version
    /// this change was based on; omitting it makes the write last-write-wins.
    pub async fn put_content(
        &self,
        id: &str,
        gz: Vec<u8>,
        sha_hex: &str,
        base_version: Option<i64>,
    ) -> Result<PutOutcome> {
        let mut request = self
            .http
            .put(self.endpoint(&content_path(id))?)
            .bearer_auth(&self.token)
            .header(CONTENT_ENCODING, "gzip")
            .header(IF_NONE_MATCH, format!("\"{sha_hex}\""))
            .body(gz);
        if let Some(base) = base_version {
            request = request.header(BASE_VERSION_HEADER, base.to_string());
        }

        let response = request
            .send()
            .await
            .with_context(|| format!("uploading to {}", self.base))?;

        match response.status() {
            StatusCode::NOT_MODIFIED => Ok(PutOutcome::Unchanged),
            StatusCode::NOT_FOUND => Ok(PutOutcome::Missing),
            StatusCode::CONFLICT => Ok(PutOutcome::Conflict {
                version: version_of(response, "the conflict the server reported").await?,
            }),
            _ => {
                let response = checked(response, "uploading the document").await?;
                Ok(PutOutcome::Changed {
                    version: version_of(response, "the stored version").await?,
                })
            }
        }
    }

    /// `GET /api/artifacts/:id/content` — read a document back.
    pub async fn get_content(&self, id: &str) -> Result<String> {
        let response = self
            .http
            .get(self.endpoint(&content_path(id))?)
            .bearer_auth(&self.token)
            .send()
            .await
            .with_context(|| format!("reaching {}", self.base))?;

        checked(response, "reading the document")
            .await?
            .text()
            .await
            .context("decoding the document")
    }

    /// `GET /api/artifacts?limit=1` — the smallest call that proves a token works, which
    /// is how `artef login --token` checks one before writing it to disk (spec §7.2).
    pub async fn verify_token(&self) -> Result<()> {
        let response = self
            .http
            .get(self.endpoint("api/artifacts?limit=1")?)
            .bearer_auth(&self.token)
            .send()
            .await
            .with_context(|| format!("reaching {}", self.base))?;

        if response.status() == StatusCode::UNAUTHORIZED {
            bail!("the server did not accept that token");
        }
        checked(response, "checking the token").await?;
        Ok(())
    }

    /// `GET /api/artifacts` — the first page of the workspace's artifacts.
    pub async fn list(&self) -> Result<Vec<ArtifactMeta>> {
        let response = self
            .http
            .get(self.endpoint("api/artifacts")?)
            .bearer_auth(&self.token)
            .send()
            .await
            .with_context(|| format!("reaching {}", self.base))?;

        let page: ListPage = checked(response, "listing artifacts")
            .await?
            .json()
            .await
            .context("reading the artifact list")?;
        Ok(page.items)
    }

    /// `DELETE /api/artifacts/:id`. A 404 is reported, not raised: an artifact that
    /// is not there is the outcome the caller was asking for.
    pub async fn delete(&self, id: &str) -> Result<DeleteOutcome> {
        let response = self
            .http
            .delete(self.endpoint(&format!("api/artifacts/{id}"))?)
            .bearer_auth(&self.token)
            .send()
            .await
            .with_context(|| format!("reaching {}", self.base))?;

        if response.status() == StatusCode::NOT_FOUND {
            return Ok(DeleteOutcome::AlreadyGone);
        }
        checked(response, "deleting the artifact").await?;
        Ok(DeleteOutcome::Deleted)
    }

    /// `PATCH /api/artifacts/:id` — change the name, the visibility, or both.
    pub async fn patch(
        &self,
        id: &str,
        name: Option<&str>,
        visibility: Option<&str>,
    ) -> Result<()> {
        let response = self
            .http
            .patch(self.endpoint(&format!("api/artifacts/{id}"))?)
            .bearer_auth(&self.token)
            .json(&ArtifactFields { name, visibility })
            .send()
            .await
            .with_context(|| format!("reaching {}", self.base))?;

        checked(response, "updating the artifact").await?;
        Ok(())
    }

    /// `POST /api/artifacts/:id/grants` — let one person in (spec §5.3).
    pub async fn grant(&self, id: &str, email: &str, role: &str) -> Result<()> {
        let response = self
            .http
            .post(self.endpoint(&format!("api/artifacts/{id}/grants"))?)
            .bearer_auth(&self.token)
            .json(&GrantRequest {
                email,
                role: server_role(role),
            })
            .send()
            .await
            .with_context(|| format!("reaching {}", self.base))?;

        checked(response, "sharing the artifact").await?;
        Ok(())
    }

    /// `POST /api/assets` — store one extracted image and get back its path (spec §5.4).
    pub async fn upload_asset(&self, bytes: &[u8], media_type: &str) -> Result<String> {
        let part = multipart::Part::bytes(bytes.to_vec())
            .file_name("asset")
            .mime_str(media_type)
            .with_context(|| format!("{media_type} is not a media type I can send"))?;

        let response = self
            .http
            .post(self.endpoint("api/assets")?)
            .bearer_auth(&self.token)
            .multipart(multipart::Form::new().part("file", part))
            .send()
            .await
            .with_context(|| format!("reaching {}", self.base))?;

        let asset: UploadedAsset = checked(response, "uploading an asset")
            .await?
            .json()
            .await
            .context("reading the uploaded asset")?;
        Ok(asset.url)
    }
}

/// The short URL people share: `{server}/{id}`, which redirects to the viewer (spec §5.7).
pub fn share_url(server: &str, id: &str) -> String {
    format!("{}/{id}", server.trim_end_matches('/'))
}

/// The page a person opens: `{server}/a/{id}` (spec §5.7).
pub fn viewer_url(server: &str, id: &str) -> String {
    format!("{}/a/{id}", server.trim_end_matches('/'))
}

/// The CLI says "view" and "update" because that is what a reader understands and what
/// the share dialog shows; the API stores `viewer` and `editor` (spec §3, §5.9).
fn server_role(role: &str) -> &str {
    match role {
        "view" => "viewer",
        "update" => "editor",
        other => other,
    }
}

fn content_path(id: &str) -> String {
    format!("api/artifacts/{id}/content")
}

/// An ETag as the hash inside it: `W/"ab12"` and `"ab12"` both mean `ab12`.
fn etag_hex(etag: &str) -> String {
    etag.trim()
        .trim_start_matches("W/")
        .trim_matches('"')
        .to_ascii_lowercase()
}

/// Pass a successful response through; turn anything else into an error carrying the
/// status and whatever the server said about it.
async fn checked(response: Response, what: &str) -> Result<Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let body = response.text().await.unwrap_or_default();
    match server_message(&body) {
        Some(message) => bail!("{what} failed: {status} — {message}"),
        None => bail!("{what} failed: {status}"),
    }
}

/// The server's own explanation, from `{"error": "…"}` or a plain-text body.
fn server_message(body: &str) -> Option<String> {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|json| {
            json.get("error")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.trim().to_string());

    let message = message.trim();
    if message.is_empty() {
        return None;
    }
    Some(match message.char_indices().nth(300) {
        Some((cut, _)) => format!("{}…", &message[..cut]),
        None => message.to_string(),
    })
}

async fn version_of(response: Response, what: &str) -> Result<i64> {
    let body: VersionBody = response
        .json()
        .await
        .with_context(|| format!("reading {what}"))?;
    Ok(body.version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn a_server_with_a_path_prefix_keeps_it() {
        let client = ApiClient::new("https://host.example.com/artef", "art_live_x").unwrap();
        assert_eq!(
            client.endpoint("api/artifacts").unwrap().as_str(),
            "https://host.example.com/artef/api/artifacts"
        );

        let client = ApiClient::new("https://host.example.com/artef/", "art_live_x").unwrap();
        assert_eq!(
            client.endpoint("api/artifacts").unwrap().as_str(),
            "https://host.example.com/artef/api/artifacts"
        );
    }

    #[test]
    fn a_server_that_is_not_a_url_says_so() {
        let err = ApiClient::new("not a url", "art_live_x")
            .err()
            .expect("a server that is not a URL must be rejected");
        assert!(
            format!("{err:#}").contains("not a url"),
            "error was {err:#}"
        );
    }

    #[test]
    fn urls_survive_a_trailing_slash_on_the_server() {
        assert_eq!(share_url("https://a.co", "abc"), "https://a.co/abc");
        assert_eq!(share_url("https://a.co/", "abc"), "https://a.co/abc");
        assert_eq!(viewer_url("https://a.co/", "abc"), "https://a.co/a/abc");
    }

    #[test]
    fn the_cli_role_names_map_to_the_ones_the_api_stores() {
        assert_eq!(server_role("view"), "viewer");
        assert_eq!(server_role("update"), "editor");
    }

    #[test]
    fn an_etag_is_read_as_the_bare_hash() {
        assert_eq!(etag_hex("\"AB12\""), "ab12");
        assert_eq!(etag_hex("W/\"ab12\""), "ab12");
        assert_eq!(etag_hex(" ab12 "), "ab12");
    }

    #[test]
    fn a_failure_message_prefers_the_servers_own_words() {
        assert_eq!(
            server_message(r#"{"error":"artifact too large"}"#).as_deref(),
            Some("artifact too large")
        );
        assert_eq!(server_message("plain text"), Some("plain text".to_string()));
        assert_eq!(server_message("   "), None);
        assert!(server_message(&"x".repeat(400)).unwrap().ends_with('…'));
    }

    #[tokio::test]
    async fn an_asset_is_uploaded_as_one_multipart_part_named_file() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "sha256": "ab12",
                "url": "/assets/ab12",
                "byte_size": 3,
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = ApiClient::new(&server.uri(), "art_live_x").unwrap();
        let url = client.upload_asset(b"png", "image/png").await.unwrap();

        assert_eq!(url, "/assets/ab12");
        let request = &server.received_requests().await.unwrap()[0];
        let content_type = request
            .headers
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            content_type.starts_with("multipart/form-data"),
            "content type was {content_type}"
        );
        let body = String::from_utf8_lossy(&request.body);
        assert!(body.contains("name=\"file\""), "body was {body}");
        assert!(body.contains("image/png"), "body was {body}");
        assert!(body.contains("png"), "body was {body}");
    }
}
