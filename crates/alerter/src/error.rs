use std::io;

#[derive(Debug, thiserror::Error)]
pub enum AlerterError {
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
    #[error("alert runtime error: {0}")]
    Runtime(String),
    #[error("alert rule error: {0}")]
    AlertRule(String),
    #[error("alert schema is not available")]
    AlertSchemaUnavailable,
    #[error("alert instance capacity exceeded")]
    AlertCapacity,
    #[error("alert delivery capacity exceeded")]
    AlertDeliveryCapacity,
    #[error("SMTP error: {0}")]
    Smtp(String),
}

impl AlerterError {
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
            Self::AlertRule(_) => "Alert rule is invalid",
            Self::AlertSchemaUnavailable => "Alert database schema is not ready",
            Self::AlertCapacity => "Alert instance limit reached",
            Self::AlertDeliveryCapacity => "Alert delivery limit reached",
            Self::Smtp(_) => "SMTP delivery failed",
            Self::Runtime(_) => "Collector failed",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_legacy_sanitized_messages() {
        let cases = [
            (
                AlerterError::FutureMetricsSchema(4),
                "Metrics database schema is newer than this monitor",
            ),
            (
                AlerterError::Config("invalid".to_owned()),
                "Monitor configuration is invalid",
            ),
            (
                AlerterError::Io(io::Error::from(io::ErrorKind::PermissionDenied)),
                "Collector permission denied",
            ),
            (
                AlerterError::Io(io::Error::from(io::ErrorKind::NotFound)),
                "Collector dependency unavailable",
            ),
            (
                AlerterError::Runtime("worker stopped".to_owned()),
                "Collector failed",
            ),
            (
                AlerterError::Serialization(
                    serde_json::from_str::<serde_json::Value>("{").unwrap_err(),
                ),
                "Monitor operation failed",
            ),
        ];

        for (error, expected) in cases {
            assert_eq!(error.sanitized(), expected);
        }
    }

    #[test]
    fn preserves_storage_sanitization() {
        let full = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
            None,
        );
        assert_eq!(
            AlerterError::Storage(full).sanitized(),
            "Metrics database is full"
        );
        assert_eq!(
            AlerterError::Storage(rusqlite::Error::InvalidQuery).sanitized(),
            "Metrics database operation failed"
        );
    }
}
