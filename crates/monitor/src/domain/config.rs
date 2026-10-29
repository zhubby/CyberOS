use std::path::PathBuf;
use std::time::Duration;

use cyberos_monitoring_contracts::SamplingIntervals;

const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitoringConfig {
    pub enabled: bool,
    pub sampling: SamplingIntervals,
    pub raw_retention: Duration,
    pub minute_retention: Duration,
    pub hour_retention: Duration,
    pub max_database_bytes: u64,
}

impl Default for MonitoringConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            sampling: SamplingIntervals::default(),
            raw_retention: Duration::from_secs(48 * 60 * 60),
            minute_retention: Duration::from_secs(30 * 24 * 60 * 60),
            hour_retention: Duration::from_secs(365 * 24 * 60 * 60),
            max_database_bytes: 512 * MIB,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MonitorConfig {
    pub root_dir: PathBuf,
    pub state_dir: PathBuf,
    pub data_root: PathBuf,
    pub database_path: PathBuf,
    pub metrics_database_path: PathBuf,
    pub monitoring: MonitoringConfig,
}
