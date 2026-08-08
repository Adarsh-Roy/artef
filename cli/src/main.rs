mod api;
mod commands;
mod config;
mod lint;
mod state;

use std::path::PathBuf;

use anyhow::{bail, Result};
use clap::{ArgGroup, Parser, Subcommand, ValueEnum};

use crate::config::GlobalConfig;

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
        /// Name to give a newly created artifact.
        #[arg(long)]
        name: Option<String>,
        /// Visibility to give a newly created artifact.
        #[arg(long, value_enum)]
        visibility: Option<Visibility>,
        /// Overwrite whatever the server has, even if someone else pushed since.
        #[arg(long)]
        force: bool,
        /// Upload without running the CSP check first.
        #[arg(long)]
        no_preflight: bool,
        /// Leave large inline images in the document instead of extracting them.
        #[arg(long)]
        no_extract: bool,
    },
    /// List artifacts.
    Ls,
    /// Share an artifact with a person, a workspace, or the public.
    #[command(group(ArgGroup::new("who").required(true).args(["public", "email"])))]
    Share {
        /// Artifact id, or a file path from .artef.json.
        target: String,
        /// Let anyone with the link view it.
        #[arg(long)]
        public: bool,
        /// Let one person in, by email address.
        #[arg(long)]
        email: Option<String>,
        /// What that person may do.
        #[arg(long, value_enum, default_value_t = Role::View)]
        role: Role,
    },
    /// Open an artifact in the browser.
    Open {
        /// Artifact id, or a file path from .artef.json.
        target: String,
    },
    /// Print an artifact's HTML to stdout.
    Pull {
        /// Artifact id, or a file path from .artef.json.
        target: String,
    },
    /// Delete an artifact.
    Rm {
        /// Artifact id, or a file path from .artef.json.
        target: String,
    },
    /// Regenerate and push a file on an interval.
    Watch {
        /// HTML file to watch.
        file: PathBuf,
    },
    /// Run every [[watch]] entry in artef.toml.
    Daemon,
}

/// Who can reach an artifact (spec §3).
#[derive(Debug, Clone, Copy, ValueEnum)]
enum Visibility {
    Private,
    Restricted,
    Workspace,
    Public,
}

impl Visibility {
    fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Restricted => "restricted",
            Self::Workspace => "workspace",
            Self::Public => "public",
        }
    }
}

/// What a person may do with an artifact. "update", never "edit": the role grants the
/// right to push new versions, not a text cursor (spec §5.9).
#[derive(Debug, Clone, Copy, ValueEnum)]
enum Role {
    View,
    Update,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Self::View => "view",
            Self::Update => "update",
        }
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("error: {err:#}");
            std::process::exit(1);
        }
    }
}

async fn run(cli: Cli) -> Result<i32> {
    match cli.command {
        Command::Lint { file } => commands::lint::run(&file),
        Command::Push {
            file,
            name,
            visibility,
            force,
            no_preflight,
            no_extract,
        } => {
            commands::push::run(
                &GlobalConfig::load()?,
                &commands::push::Options {
                    file: &file,
                    name: name.as_deref(),
                    visibility: visibility.map(Visibility::as_str),
                    force,
                    no_preflight,
                    no_extract,
                },
            )
            .await
        }
        Command::Ls => commands::ls::run(&GlobalConfig::load()?).await,
        Command::Share {
            target,
            public,
            email,
            role,
        } => {
            let mode = match email.as_deref() {
                Some(email) => commands::share::Mode::Person {
                    email,
                    role: role.as_str(),
                },
                // clap's argument group guarantees one of the two was given.
                None => {
                    debug_assert!(public);
                    commands::share::Mode::Public
                }
            };
            commands::share::run(&GlobalConfig::load()?, &target, &mode).await
        }
        Command::Open { target } => commands::open::run(&GlobalConfig::load()?, &target),
        Command::Pull { target } => commands::pull::run(&GlobalConfig::load()?, &target).await,
        Command::Rm { target } => commands::rm::run(&GlobalConfig::load()?, &target).await,
        Command::Login => bail!("not yet implemented"),
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

    #[tokio::test]
    async fn unimplemented_subcommands_report_that() {
        let cli = Cli::try_parse_from(["artef", "daemon"]).unwrap();
        let err = run(cli).await.unwrap_err();
        assert_eq!(err.to_string(), "not yet implemented");
    }

    #[test]
    fn share_insists_on_being_told_who() {
        assert!(Cli::try_parse_from(["artef", "share", "some-id"]).is_err());
        assert!(Cli::try_parse_from(["artef", "share", "some-id", "--public"]).is_ok());
        assert!(Cli::try_parse_from(["artef", "share", "some-id", "--email", "a@b.com"]).is_ok());
        // Two answers to one question is also no answer.
        assert!(Cli::try_parse_from([
            "artef", "share", "some-id", "--public", "--email", "a@b.com"
        ])
        .is_err());
    }

    #[test]
    fn push_flags_carry_the_names_the_spec_uses() {
        let cli = Cli::try_parse_from([
            "artef",
            "push",
            "q3.html",
            "--name",
            "Q3 Report",
            "--visibility",
            "workspace",
            "--force",
            "--no-preflight",
            "--no-extract",
        ])
        .unwrap();

        let Command::Push {
            file,
            name,
            visibility,
            force,
            no_preflight,
            no_extract,
        } = cli.command
        else {
            panic!("expected a push");
        };
        assert_eq!(file, PathBuf::from("q3.html"));
        assert_eq!(name.as_deref(), Some("Q3 Report"));
        assert_eq!(visibility.map(Visibility::as_str), Some("workspace"));
        assert!(force && no_preflight && no_extract);
    }
}
