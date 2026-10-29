use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

use cyberos_monitoring_contracts::SamplingIntervals;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;

use crate::domain::config::{MonitorConfig, MonitoringConfig};
use crate::error::MonitorError;

const MIB: u64 = 1024 * 1024;
const DAY_SECONDS: u64 = 24 * 60 * 60;

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

impl MonitorConfig {
    pub fn load() -> Result<Self, MonitorError> {
        Self::load_from(&env::vars().collect(), env::current_dir()?)
    }

    fn load_from(
        environment: &HashMap<String, String>,
        current_dir: PathBuf,
    ) -> Result<Self, MonitorError> {
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
            return Err(MonitorError::Config(
                "CYBEROS_ROOT must be an absolute path".to_owned(),
            ));
        }
        if production && root_dir != std::path::Path::new("/cyberos") {
            return Err(MonitorError::Config(
                "production CyberOS root must be /cyberos".to_owned(),
            ));
        }
        let state_dir = root_dir.join("state");
        let database_path = state_dir.join("cyberos.sqlite");
        let monitoring = load_monitoring_settings(&database_path)?;
        Ok(Self {
            data_root: root_dir.join("data"),
            database_path,
            metrics_database_path: state_dir.join("metrics.sqlite"),
            state_dir,
            root_dir,
            monitoring,
        })
    }

    pub(crate) fn refresh_monitoring(&self) -> Result<MonitoringConfig, MonitorError> {
        load_monitoring_settings(&self.database_path)
    }

    #[cfg(test)]
    pub(crate) fn for_test(root: &Path) -> Self {
        let state_dir = root.join("state");
        Self {
            root_dir: root.to_path_buf(),
            data_root: root.join("data"),
            database_path: state_dir.join("cyberos.sqlite"),
            metrics_database_path: state_dir.join("metrics.sqlite"),
            state_dir,
            monitoring: MonitoringConfig::default(),
        }
    }
}

fn load_monitoring_settings(path: &Path) -> Result<MonitoringConfig, MonitorError> {
    if !path.exists() {
        return Ok(MonitoringConfig::default());
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
        return Ok(MonitoringConfig::default());
    };
    let stored: StoredMonitoringSettings = serde_json::from_str(&value).map_err(|error| {
        MonitorError::Config(format!("monitoring settings are invalid: {error}"))
    })?;
    if stored.updated_at.trim().is_empty() {
        return Err(config_error("updatedAt"));
    }
    let config = MonitoringConfig {
        enabled: stored.enabled,
        sampling: SamplingIntervals::default(),
        raw_retention: days(stored.raw_retention_days, "rawRetentionDays")?,
        minute_retention: days(stored.minute_retention_days, "minuteRetentionDays")?,
        hour_retention: days(stored.hour_retention_days, "hourRetentionDays")?,
        max_database_bytes: stored.max_database_bytes,
    };
    validate_monitoring(&config)?;
    Ok(config)
}

fn days(value: u64, name: &str) -> Result<Duration, MonitorError> {
    value
        .checked_mul(DAY_SECONDS)
        .map(Duration::from_secs)
        .ok_or_else(|| config_error(name))
}

fn validate_monitoring(config: &MonitoringConfig) -> Result<(), MonitorError> {
    config
        .sampling
        .validate()
        .map_err(|error| config_error(error.field()))?;
    if config.raw_retention < Duration::from_secs(DAY_SECONDS)
        || config.minute_retention < config.raw_retention
        || config.hour_retention < config.minute_retention
        || !(16 * MIB..=16 * 1024 * MIB).contains(&config.max_database_bytes)
    {
        return Err(config_error("retention or database limit"));
    }
    Ok(())
}

fn config_error(name: &str) -> MonitorError {
    MonitorError::Config(format!("monitoring {name} is invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_paths_and_missing_setting_defaults() {
        let root = tempfile::tempdir().unwrap();
        let environment =
            HashMap::from([("CYBEROS_ROOT".to_owned(), root.path().display().to_string())]);
        let config = MonitorConfig::load_from(&environment, root.path().to_path_buf()).unwrap();
        assert_eq!(config.monitoring.sampling.fast, Duration::from_secs(10));
        assert_eq!(
            config.database_path,
            root.path().join("state/cyberos.sqlite")
        );
        assert_eq!(config.data_root, root.path().join("data"));
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
        assert!(load_monitoring_settings(&database).is_err());
    }

    #[test]
    fn production_rejects_a_nonstandard_root() {
        let environment = HashMap::from([
            ("CYBEROS_ENVIRONMENT".to_owned(), "production".to_owned()),
            ("CYBEROS_ROOT".to_owned(), "/isolated".to_owned()),
        ]);
        assert!(MonitorConfig::load_from(&environment, PathBuf::from("/workspace")).is_err());
    }
}
