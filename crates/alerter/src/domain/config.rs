use std::path::PathBuf;

use zos_monitoring_contracts::SamplingIntervals;

#[derive(Debug, Clone)]
pub struct AlerterConfig {
    pub database_path: PathBuf,
    pub metrics_database_path: PathBuf,
    pub monitoring_enabled: bool,
    pub sampling: SamplingIntervals,
}
