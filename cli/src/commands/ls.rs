//! `artef ls` — the flat list (spec §5.1, §7.2).

use anyhow::Result;

use crate::api::{ApiClient, ArtifactMeta};
use crate::config::GlobalConfig;

/// Shown instead of a name for artifacts that never got one.
const NO_NAME: &str = "—";

pub async fn run(config: &GlobalConfig) -> Result<i32> {
    let artifacts = ApiClient::from_config(config)?.list().await?;
    for line in rows(&artifacts) {
        println!("{line}");
    }
    Ok(0)
}

/// One line per artifact: the id prefix people paste, then name, visibility, version
/// and when it last changed. Columns are padded to the widest value so the list reads
/// as a table without needing a header.
fn rows(artifacts: &[ArtifactMeta]) -> Vec<String> {
    let names: Vec<&str> = artifacts
        .iter()
        .map(|a| match a.name.as_deref() {
            Some(name) if !name.trim().is_empty() => name,
            _ => NO_NAME,
        })
        .collect();

    let name_width = names.iter().map(|n| n.chars().count()).max().unwrap_or(0);
    let visibility_width = artifacts
        .iter()
        .map(|a| a.visibility.chars().count())
        .max()
        .unwrap_or(0);
    let version_width = artifacts
        .iter()
        .map(|a| format!("v{}", a.version).chars().count())
        .max()
        .unwrap_or(0);

    artifacts
        .iter()
        .zip(names)
        .map(|(artifact, name)| {
            format!(
                "{}  {}  {}  {}  {}",
                short_id(&artifact.id),
                pad(name, name_width),
                pad(&artifact.visibility, visibility_width),
                pad(&format!("v{}", artifact.version), version_width),
                artifact.updated_at,
            )
        })
        .collect()
}

/// The first eight characters of the id — enough to recognise, short enough to scan.
fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// Pad by characters, not bytes, so an em dash or an accented name stays aligned.
fn pad(value: &str, width: usize) -> String {
    let padding = width.saturating_sub(value.chars().count());
    format!("{value}{}", " ".repeat(padding))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, name: Option<&str>, visibility: &str, version: i64) -> ArtifactMeta {
        ArtifactMeta {
            id: id.to_string(),
            name: name.map(str::to_string),
            visibility: visibility.to_string(),
            version,
            updated_at: "2026-08-08T10:12:33.000Z".to_string(),
        }
    }

    #[test]
    fn every_column_is_there_and_the_id_is_shortened() {
        let rows = rows(&[meta(
            "8f14e45f-1111-2222-3333-444444444444",
            Some("Q3 infra report"),
            "workspace",
            3,
        )]);

        assert_eq!(
            rows,
            vec!["8f14e45f  Q3 infra report  workspace  v3  2026-08-08T10:12:33.000Z"]
        );
    }

    #[test]
    fn a_nameless_artifact_still_lines_up() {
        let rows = rows(&[
            meta("8f14e45f-1111-2222-3333-444444444444", None, "private", 1),
            meta(
                "3c9a7b21-5555-6666-7777-888888888888",
                Some("Status"),
                "workspace",
                12,
            ),
        ]);

        assert_eq!(
            rows,
            vec![
                "8f14e45f  —       private    v1   2026-08-08T10:12:33.000Z",
                "3c9a7b21  Status  workspace  v12  2026-08-08T10:12:33.000Z",
            ]
        );
    }

    #[test]
    fn a_blank_name_reads_as_no_name() {
        let rows = rows(&[meta(
            "8f14e45f-1111-2222-3333-444444444444",
            Some("   "),
            "private",
            1,
        )]);
        assert!(rows[0].contains(NO_NAME), "row was {:?}", rows[0]);
    }

    #[test]
    fn an_empty_workspace_prints_nothing() {
        assert!(rows(&[]).is_empty());
    }
}
