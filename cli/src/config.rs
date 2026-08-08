//! Global CLI config: `~/.config/artef/config.toml` plus environment overrides (spec §7.3).

// `lint` is the only command wired up so far, and it talks to no server; the callers
// of this module are `login`, `push`, and the rest of the network commands.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

/// Server used when neither the config file nor the environment names one.
pub const DEFAULT_SERVER: &str = "http://localhost:8080";

const SERVER_ENV: &str = "ARTEF_SERVER";
const TOKEN_ENV: &str = "ARTEF_TOKEN";

/// Where the config file lives: `~/.config/artef/config.toml` (spec §7.3), or the
/// platform config directory on Windows.
pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("artef").join("config.toml"))
}

fn config_dir() -> Result<PathBuf> {
    if let Some(dir) = non_empty_env("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(dir));
    }
    let dir = if cfg!(windows) {
        dirs::config_dir()
    } else {
        dirs::home_dir().map(|home| home.join(".config"))
    };
    dir.ok_or_else(|| anyhow!("cannot find a home directory to store the artef config in"))
}

fn non_empty_env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Some(value.trim().to_string()),
        _ => None,
    }
}

/// Resolved settings: config file first, environment second (environment wins).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalConfig {
    pub server: String,
    pub token: Option<String>,
}

/// The file on disk. Both keys are optional so a partial file still loads.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ConfigFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
}

impl GlobalConfig {
    pub fn load() -> Result<Self> {
        Self::load_from(&config_path()?)
    }

    pub fn save(&self) -> Result<()> {
        self.save_to(&config_path()?)
    }

    fn load_from(path: &Path) -> Result<Self> {
        let file = match std::fs::read_to_string(path) {
            Ok(raw) => toml::from_str::<ConfigFile>(&raw)
                .with_context(|| format!("reading {}", path.display()))?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => ConfigFile::default(),
            Err(err) => {
                return Err(err).with_context(|| format!("reading {}", path.display()));
            }
        };

        Ok(Self {
            server: non_empty_env(SERVER_ENV)
                .or(file.server)
                .unwrap_or_else(|| DEFAULT_SERVER.to_string()),
            token: non_empty_env(TOKEN_ENV).or(file.token),
        })
    }

    fn save_to(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let body = toml::to_string_pretty(&ConfigFile {
            server: Some(self.server.clone()),
            token: self.token.clone(),
        })?;
        std::fs::write(path, body).with_context(|| format!("writing {}", path.display()))?;
        restrict_permissions(path)
    }
}

/// The file holds a machine token, so keep it owner-only.
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("setting permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, MutexGuard};

    use super::*;

    // ARTEF_SERVER / ARTEF_TOKEN are process-wide, so these tests take turns.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn env_guard() -> MutexGuard<'static, ()> {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("ARTEF_SERVER");
        std::env::remove_var("ARTEF_TOKEN");
        guard
    }

    fn write_config(dir: &tempfile::TempDir, body: &str) -> PathBuf {
        let path = dir.path().join("config.toml");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn the_environment_wins_over_the_file() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            &dir,
            "server = \"https://from-file.example.com\"\ntoken = \"art_live_file\"\n",
        );
        std::env::set_var("ARTEF_SERVER", "https://from-env.example.com");
        std::env::set_var("ARTEF_TOKEN", "art_live_env");

        let cfg = GlobalConfig::load_from(&path).unwrap();

        assert_eq!(cfg.server, "https://from-env.example.com");
        assert_eq!(cfg.token.as_deref(), Some("art_live_env"));
    }

    #[test]
    fn the_file_is_used_when_the_environment_is_empty() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            &dir,
            "server = \"https://artef.company.com\"\ntoken = \"art_live_xxxxxxxx\"\n",
        );

        let cfg = GlobalConfig::load_from(&path).unwrap();

        assert_eq!(cfg.server, "https://artef.company.com");
        assert_eq!(cfg.token.as_deref(), Some("art_live_xxxxxxxx"));
    }

    #[test]
    fn each_setting_falls_back_on_its_own() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            &dir,
            "server = \"https://artef.company.com\"\ntoken = \"art_live_file\"\n",
        );
        std::env::set_var("ARTEF_TOKEN", "art_live_env");

        let cfg = GlobalConfig::load_from(&path).unwrap();

        assert_eq!(cfg.server, "https://artef.company.com");
        assert_eq!(cfg.token.as_deref(), Some("art_live_env"));
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();

        let cfg = GlobalConfig::load_from(&dir.path().join("nope.toml")).unwrap();

        assert_eq!(cfg.server, DEFAULT_SERVER);
        assert_eq!(cfg.token, None);
    }

    #[test]
    fn an_unparsable_file_is_an_error_naming_the_file() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(&dir, "server = not-a-toml-value");

        let err = GlobalConfig::load_from(&path).unwrap_err();
        assert!(
            format!("{err:#}").contains("config.toml"),
            "error was {err:#}"
        );
    }

    #[test]
    fn save_then_load_roundtrips() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.toml");
        let cfg = GlobalConfig {
            server: "https://artef.company.com".to_string(),
            token: Some("art_live_xxxxxxxx".to_string()),
        };

        cfg.save_to(&path).unwrap();

        assert_eq!(GlobalConfig::load_from(&path).unwrap(), cfg);
    }

    #[test]
    fn saving_without_a_token_leaves_it_unset() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let cfg = GlobalConfig {
            server: "https://artef.company.com".to_string(),
            token: None,
        };

        cfg.save_to(&path).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("token"), "file was {raw:?}");
        assert_eq!(GlobalConfig::load_from(&path).unwrap(), cfg);
    }

    #[cfg(unix)]
    #[test]
    fn the_saved_file_holds_a_token_so_it_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let cfg = GlobalConfig {
            server: "https://artef.company.com".to_string(),
            token: Some("art_live_xxxxxxxx".to_string()),
        };

        cfg.save_to(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "mode was {:o}", mode & 0o777);
    }

    #[test]
    fn the_config_file_lives_under_a_dot_config_style_directory() {
        let path = config_path().unwrap();
        assert!(
            path.ends_with("artef/config.toml"),
            "path was {}",
            path.display()
        );
    }
}
