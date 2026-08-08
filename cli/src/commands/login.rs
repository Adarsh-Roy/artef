//! `artef login` — get a machine token for a server and store it (spec §7.2).
//!
//! The browser round-trip is against the artef server, not an IdP: the credential the
//! CLI needs is an artef machine token. The CLI opens a listener on a loopback port,
//! sends the browser to `{server}/cli/auth` carrying that port and a random `state`, the
//! user signs in normally, and the server redirects the browser back to the listener with
//! a freshly minted token. The `state` is what ties the callback to this terminal: a
//! callback carrying anyone else's is answered and ignored, and the wait goes on.
//!
//! `--token` skips all of it, for machines with no browser to open.

use std::io::{Cursor, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use tiny_http::{Header, Response, Server};
use url::Url;

use crate::api::ApiClient;
use crate::config::{self, GlobalConfig};

/// How long the browser round-trip gets before the CLI gives up. Long enough to find a
/// password manager and a second factor, short enough that a forgotten terminal frees
/// its port the same afternoon.
const WAIT: Duration = Duration::from_secs(180);

/// 24 random bytes are exactly 32 base64url characters, with no padding to escape.
const STATE_BYTES: usize = 24;

/// The listener only ever hears from a browser on this machine, so the loopback address
/// is both the bind address and the base every callback URL is read against.
const LOOPBACK: &str = "127.0.0.1";

/// Everything `artef login` was asked to do.
pub struct Options<'a> {
    pub server: Option<&'a str>,
    pub token: Option<&'a str>,
}

/// What arrived on the loopback listener.
enum Callback {
    /// The callback this terminal was waiting for.
    Token(String),
    /// A callback for some other terminal's login.
    WrongState,
    /// Our callback, but with nothing in it.
    NoToken,
    /// Not the callback at all.
    NotOurs,
}

pub async fn run(options: &Options<'_>) -> Result<i32> {
    let config_path = config::config_path()?;
    let server = resolve_server(&config_path, options.server)?;
    let mut out = std::io::stdout().lock();

    match options.token {
        // A token handed in has to be checked before it is written down, or the next
        // command is the one that finds out it was a typo.
        Some(token) => {
            ApiClient::new(&server, token)?
                .verify_token()
                .await
                .with_context(|| format!("checking that token against {server}"))?;
            finish(&mut out, &config_path, &server, token)
        }
        None => login_with_browser(&mut out, &config_path, &server, WAIT, open_browser),
    }
}

/// The server to log in to: the flag first, then whatever the user has already set.
///
/// Nothing is guessed. Logging in is the one command where a default server would be
/// actively harmful — it would open a browser at, and hand a token to, somewhere the
/// user never named.
fn resolve_server(config_path: &Path, flag: Option<&str>) -> Result<String> {
    let server = match flag {
        Some(server) => server.to_string(),
        None => config::configured_server(config_path)?.ok_or_else(|| {
            anyhow!(
                "no server to log in to: pass --server https://artef.example.com \
                 (or set ARTEF_SERVER)"
            )
        })?,
    };

    // Catch a typo here rather than in a browser window.
    Url::parse(&server).with_context(|| format!("{server} is not a URL I can talk to"))?;
    Ok(server)
}

/// The real browser. Failing to open one is not fatal: the URL is already on screen, and
/// pasting it into a browser — even one on another machine — works just as well.
fn open_browser(url: &str) -> Result<()> {
    webbrowser::open(url).map(|_| ()).map_err(Into::into)
}

/// The browser round-trip, with the browser handed in so tests can play it.
fn login_with_browser(
    out: &mut impl Write,
    config_path: &Path,
    server: &str,
    wait: Duration,
    open: impl Fn(&str) -> Result<()>,
) -> Result<i32> {
    let token = wait_for_token(out, server, wait, open)?;
    finish(out, config_path, server, &token)
}

/// Store the token and say so. The confirmation names the server and nothing else — the
/// CLI never learns who the user is, and should not pretend to.
fn finish(out: &mut impl Write, config_path: &Path, server: &str, token: &str) -> Result<i32> {
    GlobalConfig {
        server: server.to_string(),
        token: Some(token.to_string()),
    }
    .save_to(config_path)?;

    writeln!(out, "logged in to {server}")?;
    Ok(0)
}

/// Open the listener, send the user to the server, and wait for the token to come back.
fn wait_for_token(
    out: &mut impl Write,
    server: &str,
    wait: Duration,
    open: impl Fn(&str) -> Result<()>,
) -> Result<String> {
    // Port 0 asks the OS for a free port, which is then part of the URL the server needs
    // in order to redirect back here.
    let listener = Server::http((LOOPBACK, 0))
        .map_err(|err| anyhow!("{err}"))
        .context("opening a local port for the login callback")?;
    let port = listener
        .server_addr()
        .to_ip()
        .ok_or_else(|| anyhow!("the login listener did not get a port"))?
        .port();

    let state = random_state();
    let url = auth_url(server, port, &state);

    // Printed before the browser is opened, and printed whether or not one opens: on a
    // remote machine this line is the whole flow.
    writeln!(out, "finish signing in here:\n  {url}")?;
    out.flush()?;
    if let Err(err) = open(&url) {
        writeln!(
            out,
            "(no browser opened — {err:#} — so open that URL yourself)"
        )?;
        out.flush()?;
    }

    listen(&listener, &state, wait)
}

/// Answer everything that knocks, and return only the token meant for this terminal.
fn listen(listener: &Server, state: &str, wait: Duration) -> Result<String> {
    let deadline = Instant::now() + wait;

    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            bail!(
                "timed out after {wait:?} waiting for the browser to come back; \
                 if this machine has no browser, run `artef login --token art_live_…`"
            );
        }

        // Blocks until a request arrives or the time runs out — no polling.
        let Some(request) = listener
            .recv_timeout(left)
            .context("waiting for the browser to come back")?
        else {
            // The wait ran out; the check at the top of the loop is what says so.
            continue;
        };

        match read_callback(request.url(), state) {
            Callback::Token(token) => {
                // A browser that never sees the page is a browser left spinning, so the
                // reply goes out before the token is used for anything.
                let _ = request.respond(page(200, "Logged in — you can close this tab."));
                return Ok(token);
            }
            Callback::WrongState => {
                let _ = request.respond(page(
                    400,
                    "That sign-in belongs to a different terminal. Nothing was saved.",
                ));
            }
            Callback::NoToken => {
                let _ = request.respond(page(400, "That sign-in carried no token."));
                bail!("the server's callback carried no token");
            }
            Callback::NotOurs => {
                let _ = request.respond(page(404, "Nothing here."));
            }
        }
    }
}

/// Read one request to the listener: is it our callback, and what did it bring?
fn read_callback(raw_url: &str, state: &str) -> Callback {
    let Ok(url) = Url::parse(&format!("http://{LOOPBACK}/")).and_then(|base| base.join(raw_url))
    else {
        return Callback::NotOurs;
    };
    if url.path() != "/callback" {
        return Callback::NotOurs;
    }

    let mut token = None;
    let mut carried_state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "token" => token = Some(value.into_owned()),
            "state" => carried_state = Some(value.into_owned()),
            _ => {}
        }
    }

    if carried_state.as_deref() != Some(state) {
        return Callback::WrongState;
    }
    match token {
        Some(token) if !token.is_empty() => Callback::Token(token),
        _ => Callback::NoToken,
    }
}

/// Where the user signs in: `{server}/cli/auth?port=…&state=…` (spec §7.2).
fn auth_url(server: &str, port: u16, state: &str) -> String {
    format!(
        "{}/cli/auth?port={port}&state={state}",
        server.trim_end_matches('/')
    )
}

/// The nonce that ties a callback to this terminal. base64url, so it needs no escaping
/// in the URL it travels in.
fn random_state() -> String {
    let mut bytes = [0u8; STATE_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// One sentence in a browser tab. Whoever is reading it is done with this window.
fn page(status: u16, message: &str) -> Response<Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
        .expect("a constant header");

    Response::from_string(format!(
        "<!doctype html>\n<meta charset=\"utf-8\">\n<title>artef</title>\n<p>{message}\n"
    ))
    .with_status_code(status)
    .with_header(header)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use anyhow::anyhow;
    use tokio::task::JoinHandle;
    use url::Url;

    use super::*;

    const SERVER: &str = "https://artef.example.com";

    /// The browser flow running on a thread of its own, plus the URL it told the user to
    /// open. Holding the handle lets a test play the browser and then read the outcome.
    struct Flow {
        url: String,
        task: JoinHandle<(Result<i32>, Vec<u8>)>,
    }

    /// Start the flow with the browser replaced by a channel, so the test sees the URL
    /// instead of a window opening.
    async fn start(config_path: PathBuf, wait: Duration) -> Flow {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::task::spawn_blocking(move || {
            let mut out = Vec::new();
            let outcome = login_with_browser(&mut out, &config_path, SERVER, wait, |url| {
                let _ = tx.send(url.to_string());
                Ok(())
            });
            (outcome, out)
        });

        let url = rx
            .recv()
            .await
            .expect("the flow shows a URL before it starts waiting");
        Flow { url, task }
    }

    fn port_and_state(url: &str) -> (u16, String) {
        let url = Url::parse(url).expect("the URL the CLI shows is a URL");
        let mut port = None;
        let mut state = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "port" => port = value.parse().ok(),
                "state" => state = Some(value.to_string()),
                _ => {}
            }
        }
        (
            port.expect("the URL carries a port"),
            state.expect("the URL carries a state"),
        )
    }

    /// One request to the loopback listener, as the browser would make it.
    async fn get(port: u16, rest: &str) -> (u16, String) {
        let response = reqwest::get(format!("http://127.0.0.1:{port}/{rest}"))
            .await
            .expect("the loopback listener answers");
        let status = response.status().as_u16();
        (status, response.text().await.expect("a body"))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_browser_hands_the_token_back_through_the_loopback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");

        let flow = start(path.clone(), Duration::from_secs(30)).await;
        let (port, state) = port_and_state(&flow.url);
        assert_eq!(
            flow.url,
            format!("{SERVER}/cli/auth?port={port}&state={state}")
        );

        // Stray traffic on the port is not the callback, and does not end the wait.
        assert_eq!(get(port, "favicon.ico").await.0, 404);
        // Neither is a callback carrying some other terminal's state.
        assert_eq!(
            get(port, "callback?token=art_live_wrong&state=someone-else")
                .await
                .0,
            400
        );

        let (status, body) = get(
            port,
            &format!("callback?token=art_live_right&state={state}"),
        )
        .await;
        assert_eq!(status, 200);
        assert!(body.contains("you can close this tab"), "body was {body}");

        let (outcome, printed) = flow.task.await.expect("the flow finished");
        assert_eq!(outcome.unwrap(), 0);

        let saved = std::fs::read_to_string(&path).expect("a config file");
        assert!(saved.contains("art_live_right"), "config was {saved}");
        assert!(!saved.contains("art_live_wrong"), "config was {saved}");
        assert!(saved.contains(SERVER), "config was {saved}");

        let printed = String::from_utf8(printed).unwrap();
        assert!(printed.contains(&flow.url), "printed {printed}");
        assert!(
            printed.contains(&format!("logged in to {SERVER}")),
            "printed {printed}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_browser_that_never_comes_back_times_out_and_saves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");

        let flow = start(path.clone(), Duration::from_millis(50)).await;

        let err = flow.task.await.expect("the flow finished").0.unwrap_err();
        assert!(
            format!("{err:#}").contains("timed out"),
            "error was {err:#}"
        );
        assert!(!path.exists(), "a timed-out login wrote a config file");
    }

    #[test]
    fn a_browser_that_will_not_open_leaves_the_url_on_screen() {
        let dir = tempfile::tempdir().unwrap();
        let mut out = Vec::new();

        let outcome = login_with_browser(
            &mut out,
            &dir.path().join("config.toml"),
            SERVER,
            Duration::from_millis(50),
            |_| Err(anyhow!("no browser here")),
        );

        assert!(outcome.is_err(), "the wait should still have timed out");
        let printed = String::from_utf8(out).unwrap();
        assert!(printed.contains("/cli/auth?port="), "printed {printed}");
        assert!(printed.contains("no browser here"), "printed {printed}");
    }

    #[test]
    fn the_state_is_32_url_safe_characters_and_never_the_same_twice() {
        let state = random_state();

        assert_eq!(state.chars().count(), 32);
        assert!(
            state
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "state was {state}"
        );
        assert_ne!(state, random_state());
    }

    #[test]
    fn only_a_callback_carrying_this_terminals_state_counts() {
        assert!(matches!(
            read_callback("/callback?token=art_live_x&state=abc", "abc"),
            Callback::Token(token) if token == "art_live_x"
        ));
        assert!(matches!(
            read_callback("/callback?token=art_live_x&state=nope", "abc"),
            Callback::WrongState
        ));
        assert!(matches!(
            read_callback("/callback?token=art_live_x", "abc"),
            Callback::WrongState
        ));
        assert!(matches!(
            read_callback("/callback?state=abc", "abc"),
            Callback::NoToken
        ));
        assert!(matches!(
            read_callback("/favicon.ico", "abc"),
            Callback::NotOurs
        ));
        assert!(matches!(
            read_callback("/callback/extra?token=t&state=abc", "abc"),
            Callback::NotOurs
        ));
    }

    #[test]
    fn the_auth_url_survives_a_trailing_slash_on_the_server() {
        assert_eq!(
            auth_url("https://a.co/", 1234, "st"),
            "https://a.co/cli/auth?port=1234&state=st"
        );
        assert_eq!(
            auth_url("https://a.co", 1234, "st"),
            "https://a.co/cli/auth?port=1234&state=st"
        );
    }
}
