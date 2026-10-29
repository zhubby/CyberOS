//! Narrow, typed entry point to the fixed LIO helper. All requests run under
//! the same storage mutex as pool deletion in `server`.
use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::fs;

use crate::command::{CommandRunner, DEFAULT_OUTPUT_LIMIT};
use crate::error::{ErrorCode, HostdError};

const HELPER: &str = "/usr/lib/cyberos/helpers/iscsi.py";

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdIscsiChapInput"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChapInput {
    enabled: bool,
    username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    password: Option<String>,
}

impl std::fmt::Debug for ChapInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChapInput")
            .field("enabled", &self.enabled)
            .field("username", &self.username)
            .field("password", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdIscsiRequest"))]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum IscsiRequest {
    Read {},
    CreateTarget {
        confirmed: bool,
        expected_revision: String,
        name: String,
        address: String,
        port: u16,
        initiators: Vec<String>,
        chap: ChapInput,
        enabled: bool,
    },
    UpdateTarget {
        confirmed: bool,
        expected_revision: String,
        target_id: String,
        name: String,
        address: String,
        port: u16,
        initiators: Vec<String>,
        chap: ChapInput,
    },
    SetTargetEnabled {
        confirmed: bool,
        expected_revision: String,
        target_id: String,
        enabled: bool,
    },
    DeleteTarget {
        confirmed: bool,
        expected_revision: String,
        target_id: String,
        destroy_images: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        confirmation: Option<String>,
    },
    CreateLun {
        confirmed: bool,
        expected_revision: String,
        target_id: String,
        name: String,
        storage_pool_id: String,
        size_bytes: u64,
    },
    AttachLun {
        confirmed: bool,
        expected_revision: String,
        target_id: String,
        image_id: String,
    },
    DetachLun {
        confirmed: bool,
        expected_revision: String,
        target_id: String,
        image_id: String,
        destroy_image: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(test, ts(optional))]
        confirmation: Option<String>,
    },
    DestroyImage {
        confirmed: bool,
        expected_revision: String,
        image_id: String,
        confirmation: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdIscsiSummary"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IscsiSummary {
    collected_at: String,
    revision: String,
    available: bool,
    error: Option<String>,
    listen_addresses: Vec<String>,
    pools: Vec<IscsiPool>,
    targets: Vec<IscsiTarget>,
    images: Vec<IscsiImage>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdIscsiPool"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IscsiPool {
    id: String,
    name: String,
    available_bytes: Option<u64>,
    ready: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdIscsiImage"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IscsiImage {
    id: String,
    name: String,
    storage_pool_id: String,
    size_bytes: u64,
    attached_target_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdIscsiTarget"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IscsiTarget {
    id: String,
    name: String,
    iqn: String,
    address: String,
    port: u16,
    enabled: bool,
    chap_enabled: bool,
    chap_username: Option<String>,
    credential_configured: bool,
    initiators: Vec<String>,
    status: IscsiTargetStatus,
    error: Option<String>,
    luns: Vec<IscsiLun>,
    sessions: Vec<IscsiSession>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdIscsiTargetStatus"))]
#[serde(rename_all = "snake_case")]
enum IscsiTargetStatus {
    Running,
    Disabled,
    Degraded,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdIscsiLun"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IscsiLun {
    image_id: String,
    lun: u16,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdIscsiSession"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IscsiSession {
    initiator: String,
    address: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredState {
    version: u8,
    targets: Vec<StoredTarget>,
    images: Vec<IscsiImage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTarget {
    id: String,
    name: String,
    iqn: String,
    address: String,
    port: u16,
    initiators: Vec<String>,
    chap: ChapInput,
    #[serde(rename = "enabled")]
    _enabled: bool,
    luns: Vec<IscsiLun>,
}

fn valid_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 64
        && value.trim() == value
        && value
            .chars()
            .all(|character| character >= ' ' && character != '\u{7f}')
}

fn valid_pool(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || (index > 0 && (byte.is_ascii_digit() || matches!(byte, b'_' | b'-')))
        })
}

fn valid_iqn(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("iqn.") else {
        return false;
    };
    let Some((date, qualified)) = rest.split_once('.') else {
        return false;
    };
    date.len() == 7
        && date.as_bytes()[4] == b'-'
        && date[..4].bytes().all(|byte| byte.is_ascii_digit())
        && date[5..]
            .parse::<u8>()
            .is_ok_and(|month| (1..=12).contains(&month))
        && !qualified.is_empty()
        && qualified.as_bytes()[0].is_ascii_alphanumeric()
        && qualified.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'-' | b'_' | b':')
        })
        && value.len() <= 223
}

impl StoredState {
    fn validate(&self) -> Result<(), HostdError> {
        let invalid = || HostdError::unavailable("iSCSI state is invalid");
        if self.version != 1 {
            return Err(invalid());
        }
        let mut images = BTreeSet::new();
        for image in &self.images {
            if !valid_id(&image.id)
                || !images.insert(&image.id)
                || !valid_name(&image.name)
                || !valid_pool(&image.storage_pool_id)
                || image.size_bytes < 1_073_741_824
                || image.size_bytes > 9_007_199_254_740_991
                || !image.size_bytes.is_multiple_of(1_073_741_824)
                || image
                    .attached_target_id
                    .as_deref()
                    .is_some_and(|id| !valid_id(id))
            {
                return Err(invalid());
            }
        }
        let mut targets = BTreeSet::new();
        let mut attachments = BTreeSet::new();
        for target in &self.targets {
            let address = target
                .address
                .parse::<std::net::IpAddr>()
                .map_err(|_| invalid())?;
            let local_only = match address {
                std::net::IpAddr::V4(address) => address.is_link_local(),
                std::net::IpAddr::V6(address) => address.is_unicast_link_local(),
            };
            if !valid_id(&target.id)
                || !targets.insert(&target.id)
                || !valid_name(&target.name)
                || target.iqn != format!("iqn.2026-10.local.cyberos:{}", target.id)
                || address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || local_only
                || target.port == 0
                || target.initiators.is_empty()
                || target.initiators.len() > 64
                || target.initiators.iter().any(|iqn| !valid_iqn(iqn))
                || target.initiators.iter().collect::<BTreeSet<_>>().len()
                    != target.initiators.len()
            {
                return Err(invalid());
            }
            if target.chap.enabled
                && (target.chap.username.is_empty()
                    || target.chap.username.len() > 128
                    || !target
                        .chap
                        .username
                        .bytes()
                        .all(|byte| (33..=126).contains(&byte))
                    || !target.chap.password.as_ref().is_some_and(|password| {
                        (12..=16).contains(&password.len())
                            && password.bytes().all(|byte| (32..=126).contains(&byte))
                    }))
            {
                return Err(invalid());
            }
            let mut numbers = BTreeSet::new();
            for lun in &target.luns {
                let Some(image) = self.images.iter().find(|image| image.id == lun.image_id) else {
                    return Err(invalid());
                };
                if lun.lun > 255
                    || !numbers.insert(lun.lun)
                    || !attachments.insert(&lun.image_id)
                    || image.attached_target_id.as_deref() != Some(&target.id)
                {
                    return Err(invalid());
                }
            }
        }
        if self
            .images
            .iter()
            .any(|image| image.attached_target_id.is_some() && !attachments.contains(&image.id))
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn export_protocol_bindings(config: &ts_rs::Config) {
    use ts_rs::TS;
    IscsiRequest::export_all(config).unwrap();
    IscsiSummary::export_all(config).unwrap();
}

pub(crate) async fn handle(
    request: IscsiRequest,
    runner: &dyn CommandRunner,
    data_root: &Path,
) -> Result<IscsiSummary, HostdError> {
    let value = serde_json::to_value(request)
        .map_err(|_| HostdError::validation("Invalid iSCSI request"))?;
    invoke(value, runner, data_root).await
}

pub(crate) async fn reconcile(
    runner: &dyn CommandRunner,
    data_root: &Path,
) -> Result<(), HostdError> {
    invoke(json!({ "action": "reconcile" }), runner, data_root)
        .await
        .map(|_| ())
}

async fn invoke(
    request: Value,
    runner: &dyn CommandRunner,
    data_root: &Path,
) -> Result<IscsiSummary, HostdError> {
    let input = serde_json::to_vec(&json!({ "dataRoot": data_root, "request": request }))
        .map_err(|_| HostdError::validation("Invalid iSCSI request"))?;
    let output = runner
        .run(
            "/usr/bin/python3",
            &[HELPER.to_owned()],
            Some(&input),
            Duration::from_secs(120),
            DEFAULT_OUTPUT_LIMIT,
        )
        .await?;
    // Never forward helper stderr: library failures may contain authentication
    // values. The helper's structured error messages are deliberately static.
    if !output.success {
        return Err(HostdError::unavailable("iSCSI helper is unavailable"));
    }
    let value: Value = serde_json::from_str(&output.stdout)
        .map_err(|_| HostdError::operation_failed("Invalid iSCSI helper response"))?;
    if value.get("ok") == Some(&Value::Bool(true)) {
        return serde_json::from_value(value["result"].clone())
            .map_err(|_| HostdError::operation_failed("Invalid iSCSI helper status"));
    }
    let error = &value["error"];
    let status = error["status"].as_u64().unwrap_or(502);
    let status = if (400..=599).contains(&status) {
        status as u16
    } else {
        502
    };
    let code = match error["code"].as_str() {
        Some("validation") => ErrorCode::Validation,
        Some("forbidden") => ErrorCode::Forbidden,
        Some("not_found") => ErrorCode::NotFound,
        Some("conflict") => ErrorCode::Conflict,
        Some("unavailable") => ErrorCode::Unavailable,
        _ => ErrorCode::OperationFailed,
    };
    Err(HostdError::new(
        status,
        code,
        error["message"]
            .as_str()
            .unwrap_or("iSCSI operation failed"),
    ))
}

/// Also checks the transaction journal: a retained, new, or pending-deletion
/// image prevents pool removal until the iSCSI operation has finished.
pub(crate) async fn assert_pool_unused(
    data_root: &Path,
    pool_name: &str,
) -> Result<(), HostdError> {
    let root = data_root
        .parent()
        .ok_or_else(|| HostdError::validation("Invalid data root"))?;
    let state_dir = root.join("state/hostd/iscsi");
    match fs::symlink_metadata(&state_dir).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(HostdError::unavailable("Cannot inspect iSCSI state")),
        Ok(entry)
            if !entry.is_dir()
                || entry.file_type().is_symlink()
                || entry.uid() != nix::unistd::Uid::effective().as_raw()
                || entry.mode() & 0o077 != 0 =>
        {
            return Err(HostdError::unavailable("iSCSI state directory is unsafe"));
        }
        Ok(_) => {}
    }
    if fs::canonicalize(&state_dir).await? != state_dir {
        return Err(HostdError::unavailable("iSCSI state directory is unsafe"));
    }
    for name in ["state.json", "pending.json"] {
        let path = state_dir.join(name);
        use tokio::io::AsyncReadExt;
        let mut file = match fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&path)
            .await
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(HostdError::unavailable("Cannot inspect iSCSI state")),
        };
        let entry = file.metadata().await?;
        if !entry.is_file()
            || entry.uid() != nix::unistd::Uid::effective().as_raw()
            || entry.mode() & 0o077 != 0
            || entry.nlink() != 1
            || entry.len() > 4 * 1024 * 1024
        {
            return Err(HostdError::unavailable("iSCSI state file is unsafe"));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| HostdError::unavailable("iSCSI state is invalid"))?;
        if name == "pending.json" {
            validate_journal(&value)?;
            assert_registry_unused(&value["previous"], pool_name)?;
            assert_registry_unused(&value["desired"], pool_name)?;
        } else {
            assert_registry_unused(&value, pool_name)?;
        }
    }
    Ok(())
}

fn validate_journal(value: &Value) -> Result<(), HostdError> {
    let invalid = || HostdError::unavailable("iSCSI recovery journal is invalid");
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() != 4
        || !["previous", "desired", "created", "destroyed"]
            .iter()
            .all(|key| object.contains_key(*key))
    {
        return Err(invalid());
    }
    let previous: StoredState =
        serde_json::from_value(value["previous"].clone()).map_err(|_| invalid())?;
    let desired: StoredState =
        serde_json::from_value(value["desired"].clone()).map_err(|_| invalid())?;
    previous.validate()?;
    desired.validate()?;
    let created: Vec<IscsiImage> =
        serde_json::from_value(value["created"].clone()).map_err(|_| invalid())?;
    let destroyed: Vec<IscsiImage> =
        serde_json::from_value(value["destroyed"].clone()).map_err(|_| invalid())?;
    let expected_created: BTreeSet<_> = desired
        .images
        .iter()
        .filter(|image| !previous.images.iter().any(|old| old.id == image.id))
        .map(|image| &image.id)
        .collect();
    let expected_destroyed: BTreeSet<_> = previous
        .images
        .iter()
        .filter(|image| !desired.images.iter().any(|new| new.id == image.id))
        .map(|image| &image.id)
        .collect();
    if created
        .iter()
        .map(|image| &image.id)
        .collect::<BTreeSet<_>>()
        != expected_created
        || destroyed
            .iter()
            .map(|image| &image.id)
            .collect::<BTreeSet<_>>()
            != expected_destroyed
    {
        return Err(invalid());
    }
    for image in created.iter().chain(&destroyed) {
        let registered = previous
            .images
            .iter()
            .chain(&desired.images)
            .find(|entry| entry.id == image.id)
            .ok_or_else(invalid)?;
        if image.name != registered.name
            || image.storage_pool_id != registered.storage_pool_id
            || image.size_bytes != registered.size_bytes
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn assert_registry_unused(value: &Value, pool_name: &str) -> Result<(), HostdError> {
    let state: StoredState = serde_json::from_value(value.clone())
        .map_err(|_| HostdError::unavailable("iSCSI state is invalid"))?;
    state.validate()?;
    if state
        .images
        .iter()
        .any(|image| image.storage_pool_id == pool_name)
    {
        return Err(HostdError::conflict(
            "Remove all iSCSI images, including retained images, before deleting this pool",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::CommandOutput;
    use async_trait::async_trait;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    #[test]
    fn rejects_extra_fields_and_secret_debug_output() {
        assert!(
            serde_json::from_value::<IscsiRequest>(json!({ "action": "read", "path": "/etc" }))
                .is_err()
        );
        let chap = ChapInput {
            enabled: true,
            username: "user".into(),
            password: Some("sensitive-value".into()),
        };
        assert!(!format!("{chap:?}").contains("sensitive-value"));
    }

    #[tokio::test]
    async fn retained_images_and_pending_transactions_block_pool_deletion() {
        let temp = TempDir::new().unwrap();
        let root = fs::canonicalize(temp.path()).await.unwrap();
        let state_dir = root.join("state/hostd/iscsi");
        fs::create_dir_all(&state_dir).await.unwrap();
        fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        let state = json!({"version":1,"targets":[],"images":[{"id":"27f9f605-a5e5-4421-84f1-8b41d8973710","name":"retained","sizeBytes":1073741824,"storagePoolId":"pool-1","attachedTargetId":null}]});
        fs::write(state_dir.join("state.json"), state.to_string())
            .await
            .unwrap();
        fs::set_permissions(
            state_dir.join("state.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .await
        .unwrap();
        assert_eq!(
            assert_pool_unused(&root.join("data"), "pool-1")
                .await
                .unwrap_err()
                .status,
            409
        );
        assert!(
            assert_pool_unused(&root.join("data"), "pool-2")
                .await
                .is_ok()
        );
        fs::write(state_dir.join("state.json"), "broken")
            .await
            .unwrap();
        assert_eq!(
            assert_pool_unused(&root.join("data"), "pool-2")
                .await
                .unwrap_err()
                .status,
            503
        );
    }

    #[tokio::test]
    async fn pending_image_allocation_blocks_deletion_before_state_commit() {
        let temp = TempDir::new().unwrap();
        let root = fs::canonicalize(temp.path()).await.unwrap();
        let state_dir = root.join("state/hostd/iscsi");
        fs::create_dir_all(&state_dir).await.unwrap();
        fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        let previous = json!({"version":1,"targets":[],"images":[]});
        let desired = json!({"version":1,"targets":[],"images":[{"id":"27f9f605-a5e5-4421-84f1-8b41d8973710","name":"retained","sizeBytes":1073741824,"storagePoolId":"pool-1","attachedTargetId":null}]});
        fs::write(
            state_dir.join("pending.json"),
            json!({"previous":previous,"created":desired["images"],"desired":desired,"destroyed":[]}).to_string(),
        )
        .await
        .unwrap();
        fs::set_permissions(
            state_dir.join("pending.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .await
        .unwrap();
        assert_eq!(
            assert_pool_unused(&root.join("data"), "pool-1")
                .await
                .unwrap_err()
                .status,
            409
        );
    }

    #[test]
    fn public_names_do_not_block_unrelated_pool_deletion() {
        let state = json!({"version":1,"targets":[],"images":[{"id":"27f9f605-a5e5-4421-84f1-8b41d8973710","name":"disk\u{0085}name","sizeBytes":1073741824,"storagePoolId":"pool-1","attachedTargetId":null}]});
        assert!(assert_registry_unused(&state, "pool-2").is_ok());
    }

    #[test]
    fn broken_target_references_fail_closed_even_for_another_pool() {
        let state = json!({"version":1,"targets":[{"id":"27f9f605-a5e5-4421-84f1-8b41d8973710","name":"target","iqn":"iqn.2026-10.local.cyberos:27f9f605-a5e5-4421-84f1-8b41d8973710","address":"192.0.2.10","port":3260,"initiators":["iqn.2026-10.example:client"],"chap":{"enabled":false,"username":""},"enabled":true,"luns":[{"imageId":"bd7ca91b-3f94-41f9-8347-857a5295071d","lun":0}]}],"images":[]});
        assert_eq!(
            assert_registry_unused(&state, "unrelated")
                .unwrap_err()
                .status,
            503
        );
    }

    struct FakeRunner;

    #[async_trait]
    impl CommandRunner for FakeRunner {
        async fn run(
            &self,
            command: &str,
            args: &[String],
            input: Option<&[u8]>,
            _: Duration,
            _: usize,
        ) -> Result<CommandOutput, HostdError> {
            assert_eq!(command, "/usr/bin/python3");
            assert_eq!(args, [HELPER]);
            let request: Value = serde_json::from_slice(input.unwrap()).unwrap();
            assert_eq!(request["request"]["action"], "read");
            assert_eq!(request["dataRoot"], "/cyberos/data");
            Ok(CommandOutput { success:true, stderr:"password=do-not-return".into(), stdout:json!({"ok":true,"result":{"collectedAt":"2026-10-29T00:00:00Z","revision":"0".repeat(64),"available":false,"error":"unavailable","listenAddresses":[],"pools":[],"targets":[],"images":[]}}).to_string() })
        }
    }

    #[tokio::test]
    async fn passes_fixed_helper_and_structured_input_without_exposing_stderr() {
        let status = handle(
            IscsiRequest::Read {},
            &FakeRunner,
            Path::new("/cyberos/data"),
        )
        .await
        .unwrap();
        assert!(!status.available);
        assert!(
            !serde_json::to_string(&status)
                .unwrap()
                .contains("do-not-return")
        );
    }
}
