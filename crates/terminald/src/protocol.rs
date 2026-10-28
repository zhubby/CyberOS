use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::{Uuid, Variant};

use crate::error::{ErrorCode, TerminalError};

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 24 * 1024;
pub const MIN_COLS: u16 = 2;
pub const MAX_COLS: u16 = 500;
pub const MIN_ROWS: u16 = 1;
pub const MAX_ROWS: u16 = 200;
pub const UNKNOWN_REQUEST_ID: &str = "00000000-0000-4000-8000-000000000000";

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ClientFrame {
    #[serde(rename = "request")]
    Request {
        version: u8,
        id: String,
        operation: String,
        payload: Value,
    },
    #[serde(rename = "command")]
    Command {
        version: u8,
        #[serde(rename = "streamId")]
        stream_id: String,
        operation: String,
        payload: Value,
    },
}

#[derive(Debug)]
pub enum Request {
    Open { id: String, payload: OpenPayload },
    Close { id: String, payload: ClosePayload },
    Destroy { id: String, payload: DestroyPayload },
}

#[derive(Debug)]
pub enum Command {
    Input {
        stream_id: String,
        data: Vec<u8>,
    },
    Resize {
        stream_id: String,
        cols: u16,
        rows: u16,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "terminal.ts", rename = "TerminalOpenPayload"))]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenPayload {
    pub user: String,
    pub cols: u16,
    pub rows: u16,
    #[cfg_attr(test, ts(optional = nullable))]
    pub session_name: Option<String>,
    #[serde(default)]
    pub persistent: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "terminal.ts", rename = "TerminalClosePayload"))]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClosePayload {
    pub stream_id: String,
    #[serde(default)]
    pub destroy: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "terminal.ts", rename = "TerminalDestroyPayload"))]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DestroyPayload {
    pub user: String,
    pub session_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "terminal.ts", rename = "TerminalInputPayload"))]
#[serde(deny_unknown_fields)]
struct InputPayload {
    data: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "terminal.ts", rename = "TerminalResizePayload"))]
#[serde(deny_unknown_fields)]
struct ResizePayload {
    cols: u16,
    rows: u16,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "terminal.ts", rename = "TerminalOpenResult"))]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub stream_id: String,
    pub user: String,
    pub cwd: String,
    pub shell: String,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "terminal.ts", rename = "TerminalCloseResult"))]
#[serde(rename_all = "camelCase")]
pub struct CloseResult {
    pub closed: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "terminal.ts", rename = "TerminalDestroyResult"))]
#[serde(rename_all = "camelCase")]
pub struct DestroyResult {
    pub session_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    version: u8,
    kind: &'static str,
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorEnvelope>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "camelCase")]
struct ErrorEnvelope {
    status: u16,
    code: ErrorCode,
    message: String,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope<T: Serialize> {
    version: u8,
    kind: &'static str,
    stream_id: String,
    event: &'static str,
    payload: T,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "terminal.ts", rename = "TerminalOutputPayload"))]
pub struct OutputPayload {
    pub data: String,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "terminal.ts", rename = "TerminalExitPayload"))]
#[serde(rename_all = "camelCase")]
pub struct ExitPayload {
    pub exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    pub recoverable: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "terminal.ts", rename = "TerminalStreamErrorPayload")
)]
#[serde(rename_all = "camelCase")]
pub struct StreamErrorPayload {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl ClientFrame {
    pub fn parse(frame: &[u8]) -> Result<Self, TerminalError> {
        let parsed: Self = serde_json::from_slice(frame)
            .map_err(|_| TerminalError::protocol("Invalid Terminal Protocol JSONL frame"))?;
        let version = match &parsed {
            Self::Request { version, .. } | Self::Command { version, .. } => *version,
        };
        if version != PROTOCOL_VERSION {
            return Err(TerminalError::protocol(
                "Unsupported Terminal Protocol version",
            ));
        }
        Ok(parsed)
    }

    pub fn into_request(self) -> Result<Request, TerminalError> {
        let Self::Request {
            id,
            operation,
            payload,
            ..
        } = self
        else {
            return Err(TerminalError::protocol("Expected a request frame"));
        };
        validate_request_id(&id)?;
        match operation.as_str() {
            "session.open" => {
                let payload = decode_payload::<OpenPayload>(payload)?;
                validate_dimensions(payload.cols, payload.rows)?;
                if let Some(name) = &payload.session_name {
                    validate_session_name(name)?;
                }
                Ok(Request::Open { id, payload })
            }
            "session.close" => {
                let payload = decode_payload::<ClosePayload>(payload)?;
                validate_stream_id(&payload.stream_id)?;
                Ok(Request::Close { id, payload })
            }
            "session.destroy" => {
                let payload = decode_payload::<DestroyPayload>(payload)?;
                validate_session_name(&payload.session_name)?;
                Ok(Request::Destroy { id, payload })
            }
            _ => Err(TerminalError::protocol(
                "Unknown Terminal request operation",
            )),
        }
    }

    pub fn into_command(self) -> Result<Command, TerminalError> {
        let Self::Command {
            stream_id,
            operation,
            payload,
            ..
        } = self
        else {
            return Err(TerminalError::protocol("Expected a command frame"));
        };
        validate_stream_id(&stream_id)?;
        match operation.as_str() {
            "terminal.input" => {
                let payload = decode_payload::<InputPayload>(payload)?;
                if payload.data.len() > MAX_INPUT_BYTES.div_ceil(3) * 4 {
                    return Err(TerminalError::new(
                        413,
                        ErrorCode::OutputTooLarge,
                        "Terminal input payload is too large",
                    ));
                }
                let data = base64::engine::general_purpose::STANDARD
                    .decode(&payload.data)
                    .map_err(|_| TerminalError::protocol("Invalid terminal input encoding"))?;
                if base64::engine::general_purpose::STANDARD.encode(&data) != payload.data {
                    return Err(TerminalError::protocol("Invalid terminal input encoding"));
                }
                if data.len() > MAX_INPUT_BYTES {
                    return Err(TerminalError::new(
                        413,
                        ErrorCode::OutputTooLarge,
                        "Terminal input payload is too large",
                    ));
                }
                Ok(Command::Input { stream_id, data })
            }
            "terminal.resize" => {
                let payload = decode_payload::<ResizePayload>(payload)?;
                validate_dimensions(payload.cols, payload.rows)?;
                Ok(Command::Resize {
                    stream_id,
                    cols: payload.cols,
                    rows: payload.rows,
                })
            }
            _ => Err(TerminalError::protocol(
                "Unknown Terminal command operation",
            )),
        }
    }
}

impl ResponseEnvelope {
    pub fn success(id: String, result: impl Serialize) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            kind: "response",
            id,
            ok: true,
            result: Some(
                serde_json::to_value(result).expect("Terminal protocol result must serialize"),
            ),
            error: None,
        }
    }

    pub fn failure(id: String, error: TerminalError) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            kind: "response",
            id,
            ok: false,
            result: None,
            error: Some(ErrorEnvelope {
                status: error.status,
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                details: error.details,
            }),
        }
    }
}

impl EventEnvelope<OutputPayload> {
    pub fn output(stream_id: String, data: &[u8]) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            kind: "event",
            stream_id,
            event: "terminal.output",
            payload: OutputPayload {
                data: base64::engine::general_purpose::STANDARD.encode(data),
            },
        }
    }
}

impl EventEnvelope<ExitPayload> {
    pub fn exit(stream_id: String, payload: ExitPayload) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            kind: "event",
            stream_id,
            event: "terminal.exit",
            payload,
        }
    }
}

impl EventEnvelope<StreamErrorPayload> {
    pub fn error(stream_id: String, error: TerminalError) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            kind: "event",
            stream_id,
            event: "terminal.error",
            payload: StreamErrorPayload {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
            },
        }
    }
}

fn decode_payload<T: for<'de> Deserialize<'de>>(payload: Value) -> Result<T, TerminalError> {
    serde_json::from_value(payload)
        .map_err(|_| TerminalError::protocol("Invalid Terminal operation payload"))
}

fn validate_request_id(id: &str) -> Result<(), TerminalError> {
    validate_uuid(id).map_err(|_| TerminalError::protocol("Invalid Terminal request id"))
}

fn validate_stream_id(id: &str) -> Result<(), TerminalError> {
    validate_uuid(id).map_err(|_| TerminalError::protocol("Invalid Terminal stream id"))
}

fn validate_uuid(id: &str) -> Result<(), ()> {
    let parsed = Uuid::parse_str(id).map_err(|_| ())?;
    if !parsed.hyphenated().to_string().eq_ignore_ascii_case(id)
        || !(1..=8).contains(&parsed.get_version_num())
        || parsed.get_variant() != Variant::RFC4122
    {
        return Err(());
    }
    Ok(())
}

fn validate_session_name(name: &str) -> Result<(), TerminalError> {
    if name.is_empty()
        || name.len() > 96
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(TerminalError::validation("Invalid terminal session name"));
    }
    Ok(())
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), TerminalError> {
    if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return Err(TerminalError::validation("Invalid terminal dimensions"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_rs::{Config, TS};

    #[allow(dead_code)]
    #[derive(Serialize, TS)]
    #[ts(export_to = "terminal.ts")]
    #[serde(tag = "operation", content = "payload")]
    enum TerminalRequestContract {
        #[serde(rename = "session.open")]
        Open(OpenPayload),
        #[serde(rename = "session.close")]
        Close(ClosePayload),
        #[serde(rename = "session.destroy")]
        Destroy(DestroyPayload),
    }

    #[allow(dead_code)]
    #[derive(Serialize, TS)]
    #[ts(export_to = "terminal.ts")]
    #[serde(tag = "operation", content = "payload")]
    enum TerminalCommandContract {
        #[serde(rename = "terminal.input")]
        Input(InputPayload),
        #[serde(rename = "terminal.resize")]
        Resize(ResizePayload),
    }

    #[allow(dead_code)]
    #[derive(Serialize, TS)]
    #[ts(export_to = "terminal.ts")]
    #[serde(tag = "event", content = "payload")]
    enum TerminalEventContract {
        #[serde(rename = "terminal.output")]
        Output(OutputPayload),
        #[serde(rename = "terminal.exit")]
        Exit(ExitPayload),
        #[serde(rename = "terminal.error")]
        Error(StreamErrorPayload),
    }

    #[allow(dead_code)]
    #[derive(Serialize, TS)]
    #[ts(export_to = "terminal.ts")]
    #[serde(tag = "operation", content = "result")]
    enum TerminalResultContract {
        #[serde(rename = "session.open")]
        Open(OpenResult),
        #[serde(rename = "session.close")]
        Close(CloseResult),
        #[serde(rename = "session.destroy")]
        Destroy(DestroyResult),
    }

    #[derive(Deserialize)]
    struct GoldenFixtures {
        client: Vec<String>,
        server: Vec<String>,
    }

    const ID: &str = "67e55044-10b1-426f-9247-bb680e5fe0c8";

    #[test]
    #[ignore = "writes checked-in TypeScript protocol bindings"]
    fn export_protocol_bindings() {
        let config = Config::from_env();
        TerminalRequestContract::export_all(&config).unwrap();
        TerminalCommandContract::export_all(&config).unwrap();
        TerminalEventContract::export_all(&config).unwrap();
        TerminalResultContract::export_all(&config).unwrap();
    }

    #[test]
    fn parses_open_and_binary_input_frames() {
        let frame = format!(
            r#"{{"version":1,"kind":"request","id":"{ID}","operation":"session.open","payload":{{"user":"cyberos","cols":120,"rows":32,"sessionName":"cyberos-demo","persistent":true}}}}"#
        );
        let Request::Open { payload, .. } = ClientFrame::parse(frame.as_bytes())
            .unwrap()
            .into_request()
            .unwrap()
        else {
            panic!("expected open request");
        };
        assert_eq!(payload.session_name.as_deref(), Some("cyberos-demo"));

        let frame = format!(
            r#"{{"version":1,"kind":"command","streamId":"{ID}","operation":"terminal.input","payload":{{"data":"cHdkDQ=="}}}}"#
        );
        let Command::Input { data, .. } = ClientFrame::parse(frame.as_bytes())
            .unwrap()
            .into_command()
            .unwrap()
        else {
            panic!("expected input command");
        };
        assert_eq!(data, b"pwd\r");
    }

    #[test]
    fn rejects_unknown_fields_versions_and_invalid_bounds() {
        let unknown = format!(
            r#"{{"version":1,"kind":"request","id":"{ID}","operation":"session.open","payload":{{"user":"cyberos","cols":120,"rows":32}},"extra":true}}"#
        );
        assert!(ClientFrame::parse(unknown.as_bytes()).is_err());
        let version = format!(
            r#"{{"version":2,"kind":"request","id":"{ID}","operation":"session.open","payload":{{"user":"cyberos","cols":120,"rows":32}}}}"#
        );
        assert!(ClientFrame::parse(version.as_bytes()).is_err());
        let dimensions = format!(
            r#"{{"version":1,"kind":"request","id":"{ID}","operation":"session.open","payload":{{"user":"cyberos","cols":1,"rows":32}}}}"#
        );
        assert!(
            ClientFrame::parse(dimensions.as_bytes())
                .unwrap()
                .into_request()
                .is_err()
        );
    }

    #[test]
    fn enforces_canonical_uuid_and_base64_encodings() {
        for id in [
            "67e5504410b1426f9247bb680e5fe0c8",
            "67e55044-10b1-026f-9247-bb680e5fe0c8",
            "67e55044-10b1-426f-7247-bb680e5fe0c8",
            "67e55044-10b1-926f-9247-bb680e5fe0c8",
        ] {
            assert!(validate_request_id(id).is_err(), "accepted invalid id {id}");
        }
        assert!(validate_request_id(&ID.to_ascii_uppercase()).is_ok());

        for data in ["Zh==", "Zg", "***"] {
            let frame = format!(
                r#"{{"version":1,"kind":"command","streamId":"{ID}","operation":"terminal.input","payload":{{"data":"{data}"}}}}"#
            );
            assert!(
                ClientFrame::parse(frame.as_bytes())
                    .unwrap()
                    .into_command()
                    .is_err(),
                "accepted invalid base64 {data}"
            );
        }
    }

    #[test]
    fn encodes_protocol_envelopes() {
        let response =
            ResponseEnvelope::success(ID.to_owned(), serde_json::json!({"streamId": ID}));
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["kind"], "response");
        assert_eq!(value["result"]["streamId"], ID);

        let output = EventEnvelope::output(ID.to_owned(), "终端".as_bytes());
        let value = serde_json::to_value(output).unwrap();
        assert_eq!(value["event"], "terminal.output");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(value["payload"]["data"].as_str().unwrap())
                .unwrap(),
            "终端".as_bytes()
        );
    }

    #[test]
    fn accepts_the_shared_golden_client_frames() {
        let fixtures: GoldenFixtures = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/shared/fixtures/terminal-protocol-v1.json"
        )))
        .unwrap();
        for frame in fixtures.client {
            match ClientFrame::parse(frame.as_bytes()).unwrap() {
                frame @ ClientFrame::Request { .. } => {
                    frame.into_request().unwrap();
                }
                frame @ ClientFrame::Command { .. } => {
                    frame.into_command().unwrap();
                }
            }
        }
        for frame in fixtures.server {
            let value: Value = serde_json::from_str(&frame).unwrap();
            assert_eq!(round_trip_server_fixture(&value), value);
        }
    }

    fn round_trip_server_fixture(value: &Value) -> Value {
        let id = value
            .get("id")
            .or_else(|| value.get("streamId"))
            .and_then(Value::as_str)
            .unwrap()
            .to_owned();
        match (
            value["kind"].as_str(),
            value["ok"].as_bool(),
            value["event"].as_str(),
        ) {
            (Some("response"), Some(true), _) => {
                let result = value["result"].clone();
                let response = if result.get("streamId").is_some() {
                    ResponseEnvelope::success(
                        id,
                        serde_json::from_value::<OpenResult>(result).unwrap(),
                    )
                } else if result.get("closed").is_some() {
                    ResponseEnvelope::success(
                        id,
                        serde_json::from_value::<CloseResult>(result).unwrap(),
                    )
                } else {
                    ResponseEnvelope::success(
                        id,
                        serde_json::from_value::<DestroyResult>(result).unwrap(),
                    )
                };
                serde_json::to_value(response).unwrap()
            }
            (Some("response"), Some(false), _) => serde_json::to_value(ResponseEnvelope {
                version: PROTOCOL_VERSION,
                kind: "response",
                id,
                ok: false,
                result: None,
                error: Some(serde_json::from_value(value["error"].clone()).unwrap()),
            })
            .unwrap(),
            (Some("event"), _, Some("terminal.output")) => serde_json::to_value(EventEnvelope {
                version: PROTOCOL_VERSION,
                kind: "event",
                stream_id: id,
                event: "terminal.output",
                payload: serde_json::from_value::<OutputPayload>(value["payload"].clone()).unwrap(),
            })
            .unwrap(),
            (Some("event"), _, Some("terminal.exit")) => serde_json::to_value(EventEnvelope {
                version: PROTOCOL_VERSION,
                kind: "event",
                stream_id: id,
                event: "terminal.exit",
                payload: serde_json::from_value::<ExitPayload>(value["payload"].clone()).unwrap(),
            })
            .unwrap(),
            (Some("event"), _, Some("terminal.error")) => serde_json::to_value(EventEnvelope {
                version: PROTOCOL_VERSION,
                kind: "event",
                stream_id: id,
                event: "terminal.error",
                payload: serde_json::from_value::<StreamErrorPayload>(value["payload"].clone())
                    .unwrap(),
            })
            .unwrap(),
            _ => panic!("unexpected Terminal server fixture: {value}"),
        }
    }
}
