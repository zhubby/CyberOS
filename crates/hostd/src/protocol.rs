use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ErrorCode, HostdError};
use crate::ops::{OpsRequest, OpsResult};
use crate::power::{PowerRequest, PowerResult};
use crate::shares::{ShareApplyRequest, ShareApplyResult};
use crate::storage::{StorageCommand, StorageCommandResult, StorageOperation, StorageResult};
use crate::tv::{TvRequest, TvResult};
use crate::{bluetooth, docker_daemon, network_manager};

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestEnvelope {
    pub version: u8,
    pub id: String,
    pub operation: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts"))]
pub(crate) enum HostdOperation {
    #[serde(rename = "shares.apply")]
    SharesApply,
    #[serde(rename = "storage.command")]
    StorageCommand,
    #[serde(rename = "storage.operation")]
    StorageOperation,
    #[serde(rename = "docker.daemon")]
    DockerDaemon,
    #[serde(rename = "network.manager")]
    NetworkManager,
    #[serde(rename = "bluetooth.manager")]
    BluetoothManager,
    #[serde(rename = "system.power")]
    SystemPower,
    #[serde(rename = "system.ops")]
    SystemOps,
    #[serde(rename = "system.tv")]
    SystemTv,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdRequestContract"))]
#[serde(tag = "operation", content = "payload")]
pub(crate) enum HostdRequest {
    #[serde(rename = "shares.apply")]
    SharesApply(ShareApplyRequest),
    #[serde(rename = "storage.command")]
    StorageCommand(StorageCommand),
    #[serde(rename = "storage.operation")]
    StorageOperation(StorageOperation),
    #[serde(rename = "docker.daemon")]
    DockerDaemon(docker_daemon::DockerRequest),
    #[serde(rename = "network.manager")]
    NetworkManager(network_manager::NetworkRequest),
    #[serde(rename = "bluetooth.manager")]
    BluetoothManager(bluetooth::BluetoothRequest),
    #[serde(rename = "system.power")]
    SystemPower(PowerRequest),
    #[serde(rename = "system.ops")]
    SystemOps(OpsRequest),
    #[serde(rename = "system.tv")]
    SystemTv(TvRequest),
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum HostdResult {
    SharesApply(ShareApplyResult),
    StorageCommand(StorageCommandResult),
    StorageOperation(StorageResult),
    DockerDaemon(docker_daemon::DockerResult),
    NetworkManager(network_manager::NetworkResult),
    BluetoothManager(bluetooth::BluetoothResult),
    SystemPower(PowerResult),
    SystemOps(OpsResult),
    SystemTv(TvResult),
}

#[derive(Debug, Serialize)]
pub struct ResponseEnvelope {
    pub version: u8,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorEnvelope>,
}

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope {
    pub status: u16,
    pub code: ErrorCode,
    pub message: String,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl RequestEnvelope {
    pub fn parse(frame: &[u8]) -> Result<Self, HostdError> {
        let request: Self = serde_json::from_slice(frame).map_err(|_| {
            HostdError::new(
                400,
                ErrorCode::ProtocolError,
                "Invalid JSONL request envelope",
            )
        })?;
        if request.version != PROTOCOL_VERSION {
            return Err(HostdError::new(
                400,
                ErrorCode::ProtocolError,
                "Unsupported hostd protocol version",
            ));
        }
        uuid::Uuid::parse_str(&request.id)
            .map_err(|_| HostdError::new(400, ErrorCode::ProtocolError, "Invalid request id"))?;
        if request.operation.is_empty() || request.operation.len() > 64 {
            return Err(HostdError::new(
                400,
                ErrorCode::ProtocolError,
                "Invalid operation name",
            ));
        }
        Ok(request)
    }

    pub(crate) fn into_contract(self) -> Result<HostdRequest, HostdError> {
        let operation = HostdOperation::parse(&self.operation)?;
        if matches!(operation, HostdOperation::BluetoothManager)
            && !bluetooth::request_has_exact_fields(&self.payload)
        {
            return Err(HostdError::validation(operation.invalid_payload_message()));
        }
        serde_json::from_value(serde_json::json!({
            "operation": self.operation,
            "payload": self.payload,
        }))
        .map_err(|_| HostdError::validation(operation.invalid_payload_message()))
    }
}

impl HostdOperation {
    fn parse(value: &str) -> Result<Self, HostdError> {
        serde_json::from_value(Value::String(value.to_owned()))
            .map_err(|_| HostdError::new(404, ErrorCode::NotFound, "Unknown hostd operation"))
    }

    fn invalid_payload_message(self) -> &'static str {
        match self {
            Self::SharesApply => "Invalid shares.apply payload",
            Self::StorageCommand => "Invalid storage command request",
            Self::StorageOperation => "Invalid storage operation request",
            Self::DockerDaemon => "Invalid Docker daemon request",
            Self::NetworkManager => "Invalid NetworkManager request",
            Self::BluetoothManager => "Invalid Bluetooth request",
            Self::SystemPower => "A confirmed power action is required",
            Self::SystemOps => "Invalid system.ops payload",
            Self::SystemTv => "Invalid system.tv payload",
        }
    }
}

impl ResponseEnvelope {
    pub fn success(id: String, result: Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(id: String, error: HostdError) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id,
            ok: false,
            result: None,
            error: Some(ErrorEnvelope {
                status: error.status,
                code: error.code,
                message: error.message,
                details: error.details,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_rs::{Config, TS};

    #[derive(Deserialize)]
    struct GoldenFixtures {
        contracts: Vec<GoldenContract>,
    }

    #[derive(Deserialize)]
    struct GoldenContract {
        operation: String,
        request: Value,
        result: Value,
    }

    #[allow(dead_code)]
    #[derive(Serialize, TS)]
    #[ts(export_to = "hostd.ts")]
    #[serde(tag = "operation", content = "result")]
    enum HostdResultContract {
        #[serde(rename = "shares.apply")]
        SharesApply(ShareApplyResult),
        #[serde(rename = "storage.command")]
        StorageCommand(StorageCommandResult),
        #[serde(rename = "storage.operation")]
        StorageOperation(StorageResult),
        #[serde(rename = "docker.daemon")]
        DockerDaemon(docker_daemon::DockerResult),
        #[serde(rename = "network.manager")]
        NetworkManager(network_manager::NetworkResult),
        #[serde(rename = "bluetooth.manager")]
        BluetoothManager(bluetooth::BluetoothResult),
        #[serde(rename = "system.power")]
        SystemPower(PowerResult),
        #[serde(rename = "system.ops")]
        SystemOps(OpsResult),
        #[serde(rename = "system.tv")]
        SystemTv(TvResult),
    }

    #[test]
    #[ignore = "writes checked-in TypeScript protocol bindings"]
    fn export_protocol_bindings() {
        let config = Config::from_env();
        HostdOperation::export_all(&config).unwrap();
        HostdRequest::export_all(&config).unwrap();
        HostdResultContract::export_all(&config).unwrap();
        ErrorCode::export_all(&config).unwrap();
        crate::shares::export_protocol_bindings(&config);
        crate::storage::export_protocol_bindings(&config);
        crate::docker_daemon::export_protocol_bindings(&config);
        crate::network_manager::export_protocol_bindings(&config);
        crate::bluetooth::export_protocol_bindings(&config);
        crate::power::export_protocol_bindings(&config);
        crate::ops::export_protocol_bindings(&config);
        crate::tv::export_protocol_bindings(&config);
    }

    #[test]
    fn parses_a_valid_request() {
        let request = RequestEnvelope::parse(
            br#"{"version":1,"id":"67e55044-10b1-426f-9247-bb680e5fe0c8","operation":"shares.apply","payload":{}}"#,
        )
        .unwrap();
        assert_eq!(request.operation, "shares.apply");
    }

    #[test]
    fn rejects_unknown_fields_and_versions() {
        assert!(RequestEnvelope::parse(
            br#"{"version":2,"id":"67e55044-10b1-426f-9247-bb680e5fe0c8","operation":"shares.apply","payload":{}}"#
        )
        .is_err());
        assert!(RequestEnvelope::parse(
            br#"{"version":1,"id":"67e55044-10b1-426f-9247-bb680e5fe0c8","operation":"shares.apply","payload":{},"extra":true}"#
        )
        .is_err());
    }

    #[test]
    fn accepts_the_shared_operation_and_action_fixtures() {
        let fixtures: GoldenFixtures = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/shared/fixtures/hostd-protocol-v1.json"
        )))
        .unwrap();
        assert_eq!(fixtures.contracts.len(), 29);

        for contract in fixtures.contracts {
            let frame = serde_json::to_vec(&serde_json::json!({
                "version": PROTOCOL_VERSION,
                "id": "67e55044-10b1-426f-9247-bb680e5fe0c8",
                "operation": &contract.operation,
                "payload": &contract.request,
            }))
            .unwrap();
            let request = RequestEnvelope::parse(&frame).unwrap();
            let parsed = serde_json::to_value(request.into_contract().unwrap()).unwrap();
            assert_eq!(parsed["operation"], contract.operation);
            assert_eq!(
                parsed["payload"].get("action"),
                contract.request.get("action")
            );
            assert!(contract.result.is_object());
        }
    }

    #[test]
    fn rejects_unknown_contract_operations_and_actions() {
        for (operation, payload) in [
            ("unknown", serde_json::json!({})),
            ("docker.daemon", serde_json::json!({ "action": "unknown" })),
            (
                "network.manager",
                serde_json::json!({ "action": "unknown" }),
            ),
            (
                "bluetooth.manager",
                serde_json::json!({ "action": "unknown" }),
            ),
            (
                "bluetooth.manager",
                serde_json::json!({ "action": "status", "extra": true }),
            ),
            (
                "storage.operation",
                serde_json::json!({ "action": "unknown" }),
            ),
            (
                "system.power",
                serde_json::json!({ "action": "unknown", "confirmed": true }),
            ),
            (
                "system.ops",
                serde_json::json!({ "task": "unknown", "confirmed": true }),
            ),
            ("shares.apply", serde_json::json!({})),
        ] {
            assert!(
                RequestEnvelope {
                    version: PROTOCOL_VERSION,
                    id: "67e55044-10b1-426f-9247-bb680e5fe0c8".to_owned(),
                    operation: operation.to_owned(),
                    payload,
                }
                .into_contract()
                .is_err(),
                "accepted invalid {operation} contract"
            );
        }
    }
}
