use std::fmt::Display;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    StorageUnavailable,
    SourceChanged,
    InvalidPath,
    PermissionDenied,
    SizeLimit,
    CorruptDocument,
    ToolUnavailable,
    CommandTimeout,
    CommandFailed,
    Database,
    Watcher,
    Internal,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::StorageUnavailable => "STORAGE_UNAVAILABLE",
            Self::SourceChanged => "SOURCE_CHANGED",
            Self::InvalidPath => "INVALID_PATH",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::SizeLimit => "SIZE_LIMIT",
            Self::CorruptDocument => "CORRUPT_DOCUMENT",
            Self::ToolUnavailable => "TOOL_UNAVAILABLE",
            Self::CommandTimeout => "COMMAND_TIMEOUT",
            Self::CommandFailed => "COMMAND_FAILED",
            Self::Database => "DATABASE",
            Self::Watcher => "WATCHER",
            Self::Internal => "INTERNAL",
        }
    }
}

#[derive(Debug, thiserror::Error, Clone)]
#[error("{message}")]
pub struct IndexerError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl IndexerError {
    pub fn new(code: ErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: sanitize(message.into()),
            retryable,
        }
    }

    pub fn database(error: impl Display) -> Self {
        Self::new(ErrorCode::Database, error.to_string(), true)
    }

    pub fn storage(error: impl Display) -> Self {
        let message = error.to_string();
        let lower = message.to_ascii_lowercase();
        let code = if lower.contains("permission denied") {
            ErrorCode::PermissionDenied
        } else if lower.contains("invalid") || lower.contains("symlink") {
            ErrorCode::InvalidPath
        } else {
            ErrorCode::StorageUnavailable
        };
        Self::new(code, message, !matches!(code, ErrorCode::InvalidPath))
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidPath, message, false)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message, false)
    }
}

impl From<std::io::Error> for IndexerError {
    fn from(error: std::io::Error) -> Self {
        Self::storage(error)
    }
}

fn sanitize(message: String) -> String {
    let one_line = message.replace(['\r', '\n'], " ");
    let value: String = one_line.chars().take(500).collect();
    if value.is_empty() {
        "Indexer operation failed".to_owned()
    } else {
        value
    }
}
