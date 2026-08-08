mod commands;
mod config;
mod lint;
mod state;

use std::path::PathBuf;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};

/// Push agent-generated HTML documents to an artef server.
#[derive(Debug, Parser)]
#[command(name = "artef", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Log in to an artef server and store a machine token.
    Login,
    /// Check a file against the artifact CSP without uploading it.
    Lint {
        /// HTML file to check.
        file: PathBuf,
    },
    /// Create or update an artifact from a file.
    Push {
        /// HTML file to upload.
        file: PathBuf,
    },
    /// List artifacts.
    Ls,
    /// Share an artifact with a person, a workspace, or the public.
    Share {
        /// Artifact id.
        id: String,
    },
    /// Open an artifact in the browser.
    Open {
        /// Artifact id.
        id: String,
    },
    /// Print an artifact's HTML to stdout.
    Pull {
        /// Artifact id.
        id: String,
    },
    /// Delete an artifact.
    Rm {
        /// Artifact id.
        id: String,
    },
    /// Regenerate and push a file on an interval.
    Watch {
        /// HTML file to watch.
        file: PathBuf,
    },
    /// Run every [[watch]] entry in artef.toml.
    Daemon,
}

fn main() {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("error: {err:#}");
            std::process::exit(1);
        }
    }
}

fn run(cli: Cli) -> Result<i32> {
    match cli.command {
        Command::Lint { file } => commands::lint::run(&file),
        Command::Login => bail!("not yet implemented"),
        Command::Push { .. } => bail!("not yet implemented"),
        Command::Ls => bail!("not yet implemented"),
        Command::Share { .. } => bail!("not yet implemented"),
        Command::Open { .. } => bail!("not yet implemented"),
        Command::Pull { .. } => bail!("not yet implemented"),
        Command::Rm { .. } => bail!("not yet implemented"),
        Command::Watch { .. } => bail!("not yet implemented"),
        Command::Daemon => bail!("not yet implemented"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn every_subcommand_from_spec_7_2_is_present() {
        let cmd = Cli::command();
        let names: Vec<&str> = cmd.get_subcommands().map(|s| s.get_name()).collect();
        for expected in [
            "login", "lint", "push", "ls", "share", "open", "pull", "rm", "watch", "daemon",
        ] {
            assert!(names.contains(&expected), "missing subcommand {expected}");
        }
    }

    #[test]
    fn unimplemented_subcommands_report_that() {
        let cli = Cli::try_parse_from(["artef", "ls"]).unwrap();
        let err = run(cli).unwrap_err();
        assert_eq!(err.to_string(), "not yet implemented");
    }
}
