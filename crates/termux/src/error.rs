use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "termux.ts", rename = "TermuxErrorCode"))]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ProtocolError,
    Validation,
    Forbidden,
    NotFound,
    Conflict,
    SessionLimit,
    Timeout,
    OutputTooLarge,
    Unavailable,
    OperationFailed,
    Internal,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct TermuxError {
    pub status: u16,
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl TermuxError {
    pub fn new(status: u16, code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: sanitize_message(&message.into()),
            retryable: false,
            details: None,
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(400, ErrorCode::Validation, message)
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(400, ErrorCode::ProtocolError, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        let mut error = Self::new(409, ErrorCode::Conflict, message);
        error.retryable = true;
        error
    }

    pub fn session_limit() -> Self {
        let mut error = Self::new(
            429,
            ErrorCode::SessionLimit,
            "Terminal session limit reached",
        );
        error.retryable = true;
        error
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        let mut error = Self::new(503, ErrorCode::Unavailable, message);
        error.retryable = true;
        error
    }

    pub fn operation_failed(message: impl Into<String>) -> Self {
        Self::new(502, ErrorCode::OperationFailed, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        let mut error = Self::new(504, ErrorCode::Timeout, message);
        error.retryable = true;
        error
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl From<std::io::Error> for TermuxError {
    fn from(error: std::io::Error) -> Self {
        Self::new(500, ErrorCode::Internal, error.to_string())
    }
}

impl From<nix::Error> for TermuxError {
    fn from(error: nix::Error) -> Self {
        Self::new(500, ErrorCode::Internal, error.to_string())
    }
}

fn sanitize_message(message: &str) -> String {
    let mut output = message.replace(['\r', '\n'], " ");
    for marker in ["password", "secret", "token", "authorization"] {
        output = redact_assignment(&output, marker);
    }
    output.chars().take(500).collect()
}

fn redact_assignment(input: &str, marker: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let Some(marker_offset) = lower.find(marker) else {
        return input.to_owned();
    };
    let marker_end = marker_offset + marker.len();
    let Some(separator_offset) = input[marker_end..].find([':', '=']) else {
        return input.to_owned();
    };
    if separator_offset > 3 {
        return input.to_owned();
    }
    let value_start = marker_end + separator_offset + 1;
    let value_end = input[value_start..]
        .find([',', ';', ' ', '}'])
        .map(|offset| value_start + offset)
        .unwrap_or(input.len());
    format!("{}[redacted]{}", &input[..value_start], &input[value_end..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_error_messages() {
        let error = TermuxError::validation(format!("token=secret\n{}", "x".repeat(600)));
        assert!(!error.message.contains("secret"));
        assert!(!error.message.contains('\n'));
        assert!(error.message.chars().count() <= 500);
    }
}
