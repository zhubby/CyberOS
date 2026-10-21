use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdErrorCode"))]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ProtocolError,
    Validation,
    Forbidden,
    NotFound,
    Conflict,
    Timeout,
    OutputTooLarge,
    Unavailable,
    OperationFailed,
    RestartFailed,
    Unsupported,
    Internal,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct HostdError {
    pub status: u16,
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<Value>,
}

impl HostdError {
    pub fn new(status: u16, code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: sanitize_message(&message.into()),
            details: None,
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(400, ErrorCode::Validation, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, ErrorCode::Conflict, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, ErrorCode::NotFound, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(503, ErrorCode::Unavailable, message)
    }

    pub fn operation_failed(message: impl Into<String>) -> Self {
        Self::new(502, ErrorCode::OperationFailed, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(501, ErrorCode::Unsupported, message)
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl From<std::io::Error> for HostdError {
    fn from(error: std::io::Error) -> Self {
        Self::new(500, ErrorCode::Internal, error.to_string())
    }
}

fn sanitize_message(message: &str) -> String {
    let mut output = message.to_owned();
    for marker in ["password", "psk", "secret", "token", "authorization"] {
        output = redact_assignment(&output, marker);
    }
    output.chars().take(500).collect()
}

fn redact_assignment(input: &str, marker: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find(marker) {
        let marker_end = cursor + offset + marker.len();
        let suffix = &input[marker_end..];
        let Some(separator_offset) = suffix.find([':', '=']) else {
            break;
        };
        if separator_offset > 3 {
            output.push_str(&input[cursor..marker_end]);
            cursor = marker_end;
            continue;
        }
        let raw_value_start = marker_end + separator_offset + 1;
        let whitespace_len = input[raw_value_start..]
            .chars()
            .take_while(|character| character.is_whitespace())
            .map(char::len_utf8)
            .sum::<usize>();
        let value_start = raw_value_start + whitespace_len;
        let (value_end, found_value) =
            assignment_value_end(input, value_start, marker == "authorization");
        if !found_value {
            output.push_str(&input[cursor..value_start]);
            cursor = value_start;
            continue;
        }
        output.push_str(&input[cursor..value_start]);
        output.push_str("[redacted]");
        cursor = value_end;
    }
    output.push_str(&input[cursor..]);
    output
}

fn assignment_value_end(input: &str, start: usize, allow_spaces: bool) -> (usize, bool) {
    let Some(first) = input[start..].chars().next() else {
        return (start, false);
    };
    if matches!(first, '\'' | '"') {
        let content_start = start + first.len_utf8();
        let end = input[content_start..]
            .find(first)
            .map(|offset| content_start + offset + first.len_utf8())
            .unwrap_or(input.len());
        return (end, end > content_start);
    }
    let end = input[start..]
        .find(|character: char| {
            matches!(character, '\r' | '\n' | ',' | ';' | '}')
                || (!allow_spaces && character.is_whitespace())
        })
        .map(|offset| start + offset)
        .unwrap_or(input.len());
    (end, end > start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_credentials_and_caps_messages() {
        let error = HostdError::validation(format!(
            "password=secret password = 'second secret' token:abc authorization: Bearer {}",
            "x".repeat(600)
        ));
        assert!(!error.message.contains("secret"));
        assert!(!error.message.contains("second"));
        assert!(!error.message.contains("abc"));
        assert!(!error.message.contains("Bearer"));
        assert_eq!(error.message.matches("[redacted]").count(), 4);
        assert!(error.message.chars().count() <= 500);
    }
}
