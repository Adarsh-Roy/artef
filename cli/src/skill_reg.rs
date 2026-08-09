//! Registering the agent skill with the harnesses on this machine (spec §7.2b).
//!
//! The skill only helps if it is installed where agents look, and nobody runs a manual
//! install step. So the binary carries the skill, keeps one canonical copy under
//! `~/.config/artef`, and points each harness it can see at that copy with a symlink.
//!
//! Two rules govern everything here, because this writes into the user's home
//! directory: a harness's config tree is never created (its absence means the harness
//! isn't installed), and anything at our target path that we did not put there is
//! never modified or removed — we warn and skip.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

use crate::config::{artef_dir, GlobalConfig};

/// The skill text, compiled in from the monorepo's `skill/SKILL.md`.
///
/// The path reaches outside this crate, so `cargo package` / `cargo publish` would
/// refuse it. That is fine — artef ships binaries built from the monorepo. If the CLI
/// ever goes to crates.io, the fix is a build script that copies `skill/SKILL.md` into
/// the crate before compiling.
pub const SKILL_MD: &str = include_str!("../../skill/SKILL.md");

/// The directory name the skill is registered under, in every harness and in ours.
const SKILL_DIR: &str = "artef-html";
/// The file every harness reads (the Agent Skills format).
const SKILL_FILE: &str = "SKILL.md";
/// Dropped inside a copied directory so a later run knows the copy is ours to update.
/// Symlinked installs don't need it — the link itself is the proof.
const MARKER: &str = ".artef-managed";
/// Turns the automatic pass off, for people who'd rather manage this themselves.
const DISABLE_ENV: &str = "ARTEF_NO_SKILL_INSTALL";

/// One harness we know how to register with. Adding another is one row: they all read
/// the same Agent Skills format, so only the paths differ.
struct Harness {
    /// What the user is told, e.g. "registered agent skill for claude".
    name: &'static str,
    /// Directory under `$HOME` whose existence means the harness is installed. We
    /// never create it.
    base: &'static str,
    /// Where that harness keeps skills, under `base`.
    skills: &'static str,
}

const HARNESSES: &[Harness] = &[
    Harness {
        name: "claude",
        base: ".claude",
        skills: "skills",
    },
    Harness {
        name: "codex",
        base: ".codex",
        skills: "skills",
    },
];

/// Where everything lives on this machine. Kept as data so tests can point the whole
/// thing at a temporary directory.
#[derive(Debug, Clone)]
pub struct Layout {
    /// The user's home, which the harness directories hang off.
    pub home: PathBuf,
    /// `~/.config/artef/skills/artef-html`, the one copy everything else points at.
    pub canonical: PathBuf,
}

impl Layout {
    pub fn resolve() -> Result<Self> {
        let home = dirs::home_dir()
            .ok_or_else(|| anyhow!("cannot find a home directory to install to"))?;
        Ok(Self {
            home,
            canonical: artef_dir()?.join("skills").join(SKILL_DIR),
        })
    }

    fn target(&self, harness: &Harness) -> PathBuf {
        self.home
            .join(harness.base)
            .join(harness.skills)
            .join(SKILL_DIR)
    }
}

/// What we found at a harness's target path — and, after an install, what is there now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// The harness isn't on this machine.
    NotDetected,
    /// The harness is here and the skill isn't registered with it.
    NotRegistered,
    /// Our symlink, or a copy of ours whose contents are current.
    Registered,
    /// A copy of ours whose contents are behind the binary's.
    Outdated,
    /// Something we didn't put there. Never touched.
    Foreign,
}

/// What one harness ended up as, and whether this pass changed anything.
#[derive(Debug, Clone)]
pub struct HarnessOutcome {
    pub name: &'static str,
    pub target: PathBuf,
    pub state: State,
    /// True when this pass created or refreshed the registration.
    pub changed: bool,
}

/// What a whole pass found or did.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub canonical: PathBuf,
    /// True when this pass wrote the canonical copy (first install, or an update).
    pub canonical_changed: bool,
    /// Whether the canonical copy matches the binary. Always true after an install.
    pub canonical_current: bool,
    pub harnesses: Vec<HarnessOutcome>,
}

impl Outcome {
    /// The harnesses this pass actually did something to.
    pub fn changed(&self) -> impl Iterator<Item = &HarnessOutcome> {
        self.harnesses.iter().filter(|h| h.changed)
    }

    /// Directories that are in our way and belong to someone else.
    pub fn foreign(&self) -> impl Iterator<Item = &HarnessOutcome> {
        self.harnesses.iter().filter(|h| h.state == State::Foreign)
    }
}

/// The opportunistic pass every command makes before it does its own work.
///
/// Cheap when there is nothing to do — a handful of stats and one read — silent unless
/// it changed something, and never fatal: a home directory we can't write to is not a
/// reason for `artef push` to fail.
pub fn run_auto() {
    if !autoinstall_wanted() {
        return;
    }
    let Ok(layout) = Layout::resolve() else {
        return;
    };
    match install(&layout) {
        Ok(outcome) => {
            for harness in outcome.foreign() {
                warn_foreign(&harness.target);
            }
            // One line, on stderr: stdout is data (`artef pull` writes a document there).
            for harness in outcome.changed() {
                eprintln!("registered agent skill for {}", harness.name);
            }
        }
        Err(err) => eprintln!("warning: could not register the agent skill: {err:#}"),
    }
}

/// `ARTEF_NO_SKILL_INSTALL=1`, or `skill_autoinstall = false` in the config file.
///
/// A config file we can't read leaves the automatic pass off: whatever command the user
/// ran is about to report that problem properly, and this is not the place to guess.
fn autoinstall_wanted() -> bool {
    match std::env::var(DISABLE_ENV) {
        Ok(value) if !matches!(value.trim(), "" | "0" | "false") => return false,
        _ => {}
    }
    GlobalConfig::load().is_ok_and(|config| config.skill_autoinstall)
}

fn warn_foreign(path: &Path) {
    eprintln!(
        "warning: {} is not ours, leaving it alone — the artef skill was not registered there",
        path.display()
    );
}

/// Write the canonical copy if it is missing or stale, then register it with every
/// harness this machine has.
pub fn install(layout: &Layout) -> Result<Outcome> {
    let canonical_changed = write_canonical(&layout.canonical)?;

    let mut harnesses = Vec::with_capacity(HARNESSES.len());
    for harness in HARNESSES {
        harnesses.push(register(layout, harness)?);
    }

    Ok(Outcome {
        canonical: layout.canonical.clone(),
        canonical_changed,
        canonical_current: true,
        harnesses,
    })
}

/// Look, change nothing.
pub fn inspect(layout: &Layout) -> Result<Outcome> {
    let harnesses = HARNESSES
        .iter()
        .map(|harness| {
            let target = layout.target(harness);
            HarnessOutcome {
                name: harness.name,
                state: look(layout, harness, &target),
                target,
                changed: false,
            }
        })
        .collect();

    Ok(Outcome {
        canonical: layout.canonical.clone(),
        canonical_changed: false,
        canonical_current: reads_as(&layout.canonical.join(SKILL_FILE), SKILL_MD),
        harnesses,
    })
}

/// Take our registrations back out: every harness link or managed copy, then the
/// canonical copy. Foreign directories are reported, never removed.
pub fn uninstall(layout: &Layout) -> Result<Outcome> {
    let mut harnesses = Vec::with_capacity(HARNESSES.len());
    for harness in HARNESSES {
        let target = layout.target(harness);
        let state = look(layout, harness, &target);
        let changed = match state {
            State::Registered | State::Outdated => remove(&target)
                .with_context(|| format!("removing {}", target.display()))
                .map(|()| true)?,
            _ => false,
        };
        harnesses.push(HarnessOutcome {
            name: harness.name,
            target,
            state,
            changed,
        });
    }

    let canonical_changed = layout.canonical.exists();
    if canonical_changed {
        std::fs::remove_dir_all(&layout.canonical)
            .with_context(|| format!("removing {}", layout.canonical.display()))?;
    }
    // The skills/ directory above it is ours too, but only if nothing else moved in.
    if let Some(parent) = layout.canonical.parent() {
        let _ = std::fs::remove_dir(parent);
    }

    Ok(Outcome {
        canonical: layout.canonical.clone(),
        canonical_changed,
        canonical_current: false,
        harnesses,
    })
}

/// Keep `~/.config/artef/skills/artef-html/SKILL.md` equal to what the binary carries.
/// Returns whether it had to write.
fn write_canonical(dir: &Path) -> Result<bool> {
    let file = dir.join(SKILL_FILE);
    if reads_as(&file, SKILL_MD) {
        return Ok(false);
    }
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    write_atomically(&file, SKILL_MD)?;
    Ok(true)
}

/// Point one harness at the canonical copy, unless something else is already there.
fn register(layout: &Layout, harness: &Harness) -> Result<HarnessOutcome> {
    let target = layout.target(harness);
    let mut outcome = HarnessOutcome {
        name: harness.name,
        state: look(layout, harness, &target),
        target,
        changed: false,
    };

    match outcome.state {
        // Not this machine's harness, or not ours to touch.
        State::NotDetected | State::Foreign | State::Registered => {}
        State::NotRegistered => {
            let parent = outcome
                .target
                .parent()
                .ok_or_else(|| anyhow!("{} has no parent", outcome.target.display()))?;
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
            link_or_copy(&layout.canonical, &outcome.target)?;
            outcome.state = State::Registered;
            outcome.changed = true;
        }
        // A copy we made on a machine that couldn't symlink, now out of date.
        State::Outdated => {
            write_copy(&outcome.target)?;
            outcome.state = State::Registered;
            outcome.changed = true;
        }
    }

    Ok(outcome)
}

/// What is at a harness's target path right now.
fn look(layout: &Layout, harness: &Harness, target: &Path) -> State {
    if !layout.home.join(harness.base).is_dir() {
        return State::NotDetected;
    }
    let Ok(meta) = std::fs::symlink_metadata(target) else {
        return State::NotRegistered;
    };
    if meta.is_symlink() {
        // Ours only if it lands on the canonical copy. A link to anywhere else is
        // somebody's deliberate arrangement, and not ours to redirect.
        return if same_dir(target, &layout.canonical) {
            State::Registered
        } else {
            State::Foreign
        };
    }
    if !meta.is_dir() || !target.join(MARKER).is_file() {
        return State::Foreign;
    }
    if reads_as(&target.join(SKILL_FILE), SKILL_MD) {
        State::Registered
    } else {
        State::Outdated
    }
}

/// A symlink where we can make one, a marked copy where we can't (Windows without the
/// privilege to link).
fn link_or_copy(canonical: &Path, target: &Path) -> Result<()> {
    match symlink_dir(canonical, target) {
        Ok(()) => Ok(()),
        // Linking needs a privilege on Windows that plenty of accounts don't have.
        Err(_) if cfg!(windows) => write_copy(target),
        Err(err) => Err(err)
            .with_context(|| format!("linking {} to {}", target.display(), canonical.display())),
    }
}

#[cfg(unix)]
fn symlink_dir(canonical: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(canonical, target)
}

#[cfg(windows)]
fn symlink_dir(canonical: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(canonical, target)
}

/// What the marker file says, for whoever finds it and wonders.
const MARKER_NOTE: &str = "This directory is managed by artef and is refreshed by the artef CLI.\nRemove it with `artef skill uninstall`.\n";

/// The fallback install: the skill plus the marker that says the directory is ours.
fn write_copy(target: &Path) -> Result<()> {
    std::fs::create_dir_all(target).with_context(|| format!("creating {}", target.display()))?;
    write_atomically(&target.join(SKILL_FILE), SKILL_MD)?;
    write_atomically(&target.join(MARKER), MARKER_NOTE)
}

/// Delete one of our registrations, whichever shape it took.
fn remove(target: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(target)?;
    if meta.is_symlink() {
        // On Windows a directory symlink is removed as a directory, not a file.
        return std::fs::remove_file(target)
            .or_else(|_| std::fs::remove_dir(target))
            .map_err(Into::into);
    }
    std::fs::remove_dir_all(target).map_err(Into::into)
}

/// Whether a file exists and already holds exactly this text.
fn reads_as(path: &Path, wanted: &str) -> bool {
    std::fs::read_to_string(path).is_ok_and(|found| found == wanted)
}

/// Whether two paths are the same directory once symlinks are followed. Falls back to
/// comparing the paths themselves when one of them isn't there — during `status` on a
/// machine that has never installed, that is the honest answer.
fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => std::fs::read_link(a).is_ok_and(|link| link == b),
    }
}

/// Write via a temporary file in the same directory, then rename over the target, so a
/// reader never sees half a skill.
fn write_atomically(path: &Path, contents: &str) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("skill"),
        std::process::id()
    ));

    std::fs::write(&temp, contents).with_context(|| format!("writing {}", temp.display()))?;
    if let Err(err) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(err).with_context(|| format!("writing {}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A machine with nothing on it: `$HOME` and the canonical copy both live in a
    /// temporary directory, so no test ever reads the developer's own `~/.claude`.
    fn machine() -> (tempfile::TempDir, Layout) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let canonical = home
            .join(".config")
            .join("artef")
            .join("skills")
            .join(SKILL_DIR);
        (dir, Layout { home, canonical })
    }

    fn with_harness(layout: &Layout, base: &str) {
        std::fs::create_dir_all(layout.home.join(base)).unwrap();
    }

    fn state_of(outcome: &Outcome, name: &str) -> State {
        outcome
            .harnesses
            .iter()
            .find(|h| h.name == name)
            .unwrap_or_else(|| panic!("no harness named {name}"))
            .state
    }

    fn target_of(outcome: &Outcome, name: &str) -> PathBuf {
        outcome
            .harnesses
            .iter()
            .find(|h| h.name == name)
            .unwrap()
            .target
            .clone()
    }

    #[test]
    fn the_embedded_skill_is_the_one_from_the_repository() {
        assert!(
            SKILL_MD.contains("name: artef-html"),
            "the embedded skill has no artef-html frontmatter"
        );
        assert!(SKILL_MD.starts_with("---"), "the frontmatter is missing");
    }

    #[test]
    fn a_detected_harness_is_symlinked_and_an_absent_one_is_not_created() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");

        let outcome = install(&layout).unwrap();

        assert!(outcome.canonical_changed);
        assert_eq!(
            std::fs::read_to_string(layout.canonical.join(SKILL_FILE)).unwrap(),
            SKILL_MD
        );
        assert_eq!(state_of(&outcome, "claude"), State::Registered);
        assert_eq!(state_of(&outcome, "codex"), State::NotDetected);

        let target = target_of(&outcome, "claude");
        assert!(std::fs::symlink_metadata(&target).unwrap().is_symlink());
        assert_eq!(
            std::fs::canonicalize(&target).unwrap(),
            std::fs::canonicalize(&layout.canonical).unwrap()
        );
        assert!(!layout.home.join(".codex").exists());
    }

    #[test]
    fn a_second_pass_changes_nothing() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");

        install(&layout).unwrap();
        let again = install(&layout).unwrap();

        assert!(!again.canonical_changed);
        assert_eq!(again.changed().count(), 0);
    }

    #[test]
    fn a_stale_canonical_copy_is_rewritten() {
        let (_dir, layout) = machine();
        std::fs::create_dir_all(&layout.canonical).unwrap();
        std::fs::write(layout.canonical.join(SKILL_FILE), "# stale").unwrap();

        let outcome = install(&layout).unwrap();

        assert!(outcome.canonical_changed);
        assert_eq!(
            std::fs::read_to_string(layout.canonical.join(SKILL_FILE)).unwrap(),
            SKILL_MD
        );
    }

    #[test]
    fn a_directory_that_is_not_ours_is_left_exactly_as_it_was() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");
        let foreign = layout.home.join(".claude").join("skills").join(SKILL_DIR);
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join(SKILL_FILE), "# theirs").unwrap();

        let outcome = install(&layout).unwrap();

        assert_eq!(state_of(&outcome, "claude"), State::Foreign);
        assert_eq!(outcome.foreign().count(), 1);
        assert_eq!(
            std::fs::read_to_string(foreign.join(SKILL_FILE)).unwrap(),
            "# theirs"
        );
        assert!(!foreign.join(MARKER).exists());
    }

    #[test]
    fn a_symlink_pointing_somewhere_else_is_not_ours_either() {
        let (dir, layout) = machine();
        with_harness(&layout, ".claude");
        let elsewhere = dir.path().join("someone-elses-skill");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let target = layout.home.join(".claude").join("skills").join(SKILL_DIR);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        symlink_dir(&elsewhere, &target).unwrap();

        let outcome = install(&layout).unwrap();

        assert_eq!(state_of(&outcome, "claude"), State::Foreign);
        assert_eq!(std::fs::read_link(&target).unwrap(), elsewhere);
    }

    #[test]
    fn a_plain_file_in_the_way_is_not_ours_either() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");
        let target = layout.home.join(".claude").join("skills").join(SKILL_DIR);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "not a directory").unwrap();

        let outcome = install(&layout).unwrap();

        assert_eq!(state_of(&outcome, "claude"), State::Foreign);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "not a directory");
    }

    #[test]
    fn a_copy_of_ours_is_refreshed_when_it_falls_behind() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");
        let target = layout.home.join(".claude").join("skills").join(SKILL_DIR);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join(SKILL_FILE), "# an older artef skill").unwrap();
        std::fs::write(target.join(MARKER), MARKER_NOTE).unwrap();

        let outcome = install(&layout).unwrap();

        assert_eq!(state_of(&outcome, "claude"), State::Registered);
        assert_eq!(outcome.changed().count(), 1);
        assert_eq!(
            std::fs::read_to_string(target.join(SKILL_FILE)).unwrap(),
            SKILL_MD
        );
        // Still a copy — we don't swap someone's working install out from under them.
        assert!(!std::fs::symlink_metadata(&target).unwrap().is_symlink());
    }

    #[test]
    fn a_current_copy_of_ours_is_left_alone() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");
        let target = layout.home.join(".claude").join("skills").join(SKILL_DIR);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join(SKILL_FILE), SKILL_MD).unwrap();
        std::fs::write(target.join(MARKER), MARKER_NOTE).unwrap();

        let outcome = install(&layout).unwrap();

        assert_eq!(state_of(&outcome, "claude"), State::Registered);
        assert_eq!(outcome.changed().count(), 0);
    }

    #[test]
    fn inspecting_reports_without_writing_anything() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");

        let outcome = inspect(&layout).unwrap();

        assert_eq!(state_of(&outcome, "claude"), State::NotRegistered);
        assert_eq!(state_of(&outcome, "codex"), State::NotDetected);
        assert!(!outcome.canonical_current);
        assert!(!layout.canonical.exists(), "inspecting wrote the skill");
        assert!(!layout.home.join(".claude").join("skills").exists());
    }

    #[test]
    fn inspecting_sees_a_canonical_copy_that_has_fallen_behind() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");
        install(&layout).unwrap();
        std::fs::write(layout.canonical.join(SKILL_FILE), "# stale").unwrap();

        let outcome = inspect(&layout).unwrap();

        assert!(!outcome.canonical_current);
        // The link is still ours, it just points at a copy that needs rewriting.
        assert_eq!(state_of(&outcome, "claude"), State::Registered);
    }

    #[test]
    fn uninstalling_takes_ours_out_and_leaves_theirs_in() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");
        with_harness(&layout, ".codex");
        let foreign = layout.home.join(".codex").join("skills").join(SKILL_DIR);
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join(SKILL_FILE), "# theirs").unwrap();

        install(&layout).unwrap();
        let outcome = uninstall(&layout).unwrap();

        let claude = layout.home.join(".claude").join("skills").join(SKILL_DIR);
        assert!(std::fs::symlink_metadata(&claude).is_err());
        assert!(!layout.canonical.exists());
        assert!(outcome.canonical_changed);
        assert_eq!(state_of(&outcome, "codex"), State::Foreign);
        assert_eq!(
            std::fs::read_to_string(foreign.join(SKILL_FILE)).unwrap(),
            "# theirs"
        );
    }

    #[test]
    fn uninstalling_removes_a_copy_of_ours_too() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");
        let target = layout.home.join(".claude").join("skills").join(SKILL_DIR);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join(SKILL_FILE), SKILL_MD).unwrap();
        std::fs::write(target.join(MARKER), MARKER_NOTE).unwrap();

        uninstall(&layout).unwrap();

        assert!(!target.exists());
    }

    #[test]
    fn uninstalling_a_machine_that_never_installed_is_not_an_error() {
        let (_dir, layout) = machine();
        with_harness(&layout, ".claude");

        let outcome = uninstall(&layout).unwrap();

        assert!(!outcome.canonical_changed);
        assert_eq!(outcome.changed().count(), 0);
    }

    #[test]
    fn writing_atomically_leaves_no_temporary_file_behind() {
        let (dir, _layout) = machine();
        let path = dir.path().join("SKILL.md");

        write_atomically(&path, "hello").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left {leftovers:?} behind");
    }
}
