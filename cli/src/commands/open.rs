//! `artef open <id-or-file>` — open the artifact in a browser (spec §5.7, §7.2).

use std::path::Path;

use anyhow::{Context, Result};

use crate::api;
use crate::commands::resolve_target;
use crate::config::GlobalConfig;
use crate::state::State;

pub fn run(config: &GlobalConfig, target: &str) -> Result<i32> {
    let dir = std::env::current_dir().context("finding the working directory")?;
    open_in(config, &dir, target, |url| {
        webbrowser::open(url).map(|_| ()).map_err(Into::into)
    })
}

/// The command with the browser handed in, so the URL it builds can be tested without
/// a window opening. `open` is the one command that talks to no server, so this is the
/// only way to see what it does.
fn open_in(
    config: &GlobalConfig,
    dir: &Path,
    target: &str,
    open: impl FnOnce(&str) -> Result<()>,
) -> Result<i32> {
    let id = resolve_target(target, &State::load(dir)?)?;
    // The shell page, not the raw document: `/a/:id` is what a person should land on.
    let url = api::viewer_url(&config.server, &id);

    open(&url).with_context(|| format!("opening {url}"))?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::state::{Entry, State};

    const ID: &str = "8f14e45f-1111-2222-3333-444444444444";

    fn config() -> GlobalConfig {
        GlobalConfig {
            server: "https://artef.company.com".to_string(),
            token: None,
        }
    }

    #[test]
    fn it_opens_the_viewer_page_for_an_id() {
        let dir = tempfile::tempdir().unwrap();
        let opened = RefCell::new(String::new());

        open_in(&config(), dir.path(), ID, |url| {
            opened.replace(url.to_string());
            Ok(())
        })
        .unwrap();

        assert_eq!(
            opened.into_inner(),
            format!("https://artef.company.com/a/{ID}")
        );
    }

    #[test]
    fn it_opens_the_artifact_a_tracked_file_belongs_to() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = State::default();
        state.artifacts.insert(
            "status.html".to_string(),
            Entry {
                id: ID.to_string(),
                hash: "abc".to_string(),
            },
        );
        state.save(dir.path()).unwrap();
        let opened = RefCell::new(String::new());

        open_in(&config(), dir.path(), "status.html", |url| {
            opened.replace(url.to_string());
            Ok(())
        })
        .unwrap();

        assert!(opened.into_inner().ends_with(&format!("/a/{ID}")));
    }

    #[test]
    fn a_browser_that_will_not_open_says_which_url_it_was() {
        let dir = tempfile::tempdir().unwrap();

        let err = open_in(&config(), dir.path(), ID, |_| {
            Err(anyhow::anyhow!("no browser here"))
        })
        .unwrap_err();

        assert!(format!("{err:#}").contains(ID), "error was {err:#}");
    }
}
