//! `artef skill install | status | uninstall` — the explicit face of the automatic
//! registration every other command does on its way past (spec §7.2b).

use std::io::Write;

use anyhow::Result;

use crate::skill_reg::{self, HarnessOutcome, Layout, Outcome, State};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Install or refresh, whatever the config file says about the automatic pass.
    Install,
    /// Say what is installed where. Changes nothing.
    Status,
    /// Take our registrations back out.
    Uninstall,
}

pub fn run(action: Action) -> Result<i32> {
    let layout = Layout::resolve()?;
    let mut out = std::io::stdout();

    match action {
        Action::Install => report_install(&mut out, &skill_reg::install(&layout)?)?,
        Action::Status => report_status(&mut out, &skill_reg::inspect(&layout)?)?,
        Action::Uninstall => report_uninstall(&mut out, &skill_reg::uninstall(&layout)?)?,
    }

    // A directory that isn't ours is reported, not treated as a failure: the command
    // did everything it was allowed to do.
    Ok(0)
}

fn report_install(out: &mut impl Write, outcome: &Outcome) -> Result<()> {
    writeln!(
        out,
        "skill: {} ({})",
        outcome.canonical.display(),
        if outcome.canonical_changed {
            "written"
        } else {
            "already current"
        }
    )?;
    for harness in &outcome.harnesses {
        writeln!(out, "{}: {}", harness.name, installed_as(harness))?;
    }
    Ok(())
}

fn installed_as(harness: &HarnessOutcome) -> String {
    match harness.state {
        State::NotDetected => "skipped, not detected".to_string(),
        State::Foreign => format!("skipped, {} is not ours", harness.target.display()),
        _ if harness.changed => "registered".to_string(),
        _ => "already registered".to_string(),
    }
}

fn report_status(out: &mut impl Write, outcome: &Outcome) -> Result<()> {
    writeln!(
        out,
        "skill: {} ({})",
        outcome.canonical.display(),
        if outcome.canonical_current {
            "up to date"
        } else if outcome.canonical.exists() {
            "out of date"
        } else {
            "not installed"
        }
    )?;
    for harness in &outcome.harnesses {
        writeln!(out, "{}: {}", harness.name, status_of(harness))?;
    }
    Ok(())
}

fn status_of(harness: &HarnessOutcome) -> String {
    match harness.state {
        State::NotDetected => "not detected".to_string(),
        State::NotRegistered => "not registered".to_string(),
        State::Registered => "registered".to_string(),
        State::Outdated => "out of date".to_string(),
        State::Foreign => format!("not ours, left alone: {}", harness.target.display()),
    }
}

fn report_uninstall(out: &mut impl Write, outcome: &Outcome) -> Result<()> {
    writeln!(
        out,
        "skill: {} ({})",
        outcome.canonical.display(),
        if outcome.canonical_changed {
            "removed"
        } else {
            "nothing to remove"
        }
    )?;
    for harness in &outcome.harnesses {
        let line = if harness.changed {
            "removed".to_string()
        } else if harness.state == State::Foreign {
            format!("not ours, left alone: {}", harness.target.display())
        } else {
            "nothing to remove".to_string()
        };
        writeln!(out, "{}: {line}", harness.name)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn harness(name: &'static str, state: State, changed: bool) -> HarnessOutcome {
        HarnessOutcome {
            name,
            target: PathBuf::from("/home/u")
                .join(name)
                .join("skills/artef-html"),
            state,
            changed,
        }
    }

    fn outcome(harnesses: Vec<HarnessOutcome>) -> Outcome {
        Outcome {
            canonical: PathBuf::from("/home/u/.config/artef/skills/artef-html"),
            canonical_changed: true,
            canonical_current: true,
            harnesses,
        }
    }

    fn rendered(f: impl Fn(&mut Vec<u8>, &Outcome) -> Result<()>, outcome: &Outcome) -> String {
        let mut out = Vec::new();
        f(&mut out, outcome).unwrap();
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn installing_says_what_happened_to_each_harness() {
        let text = rendered(
            report_install,
            &outcome(vec![
                harness("claude", State::Registered, true),
                harness("codex", State::NotDetected, false),
            ]),
        );

        assert!(text.contains("skill: /home/u/.config/artef/skills/artef-html (written)"));
        assert!(text.contains("claude: registered\n"), "was:\n{text}");
        assert!(
            text.contains("codex: skipped, not detected\n"),
            "was:\n{text}"
        );
    }

    #[test]
    fn installing_over_a_directory_that_is_not_ours_says_which_one() {
        let text = rendered(
            report_install,
            &outcome(vec![harness("claude", State::Foreign, false)]),
        );

        assert!(
            text.contains("claude: skipped, /home/u/claude/skills/artef-html is not ours"),
            "was:\n{text}"
        );
    }

    #[test]
    fn an_unchanged_harness_says_so_rather_than_claiming_work() {
        let text = rendered(
            report_install,
            &outcome(vec![harness("claude", State::Registered, false)]),
        );

        assert!(
            text.contains("claude: already registered\n"),
            "was:\n{text}"
        );
    }

    #[test]
    fn status_has_one_word_per_harness() {
        let text = rendered(
            report_status,
            &outcome(vec![
                harness("claude", State::Registered, false),
                harness("codex", State::NotRegistered, false),
            ]),
        );

        assert!(text.contains("(up to date)"), "was:\n{text}");
        assert!(text.contains("claude: registered\n"), "was:\n{text}");
        assert!(text.contains("codex: not registered\n"), "was:\n{text}");
    }

    #[test]
    fn uninstalling_distinguishes_what_it_removed_from_what_it_refused_to() {
        let text = rendered(
            report_uninstall,
            &outcome(vec![
                harness("claude", State::Registered, true),
                harness("codex", State::Foreign, false),
            ]),
        );

        assert!(text.contains("claude: removed\n"), "was:\n{text}");
        assert!(
            text.contains("codex: not ours, left alone: /home/u/codex/skills/artef-html"),
            "was:\n{text}"
        );
    }
}
