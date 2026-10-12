mod ethernet;
mod model;
mod nmcli;
mod profiles;
mod store;
mod validation;

#[cfg(test)]
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::fs;
use uuid::Uuid;

use crate::command::{CommandRunner, run_checked};
use crate::error::{ErrorCode, HostdError};

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::os::unix::fs::PermissionsExt;

#[cfg(test)]
use model::ConfirmedDeviceInput;
pub use model::NetworkOptions;
use model::{
    AccessPoint, ConnectInput, HotspotUpdateInput, InspectionResult, MANAGED_PREFIX,
    ManagedProfile, MutationResult, PingResult, ProfileDefinition, ProfileUpdateInput,
    RecoveryEntry, RollbackStatus, ScanInput, ScanResult,
};
pub(crate) use model::{NetworkRequest, NetworkResult};
use nmcli::{
    active_connection_uuid, assert_available, assert_client_profile, assert_wifi_device,
    is_connection_active, parse_frequency, parse_integer, restore_connection,
    run_owned as run_nmcli_owned, safe_reload, security as security_from_nmcli,
    split_line as split_nmcli_line,
};
use profiles::{
    create_keyfile, find_hotspot, find_profile, keyfile_value, parse_keyfile, read_profile,
    read_profiles,
};
use store::{atomic_write, read_recovery_state, remove_if_exists, write_recovery_state};
use validation::{validate_credential, validate_request};

#[cfg(test)]
pub(crate) fn export_protocol_bindings(config: &ts_rs::Config) {
    use ts_rs::TS;

    NetworkRequest::export_all(config).unwrap();
    NetworkResult::export_all(config).unwrap();
}

pub(crate) async fn handle(
    request: NetworkRequest,
    runner: &dyn CommandRunner,
) -> Result<NetworkResult, HostdError> {
    execute_with_options(request, runner, &NetworkOptions::default()).await
}

async fn execute_with_options(
    request: NetworkRequest,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<NetworkResult, HostdError> {
    validate_request(&request)?;
    let result = match request {
        NetworkRequest::Ping => {
            assert_available(runner).await?;
            NetworkResult::Ping(PingResult { ready: true })
        }
        NetworkRequest::Inspect => NetworkResult::Inspection(inspect(options).await?),
        NetworkRequest::EthernetStatus => {
            assert_available(runner).await?;
            NetworkResult::EthernetStatus(ethernet::status(runner, options).await?)
        }
        request => {
            assert_available(runner).await?;
            match request {
                NetworkRequest::Scan { input } => NetworkResult::Scan(scan(&input, runner).await?),
                NetworkRequest::Connect { input } => {
                    NetworkResult::Mutation(connect(&input, runner, options).await?)
                }
                NetworkRequest::Disconnect { input } => {
                    assert_wifi_device(&input.device, runner).await?;
                    run_checked(
                        runner,
                        "nmcli",
                        &["device", "disconnect", &input.device],
                        None,
                    )
                    .await?;
                    NetworkResult::Mutation(success_result())
                }
                NetworkRequest::Radio { input } => {
                    run_checked(
                        runner,
                        "nmcli",
                        &["radio", "wifi", if input.enabled { "on" } else { "off" }],
                        None,
                    )
                    .await?;
                    NetworkResult::Mutation(success_result())
                }
                NetworkRequest::UpdateProfile { profile_id, input } => NetworkResult::Mutation(
                    update_profile(&profile_id, &input, runner, options).await?,
                ),
                NetworkRequest::DeleteProfile { profile_id, .. } => {
                    NetworkResult::Mutation(delete_profile(&profile_id, runner, options).await?)
                }
                NetworkRequest::UpdateHotspot { input } => {
                    NetworkResult::Mutation(update_hotspot(&input, runner, options).await?)
                }
                NetworkRequest::StartHotspot { input } => {
                    NetworkResult::Mutation(start_hotspot(&input.device, runner, options).await?)
                }
                NetworkRequest::StopHotspot { input } => {
                    NetworkResult::Mutation(stop_hotspot(&input.device, runner, options).await?)
                }
                NetworkRequest::DeleteHotspot { input } => {
                    stop_hotspot(&input.device, runner, options).await?;
                    NetworkResult::Mutation(delete_hotspot(&input.device, runner, options).await?)
                }
                NetworkRequest::EthernetSave { device_id, input } => NetworkResult::EthernetStatus(
                    ethernet::save(&device_id, &input, runner, options).await?,
                ),
                NetworkRequest::EthernetApply { confirmed } => NetworkResult::EthernetTransaction(
                    ethernet::apply(confirmed, runner, options).await?,
                ),
                NetworkRequest::EthernetConfirm { transaction_id } => {
                    NetworkResult::EthernetTransaction(
                        ethernet::confirm(&transaction_id, runner, options).await?,
                    )
                }
                NetworkRequest::EthernetRollback { transaction_id } => {
                    NetworkResult::EthernetTransaction(
                        ethernet::rollback(&transaction_id, runner, options).await?,
                    )
                }
                NetworkRequest::Ping | NetworkRequest::Inspect | NetworkRequest::EthernetStatus => {
                    unreachable!()
                }
            }
        }
    };
    Ok(result)
}

#[cfg(test)]
async fn handle_with_options(
    payload: Value,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<Value, HostdError> {
    let request: NetworkRequest = serde_json::from_value(payload)
        .map_err(|_| HostdError::validation("Invalid NetworkManager request"))?;
    let result = execute_with_options(request, runner, options).await?;
    serde_json::to_value(result).map_err(|error| HostdError::operation_failed(error.to_string()))
}

async fn inspect(options: &NetworkOptions) -> Result<InspectionResult, HostdError> {
    let profiles = read_profiles(&options.connections_dir)
        .await?
        .into_iter()
        .map(|profile| profile.inspection)
        .collect::<Vec<_>>();
    Ok(InspectionResult {
        profiles,
        recovery: read_recovery_state(&options.state_dir).await?,
    })
}

pub(crate) async fn recover_on_startup(runner: &dyn CommandRunner) -> Result<(), HostdError> {
    ethernet::recover_on_startup(runner, &NetworkOptions::default()).await
}

pub(crate) async fn recover_expired_transaction(
    runner: &dyn CommandRunner,
) -> Result<(), HostdError> {
    ethernet::recover_expired(runner, &NetworkOptions::default()).await
}

async fn scan(input: &ScanInput, runner: &dyn CommandRunner) -> Result<ScanResult, HostdError> {
    assert_wifi_device(&input.device, runner).await?;
    let output = run_checked(
        runner,
        "nmcli",
        &[
            "--terse",
            "--escape",
            "yes",
            "--fields",
            "IN-USE,SSID,BSSID,MODE,CHAN,FREQ,SIGNAL,SECURITY",
            "device",
            "wifi",
            "list",
            "ifname",
            &input.device,
            "--rescan",
            "yes",
        ],
        None,
    )
    .await?;
    let access_points = output
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let fields = split_nmcli_line(line);
            if fields.len() < 8 || fields[1].is_empty() {
                return None;
            }
            let channel = parse_integer(&fields[4]).unwrap_or(0).max(0) as u16;
            let frequency = parse_frequency(&fields[5]).unwrap_or(0);
            Some(AccessPoint {
                active: fields[0] == "*" || fields[0] == "yes",
                ssid: fields[1].clone(),
                bssid: fields[2].clone(),
                channel,
                frequency_mhz: frequency,
                signal: parse_integer(&fields[6]).unwrap_or(0).clamp(0, 100),
                band: if frequency >= 4900 || (frequency == 0 && channel > 14) {
                    "5".to_owned()
                } else {
                    "2.4".to_owned()
                },
                security: security_from_nmcli(&fields[7]).to_owned(),
                saved_profile_id: None,
            })
        })
        .collect::<Vec<_>>();
    Ok(ScanResult {
        device: input.device.clone(),
        scanned_at: OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|error| HostdError::operation_failed(error.to_string()))?,
        access_points,
    })
}

async fn connect(
    input: &ConnectInput,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<MutationResult, HostdError> {
    assert_wifi_device(&input.device, runner).await?;
    let previous_id = active_connection_uuid(&input.device, runner).await?;
    if let Some(profile_id) = &input.profile_id {
        assert_client_profile(profile_id, runner).await?;
        let mut args = vec![
            "connection".to_owned(),
            "up".to_owned(),
            "uuid".to_owned(),
            profile_id.clone(),
            "ifname".to_owned(),
            input.device.clone(),
        ];
        if let Some(bssid) = &input.bssid {
            args.extend(["ap".to_owned(), bssid.to_ascii_uppercase()]);
        }
        if run_nmcli_owned(runner, &args).await.is_ok() {
            return Ok(success_result());
        }
        let rollback = restore_connection(previous_id.as_deref(), &input.device, runner).await;
        return Err(network_error("Wi-Fi connection failed", rollback));
    }

    let id = Uuid::new_v4().to_string();
    let definition = ProfileDefinition {
        id: id.clone(),
        name: format!("SigmaOS {}", input.ssid.as_deref().unwrap_or_default()),
        ssid: input.ssid.clone().unwrap_or_default(),
        device: input.device.clone(),
        security: input.security.clone().unwrap_or_else(|| "open".to_owned()),
        password: input.password.clone(),
        mode: "client".to_owned(),
        band: "auto".to_owned(),
        channel: None,
        autoconnect: input.autoconnect.unwrap_or(true),
    };
    let path = options
        .connections_dir
        .join(format!("{MANAGED_PREFIX}{id}.nmconnection"));
    let content = create_keyfile(&definition, runner).await?;
    atomic_write(&path, content.as_bytes(), 0o600, || async { Ok(()) }).await?;
    let mut args = vec![
        "connection".to_owned(),
        "load".to_owned(),
        path.to_string_lossy().into_owned(),
    ];
    let loaded = run_nmcli_owned(runner, &args).await;
    args = vec![
        "connection".to_owned(),
        "up".to_owned(),
        "uuid".to_owned(),
        id,
        "ifname".to_owned(),
        input.device.clone(),
    ];
    if let Some(bssid) = &input.bssid {
        args.extend(["ap".to_owned(), bssid.to_ascii_uppercase()]);
    }
    if loaded.is_ok() && run_nmcli_owned(runner, &args).await.is_ok() {
        return Ok(success_result());
    }
    let _ = fs::remove_file(&path).await;
    safe_reload(runner).await;
    let rollback = restore_connection(previous_id.as_deref(), &input.device, runner).await;
    Err(network_error("Wi-Fi connection failed", rollback))
}

async fn update_profile(
    profile_id: &str,
    input: &ProfileUpdateInput,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<MutationResult, HostdError> {
    let current = find_profile(profile_id, &options.connections_dir).await?;
    if current.inspection.mode != "client" {
        return Err(HostdError::conflict(
            "Hotspot profiles must be edited through hotspot settings",
        ));
    }
    if current.inspection.revision != input.expected_revision {
        return Err(HostdError::conflict(
            "Wi-Fi profile changed; reload before saving",
        ));
    }
    let security = input
        .security
        .clone()
        .unwrap_or_else(|| current.inspection.security.clone());
    if security == "unsupported" {
        return Err(HostdError::validation("Unsupported Wi-Fi security"));
    }
    let keyfile = parse_keyfile(&current.content);
    let password = if security == "open" {
        None
    } else {
        input
            .password
            .clone()
            .or_else(|| keyfile_value(&keyfile, "wifi-security", "psk").map(ToOwned::to_owned))
    };
    validate_credential(&security, password.as_deref())?;
    let device = current
        .inspection
        .device
        .clone()
        .ok_or_else(|| HostdError::validation("Managed Wi-Fi profile has no device"))?;
    let definition = ProfileDefinition {
        id: current.inspection.id.clone(),
        name: current.inspection.name.clone(),
        ssid: input
            .ssid
            .clone()
            .unwrap_or_else(|| current.inspection.ssid.clone()),
        device,
        security,
        password,
        mode: "client".to_owned(),
        band: current.inspection.band.clone(),
        channel: current.inspection.channel,
        autoconnect: input.autoconnect.unwrap_or(current.inspection.autoconnect),
    };
    replace_profile(&current, &definition, input.confirmed, runner).await
}

async fn delete_profile(
    profile_id: &str,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<MutationResult, HostdError> {
    let profile = find_profile(profile_id, &options.connections_dir).await?;
    if profile.inspection.mode != "client" {
        return Err(HostdError::conflict(
            "Hotspot profiles must be deleted through hotspot settings",
        ));
    }
    run_checked(
        runner,
        "nmcli",
        &["connection", "delete", "uuid", &profile.inspection.id],
        None,
    )
    .await?;
    remove_if_exists(&profile.path).await?;
    Ok(success_result())
}

async fn update_hotspot(
    input: &HotspotUpdateInput,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<MutationResult, HostdError> {
    assert_wifi_device(&input.device, runner).await?;
    let existing = read_profiles(&options.connections_dir)
        .await?
        .into_iter()
        .find(|profile| {
            profile.inspection.mode == "hotspot"
                && profile.inspection.device.as_deref() == Some(&input.device)
        });
    if let Some(existing) = &existing {
        match &input.expected_revision {
            Some(expected) if expected != &existing.inspection.revision => {
                return Err(HostdError::conflict(
                    "Hotspot configuration changed; reload before saving",
                ));
            }
            None => return Err(HostdError::conflict("Hotspot revision is required")),
            _ => {}
        }
    }
    let existing_password = existing.as_ref().and_then(|profile| {
        let keyfile = parse_keyfile(&profile.content);
        keyfile_value(&keyfile, "wifi-security", "psk").map(ToOwned::to_owned)
    });
    let password = input.password.clone().or(existing_password);
    validate_credential("wpa2", password.as_deref())?;
    let id = existing
        .as_ref()
        .map(|profile| profile.inspection.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let definition = ProfileDefinition {
        id: id.clone(),
        name: format!("SigmaOS Hotspot {}", input.device),
        ssid: input.ssid.clone(),
        device: input.device.clone(),
        security: "wpa2".to_owned(),
        password,
        mode: "hotspot".to_owned(),
        band: input.band.clone(),
        channel: input.channel,
        autoconnect: input.autostart,
    };
    if let Some(existing) = existing {
        return replace_profile(&existing, &definition, input.confirmed, runner).await;
    }
    let path = options
        .connections_dir
        .join(format!("{MANAGED_PREFIX}{id}.nmconnection"));
    let content = create_keyfile(&definition, runner).await?;
    atomic_write(&path, content.as_bytes(), 0o600, || async { Ok(()) }).await?;
    if run_checked(
        runner,
        "nmcli",
        &["connection", "load", &path.to_string_lossy()],
        None,
    )
    .await
    .is_ok()
    {
        return Ok(success_result());
    }
    let _ = fs::remove_file(&path).await;
    safe_reload(runner).await;
    Err(network_error(
        "Hotspot configuration failed; the partial configuration was removed",
        RollbackStatus::Succeeded,
    ))
}

async fn start_hotspot(
    device: &str,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<MutationResult, HostdError> {
    assert_wifi_device(device, runner).await?;
    let hotspot = find_hotspot(device, &options.connections_dir).await?;
    let previous_id = active_connection_uuid(device, runner).await?;
    let mut state = read_recovery_state(&options.state_dir).await?;
    if previous_id.as_deref() == Some(&hotspot.inspection.id) {
        return Ok(success_result());
    }
    state.insert(
        device.to_owned(),
        RecoveryEntry {
            restore_profile_id: previous_id.clone(),
            hotspot_profile_id: hotspot.inspection.id.clone(),
        },
    );
    write_recovery_state(&options.state_dir, &state).await?;
    if previous_id.is_some() {
        let _ = run_checked(runner, "nmcli", &["device", "disconnect", device], None).await;
    }
    let activation = run_checked(
        runner,
        "nmcli",
        &[
            "connection",
            "up",
            "uuid",
            &hotspot.inspection.id,
            "ifname",
            device,
        ],
        None,
    )
    .await;
    if activation.is_ok() {
        return Ok(success_result());
    }
    let restore_id = state
        .get(device)
        .and_then(|entry| entry.restore_profile_id.as_deref());
    let rollback = restore_connection(restore_id, device, runner).await;
    if rollback != RollbackStatus::Failed {
        state.remove(device);
        write_recovery_state(&options.state_dir, &state).await?;
    }
    Err(network_error("Hotspot activation failed", rollback))
}

async fn stop_hotspot(
    device: &str,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<MutationResult, HostdError> {
    assert_wifi_device(device, runner).await?;
    let hotspot = find_hotspot(device, &options.connections_dir).await?;
    let mut state = read_recovery_state(&options.state_dir).await?;
    if active_connection_uuid(device, runner).await?.as_deref() == Some(&hotspot.inspection.id) {
        run_checked(
            runner,
            "nmcli",
            &["connection", "down", "uuid", &hotspot.inspection.id],
            None,
        )
        .await?;
    }
    let restore_id = state
        .get(device)
        .and_then(|entry| entry.restore_profile_id.as_deref());
    let rollback = restore_connection(restore_id, device, runner).await;
    if rollback != RollbackStatus::Failed {
        state.remove(device);
        write_recovery_state(&options.state_dir, &state).await?;
    }
    if rollback == RollbackStatus::Failed {
        return Err(network_error(
            "Hotspot stopped but the previous Wi-Fi connection could not be restored",
            rollback,
        ));
    }
    Ok(MutationResult {
        rollback,
        message: (rollback == RollbackStatus::Succeeded)
            .then(|| "Previous Wi-Fi connection restored".to_owned()),
    })
}

async fn delete_hotspot(
    device: &str,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<MutationResult, HostdError> {
    assert_wifi_device(device, runner).await?;
    let hotspot = find_hotspot(device, &options.connections_dir).await?;
    run_checked(
        runner,
        "nmcli",
        &["connection", "delete", "uuid", &hotspot.inspection.id],
        None,
    )
    .await?;
    remove_if_exists(&hotspot.path).await?;
    Ok(success_result())
}

async fn replace_profile(
    current: &ManagedProfile,
    definition: &ProfileDefinition,
    confirmed: bool,
    runner: &dyn CommandRunner,
) -> Result<MutationResult, HostdError> {
    let active = is_connection_active(&current.inspection.id, runner).await;
    if active && !confirmed {
        return Err(HostdError::validation(
            "Confirmation is required to restart an active Wi-Fi profile",
        ));
    }
    let next = create_keyfile(definition, runner).await?;
    let expected = current.inspection.revision.clone();
    atomic_write(&current.path, next.as_bytes(), 0o600, || async {
        let latest = read_profile(&current.path).await?;
        if latest.inspection.revision != expected {
            return Err(HostdError::conflict(
                "Wi-Fi profile changed; reload before saving",
            ));
        }
        Ok(())
    })
    .await?;
    let apply = async {
        run_checked(runner, "nmcli", &["connection", "reload"], None).await?;
        if active {
            run_checked(
                runner,
                "nmcli",
                &[
                    "connection",
                    "up",
                    "uuid",
                    &current.inspection.id,
                    "ifname",
                    &definition.device,
                ],
                None,
            )
            .await?;
        }
        Ok::<(), HostdError>(())
    }
    .await;
    if apply.is_ok() {
        return Ok(success_result());
    }
    let rollback = async {
        atomic_write(&current.path, current.content.as_bytes(), 0o600, || async {
            Ok(())
        })
        .await?;
        run_checked(runner, "nmcli", &["connection", "reload"], None).await?;
        if active {
            run_checked(
                runner,
                "nmcli",
                &[
                    "connection",
                    "up",
                    "uuid",
                    &current.inspection.id,
                    "ifname",
                    &definition.device,
                ],
                None,
            )
            .await?;
        }
        Ok::<(), HostdError>(())
    }
    .await;
    if rollback.is_ok() {
        Err(network_error(
            "Wi-Fi profile update failed; the previous configuration was restored",
            RollbackStatus::Succeeded,
        ))
    } else {
        Err(network_error(
            "Wi-Fi profile update and rollback failed",
            RollbackStatus::Failed,
        ))
    }
}

fn success_result() -> MutationResult {
    MutationResult {
        rollback: RollbackStatus::NotRequired,
        message: None,
    }
}

fn network_error(message: &str, rollback: RollbackStatus) -> HostdError {
    HostdError::new(502, ErrorCode::OperationFailed, message)
        .with_details(serde_json::json!({ "rollback": rollback }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use std::time::Duration;
    use tempfile::TempDir;

    struct FakeRunner {
        calls: Mutex<Vec<(String, Vec<String>)>>,
        failures: Mutex<Vec<Vec<String>>>,
        active_id: Option<String>,
        device_type: Option<String>,
        profile_details: Option<String>,
    }

    impl Default for FakeRunner {
        fn default() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                failures: Mutex::new(Vec::new()),
                active_id: None,
                device_type: None,
                profile_details: None,
            }
        }
    }

    #[async_trait]
    impl CommandRunner for FakeRunner {
        async fn run(
            &self,
            command: &str,
            args: &[String],
            _input: Option<&[u8]>,
            _timeout: Duration,
            _output_limit: usize,
        ) -> Result<crate::command::CommandOutput, HostdError> {
            self.calls
                .lock()
                .unwrap()
                .push((command.to_owned(), args.to_vec()));
            let failure_index = self.failures.lock().unwrap().iter().position(|expected| {
                args.windows(expected.len())
                    .any(|window| window == expected)
            });
            let success = failure_index.is_none();
            if let Some(index) = failure_index {
                self.failures.lock().unwrap().remove(index);
            }
            let stdout = if args.starts_with(&[
                "--terse".to_owned(),
                "--fields".to_owned(),
                "RUNNING".to_owned(),
            ]) {
                "running\n".to_owned()
            } else if args.starts_with(&["--get-values".to_owned(), "GENERAL.TYPE".to_owned()]) {
                self.device_type
                    .clone()
                    .unwrap_or_else(|| "wifi\n".to_owned())
            } else if args.starts_with(&["--get-values".to_owned(), "GENERAL.CON-UUID".to_owned()])
            {
                self.active_id.clone().unwrap_or_default()
            } else if args.starts_with(&[
                "--get-values".to_owned(),
                "connection.type,802-11-wireless.mode".to_owned(),
            ]) {
                self.profile_details
                    .clone()
                    .unwrap_or_else(|| "wifi\ninfrastructure\n".to_owned())
            } else if args.first().is_some_and(|value| value == "--offline") {
                "[connection]\nid=base\ntype=wifi\n\n[wifi]\nssid=base\nmode=infrastructure\n\n[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n".to_owned()
            } else if args.contains(&"IN-USE,SSID,BSSID,MODE,CHAN,FREQ,SIGNAL,SECURITY".to_owned())
            {
                "*:Office\\:5G:AA\\:BB\\:CC\\:DD\\:EE\\:FF:Infra:36:5180 MHz:87:WPA2\n".to_owned()
            } else {
                String::new()
            };
            Ok(crate::command::CommandOutput {
                stdout,
                stderr: if success {
                    String::new()
                } else {
                    "forced failure".to_owned()
                },
                success,
            })
        }
    }

    fn options(temp: &TempDir) -> NetworkOptions {
        NetworkOptions {
            connections_dir: temp.path().join("connections"),
            state_dir: temp.path().join("state"),
            sys_class_net: temp.path().join("sys-class-net"),
        }
    }

    fn keyfile(id: &str, mode: &str, device: &str, password: &str) -> String {
        format!(
            "# Managed by SigmaOS. Do not edit this file directly.\n\n[connection]\nid=Sigma\ntype=wifi\nuuid={id}\ninterface-name={device}\nautoconnect=true\n\n[wifi]\nmode={mode}\nssid=Sigma\nsecurity=wifi-security\n\n[wifi-security]\nkey-mgmt=wpa-psk\npsk={password}\n\n[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n"
        )
    }

    #[test]
    fn validates_actions_and_credentials() {
        assert!(
            validate_request(&NetworkRequest::Disconnect {
                input: ConfirmedDeviceInput {
                    device: "wlan0".to_owned(),
                    confirmed: false
                }
            })
            .is_err()
        );
        assert!(validate_credential("wpa2", Some("short")).is_err());
        assert!(validate_credential("wpa2", Some("long-enough")).is_ok());
        assert!(validate_credential("open", Some("password")).is_err());
    }

    #[tokio::test]
    async fn creates_root_only_profiles_without_password_arguments() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        let runner = FakeRunner::default();
        let payload = serde_json::json!({
            "action": "connect",
            "input": {
                "device": "wlan0", "ssid": "Office", "security": "wpa2",
                "password": "top-secret", "autoconnect": true, "confirmed": true
            }
        });
        handle_with_options(payload, &runner, &options)
            .await
            .unwrap();
        let profiles = read_profiles(&options.connections_dir).await.unwrap();
        assert_eq!(profiles.len(), 1);
        assert!(profiles[0].content.contains("psk=top-secret"));
        assert!(
            runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .all(|(_, args)| !args.iter().any(|arg| arg.contains("top-secret")))
        );
        let mode = fs::metadata(&profiles[0].path)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[tokio::test]
    async fn parses_escaped_scan_results() {
        let temp = TempDir::new().unwrap();
        let result = handle_with_options(
            serde_json::json!({ "action": "scan", "input": { "device": "wlan0" } }),
            &FakeRunner::default(),
            &options(&temp),
        )
        .await
        .unwrap();
        assert_eq!(result["accessPoints"][0]["ssid"], "Office:5G");
        assert_eq!(result["accessPoints"][0]["bssid"], "AA:BB:CC:DD:EE:FF");
        assert_eq!(result["accessPoints"][0]["band"], "5");
    }

    #[tokio::test]
    async fn rejects_non_wireless_devices_and_hotspot_profiles_as_clients() {
        let temp = TempDir::new().unwrap();
        let non_wireless = FakeRunner {
            device_type: Some("ethernet\n".to_owned()),
            ..FakeRunner::default()
        };
        let error = handle_with_options(
            serde_json::json!({ "action": "scan", "input": { "device": "eth0" } }),
            &non_wireless,
            &options(&temp),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Validation);

        let hotspot = FakeRunner {
            profile_details: Some("wifi\nap\n".to_owned()),
            ..FakeRunner::default()
        };
        let error = handle_with_options(
            serde_json::json!({
                "action": "connect",
                "input": {
                    "device": "wlan0",
                    "profileId": "67e55044-10b1-426f-9247-bb680e5fe0c8",
                    "confirmed": true
                }
            }),
            &hotspot,
            &options(&temp),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Validation);
    }

    #[tokio::test]
    async fn rejects_symlinked_profiles_and_stale_revisions() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(&options.connections_dir).await.unwrap();
        let target = temp.path().join("target");
        fs::write(&target, "content").await.unwrap();
        std::os::unix::fs::symlink(
            &target,
            options.connections_dir.join("sigmaos-link.nmconnection"),
        )
        .unwrap();
        assert!(read_profiles(&options.connections_dir).await.is_err());
        fs::remove_file(options.connections_dir.join("sigmaos-link.nmconnection"))
            .await
            .unwrap();
        let id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        fs::write(
            options.connections_dir.join("sigmaos-test.nmconnection"),
            keyfile(id, "infrastructure", "wlan0", "long-enough"),
        )
        .await
        .unwrap();
        let payload = serde_json::json!({
            "action": "update_profile", "profileId": id,
            "input": { "expectedRevision": "0".repeat(64), "ssid": "Next", "confirmed": true }
        });
        assert_eq!(
            handle_with_options(payload, &FakeRunner::default(), &options)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[tokio::test]
    async fn removes_stored_credentials_when_a_profile_becomes_open() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(&options.connections_dir).await.unwrap();
        let id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        let path = options.connections_dir.join("sigmaos-test.nmconnection");
        fs::write(&path, keyfile(id, "infrastructure", "wlan0", "long-enough"))
            .await
            .unwrap();
        let current = read_profile(&path).await.unwrap();
        let payload = serde_json::json!({
            "action": "update_profile", "profileId": id,
            "input": {
                "expectedRevision": current.inspection.revision,
                "security": "open", "confirmed": false
            }
        });

        handle_with_options(payload, &FakeRunner::default(), &options)
            .await
            .unwrap();

        let content = fs::read_to_string(path).await.unwrap();
        assert!(!content.contains("[wifi-security]"));
        assert!(!content.contains("psk="));
    }

    #[tokio::test]
    async fn requires_credentials_for_new_hotspots_and_secured_profiles() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        let runner = FakeRunner::default();
        let hotspot = serde_json::json!({
            "action": "update_hotspot",
            "input": {
                "device": "wlan0", "ssid": "SigmaOS", "password": null,
                "band": "2.4", "channel": 6, "autostart": false, "confirmed": false
            }
        });
        assert_eq!(
            handle_with_options(hotspot, &runner, &options)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );

        fs::create_dir_all(&options.connections_dir).await.unwrap();
        let id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        let path = options.connections_dir.join("sigmaos-open.nmconnection");
        fs::write(
            &path,
            format!(
                "# Managed by SigmaOS. Do not edit this file directly.\n\n[connection]\nid=Open\ntype=wifi\nuuid={id}\ninterface-name=wlan0\nautoconnect=true\n\n[wifi]\nmode=infrastructure\nssid=Open\n\n[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n"
            ),
        )
        .await
        .unwrap();
        let current = read_profile(&path).await.unwrap();
        let secure = serde_json::json!({
            "action": "update_profile",
            "profileId": id,
            "input": {
                "expectedRevision": current.inspection.revision,
                "security": "wpa2", "confirmed": false
            }
        });
        assert_eq!(
            handle_with_options(secure, &runner, &options)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
    }

    #[tokio::test]
    async fn restores_previous_connection_when_hotspot_activation_fails() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(&options.connections_dir).await.unwrap();
        let hotspot_id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        let previous_id = "56e55044-10b1-426f-9247-bb680e5fe0c8";
        fs::write(
            options.connections_dir.join("sigmaos-hotspot.nmconnection"),
            keyfile(hotspot_id, "ap", "wlan0", "long-enough"),
        )
        .await
        .unwrap();
        let runner = FakeRunner {
            active_id: Some(previous_id.to_owned()),
            failures: Mutex::new(vec![vec!["uuid".to_owned(), hotspot_id.to_owned()]]),
            ..FakeRunner::default()
        };
        let error = handle_with_options(
            serde_json::json!({
                "action": "start_hotspot", "input": { "device": "wlan0", "confirmed": true }
            }),
            &runner,
            &options,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::OperationFailed);
        assert!(runner.calls.lock().unwrap().iter().any(|(_, args)| {
            args.windows(2)
                .any(|window| window == ["uuid", previous_id])
        }));
        assert!(
            read_recovery_state(&options.state_dir)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn repeated_hotspot_start_keeps_the_original_recovery_profile() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(&options.connections_dir).await.unwrap();
        let hotspot_id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        let previous_id = "56e55044-10b1-426f-9247-bb680e5fe0c8";
        fs::write(
            options.connections_dir.join("sigmaos-hotspot.nmconnection"),
            keyfile(hotspot_id, "ap", "wlan0", "long-enough"),
        )
        .await
        .unwrap();
        let original = HashMap::from([(
            "wlan0".to_owned(),
            RecoveryEntry {
                restore_profile_id: Some(previous_id.to_owned()),
                hotspot_profile_id: hotspot_id.to_owned(),
            },
        )]);
        write_recovery_state(&options.state_dir, &original)
            .await
            .unwrap();
        let runner = FakeRunner {
            active_id: Some(hotspot_id.to_owned()),
            ..FakeRunner::default()
        };

        handle_with_options(
            serde_json::json!({
                "action": "start_hotspot", "input": { "device": "wlan0", "confirmed": true }
            }),
            &runner,
            &options,
        )
        .await
        .unwrap();

        assert_eq!(
            read_recovery_state(&options.state_dir).await.unwrap(),
            original
        );
    }

    #[tokio::test]
    async fn failed_hotspot_stop_preserves_recovery_state() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(&options.connections_dir).await.unwrap();
        let hotspot_id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        let previous_id = "56e55044-10b1-426f-9247-bb680e5fe0c8";
        fs::write(
            options.connections_dir.join("sigmaos-hotspot.nmconnection"),
            keyfile(hotspot_id, "ap", "wlan0", "long-enough"),
        )
        .await
        .unwrap();
        let original = HashMap::from([(
            "wlan0".to_owned(),
            RecoveryEntry {
                restore_profile_id: Some(previous_id.to_owned()),
                hotspot_profile_id: hotspot_id.to_owned(),
            },
        )]);
        write_recovery_state(&options.state_dir, &original)
            .await
            .unwrap();
        let runner = FakeRunner {
            active_id: Some(hotspot_id.to_owned()),
            failures: Mutex::new(vec![vec![
                "connection".to_owned(),
                "down".to_owned(),
                "uuid".to_owned(),
                hotspot_id.to_owned(),
            ]]),
            ..FakeRunner::default()
        };

        assert!(
            handle_with_options(
                serde_json::json!({
                    "action": "stop_hotspot", "input": { "device": "wlan0", "confirmed": true }
                }),
                &runner,
                &options,
            )
            .await
            .is_err()
        );

        assert_eq!(
            read_recovery_state(&options.state_dir).await.unwrap(),
            original
        );
    }

    #[tokio::test]
    async fn stopping_a_hotspot_does_not_change_its_autostart_setting() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        fs::create_dir_all(&options.connections_dir).await.unwrap();
        let hotspot_id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        fs::write(
            options.connections_dir.join("sigmaos-hotspot.nmconnection"),
            keyfile(hotspot_id, "ap", "wlan0", "long-enough"),
        )
        .await
        .unwrap();
        let runner = FakeRunner {
            active_id: Some(hotspot_id.to_owned()),
            ..FakeRunner::default()
        };

        handle_with_options(
            serde_json::json!({
                "action": "stop_hotspot", "input": { "device": "wlan0", "confirmed": true }
            }),
            &runner,
            &options,
        )
        .await
        .unwrap();

        assert!(runner.calls.lock().unwrap().iter().all(|(_, args)| {
            !args
                .iter()
                .any(|argument| argument == "modify" || argument == "autoconnect")
        }));
        assert!(
            fs::read_to_string(options.connections_dir.join("sigmaos-hotspot.nmconnection"))
                .await
                .unwrap()
                .contains("autoconnect=true")
        );
    }

    #[tokio::test]
    async fn failed_hotspot_load_removes_the_partial_profile() {
        let temp = TempDir::new().unwrap();
        let options = options(&temp);
        let runner = FakeRunner {
            failures: Mutex::new(vec![vec!["connection".to_owned(), "load".to_owned()]]),
            ..FakeRunner::default()
        };
        let payload = serde_json::json!({
            "action": "update_hotspot",
            "input": {
                "device": "wlan0", "ssid": "SigmaOS", "password": "hotspot-password",
                "band": "2.4", "channel": 6, "autostart": false, "confirmed": false
            }
        });

        let error = handle_with_options(payload, &runner, &options)
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::OperationFailed);
        assert!(
            read_profiles(&options.connections_dir)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(_, args)| { args == &["connection".to_owned(), "reload".to_owned()] })
        );
    }
}
