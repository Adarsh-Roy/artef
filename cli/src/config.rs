//! Global CLI config: `~/.config/artef/config.toml` plus environment overrides (spec §7.3).

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
    Ok(artef_dir()?.join("config.toml"))
}

/// Everything artef keeps for the user: `~/.config/artef`. The config file lives here,
/// and so does the canonical copy of the agent skill (spec §7.2b).
pub fn artef_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join("artef"))
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

/// The server the user has actually named — the environment first, then the file.
/// `None` means nobody has said which server to talk to.
///
/// Every other command falls back to [`DEFAULT_SERVER`], which is fine: the worst a
/// guess costs them is a failed request. `artef login` uses this instead, because a
/// guess there sends the user's browser — and the token it comes back with — to a
/// server they never named.
pub fn configured_server(path: &Path) -> Result<Option<String>> {
    let file = read_file(path)?;
    Ok(non_empty_env(SERVER_ENV)
        .or(file.server)
        .filter(|server| !server.trim().is_empty()))
}

/// Resolved settings: config file first, environment second (environment wins).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalConfig {
    pub server: String,
    pub token: Option<String>,
    /// Whether ordinary commands may register the agent skill on their way past
    /// (spec §7.2b). On unless the file says `skill_autoinstall = false`.
    pub skill_autoinstall: bool,
}

/// The file on disk. Every key is optional so a partial file still loads, and keys we
/// don't know about are ignored rather than refused.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ConfigFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skill_autoinstall: Option<bool>,
}

impl GlobalConfig {
    pub fn load() -> Result<Self> {
        Self::load_from(&config_path()?)
    }

    fn load_from(path: &Path) -> Result<Self> {
        let file = read_file(path)?;

        Ok(Self {
            server: non_empty_env(SERVER_ENV)
                .or(file.server)
                .unwrap_or_else(|| DEFAULT_SERVER.to_string()),
            token: non_empty_env(TOKEN_ENV).or(file.token),
            skill_autoinstall: file.skill_autoinstall.unwrap_or(true),
        })
    }

    /// Write the file. Writing it is `artef login`'s job; reading it is every other
    /// command's.
    ///
    /// Only the keys logging in owns — the server and the token — are written from
    /// `self`. The file is merged as a plain TOML table rather than through this
    /// struct, so every other key survives: the ones this version knows about, the
    /// ones a later version will add, and anything the user typed there by hand.
    pub fn save_to(&self, path: &Path) -> Result<()> {
        self.save_reporting_to(path, &mut std::io::stderr())
    }

    fn save_reporting_to(&self, path: &Path, warn: &mut impl std::io::Write) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }

        let mut table = existing_table(path, warn)?;
        table.insert("server".to_string(), self.server.clone().into());
        match &self.token {
            Some(token) => table.insert("token".to_string(), token.clone().into()),
            None => table.remove("token"),
        };

        let body = toml::to_string_pretty(&table)?;
        std::fs::write(path, body).with_context(|| format!("writing {}", path.display()))?;
        restrict_permissions(path)
    }
}

/// The file as a plain table, for merging into. A file that isn't there is an empty
/// table; a file we cannot parse is replaced, because refusing to log in over a broken
/// config would leave the user stuck — but never silently, so they can put back
/// whatever was in there.
fn existing_table(path: &Path, warn: &mut impl std::io::Write) -> Result<toml::Table> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(toml::Table::new()),
        Err(err) => return Err(err).with_context(|| format!("reading {}", path.display())),
    };
    match raw.parse::<toml::Table>() {
        Ok(table) => Ok(table),
        Err(err) => {
            writeln!(
                warn,
                "warning: {} is not valid TOML ({err}) — replacing it",
                path.display()
            )
            .ok();
            Ok(toml::Table::new())
        }
    }
}

/// The file as it is on disk. A file that isn't there reads as an empty one — a machine
/// that has never run `artef login` is not an error.
fn read_file(path: &Path) -> Result<ConfigFile> {
    match std::fs::read_to_string(path) {
        Ok(raw) => toml::from_str::<ConfigFile>(&raw)
            .with_context(|| format!("reading {}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(ConfigFile::default()),
        Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
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
            skill_autoinstall: true,
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
            skill_autoinstall: true,
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
            skill_autoinstall: true,
        };

        cfg.save_to(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "mode was {:o}", mode & 0o777);
    }

    #[test]
    fn nobody_naming_a_server_is_reported_as_nobody_naming_one() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();

        // Nothing anywhere: the caller has to be told, not given a default.
        assert_eq!(
            configured_server(&dir.path().join("nope.toml")).unwrap(),
            None
        );

        // A blank entry in the file is nobody naming one either.
        let blank = write_config(&dir, "server = \"  \"\n");
        assert_eq!(configured_server(&blank).unwrap(), None);

        let path = write_config(&dir, "server = \"https://from-file.example.com\"\n");
        assert_eq!(
            configured_server(&path).unwrap().as_deref(),
            Some("https://from-file.example.com")
        );

        std::env::set_var("ARTEF_SERVER", "https://from-env.example.com");
        assert_eq!(
            configured_server(&path).unwrap().as_deref(),
            Some("https://from-env.example.com")
        );
    }

    #[test]
    fn skill_autoinstall_is_on_unless_the_file_turns_it_off() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();

        // Nothing said: on (spec §7.2b).
        assert!(
            GlobalConfig::load_from(&dir.path().join("nope.toml"))
                .unwrap()
                .skill_autoinstall
        );
        let path = write_config(&dir, "server = \"https://artef.company.com\"\n");
        assert!(GlobalConfig::load_from(&path).unwrap().skill_autoinstall);

        let path = write_config(&dir, "skill_autoinstall = false\n");
        assert!(!GlobalConfig::load_from(&path).unwrap().skill_autoinstall);
    }

    #[test]
    fn a_key_we_do_not_know_does_not_stop_the_file_loading() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(&dir, "server = \"https://a.example.com\"\nfuture = 3\n");

        assert_eq!(
            GlobalConfig::load_from(&path).unwrap().server,
            "https://a.example.com"
        );
    }

    #[test]
    fn saving_keeps_keys_this_version_has_never_heard_of() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            &dir,
            "server = \"https://old.example.com\"\nfuture_flag = \"x\"\n\n[future_section]\nkey = 1\n",
        );

        let mut warnings = Vec::new();
        GlobalConfig {
            server: "https://new.example.com".to_string(),
            token: Some("art_live_xxxxxxxx".to_string()),
            skill_autoinstall: true,
        }
        .save_reporting_to(&path, &mut warnings)
        .unwrap();

        let saved: toml::Table = std::fs::read_to_string(&path).unwrap().parse().unwrap();
        assert_eq!(saved["future_flag"].as_str(), Some("x"));
        assert_eq!(saved["future_section"]["key"].as_integer(), Some(1));
        assert_eq!(saved["server"].as_str(), Some("https://new.example.com"));
        assert_eq!(saved["token"].as_str(), Some("art_live_xxxxxxxx"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn a_file_we_cannot_parse_is_replaced_out_loud() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(&dir, "server = not-a-toml-value\n");

        let mut warnings = Vec::new();
        GlobalConfig {
            server: "https://artef.company.com".to_string(),
            token: Some("art_live_xxxxxxxx".to_string()),
            skill_autoinstall: true,
        }
        .save_reporting_to(&path, &mut warnings)
        .unwrap();

        let warnings = String::from_utf8(warnings).unwrap();
        assert!(warnings.contains("config.toml"), "warning was {warnings:?}");
        assert!(
            warnings.contains("replacing it"),
            "warning was {warnings:?}"
        );
        // Logging in still worked: a broken file must not lock the user out.
        assert_eq!(
            GlobalConfig::load_from(&path).unwrap().token.as_deref(),
            Some("art_live_xxxxxxxx")
        );
    }

    #[test]
    fn saving_leaves_settings_logging_in_does_not_own_alone() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            &dir,
            "server = \"https://old.example.com\"\nskill_autoinstall = false\n",
        );

        GlobalConfig {
            server: "https://new.example.com".to_string(),
            token: Some("art_live_xxxxxxxx".to_string()),
            skill_autoinstall: true,
        }
        .save_to(&path)
        .unwrap();

        let saved = GlobalConfig::load_from(&path).unwrap();
        assert_eq!(saved.server, "https://new.example.com");
        assert_eq!(saved.token.as_deref(), Some("art_live_xxxxxxxx"));
        assert!(
            !saved.skill_autoinstall,
            "logging in wiped a setting it does not own"
        );
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
