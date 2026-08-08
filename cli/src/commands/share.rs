//! `artef share <id-or-file>` — the CLI half of the share dialog (spec §5.3, §7.2).

use anyhow::{Context, Result};

use crate::api::{self, ApiClient};
use crate::commands::resolve_target;
use crate::config::GlobalConfig;
use crate::state::State;

/// Who is being let in.
pub enum Mode<'a> {
    /// Anyone with the link (spec §5.9).
    Public,
    /// One person, by email, as a viewer or an editor.
    Person { email: &'a str, role: &'a str },
}

pub async fn run(config: &GlobalConfig, target: &str, mode: &Mode<'_>) -> Result<i32> {
    let dir = std::env::current_dir().context("finding the working directory")?;
    let id = resolve_target(target, &State::load(&dir)?)?;
    let api = ApiClient::from_config(config)?;
    let url = api::share_url(&config.server, &id);

    match mode {
        Mode::Public => {
            api.patch(&id, None, Some("public")).await?;
            println!("anyone with the link can now view  {url}");
        }
        Mode::Person { email, role } => {
            api.grant(&id, email, role).await?;
            println!("{email} can now {role}  {url}");
        }
    }
    Ok(0)
}
