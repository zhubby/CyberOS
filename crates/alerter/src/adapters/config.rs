use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

use cyberos_monitoring_contracts::SamplingIntervals;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;

use crate::domain::config::AlerterConfig;
use crate::error::AlerterError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMonitoringSettings {
    enabled: bool,
    raw_retention_days: u64,
    minute_retention_days: u64,
    hour_retention_days: u64,
    max_database_bytes: u64,
    updated_at: String,
}

impl AlerterConfig {
    pub fn load() -> Result<Self, AlerterError> {
        Self::load_from(&env::vars().collect(), env::current_dir()?)
    }

    fn load_from(
        environment: &HashMap<String, String>,
        current_dir: PathBuf,
    ) -> Result<Self, AlerterError> {
        let production = environment
            .get("CYBEROS_ENVIRONMENT")
            .is_some_and(|value| value == "production");
        let root_dir = environment
            .get("CYBEROS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if production {
                    PathBuf::from("/cyberos")
                } else {
                    current_dir.join(".cyberos/dev-root")
                }
            });
        if !root_dir.is_absolute() {
            return Err(AlerterError::Config(
                "CYBEROS_ROOT must be an absolute path".to_owned(),
            ));
        }
        if production && root_dir != std::path::Path::new("/cyberos") {
            return Err(AlerterError::Config(
                "production CyberOS root must be /cyberos".to_owned(),
            ));
        }
        let state_dir = root_dir.join("state");
        let database_path = state_dir.join("cyberos.sqlite");
        let (monitoring_enabled, sampling) = load_monitoring(&database_path)?;
        Ok(Self {
            database_path,
            metrics_database_path: state_dir.join("metrics.sqlite"),
            monitoring_enabled,
            sampling,
        })
    }

    pub(crate) fn refresh_monitoring(&self) -> Result<(bool, SamplingIntervals), AlerterError> {
        load_monitoring(&self.database_path)
    }
}

fn load_monitoring(path: &Path) -> Result<(bool, SamplingIntervals), AlerterError> {
    if !path.exists() {
        return Ok((true, SamplingIntervals::default()));
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let value = connection
        .query_row(
            "SELECT value_json FROM system_settings WHERE key = 'monitoring_settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(value) = value else {
        return Ok((true, SamplingIntervals::default()));
    };
    let stored: StoredMonitoringSettings = serde_json::from_str(&value).map_err(|error| {
        AlerterError::Config(format!("monitoring settings are invalid: {error}"))
    })?;
    if stored.updated_at.trim().is_empty()
        || stored.raw_retention_days == 0
        || stored.minute_retention_days < stored.raw_retention_days
        || stored.hour_retention_days < stored.minute_retention_days
        || stored.max_database_bytes == 0
    {
        return Err(AlerterError::Config(
            "monitoring settings are invalid".to_owned(),
        ));
    }
    Ok((stored.enabled, SamplingIntervals::default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_paths_and_missing_setting_defaults() {
        let root = tempfile::tempdir().unwrap();
        let environment =
            HashMap::from([("CYBEROS_ROOT".to_owned(), root.path().display().to_string())]);
        let config = AlerterConfig::load_from(&environment, root.path().to_path_buf()).unwrap();
        assert!(config.monitoring_enabled);
        assert_eq!(config.sampling, SamplingIntervals::default());
        assert_eq!(
            config.database_path,
            root.path().join("state/cyberos.sqlite")
        );
    }

    #[test]
    fn rejects_corrupted_database_setting() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("state")).unwrap();
        let database = root.path().join("state/cyberos.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE system_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);\n\
                 INSERT INTO system_settings VALUES ('monitoring_settings', '{\"enabled\":true}', 'now');",
            )
            .unwrap();
        assert!(load_monitoring(&database).is_err());
    }

    #[test]
    fn production_rejects_a_nonstandard_root() {
        let environment = HashMap::from([
            ("CYBEROS_ENVIRONMENT".to_owned(), "production".to_owned()),
            ("CYBEROS_ROOT".to_owned(), "/isolated".to_owned()),
        ]);
        assert!(AlerterConfig::load_from(&environment, PathBuf::from("/workspace")).is_err());
    }
}
