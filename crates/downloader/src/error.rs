use std::any::Any;
use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    Dns,
    SsrfBlocked,
    Connect,
    Timeout,
    Tls,
    HttpStatus,
    RedirectPolicy,
    RangeProtocol,
    SourceChanged,
    SizeLimit,
    DiskSpace,
    Storage,
    TargetConflict,
    ChecksumMismatch,
    Permission,
    Database,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dns => "dns",
            Self::SsrfBlocked => "ssrf_blocked",
            Self::Connect => "connect",
            Self::Timeout => "timeout",
            Self::Tls => "tls",
            Self::HttpStatus => "http_status",
            Self::RedirectPolicy => "redirect_policy",
            Self::RangeProtocol => "range_protocol",
            Self::SourceChanged => "source_changed",
            Self::SizeLimit => "size_limit",
            Self::DiskSpace => "disk_space",
            Self::Storage => "storage",
            Self::TargetConflict => "target_conflict",
            Self::ChecksumMismatch => "checksum_mismatch",
            Self::Permission => "permission",
            Self::Database => "database",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct DownloadError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
}

impl DownloadError {
    pub fn new(code: ErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            retry_after_ms: None,
        }
    }

    pub fn retry_after(mut self, delay_ms: Option<u64>) -> Self {
        self.retry_after_ms = delay_ms;
        self
    }

    pub fn database(error: impl std::fmt::Display) -> Self {
        Self::new(ErrorCode::Database, error.to_string(), true)
    }

    pub fn storage(error: impl std::fmt::Display + 'static) -> Self {
        let code = classify_storage_error(&error);
        Self::new(code, error.to_string(), false)
    }
}

impl From<io::Error> for DownloadError {
    fn from(error: io::Error) -> Self {
        let code = classify_io_error(&error);
        Self::new(code, error.to_string(), false)
    }
}

fn classify_storage_error(error: &(impl std::fmt::Display + 'static)) -> ErrorCode {
    let error = error as &dyn Any;
    if let Some(error) = error.downcast_ref::<io::Error>() {
        return classify_io_error(error);
    }
    if let Some(error) = error.downcast_ref::<nix::errno::Errno>() {
        return match *error {
            nix::errno::Errno::EACCES | nix::errno::Errno::EPERM => ErrorCode::Permission,
            nix::errno::Errno::ENOSPC | nix::errno::Errno::EDQUOT => ErrorCode::DiskSpace,
            _ => ErrorCode::Storage,
        };
    }
    ErrorCode::Storage
}

fn classify_io_error(error: &io::Error) -> ErrorCode {
    match error.kind() {
        io::ErrorKind::PermissionDenied => ErrorCode::Permission,
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => ErrorCode::DiskSpace,
        _ => ErrorCode::Storage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_disk_and_permission_io_errors() {
        assert_eq!(
            DownloadError::storage(io::Error::from(io::ErrorKind::StorageFull)).code,
            ErrorCode::DiskSpace
        );
        assert_eq!(
            DownloadError::storage(io::Error::from(io::ErrorKind::PermissionDenied)).code,
            ErrorCode::Permission
        );
    }
}
