use std::collections::BTreeMap;

pub use zos_monitoring_contracts::{MetricCadence, MetricDefinition, MetricKind};

#[derive(Debug, Clone, PartialEq)]
pub struct MetricSample {
    pub metric: String,
    pub labels: BTreeMap<String, String>,
    pub timestamp_ms: i64,
    pub value: f64,
}

impl MetricSample {
    pub fn new(metric: impl Into<String>, timestamp_ms: i64, value: f64) -> Self {
        Self {
            metric: metric.into(),
            labels: BTreeMap::new(),
            timestamp_ms,
            value,
        }
    }

    pub fn with_label(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.labels.insert(key.into(), value.into());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollectorState {
    Ready,
    Error,
    Unsupported,
    Disabled,
}

impl CollectorState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Error => "error",
            Self::Unsupported => "unsupported",
            Self::Disabled => "disabled",
        }
    }
}

#[derive(Debug)]
pub struct Collection {
    pub samples: Vec<MetricSample>,
    pub state: CollectorState,
}

impl Collection {
    pub fn ready(samples: Vec<MetricSample>) -> Self {
        Self {
            samples,
            state: CollectorState::Ready,
        }
    }
}
