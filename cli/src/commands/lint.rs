//! `artef lint <file>` — CSP preflight only, no upload (spec §7.1).

use std::path::Path;

use anyhow::{Context, Result};

use crate::lint::{lint_html, Severity, Violation};

/// Lint one file. Returns the process exit code: 1 if anything was rejected, else 0.
pub fn run(path: &Path) -> Result<i32> {
    let html =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let violations = lint_html(&html);

    for violation in &violations {
        println!("{}", format_violation(violation));
    }

    let rejected = violations
        .iter()
        .filter(|v| v.severity == Severity::Reject)
        .count();
    let warned = violations.len() - rejected;

    if rejected > 0 {
        println!(
            "\n{rejected} rejected, {warned} warned: this document would render broken under the artifact CSP"
        );
    } else if warned > 0 {
        println!("\n{warned} warned: this document is safe to push");
    } else {
        println!("{}: no CSP problems found", path.display());
    }

    Ok(exit_code(&violations))
}

/// One printable line per violation.
fn format_violation(v: &Violation) -> String {
    let prefix = match v.severity {
        Severity::Reject => "error",
        Severity::Warn => "warn",
    };
    format!("{prefix}: {} -- {}", v.what, v.detail)
}

/// 1 if the document would be refused by `artef push`, else 0.
fn exit_code(violations: &[Violation]) -> i32 {
    i32::from(violations.iter().any(|v| v.severity == Severity::Reject))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn violation(severity: Severity) -> Violation {
        Violation {
            severity,
            what: "<script src> https://x/a.js".to_string(),
            detail: "inline it or vendor it manually".to_string(),
        }
    }

    #[test]
    fn only_rejections_fail_the_lint() {
        assert_eq!(exit_code(&[]), 0);
        assert_eq!(exit_code(&[violation(Severity::Warn)]), 0);
        assert_eq!(exit_code(&[violation(Severity::Reject)]), 1);
        assert_eq!(
            exit_code(&[violation(Severity::Warn), violation(Severity::Reject)]),
            1
        );
    }

    #[test]
    fn rejections_print_as_errors_and_warnings_as_warnings() {
        let line = format_violation(&violation(Severity::Reject));
        assert!(line.starts_with("error: "), "line was {line:?}");
        assert!(line.contains("<script src> https://x/a.js"));
        assert!(line.contains("inline it or vendor it manually"));

        let line = format_violation(&violation(Severity::Warn));
        assert!(line.starts_with("warn: "), "line was {line:?}");
    }

    #[test]
    fn a_clean_file_exits_zero_and_a_rejected_one_exits_one() {
        let dir = tempfile::tempdir().unwrap();

        let clean = dir.path().join("clean.html");
        std::fs::write(&clean, "<p>hello</p><script>alert(1)</script>").unwrap();
        assert_eq!(run(&clean).unwrap(), 0);

        let warned = dir.path().join("warned.html");
        std::fs::write(&warned, "<script>fetch('/a')</script>").unwrap();
        assert_eq!(run(&warned).unwrap(), 0);

        let rejected = dir.path().join("rejected.html");
        std::fs::write(&rejected, r#"<script src="https://x/a.js"></script>"#).unwrap();
        assert_eq!(run(&rejected).unwrap(), 1);
    }

    #[test]
    fn a_missing_file_is_an_error_naming_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.html");

        let err = run(&missing).unwrap_err();
        assert!(
            format!("{err:#}").contains("nope.html"),
            "error was {err:#}"
        );
    }
}
