use std::env;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use cyberos_monitoring_contracts::SamplingIntervals;
use toml_edit::{DocumentMut, Item};

use crate::domain::config::{MonitorConfig, MonitoringConfig};
use crate::error::MonitorError;

const DEFAULT_CONFIG_PATH: &str = "/cyberos/config/config.toml";
const MIB: u64 = 1024 * 1024;

impl MonitorConfig {
    pub fn load() -> Result<Self, MonitorError> {
        Self::load_from(&env::vars().collect(), env::current_dir()?)
    }

    fn load_from(
        environment: &std::collections::HashMap<String, String>,
        current_dir: PathBuf,
    ) -> Result<Self, MonitorError> {
        let config_path = environment
            .get("CYBEROS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
        let document = if config_path.exists() {
            std::fs::read_to_string(&config_path)?
                .parse::<DocumentMut>()
                .map_err(|error| MonitorError::Config(format!("invalid CyberOS config: {error}")))?
        } else {
            DocumentMut::new()
        };
        let root_dir = environment
            .get("CYBEROS_ROOT")
            .map(PathBuf::from)
            .or_else(|| {
                document
                    .get("root_dir")
                    .and_then(Item::as_str)
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| current_dir.join(".cyberos/dev-root"));
        let state_dir = root_dir.join("state");
        let monitoring = monitoring_config(environment, &document)?;
        Ok(Self {
            data_root: root_dir.join("data"),
            database_path: state_dir.join("cyberos.sqlite"),
            metrics_database_path: state_dir.join("metrics.sqlite"),
            state_dir,
            root_dir,
            monitoring,
        })
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

fn monitoring_config(
    environment: &std::collections::HashMap<String, String>,
    document: &DocumentMut,
) -> Result<MonitoringConfig, MonitorError> {
    let defaults = MonitoringConfig::default();
    let table = document.get("monitoring").and_then(Item::as_table);
    let config = MonitoringConfig {
        enabled: boolean(
            environment
                .get("CYBEROS_MONITORING_ENABLED")
                .map(String::as_str),
            table
                .and_then(|value| value.get("enabled"))
                .and_then(Item::as_bool),
            defaults.enabled,
            "enabled",
        )?,
        sampling: SamplingIntervals {
            fast: milliseconds(
                environment
                    .get("CYBEROS_MONITORING_FAST_SAMPLE_INTERVAL_MS")
                    .map(String::as_str),
                table
                    .and_then(|value| value.get("fast_sample_interval_ms"))
                    .and_then(Item::as_integer),
                defaults.sampling.fast,
                "fast_sample_interval_ms",
            )?,
            standard: milliseconds(
                environment
                    .get("CYBEROS_MONITORING_STANDARD_SAMPLE_INTERVAL_MS")
                    .map(String::as_str),
                table
                    .and_then(|value| value.get("standard_sample_interval_ms"))
                    .and_then(Item::as_integer),
                defaults.sampling.standard,
                "standard_sample_interval_ms",
            )?,
            temperature: milliseconds(
                environment
                    .get("CYBEROS_MONITORING_TEMPERATURE_SAMPLE_INTERVAL_MS")
                    .map(String::as_str),
                table
                    .and_then(|value| value.get("temperature_sample_interval_ms"))
                    .and_then(Item::as_integer),
                defaults.sampling.temperature,
                "temperature_sample_interval_ms",
            )?,
        },
        raw_retention: milliseconds(
            environment
                .get("CYBEROS_MONITORING_RAW_RETENTION_MS")
                .map(String::as_str),
            table
                .and_then(|value| value.get("raw_retention_ms"))
                .and_then(Item::as_integer),
            defaults.raw_retention,
            "raw_retention_ms",
        )?,
        minute_retention: milliseconds(
            environment
                .get("CYBEROS_MONITORING_MINUTE_RETENTION_MS")
                .map(String::as_str),
            table
                .and_then(|value| value.get("minute_retention_ms"))
                .and_then(Item::as_integer),
            defaults.minute_retention,
            "minute_retention_ms",
        )?,
        hour_retention: milliseconds(
            environment
                .get("CYBEROS_MONITORING_HOUR_RETENTION_MS")
                .map(String::as_str),
            table
                .and_then(|value| value.get("hour_retention_ms"))
                .and_then(Item::as_integer),
            defaults.hour_retention,
            "hour_retention_ms",
        )?,
        max_database_bytes: integer(
            environment
                .get("CYBEROS_MONITORING_MAX_DATABASE_BYTES")
                .map(String::as_str),
            table
                .and_then(|value| value.get("max_database_bytes"))
                .and_then(Item::as_integer),
            defaults.max_database_bytes,
            "max_database_bytes",
        )?,
    };
    validate_monitoring(&config)?;
    Ok(config)
}

fn validate_monitoring(config: &MonitoringConfig) -> Result<(), MonitorError> {
    config
        .sampling
        .validate()
        .map_err(|error| config_error(error.field()))?;
    if config.raw_retention < Duration::from_secs(60 * 60) {
        return Err(config_error("raw_retention_ms"));
    }
    if config.minute_retention < config.raw_retention {
        return Err(config_error("minute_retention_ms"));
    }
    if config.hour_retention < config.minute_retention {
        return Err(config_error("hour_retention_ms"));
    }
    if !(64 * MIB..=4 * 1024 * MIB).contains(&config.max_database_bytes) {
        return Err(config_error("max_database_bytes"));
    }
    Ok(())
}

fn boolean(
    environment: Option<&str>,
    configured: Option<bool>,
    fallback: bool,
    name: &str,
) -> Result<bool, MonitorError> {
    match environment {
        Some("1" | "true" | "TRUE") => Ok(true),
        Some("0" | "false" | "FALSE") => Ok(false),
        Some(_) => Err(config_error(name)),
        None => Ok(configured.unwrap_or(fallback)),
    }
}

fn milliseconds(
    environment: Option<&str>,
    configured: Option<i64>,
    fallback: Duration,
    name: &str,
) -> Result<Duration, MonitorError> {
    Ok(Duration::from_millis(integer(
        environment,
        configured,
        u64::try_from(fallback.as_millis()).unwrap_or(u64::MAX),
        name,
    )?))
}

fn integer(
    environment: Option<&str>,
    configured: Option<i64>,
    fallback: u64,
    name: &str,
) -> Result<u64, MonitorError> {
    let value = match environment {
        Some(value) => value.parse::<u64>().map_err(|_| config_error(name))?,
        None => configured
            .and_then(|value| u64::try_from(value).ok())
            .unwrap_or(fallback),
    };
    if value == 0 {
        return Err(config_error(name));
    }
    Ok(value)
}

fn config_error(name: &str) -> MonitorError {
    MonitorError::Config(format!("monitoring {name} is invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_monitoring_overrides_and_paths() {
        let root = tempfile::tempdir().unwrap();
        let mut environment = std::collections::HashMap::new();
        environment.insert("CYBEROS_ROOT".to_owned(), root.path().display().to_string());
        environment.insert(
            "CYBEROS_MONITORING_FAST_SAMPLE_INTERVAL_MS".to_owned(),
            "5000".to_owned(),
        );
        let config = MonitorConfig::load_from(&environment, root.path().to_path_buf()).unwrap();
        assert_eq!(config.monitoring.sampling.fast, Duration::from_secs(5));
        assert_eq!(
            config.database_path,
            root.path().join("state/cyberos.sqlite")
        );
        assert_eq!(config.data_root, root.path().join("data"));
    }

    #[test]
    fn rejects_invalid_retention_order() {
        let root = tempfile::tempdir().unwrap();
        let mut environment = std::collections::HashMap::new();
        environment.insert("CYBEROS_ROOT".to_owned(), root.path().display().to_string());
        environment.insert(
            "CYBEROS_MONITORING_RAW_RETENTION_MS".to_owned(),
            "7200000".to_owned(),
        );
        environment.insert(
            "CYBEROS_MONITORING_MINUTE_RETENTION_MS".to_owned(),
            "3600000".to_owned(),
        );
        assert!(MonitorConfig::load_from(&environment, root.path().to_path_buf()).is_err());
    }
}
