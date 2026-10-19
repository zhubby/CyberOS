use std::path::PathBuf;
use std::time::Duration;

const MIB: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct NasRoot {
    pub id: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct MonitoringConfig {
    pub enabled: bool,
    pub fast_interval: Duration,
    pub standard_interval: Duration,
    pub temperature_interval: Duration,
    pub raw_retention: Duration,
    pub minute_retention: Duration,
    pub hour_retention: Duration,
    pub max_database_bytes: u64,
}

impl Default for MonitoringConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            fast_interval: Duration::from_secs(10),
            standard_interval: Duration::from_secs(30),
            temperature_interval: Duration::from_secs(5 * 60),
            raw_retention: Duration::from_secs(48 * 60 * 60),
            minute_retention: Duration::from_secs(30 * 24 * 60 * 60),
            hour_retention: Duration::from_secs(365 * 24 * 60 * 60),
            max_database_bytes: 512 * MIB,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub root_dir: PathBuf,
    pub state_dir: PathBuf,
    pub database_path: PathBuf,
    pub metrics_database_path: PathBuf,
    pub nas_roots: Vec<NasRoot>,
    pub monitoring: MonitoringConfig,
}
