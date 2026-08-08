//! `artef pull <id-or-file>` — print an artifact's HTML to stdout (spec §5.2, §7.2).

use std::io::Write;

use anyhow::{Context, Result};

use crate::api::ApiClient;
use crate::commands::resolve_target;
use crate::config::GlobalConfig;
use crate::state::State;

pub async fn run(config: &GlobalConfig, target: &str) -> Result<i32> {
    let dir = std::env::current_dir().context("finding the working directory")?;
    let id = resolve_target(target, &State::load(&dir)?)?;

    let html = ApiClient::from_config(config)?.get_content(&id).await?;

    // Written, not printed: `artef pull <id> > out.html` has to be the document and
    // nothing else, with no newline added to the end.
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(html.as_bytes())
        .context("writing the document to stdout")?;
    stdout.flush().context("writing the document to stdout")?;
    Ok(0)
}
