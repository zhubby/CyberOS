use std::fmt::Display;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    PhotosStorageUnavailable,
    SourceChanged,
    InvalidPath,
    UnsupportedMedia,
    CorruptMedia,
    SizeLimit,
    DiskSpace,
    ToolUnavailable,
    CommandTimeout,
    CommandFailed,
    PublishConflict,
    PermissionDenied,
    Database,
    Internal,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PhotosStorageUnavailable => "PHOTOS_STORAGE_UNAVAILABLE",
            Self::SourceChanged => "SOURCE_CHANGED",
            Self::InvalidPath => "INVALID_PATH",
            Self::UnsupportedMedia => "UNSUPPORTED_MEDIA",
            Self::CorruptMedia => "CORRUPT_MEDIA",
            Self::SizeLimit => "SIZE_LIMIT",
            Self::DiskSpace => "DISK_SPACE",
            Self::ToolUnavailable => "TOOL_UNAVAILABLE",
            Self::CommandTimeout => "COMMAND_TIMEOUT",
            Self::CommandFailed => "COMMAND_FAILED",
            Self::PublishConflict => "PUBLISH_CONFLICT",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::Database => "DATABASE",
            Self::Internal => "INTERNAL",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PhotosError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl PhotosError {
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
        } else if lower.contains("no space left") {
            ErrorCode::DiskSpace
        } else {
            ErrorCode::PhotosStorageUnavailable
        };
        let retryable = matches!(code, ErrorCode::PhotosStorageUnavailable);
        Self::new(code, message, retryable)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message, false)
    }
}

impl From<std::io::Error> for PhotosError {
    fn from(error: std::io::Error) -> Self {
        Self::storage(error)
    }
}

fn sanitize(message: String) -> String {
    let one_line = message.replace(['\r', '\n'], " ");
    let mut result = String::with_capacity(one_line.len().min(500));
    for character in one_line.chars().take(500) {
        result.push(character);
    }
    if result.is_empty() {
        "Photos operation failed".to_owned()
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_io_errors_and_sanitizes_messages() {
        let full = PhotosError::storage(std::io::Error::from_raw_os_error(28));
        assert_eq!(full.code, ErrorCode::DiskSpace);
        assert!(!full.retryable);
        let error = PhotosError::new(ErrorCode::Internal, "bad\npath", false);
        assert_eq!(error.message, "bad path");
    }
}
