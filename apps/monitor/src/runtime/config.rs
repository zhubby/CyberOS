use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

use toml_edit::{DocumentMut, Item};

use crate::domain::config::{Config, MonitoringConfig, NasRoot};
use crate::error::MonitorError;

const DEFAULT_CONFIG_PATH: &str = "/zos/config/config.toml";
const MIB: u64 = 1024 * 1024;

impl Config {
    pub fn load() -> Result<Self, MonitorError> {
        Self::load_from(&env::vars().collect(), env::current_dir()?)
    }

    fn load_from(
        environment: &std::collections::HashMap<String, String>,
        current_dir: PathBuf,
    ) -> Result<Self, MonitorError> {
        let config_path = environment
            .get("ZOS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
        let document = if config_path.exists() {
            std::fs::read_to_string(&config_path)?
                .parse::<DocumentMut>()
                .map_err(|error| MonitorError::Config(format!("invalid ZOS config: {error}")))?
        } else {
            DocumentMut::new()
        };
        let root_dir = environment
            .get("ZOS_ROOT")
            .map(PathBuf::from)
            .or_else(|| {
                document
                    .get("root_dir")
                    .and_then(Item::as_str)
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| current_dir.join(".zos/dev-root"));
        let state_dir = root_dir.join("state");
        let monitoring = monitoring_config(environment, &document)?;
        let nas_roots = nas_roots(environment, &document, &root_dir, &current_dir);
        Ok(Self {
            root_dir,
            database_path: state_dir.join("zos.sqlite"),
            metrics_database_path: state_dir.join("metrics.sqlite"),
            state_dir,
            nas_roots,
            monitoring,
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(root: &Path) -> Self {
        let state_dir = root.join("state");
        Self {
            root_dir: root.to_path_buf(),
            database_path: state_dir.join("zos.sqlite"),
            metrics_database_path: state_dir.join("metrics.sqlite"),
            state_dir,
            nas_roots: Vec::new(),
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
    let mut config = MonitoringConfig {
        enabled: boolean(
            environment
                .get("ZOS_MONITORING_ENABLED")
                .map(String::as_str),
            table
                .and_then(|value| value.get("enabled"))
                .and_then(Item::as_bool),
            defaults.enabled,
            "enabled",
        )?,
        fast_interval: milliseconds(
            environment
                .get("ZOS_MONITORING_FAST_SAMPLE_INTERVAL_MS")
                .map(String::as_str),
            table
                .and_then(|value| value.get("fast_sample_interval_ms"))
                .and_then(Item::as_integer),
            defaults.fast_interval,
            "fast_sample_interval_ms",
        )?,
        standard_interval: milliseconds(
            environment
                .get("ZOS_MONITORING_STANDARD_SAMPLE_INTERVAL_MS")
                .map(String::as_str),
            table
                .and_then(|value| value.get("standard_sample_interval_ms"))
                .and_then(Item::as_integer),
            defaults.standard_interval,
            "standard_sample_interval_ms",
        )?,
        temperature_interval: milliseconds(
            environment
                .get("ZOS_MONITORING_TEMPERATURE_SAMPLE_INTERVAL_MS")
                .map(String::as_str),
            table
                .and_then(|value| value.get("temperature_sample_interval_ms"))
                .and_then(Item::as_integer),
            defaults.temperature_interval,
            "temperature_sample_interval_ms",
        )?,
        raw_retention: milliseconds(
            environment
                .get("ZOS_MONITORING_RAW_RETENTION_MS")
                .map(String::as_str),
            table
                .and_then(|value| value.get("raw_retention_ms"))
                .and_then(Item::as_integer),
            defaults.raw_retention,
            "raw_retention_ms",
        )?,
        minute_retention: milliseconds(
            environment
                .get("ZOS_MONITORING_MINUTE_RETENTION_MS")
                .map(String::as_str),
            table
                .and_then(|value| value.get("minute_retention_ms"))
                .and_then(Item::as_integer),
            defaults.minute_retention,
            "minute_retention_ms",
        )?,
        hour_retention: milliseconds(
            environment
                .get("ZOS_MONITORING_HOUR_RETENTION_MS")
                .map(String::as_str),
            table
                .and_then(|value| value.get("hour_retention_ms"))
                .and_then(Item::as_integer),
            defaults.hour_retention,
            "hour_retention_ms",
        )?,
        max_database_bytes: integer(
            environment
                .get("ZOS_MONITORING_MAX_DATABASE_BYTES")
                .map(String::as_str),
            table
                .and_then(|value| value.get("max_database_bytes"))
                .and_then(Item::as_integer),
            defaults.max_database_bytes,
            "max_database_bytes",
        )?,
    };
    validate_monitoring(&mut config)?;
    Ok(config)
}

fn validate_monitoring(config: &mut MonitoringConfig) -> Result<(), MonitorError> {
    if !(Duration::from_secs(1)..=Duration::from_secs(5 * 60)).contains(&config.fast_interval) {
        return Err(config_error("fast_sample_interval_ms"));
    }
    if config.standard_interval < config.fast_interval
        || config.standard_interval > Duration::from_secs(15 * 60)
    {
        return Err(config_error("standard_sample_interval_ms"));
    }
    if config.temperature_interval < config.standard_interval
        || config.temperature_interval > Duration::from_secs(60 * 60)
    {
        return Err(config_error("temperature_sample_interval_ms"));
    }
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

fn nas_roots(
    environment: &std::collections::HashMap<String, String>,
    document: &DocumentMut,
    root_dir: &Path,
    current_dir: &Path,
) -> Vec<NasRoot> {
    if let Some(value) = environment.get("ZOS_NAS_ROOTS") {
        let roots: Vec<_> = value
            .split(',')
            .filter_map(|entry| {
                let mut fields = entry.trim().splitn(3, ':');
                let id = fields.next()?.trim();
                let _name = fields.next()?;
                let path = fields.next()?.trim();
                if id.is_empty() || path.is_empty() {
                    return None;
                }
                let path = PathBuf::from(path);
                Some(NasRoot {
                    id: id.to_owned(),
                    path: if path.is_absolute() {
                        path
                    } else {
                        current_dir.join(path)
                    },
                })
            })
            .collect();
        if !roots.is_empty() {
            return roots;
        }
    }
    if let Some(tables) = document.get("nas_roots").and_then(Item::as_array_of_tables) {
        let roots: Vec<_> = tables
            .iter()
            .enumerate()
            .map(|(index, table)| {
                let id = table
                    .get("id")
                    .and_then(Item::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("root-{}", index + 1));
                let path = table
                    .get("path")
                    .and_then(Item::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| root_dir.join("data/primary"));
                NasRoot {
                    id,
                    path: if path.is_absolute() {
                        path
                    } else {
                        current_dir.join(path)
                    },
                }
            })
            .collect();
        if !roots.is_empty() {
            return roots;
        }
    }
    vec![NasRoot {
        id: "primary".to_owned(),
        path: root_dir.join("data/primary"),
    }]
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
        environment.insert("ZOS_ROOT".to_owned(), root.path().display().to_string());
        environment.insert(
            "ZOS_MONITORING_FAST_SAMPLE_INTERVAL_MS".to_owned(),
            "5000".to_owned(),
        );
        environment.insert(
            "ZOS_NAS_ROOTS".to_owned(),
            format!("dev:Development:{}", root.path().join("nas").display()),
        );
        let config = Config::load_from(&environment, root.path().to_path_buf()).unwrap();
        assert_eq!(config.monitoring.fast_interval, Duration::from_secs(5));
        assert_eq!(config.database_path, root.path().join("state/zos.sqlite"));
        assert_eq!(config.nas_roots[0].id, "dev");
    }

    #[test]
    fn rejects_invalid_retention_order() {
        let root = tempfile::tempdir().unwrap();
        let mut environment = std::collections::HashMap::new();
        environment.insert("ZOS_ROOT".to_owned(), root.path().display().to_string());
        environment.insert(
            "ZOS_MONITORING_RAW_RETENTION_MS".to_owned(),
            "7200000".to_owned(),
        );
        environment.insert(
            "ZOS_MONITORING_MINUTE_RETENTION_MS".to_owned(),
            "3600000".to_owned(),
        );
        assert!(Config::load_from(&environment, root.path().to_path_buf()).is_err());
    }
}
