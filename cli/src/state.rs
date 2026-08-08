//! Local artifact state: `.artef.json` in the working directory (spec §7.3).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// File name, in whichever directory the CLI was run from.
pub const STATE_FILE: &str = ".artef.json";

/// One tracked file: which artifact it maps to, and the hash we last pushed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub hash: String,
}

/// Contents of `.artef.json`. Keys are file paths exactly as the user gave them.
///
/// The file is meant to be committed and hand-edited, so an empty object loads too.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub artifacts: BTreeMap<String, Entry>,
}

impl State {
    /// Path of the state file in `dir`.
    pub fn path(dir: &Path) -> PathBuf {
        dir.join(STATE_FILE)
    }

    /// Read the state file. A directory without one has no artifacts yet.
    pub fn load(dir: &Path) -> Result<Self> {
        let path = Self::path(dir);
        match std::fs::read_to_string(&path) {
            Ok(raw) => {
                serde_json::from_str(&raw).with_context(|| format!("reading {}", path.display()))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        let path = Self::path(dir);
        let mut body = serde_json::to_string_pretty(self)?;
        body.push('\n');
        std::fs::write(&path, body).with_context(|| format!("writing {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, hash: &str) -> Entry {
        Entry {
            id: id.to_string(),
            hash: hash.to_string(),
        }
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = State::default();
        state.artifacts.insert(
            "reports/q3.html".to_string(),
            entry("8f14e45f-1111-2222-3333-444444444444", "a3f5"),
        );
        state.artifacts.insert(
            "status.html".to_string(),
            entry("3c9a7b21-5555-6666-7777-888888888888", "9d02"),
        );

        state.save(dir.path()).unwrap();
        assert_eq!(State::load(dir.path()).unwrap(), state);
    }

    #[test]
    fn the_file_is_dot_artef_json_with_the_shape_from_the_spec() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = State::default();
        state.artifacts.insert(
            "reports/q3.html".to_string(),
            entry("8f14e45f-1111-2222-3333-444444444444", "a3f5"),
        );
        state.save(dir.path()).unwrap();

        let raw = std::fs::read_to_string(dir.path().join(".artef.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            json["artifacts"]["reports/q3.html"]["id"],
            "8f14e45f-1111-2222-3333-444444444444"
        );
        assert_eq!(json["artifacts"]["reports/q3.html"]["hash"], "a3f5");
    }

    #[test]
    fn loading_a_directory_without_state_gives_an_empty_state() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(State::load(dir.path()).unwrap(), State::default());
    }

    #[test]
    fn an_empty_state_file_loads_as_an_empty_state() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".artef.json"), "{}").unwrap();

        assert_eq!(State::load(dir.path()).unwrap(), State::default());
    }

    #[test]
    fn a_corrupt_state_file_is_an_error_naming_the_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".artef.json"), "{ not json").unwrap();

        let err = State::load(dir.path()).unwrap_err();
        assert!(
            format!("{err:#}").contains(".artef.json"),
            "error was {err:#}"
        );
    }
}
