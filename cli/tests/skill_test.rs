//! End-to-end tests for skill auto-registration (spec §7.2b).
//!
//! Every run gets a throwaway `$HOME`, so the harness directories these tests create
//! and the symlinks the binary writes are all inside a temporary directory — the
//! developer's own `~/.claude` is never read or touched.

mod common;

use std::path::{Path, PathBuf};

use common::Cli;

/// The skill text the binary carries, read here the same way the binary reads it.
const EMBEDDED: &str = include_str!("../../skill/SKILL.md");

fn canonical(home: &Path) -> PathBuf {
    home.join(".config")
        .join("artef")
        .join("skills")
        .join("artef-html")
}

fn target(home: &Path, harness: &str) -> PathBuf {
    home.join(harness).join("skills").join("artef-html")
}

/// The one output line that starts with `prefix`, so `"claude: registered"` and
/// `"claude: not registered"` can't be confused for one another.
fn line(output: &str, prefix: &str) -> String {
    output
        .lines()
        .find(|l| l.starts_with(prefix))
        .unwrap_or_else(|| panic!("no {prefix:?} line in:\n{output}"))
        .to_string()
}

fn assert_registered(home: &Path, harness: &str) {
    let target = target(home, harness);
    let meta = std::fs::symlink_metadata(&target)
        .unwrap_or_else(|e| panic!("{} is not there: {e}", target.display()));
    assert!(meta.is_symlink(), "{} is not a symlink", target.display());
    assert_eq!(
        std::fs::canonicalize(&target).unwrap(),
        std::fs::canonicalize(canonical(home)).unwrap(),
        "{} points somewhere else",
        target.display()
    );
    assert_eq!(
        std::fs::read_to_string(target.join("SKILL.md")).unwrap(),
        EMBEDDED
    );
}

#[test]
fn a_machine_with_claude_and_no_codex_registers_the_skill_for_claude_only() {
    let cli = Cli::new();
    let home = cli.home();
    cli.mkdir_home(".claude");

    cli.run_unconfigured(&["skill", "install"]).ok();

    assert_eq!(
        std::fs::read_to_string(canonical(&home).join("SKILL.md")).unwrap(),
        EMBEDDED
    );
    assert_registered(&home, ".claude");
    assert!(
        !home.join(".codex").exists(),
        "a harness the machine doesn't have was created"
    );

    let status = cli.run_unconfigured(&["skill", "status"]);
    status.ok();
    assert_eq!(line(&status.stdout, "claude:"), "claude: registered");
    assert_eq!(line(&status.stdout, "codex:"), "codex: not detected");
    assert!(
        status
            .stdout
            .contains(&canonical(&home).display().to_string()),
        "status never says where the skill lives:\n{}",
        status.stdout
    );
}

#[test]
fn both_harnesses_get_a_symlink_when_both_are_installed() {
    let cli = Cli::new();
    let home = cli.home();
    cli.mkdir_home(".claude");
    cli.mkdir_home(".codex");

    cli.run_unconfigured(&["skill", "install"]).ok();

    assert_registered(&home, ".claude");
    assert_registered(&home, ".codex");

    let status = cli.run_unconfigured(&["skill", "status"]);
    assert_eq!(line(&status.stdout, "claude:"), "claude: registered");
    assert_eq!(line(&status.stdout, "codex:"), "codex: registered");
}

#[test]
fn status_reports_the_machine_without_changing_it() {
    let cli = Cli::new();
    let home = cli.home();
    cli.mkdir_home(".claude");

    let status = cli.run_unconfigured(&["skill", "status"]);
    status.ok();

    // Not even the automatic pass runs: asking what is installed installs nothing.
    assert!(!canonical(&home).exists(), "status wrote the skill");
    assert!(
        !home.join(".claude").join("skills").exists(),
        "status created a directory"
    );
    assert_eq!(line(&status.stdout, "claude:"), "claude: not registered");
    assert_eq!(line(&status.stdout, "codex:"), "codex: not detected");
    assert_eq!(status.stderr, "");
}

#[test]
fn an_out_of_date_canonical_copy_is_rewritten() {
    let cli = Cli::new();
    let home = cli.home();
    cli.mkdir_home(".claude");
    std::fs::create_dir_all(canonical(&home)).unwrap();
    std::fs::write(canonical(&home).join("SKILL.md"), "# stale\n").unwrap();

    cli.write("clean.html", "<p>hello</p>");
    cli.run_unconfigured(&["lint", "clean.html"]).ok();

    assert_eq!(
        std::fs::read_to_string(canonical(&home).join("SKILL.md")).unwrap(),
        EMBEDDED
    );
    assert_registered(&home, ".claude");
}

#[test]
fn an_ordinary_command_registers_the_skill_once_and_then_says_nothing() {
    let cli = Cli::new();
    let home = cli.home();
    cli.mkdir_home(".claude");
    cli.write("clean.html", "<p>hello</p>");

    let first = cli.run_unconfigured(&["lint", "clean.html"]);
    first.ok();
    assert_registered(&home, ".claude");
    assert!(
        first.stderr.contains("claude"),
        "installing said nothing:\n{}",
        first.stderr
    );
    assert_eq!(
        first.stderr.lines().count(),
        1,
        "installing should be one line, was:\n{}",
        first.stderr
    );
    assert!(
        !first.stdout.contains("skill"),
        "the notice leaked into stdout:\n{}",
        first.stdout
    );

    let second = cli.run_unconfigured(&["lint", "clean.html"]);
    second.ok();
    assert_eq!(second.stderr, "", "the second run was not silent");
}

#[test]
fn a_directory_that_is_not_ours_is_warned_about_and_left_alone() {
    let cli = Cli::new();
    let home = cli.home();
    let foreign = cli.mkdir_home(".claude/skills/artef-html");
    std::fs::write(foreign.join("SKILL.md"), "# someone else's skill\n").unwrap();
    cli.write("clean.html", "<p>hello</p>");

    let run = cli.run_unconfigured(&["lint", "clean.html"]);
    run.ok();

    assert_eq!(
        std::fs::read_to_string(foreign.join("SKILL.md")).unwrap(),
        "# someone else's skill\n",
        "we overwrote a directory that was not ours"
    );
    assert!(
        !foreign.join(".artef-managed").exists(),
        "we marked a directory that was not ours"
    );
    assert!(
        run.stderr.contains(&foreign.display().to_string()),
        "the warning never named the directory:\n{}",
        run.stderr
    );

    let status = cli.run_unconfigured(&["skill", "status"]);
    let claude = line(&status.stdout, "claude:");
    assert!(
        claude.contains("not ours"),
        "status hid the foreign directory: {claude}"
    );
    assert!(
        !home
            .join(".claude/skills/artef-html/.artef-managed")
            .exists(),
        "status touched the foreign directory"
    );
}

#[test]
fn the_environment_can_turn_auto_registration_off() {
    let cli = Cli::new();
    let home = cli.home();
    cli.mkdir_home(".claude");
    cli.write("clean.html", "<p>hello</p>");

    let run = cli.run_with_env(&["lint", "clean.html"], &[("ARTEF_NO_SKILL_INSTALL", "1")]);
    run.ok();

    assert!(!canonical(&home).exists(), "the canonical copy was written");
    assert!(
        !target(&home, ".claude").exists(),
        "claude was registered anyway"
    );
    assert_eq!(run.stderr, "");
}

#[test]
fn the_config_file_can_turn_auto_registration_off_without_disarming_the_command() {
    let cli = Cli::new();
    let home = cli.home();
    cli.mkdir_home(".claude");
    cli.mkdir_home(".config/artef");
    std::fs::write(
        home.join(".config/artef/config.toml"),
        "server = \"https://artef.example.com\"\nskill_autoinstall = false\n",
    )
    .unwrap();
    cli.write("clean.html", "<p>hello</p>");

    let run = cli.run_unconfigured(&["lint", "clean.html"]);
    run.ok();
    assert!(!canonical(&home).exists(), "the canonical copy was written");
    assert!(
        !target(&home, ".claude").exists(),
        "claude was registered anyway"
    );

    // Asking for it explicitly still works — the setting is about the automatic pass.
    cli.run_unconfigured(&["skill", "install"]).ok();
    assert_registered(&home, ".claude");
}

#[test]
fn uninstall_removes_what_we_made_and_nothing_else() {
    let cli = Cli::new();
    let home = cli.home();
    cli.mkdir_home(".claude");
    let foreign = cli.mkdir_home(".codex/skills/artef-html");
    std::fs::write(foreign.join("SKILL.md"), "# someone else's skill\n").unwrap();

    cli.run_unconfigured(&["skill", "install"]).ok();
    assert_registered(&home, ".claude");

    let run = cli.run_unconfigured(&["skill", "uninstall"]);
    run.ok();

    assert!(
        !target(&home, ".claude").exists()
            && std::fs::symlink_metadata(target(&home, ".claude")).is_err(),
        "the claude symlink is still there"
    );
    assert!(
        !canonical(&home).exists(),
        "the canonical copy is still there"
    );
    assert_eq!(
        std::fs::read_to_string(foreign.join("SKILL.md")).unwrap(),
        "# someone else's skill\n",
        "uninstall removed a directory that was not ours"
    );
}

#[test]
fn uninstall_does_not_reinstall_on_its_way_out() {
    let cli = Cli::new();
    let home = cli.home();
    cli.mkdir_home(".claude");

    let run = cli.run_unconfigured(&["skill", "uninstall"]);
    run.ok();

    assert!(!canonical(&home).exists(), "uninstall wrote the skill");
    assert!(
        !target(&home, ".claude").exists(),
        "uninstall registered the skill"
    );
}
