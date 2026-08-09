pub mod lint;
pub mod login;
pub mod ls;
pub mod open;
pub mod pull;
pub mod push;
pub mod rm;
pub mod share;
pub mod skill;
pub mod watch;

use std::path::Path;

use anyhow::{bail, Result};

use crate::state::{Entry, State};

/// Turn a command-line `<id-or-file>` into an artifact id: a tracked file path first,
/// then anything shaped like an id.
///
/// Spec §7.3: `.artef.json` is what makes UUID-only URLs tolerable, so every command
/// that takes an id takes a tracked file path just as happily.
pub fn resolve_target(target: &str, state: &State) -> Result<String> {
    if let Some(entry) = state.artifacts.get(target) {
        return Ok(entry.id.clone());
    }
    if looks_like_id(target) {
        return Ok(target.to_string());
    }
    bail!("{target} is neither an artifact id nor a file in .artef.json — push it first")
}

/// The state key for a file: the path exactly as the user typed it (spec §7.3), so
/// `artef push ./status.html` and `artef push status.html` are two different keys but
/// each one keeps working.
pub fn state_key(file: &Path) -> String {
    file.to_string_lossy().into_owned()
}

/// Remember which artifact a file belongs to, and what we last pushed (spec §7.3).
pub fn track(state: &mut State, dir: &Path, key: &str, id: &str, hash: &str) -> Result<()> {
    let entry = Entry {
        id: id.to_string(),
        hash: hash.to_string(),
    };
    if state.artifacts.get(key) == Some(&entry) {
        return Ok(());
    }
    state.artifacts.insert(key.to_string(), entry);
    state.save(dir)
}

/// A v4 UUID, which is what an artifact id is (spec §3).
fn looks_like_id(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, width)| {
            group.len() == width && group.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Entry;

    const ID: &str = "8f14e45f-1111-2222-3333-444444444444";

    fn state_with(key: &str, id: &str) -> State {
        let mut state = State::default();
        state.artifacts.insert(
            key.to_string(),
            Entry {
                id: id.to_string(),
                hash: "abc".to_string(),
            },
        );
        state
    }

    #[test]
    fn an_id_is_taken_as_an_id() {
        assert!(looks_like_id(ID));
        assert!(looks_like_id("8F14E45F-1111-2222-3333-444444444444"));
        assert!(!looks_like_id("status.html"));
        assert!(!looks_like_id("8f14e45f-1111-2222-3333-4444444444"));
        assert!(!looks_like_id("8f14e45g-1111-2222-3333-444444444444"));
        assert!(!looks_like_id(""));

        assert_eq!(resolve_target(ID, &State::default()).unwrap(), ID);
    }

    #[test]
    fn a_tracked_file_resolves_to_the_artifact_it_was_pushed_to() {
        let state = state_with("reports/q3.html", ID);
        assert_eq!(resolve_target("reports/q3.html", &state).unwrap(), ID);
    }

    #[test]
    fn the_state_key_is_the_path_as_typed() {
        assert_eq!(state_key(Path::new("reports/q3.html")), "reports/q3.html");
        assert_eq!(state_key(Path::new("./q3.html")), "./q3.html");
    }

    #[test]
    fn an_untracked_file_says_which_one_it_could_not_find() {
        let err = resolve_target("status.html", &State::default()).unwrap_err();
        assert!(
            format!("{err:#}").contains("status.html"),
            "error was {err:#}"
        );
    }
}
