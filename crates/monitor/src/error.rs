use std::io;

#[derive(Debug, thiserror::Error)]
pub enum MonitorError {
    #[error("configuration error: {0}")]
    Config(String),
    #[error("metrics schema version {0} is newer than supported version 3")]
    FutureMetricsSchema(i64),
    #[error("storage error: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("collector error: {0}")]
    Collector(String),
    #[error("monitor worker stopped")]
    WorkerStopped,
}

impl MonitorError {
    pub fn sanitized(&self) -> &'static str {
        match self {
            Self::FutureMetricsSchema(_) => "Metrics database schema is newer than this monitor",
            Self::Config(_) => "Monitor configuration is invalid",
            Self::Storage(error) if is_full(error) => "Metrics database is full",
            Self::Storage(_) => "Metrics database operation failed",
            Self::Io(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                "Collector permission denied"
            }
            Self::Io(error) if error.kind() == io::ErrorKind::NotFound => {
                "Collector dependency unavailable"
            }
            Self::Collector(_) => "Collector failed",
            _ => "Monitor operation failed",
        }
    }
}

fn is_full(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::DiskFull
    )
}
