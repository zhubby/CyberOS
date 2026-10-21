use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "vod-player.ts", rename = "VodPlayerErrorCode"))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    VodPlayerDisabled,
    VodPlayerUnavailable,
    MpvUnavailable,
    DrmUnavailable,
    AudioUnavailable,
    PermissionDenied,
    StorageUnavailable,
    SourceChanged,
    UnsupportedMedia,
    PlaybackFailed,
    CommandTimeout,
    SessionConflict,
    InvalidCommand,
    InvalidPath,
    ProtocolError,
    Internal,
}

#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct VodError {
    pub code: ErrorCode,
    pub message: String,
    pub status_code: u16,
}

impl VodError {
    pub fn new(code: ErrorCode, message: impl Into<String>, status_code: u16) -> Self {
        Self {
            code,
            message: message.into(),
            status_code,
        }
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidPath, message, 400)
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ProtocolError, message, 400)
    }

    pub fn unavailable(code: ErrorCode, message: impl Into<String>) -> Self {
        Self::new(code, message, 503)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message, 500)
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self.code,
            ErrorCode::MpvUnavailable
                | ErrorCode::DrmUnavailable
                | ErrorCode::AudioUnavailable
                | ErrorCode::StorageUnavailable
                | ErrorCode::PlaybackFailed
                | ErrorCode::CommandTimeout
        )
    }
}

impl From<std::io::Error> for VodError {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
                ErrorCode::StorageUnavailable
            }
            _ => ErrorCode::Internal,
        };
        Self::new(
            code,
            error.to_string(),
            match code {
                ErrorCode::PermissionDenied => 403,
                ErrorCode::Internal => 500,
                _ => 503,
            },
        )
    }
}

impl From<nix::Error> for VodError {
    fn from(error: nix::Error) -> Self {
        let code = match error {
            nix::errno::Errno::EACCES | nix::errno::Errno::EPERM => ErrorCode::PermissionDenied,
            nix::errno::Errno::ENOENT
            | nix::errno::Errno::ENOTDIR
            | nix::errno::Errno::ENODEV
            | nix::errno::Errno::EXDEV => ErrorCode::StorageUnavailable,
            _ => ErrorCode::Internal,
        };
        Self::new(
            code,
            error.to_string(),
            match code {
                ErrorCode::PermissionDenied => 403,
                ErrorCode::Internal => 500,
                _ => 503,
            },
        )
    }
}
