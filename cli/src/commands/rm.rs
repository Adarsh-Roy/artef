//! `artef rm <id-or-file>` — delete an artifact (spec §5.1, §7.2).

use anyhow::{Context, Result};

use crate::api::{ApiClient, DeleteOutcome};
use crate::commands::resolve_target;
use crate::config::GlobalConfig;
use crate::state::State;

pub async fn run(config: &GlobalConfig, target: &str) -> Result<i32> {
    let dir = std::env::current_dir().context("finding the working directory")?;
    let mut state = State::load(&dir)?;
    let id = resolve_target(target, &state)?;

    let outcome = ApiClient::from_config(config)?.delete(&id).await?;

    // The artifact is gone, so every file that pointed at it stops pointing anywhere —
    // otherwise the next `artef push` would update an id the server no longer has.
    let before = state.artifacts.len();
    state.artifacts.retain(|_, entry| entry.id != id);
    if state.artifacts.len() != before {
        state.save(&dir)?;
    }

    match outcome {
        DeleteOutcome::Deleted => println!("removed {id}"),
        // A 404 means the server has nothing at that id — it was already deleted, or
        // it is not ours any more (§2.3: the API answers 404 rather than 403). Either
        // way the local entry is dead weight, and this command is the only way to
        // clear it without hand-editing `.artef.json`.
        DeleteOutcome::AlreadyGone => {
            println!("{id} was already gone on the server; removed from .artef.json");
        }
    }
    Ok(0)
}
