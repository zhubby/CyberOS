use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::HostdError;

pub(super) const CONFIG_PATH: &str = "/etc/docker/daemon.json";
const STATE_DIR: &str = "/cyberos/state/hostd/docker-daemon";
pub(super) const MAX_CONFIG_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct DockerOptions {
    pub config_path: PathBuf,
    pub state_dir: PathBuf,
}

impl Default for DockerOptions {
    fn default() -> Self {
        Self {
            config_path: CONFIG_PATH.into(),
            state_dir: STATE_DIR.into(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdDockerDaemonRequest"))]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum DockerRequest {
    Read,
    Update { input: DockerUpdateInput },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdDockerDaemonUpdateInput")
)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DockerUpdateInput {
    pub(super) content: String,
    pub(super) expected_revision: String,
    pub(super) restart: bool,
    pub(super) confirmed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdDockerDaemonSnapshot"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct DockerSnapshot {
    pub(super) path: &'static str,
    pub(super) content: String,
    pub(super) revision: String,
    pub(super) exists: bool,
    pub(super) restart_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdDockerDaemonUpdateResult")
)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DockerUpdateResult {
    pub(super) snapshot: DockerSnapshot,
    pub(super) restarted: bool,
    pub(super) rollback: RollbackStatus,
    pub(super) error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdDockerDaemonRollbackStatus")
)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RollbackStatus {
    NotRequired,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdDockerDaemonResult"))]
#[serde(untagged)]
pub(crate) enum DockerResult {
    Snapshot(DockerSnapshot),
    Update(DockerUpdateResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DockerTransaction {
    pub(super) baseline_exists: bool,
    pub(super) baseline_revision: String,
    pub(super) pending_revision: String,
}

#[derive(Debug, Clone)]
pub(super) struct DockerConfigFile {
    pub(super) content: String,
    pub(super) revision: String,
    pub(super) exists: bool,
}

pub(super) fn validate_input(input: &DockerUpdateInput) -> Result<(), HostdError> {
    if input.content.len() > MAX_CONFIG_BYTES {
        return Err(HostdError::validation(
            "Docker daemon configuration exceeds 256 KiB",
        ));
    }
    if input.expected_revision.len() != 64
        || !input
            .expected_revision
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    {
        return Err(HostdError::validation(
            "Docker daemon configuration revision is invalid",
        ));
    }
    if input.restart && !input.confirmed {
        return Err(HostdError::validation(
            "Docker restart confirmation is required",
        ));
    }
    let parsed: Value = serde_json::from_str(&input.content)
        .map_err(|_| HostdError::validation("Docker daemon configuration is not valid JSON"))?;
    if !parsed.is_object() {
        return Err(HostdError::validation(
            "Docker daemon configuration must be a JSON object",
        ));
    }
    Ok(())
}
