use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::time::Duration;

use cyberos_monitoring_contracts::SamplingIntervals;
use toml_edit::{DocumentMut, Item};

use crate::domain::config::AlerterConfig;
use crate::error::AlerterError;

const DEFAULT_CONFIG_PATH: &str = "/cyberos/config/config.toml";

impl AlerterConfig {
    pub fn load() -> Result<Self, AlerterError> {
        Self::load_from(&env::vars().collect(), env::current_dir()?)
    }

    fn load_from(
        environment: &HashMap<String, String>,
        current_dir: PathBuf,
    ) -> Result<Self, AlerterError> {
        let config_path = environment
            .get("CYBEROS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
        let document = if config_path.exists() {
            std::fs::read_to_string(&config_path)?
                .parse::<DocumentMut>()
                .map_err(|error| AlerterError::Config(format!("invalid CyberOS config: {error}")))?
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
        let table = document.get("monitoring").and_then(Item::as_table);
        let defaults = SamplingIntervals::default();
        let sampling = SamplingIntervals {
            fast: milliseconds(
                environment
                    .get("CYBEROS_MONITORING_FAST_SAMPLE_INTERVAL_MS")
                    .map(String::as_str),
                table
                    .and_then(|value| value.get("fast_sample_interval_ms"))
                    .and_then(Item::as_integer),
                defaults.fast,
                "fast_sample_interval_ms",
            )?,
            standard: milliseconds(
                environment
                    .get("CYBEROS_MONITORING_STANDARD_SAMPLE_INTERVAL_MS")
                    .map(String::as_str),
                table
                    .and_then(|value| value.get("standard_sample_interval_ms"))
                    .and_then(Item::as_integer),
                defaults.standard,
                "standard_sample_interval_ms",
            )?,
            temperature: milliseconds(
                environment
                    .get("CYBEROS_MONITORING_TEMPERATURE_SAMPLE_INTERVAL_MS")
                    .map(String::as_str),
                table
                    .and_then(|value| value.get("temperature_sample_interval_ms"))
                    .and_then(Item::as_integer),
                defaults.temperature,
                "temperature_sample_interval_ms",
            )?,
        }
        .validate()
        .map_err(|error| config_error(error.field()))?;
        let state_dir = root_dir.join("state");
        Ok(Self {
            database_path: state_dir.join("cyberos.sqlite"),
            metrics_database_path: state_dir.join("metrics.sqlite"),
            monitoring_enabled: boolean(
                environment
                    .get("CYBEROS_MONITORING_ENABLED")
                    .map(String::as_str),
                table
                    .and_then(|value| value.get("enabled"))
                    .and_then(Item::as_bool),
                true,
                "enabled",
            )?,
            sampling,
        })
    }
}

fn boolean(
    environment: Option<&str>,
    configured: Option<bool>,
    fallback: bool,
    name: &str,
) -> Result<bool, AlerterError> {
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
) -> Result<Duration, AlerterError> {
    let fallback = u64::try_from(fallback.as_millis()).unwrap_or(u64::MAX);
    let value = match environment {
        Some(value) => value.parse::<u64>().map_err(|_| config_error(name))?,
        None => configured
            .and_then(|value| u64::try_from(value).ok())
            .unwrap_or(fallback),
    };
    if value == 0 {
        return Err(config_error(name));
    }
    Ok(Duration::from_millis(value))
}

fn config_error(name: &str) -> AlerterError {
    AlerterError::Config(format!("monitoring {name} is invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_only_alerter_runtime_settings() {
        let root = tempfile::tempdir().unwrap();
        let environment = HashMap::from([
            ("CYBEROS_ROOT".to_owned(), root.path().display().to_string()),
            (
                "CYBEROS_MONITORING_FAST_SAMPLE_INTERVAL_MS".to_owned(),
                "5000".to_owned(),
            ),
        ]);
        let config = AlerterConfig::load_from(&environment, root.path().to_path_buf()).unwrap();
        assert_eq!(config.sampling.fast, Duration::from_secs(5));
        assert_eq!(
            config.database_path,
            root.path().join("state/cyberos.sqlite")
        );
        assert_eq!(
            config.metrics_database_path,
            root.path().join("state/metrics.sqlite")
        );
    }

    #[test]
    fn rejects_invalid_sampling_order() {
        let root = tempfile::tempdir().unwrap();
        let environment = HashMap::from([
            ("CYBEROS_ROOT".to_owned(), root.path().display().to_string()),
            (
                "CYBEROS_MONITORING_STANDARD_SAMPLE_INTERVAL_MS".to_owned(),
                "5000".to_owned(),
            ),
        ]);
        assert!(AlerterConfig::load_from(&environment, root.path().to_path_buf()).is_err());
    }

    #[test]
    fn environment_overrides_monitoring_toml() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.toml");
        std::fs::write(
            &config_path,
            "[monitoring]\nenabled = false\nfast_sample_interval_ms = 5000\n",
        )
        .unwrap();
        let environment = HashMap::from([
            (
                "CYBEROS_CONFIG".to_owned(),
                config_path.display().to_string(),
            ),
            ("CYBEROS_ROOT".to_owned(), root.path().display().to_string()),
            ("CYBEROS_MONITORING_ENABLED".to_owned(), "true".to_owned()),
            (
                "CYBEROS_MONITORING_FAST_SAMPLE_INTERVAL_MS".to_owned(),
                "10000".to_owned(),
            ),
        ]);

        let config = AlerterConfig::load_from(&environment, root.path().to_path_buf()).unwrap();

        assert!(config.monitoring_enabled);
        assert_eq!(config.sampling.fast, Duration::from_secs(10));
    }
}
