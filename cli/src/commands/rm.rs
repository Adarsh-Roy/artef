//! `artef rm <id-or-file>` — delete an artifact (spec §5.1, §7.2).

use anyhow::{Context, Result};

use crate::api::ApiClient;
use crate::commands::resolve_target;
use crate::config::GlobalConfig;
use crate::state::State;

pub async fn run(config: &GlobalConfig, target: &str) -> Result<i32> {
    let dir = std::env::current_dir().context("finding the working directory")?;
    let mut state = State::load(&dir)?;
    let id = resolve_target(target, &state)?;

    ApiClient::from_config(config)?.delete(&id).await?;

    // The artifact is gone, so every file that pointed at it stops pointing anywhere —
    // otherwise the next `artef push` would update an id the server no longer has.
    let before = state.artifacts.len();
    state.artifacts.retain(|_, entry| entry.id != id);
    if state.artifacts.len() != before {
        state.save(&dir)?;
    }

    println!("removed {id}");
    Ok(0)
}
