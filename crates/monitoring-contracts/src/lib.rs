use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;

pub const METRICS_SCHEMA_VERSION: i64 = 3;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MetricKind {
    Gauge,
    Counter,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MetricCadence {
    Fast,
    Standard,
    Temperature,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricDefinition {
    pub name: String,
    pub description: String,
    pub kind: MetricKind,
    pub unit: String,
    pub label_keys: Vec<String>,
    pub cadence: MetricCadence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SamplingIntervals {
    pub fast: Duration,
    pub standard: Duration,
    pub temperature: Duration,
}

impl SamplingIntervals {
    pub fn validate(self) -> Result<Self, SamplingIntervalsError> {
        if !(Duration::from_secs(1)..=Duration::from_secs(5 * 60)).contains(&self.fast) {
            return Err(SamplingIntervalsError::Fast);
        }
        if self.standard < self.fast || self.standard > Duration::from_secs(15 * 60) {
            return Err(SamplingIntervalsError::Standard);
        }
        if self.temperature < self.standard || self.temperature > Duration::from_secs(60 * 60) {
            return Err(SamplingIntervalsError::Temperature);
        }
        Ok(self)
    }

    pub fn for_cadence(self, cadence: MetricCadence) -> Duration {
        match cadence {
            MetricCadence::Fast => self.fast,
            MetricCadence::Standard => self.standard,
            MetricCadence::Temperature => self.temperature,
        }
    }
}

impl Default for SamplingIntervals {
    fn default() -> Self {
        Self {
            fast: Duration::from_secs(10),
            standard: Duration::from_secs(30),
            temperature: Duration::from_secs(5 * 60),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SamplingIntervalsError {
    Fast,
    Standard,
    Temperature,
}

impl SamplingIntervalsError {
    pub const fn field(self) -> &'static str {
        match self {
            Self::Fast => "fast_sample_interval_ms",
            Self::Standard => "standard_sample_interval_ms",
            Self::Temperature => "temperature_sample_interval_ms",
        }
    }
}

impl std::fmt::Display for SamplingIntervalsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "invalid monitoring setting {}", self.field())
    }
}

impl std::error::Error for SamplingIntervalsError {}

static CATALOG: OnceLock<Vec<MetricDefinition>> = OnceLock::new();
static BY_NAME: OnceLock<HashMap<String, usize>> = OnceLock::new();

pub fn catalog() -> &'static [MetricDefinition] {
    CATALOG
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../packages/monitoring/contracts/metrics-catalog.json"
            ))
            .expect("embedded monitoring catalog must be valid")
        })
        .as_slice()
}

pub fn metric(name: &str) -> Option<&'static MetricDefinition> {
    let by_name = BY_NAME.get_or_init(|| {
        catalog()
            .iter()
            .enumerate()
            .map(|(index, definition)| (definition.name.clone(), index))
            .collect()
    });
    by_name.get(name).map(|index| &catalog()[*index])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_the_language_neutral_catalog() {
        let definition = metric("cyberos_host_filesystem_used_ratio").unwrap();
        assert_eq!(definition.label_keys, ["filesystem"]);
        assert_eq!(catalog().len(), 29);
    }

    #[test]
    fn validates_sampling_interval_order_and_bounds() {
        assert!(SamplingIntervals::default().validate().is_ok());
        assert_eq!(
            SamplingIntervals {
                fast: Duration::from_millis(999),
                ..SamplingIntervals::default()
            }
            .validate(),
            Err(SamplingIntervalsError::Fast)
        );
        assert_eq!(
            SamplingIntervals {
                standard: Duration::from_secs(5),
                ..SamplingIntervals::default()
            }
            .validate(),
            Err(SamplingIntervalsError::Standard)
        );
    }
}
