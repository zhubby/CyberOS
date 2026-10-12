use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::IpAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration as StdDuration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use tokio::fs;
use tokio::time::sleep;
use uuid::Uuid;

use crate::command::{CommandRunner, run_checked};
use crate::error::HostdError;

use super::model::{
    EthernetAddress, EthernetApplyTransaction, EthernetConfig, EthernetDevice, EthernetIpv4Config,
    EthernetIpv6Config, EthernetStatus, EthernetUpdateInput, NetworkOptions, RollbackStatus,
};
use super::nmcli::{assert_available, split_line};
use super::store::{atomic_write, remove_if_exists};

const STATE_FILE: &str = "ethernet-desired.json";
const TRANSACTION_FILE: &str = "ethernet-transaction.json";
const CHECKPOINT_SECONDS: i64 = 90;
const APPLY_VALIDATION_ATTEMPTS: usize = 41;
const APPLY_VALIDATION_INTERVAL: StdDuration = StdDuration::from_millis(500);
const ETHERNET_PREFIX: &str = "sigmaos-ethernet-";
const MANAGED_AUTOCONNECT_PRIORITY: i32 = 999;
const ETHERNET_PROFILE_FIELDS: [&str; 29] = [
    "connection.type",
    "connection.controller",
    "802-1x.eap",
    "ipv4.method",
    "ipv4.addresses",
    "ipv4.gateway",
    "ipv4.ignore-auto-dns",
    "ipv4.dns",
    "ipv4.never-default",
    "ipv4.route-metric",
    "ipv4.routes",
    "ipv6.method",
    "ipv6.addresses",
    "ipv6.gateway",
    "ipv6.ignore-auto-dns",
    "ipv6.dns",
    "ipv6.never-default",
    "ipv6.route-metric",
    "ipv6.routes",
    "802-3-ethernet.cloned-mac-address",
    "802-3-ethernet.mtu",
    "802-3-ethernet.wake-on-lan",
    "ipv4.routing-rules",
    "ipv6.routing-rules",
    "connection.interface-name",
    "802-3-ethernet.mac-address",
    "connection.autoconnect",
    "connection.autoconnect-priority",
    "connection.timestamp",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DesiredState {
    #[serde(default = "state_version")]
    version: u8,
    #[serde(default)]
    devices: HashMap<String, DesiredDevice>,
}

fn state_version() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesiredDevice {
    config: EthernetConfig,
    revision: String,
    applied_revision: Option<String>,
    managed_profile_id: String,
    source_profile_id: Option<String>,
    #[serde(default)]
    source_profile_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileBackup {
    device_id: String,
    path: PathBuf,
    content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedTransaction {
    public: EthernetApplyTransaction,
    checkpoint_path: Option<String>,
    backups: Vec<ProfileBackup>,
}

#[derive(Debug, Clone)]
struct RuntimeDevice {
    name: String,
    state: String,
    connection_name: Option<String>,
    connection_id: Option<String>,
    mac: String,
    permanent_mac: String,
    driver: Option<String>,
    speed_mbps: Option<u32>,
    carrier: bool,
    addresses: Vec<EthernetAddress>,
    ipv4_gateway: Option<String>,
    ipv6_gateway: Option<String>,
    ipv4_default_route_metric: Option<u32>,
    ipv6_default_route_metric: Option<u32>,
    dbus_path: String,
}

#[derive(Debug, Clone)]
struct ProfileConfig {
    config: EthernetConfig,
    supported: bool,
    revision: String,
    interface_name: Option<String>,
    mac_address: Option<String>,
    autoconnect_priority: i32,
    timestamp: u64,
}

#[derive(Debug, Clone)]
struct SavedProfile {
    id: String,
    profile: ProfileConfig,
}

pub(super) async fn status(
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<EthernetStatus, HostdError> {
    assert_available(runner).await?;
    recover_expired(runner, options).await?;
    let runtime = collect_runtime_devices(runner, options).await?;
    let mut desired = read_desired(options).await?;
    let mut changed = false;
    let mut devices = Vec::with_capacity(runtime.len());

    for device in runtime {
        let id = mac_id(&device.permanent_mac)?;
        let active = match device.connection_id.as_deref() {
            Some(profile_id) => Some(read_profile_config(profile_id, runner).await?),
            None => None,
        };
        let saved = if active.is_none() && !desired.devices.contains_key(&id) {
            find_saved_profile(&device, runner).await?
        } else {
            None
        };
        let source = active
            .as_ref()
            .map(|profile| (device.connection_id.clone(), profile))
            .or_else(|| {
                saved
                    .as_ref()
                    .map(|profile| (Some(profile.id.clone()), &profile.profile))
            });
        if !desired.devices.contains_key(&id) {
            if let Some((profile_id, profile)) =
                source.as_ref().filter(|(_, profile)| profile.supported)
            {
                desired.devices.insert(
                    id.clone(),
                    new_desired(
                        profile.config.clone(),
                        profile_id.clone(),
                        Some(profile.revision.clone()),
                    ),
                );
                changed = true;
            } else if source.is_none() {
                desired.devices.insert(
                    id.clone(),
                    new_desired(
                        default_config(
                            device.ipv4_gateway.is_some(),
                            device.ipv6_gateway.is_some(),
                        ),
                        None,
                        None,
                    ),
                );
                changed = true;
            }
        }

        if let Some(entry) = desired.devices.get_mut(&id)
            && entry.source_profile_revision.is_none()
            && entry.source_profile_id == device.connection_id
            && let Some(active) = active.as_ref().filter(|profile| profile.supported)
        {
            entry.source_profile_revision = Some(active.revision.clone());
            changed = true;
        }

        let entry = desired.devices.get(&id);
        let profile_path = managed_profile_path(options, &id);
        let managed_file = regular_file_exists(&profile_path).await?;
        let unsupported = source
            .as_ref()
            .is_some_and(|(_, profile)| !profile.supported);
        let desired_config = entry.map(|entry| entry.config.clone());
        let runtime_matches =
            entry.is_some_and(|entry| desired_is_applied(entry, &device, active.as_ref()));
        let active_config = effective_active_config(active.as_ref(), entry, runtime_matches);
        let needs_apply = entry.is_some_and(|entry| {
            entry.applied_revision.as_deref() != Some(entry.revision.as_str())
                || !managed_file
                || !runtime_matches
        });
        let mut warnings = Vec::new();
        if unsupported {
            warnings.push(
                "The active profile uses Ethernet features SigmaOS cannot safely manage".to_owned(),
            );
        }
        devices.push(EthernetDevice {
            id,
            name: device.name,
            permanent_mac: normalize_mac(&device.permanent_mac),
            mac: normalize_mac(&device.mac),
            driver: device.driver,
            speed_mbps: device.speed_mbps,
            carrier: device.carrier,
            state: ethernet_state(
                &device.state,
                device.carrier,
                !device.addresses.is_empty(),
                active_config.as_ref().map(|config| config.enabled),
            ),
            addresses: device.addresses,
            ipv4_gateway: device.ipv4_gateway,
            ipv6_gateway: device.ipv6_gateway,
            active_profile_id: device.connection_id,
            active_profile_name: device.connection_name,
            management_state: if unsupported {
                "external_unsupported".to_owned()
            } else if managed_file && runtime_matches {
                "managed".to_owned()
            } else if entry.is_some() {
                "pending".to_owned()
            } else {
                "external".to_owned()
            },
            active_config,
            desired_config,
            revision: entry
                .map(|value| value.revision.clone())
                .unwrap_or_default(),
            needs_apply: needs_apply && !unsupported,
            warnings,
        });
    }

    if changed {
        write_desired(options, &desired).await?;
    }
    devices.sort_by(|left, right| left.name.cmp(&right.name));
    let transaction = read_transaction(options).await?.map(|value| value.public);
    let mut warnings = Vec::new();
    for family in [4_u8, 6_u8] {
        let defaults = devices
            .iter()
            .filter(|device| {
                device
                    .desired_config
                    .as_ref()
                    .is_some_and(|config| family_default(config, family))
            })
            .count();
        if defaults == 0 {
            warnings.push(format!("No IPv{family} default route is enabled"));
        }
    }
    if has_asymmetric_subnet_routing(&devices) {
        warnings.push(
            "Ethernet ports share a subnet but use asymmetric default-route settings".to_owned(),
        );
    }
    Ok(EthernetStatus {
        collected_at: now()?,
        backend: "NetworkManager".to_owned(),
        hostd_ready: true,
        devices,
        transaction,
        warnings,
    })
}

pub(super) async fn save(
    device_id: &str,
    input: &EthernetUpdateInput,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<EthernetStatus, HostdError> {
    validate_device_id(device_id)?;
    validate_config(&input.config)?;
    ensure_no_active_transaction(options).await?;
    let runtime = collect_runtime_devices(runner, options).await?;
    let target = runtime
        .iter()
        .find(|device| mac_id(&device.permanent_mac).ok().as_deref() == Some(device_id))
        .ok_or_else(|| HostdError::not_found("Ethernet device not found"))?;
    if let Some(profile_id) = target.connection_id.as_deref() {
        let profile = read_profile_config(profile_id, runner).await?;
        if !profile.supported {
            return Err(HostdError::conflict(
                "This Ethernet profile uses unsupported advanced settings",
            ));
        }
    }
    let mut desired = read_desired(options).await?;
    let current = desired
        .devices
        .get(device_id)
        .ok_or_else(|| HostdError::conflict("Reload Ethernet status before saving"))?;
    if current.revision != input.expected_revision {
        return Err(HostdError::conflict(
            "Ethernet configuration changed; reload before saving",
        ));
    }
    let mut replacement = current.clone();
    replacement.config = input.config.clone();
    replacement.revision = config_revision(&replacement.config, &replacement.managed_profile_id)?;
    desired.devices.insert(device_id.to_owned(), replacement);
    let runtime_ids = runtime
        .iter()
        .filter_map(|device| mac_id(&device.permanent_mac).ok())
        .collect::<HashSet<_>>();
    validate_metric_conflicts(&desired, &runtime_ids)?;
    write_desired(options, &desired).await?;
    status(runner, options).await
}

pub(super) async fn apply(
    confirmed: bool,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<EthernetApplyTransaction, HostdError> {
    if !confirmed {
        return Err(HostdError::validation(
            "Ethernet apply confirmation is required",
        ));
    }
    ensure_no_active_transaction(options).await?;
    let desired = read_desired(options).await?;
    let runtime = collect_runtime_devices(runner, options).await?;
    let runtime_by_id = runtime
        .iter()
        .filter_map(|device| mac_id(&device.permanent_mac).ok().map(|id| (id, device)))
        .collect::<HashMap<_, _>>();
    let runtime_ids = runtime_by_id.keys().cloned().collect::<HashSet<_>>();
    validate_metric_conflicts(&desired, &runtime_ids)?;
    let mut device_ids = Vec::new();
    for (id, entry) in &desired.devices {
        let Some(runtime) = runtime_by_id.get(id) else {
            continue;
        };
        let active = match runtime.connection_id.as_deref() {
            Some(profile_id) => Some(read_profile_config(profile_id, runner).await?),
            None => None,
        };
        let profile_exists = regular_file_exists(&managed_profile_path(options, id)).await?;
        if entry.applied_revision.as_deref() != Some(entry.revision.as_str())
            || !profile_exists
            || !desired_is_applied(entry, runtime, active.as_ref())
        {
            device_ids.push(id.clone());
        }
    }
    if device_ids.is_empty() {
        return Err(HostdError::conflict(
            "There are no pending Ethernet changes",
        ));
    }
    for id in &device_ids {
        let runtime = runtime_by_id
            .get(id)
            .ok_or_else(|| HostdError::not_found("Ethernet device not found"))?;
        let entry = desired
            .devices
            .get(id)
            .expect("pending device must have desired state");
        let managed_active =
            runtime.connection_id.as_deref() == Some(entry.managed_profile_id.as_str());
        if !managed_active {
            let source = match entry.source_profile_id.as_deref() {
                Some(profile_id) => Some(read_profile_config(profile_id, runner).await?),
                None => None,
            };
            let source_matches =
                source_profile_matches(entry, runtime.connection_id.as_deref(), source.as_ref());
            if !source_matches {
                return Err(HostdError::conflict(
                    "An external Ethernet profile changed; reload before applying",
                ));
            }
        }
    }

    let created = OffsetDateTime::now_utc();
    let public = EthernetApplyTransaction {
        id: Uuid::new_v4().to_string(),
        status: "applying".to_owned(),
        device_ids: device_ids.clone(),
        created_at: created.format(&Rfc3339).map_err(time_error)?,
        deadline_at: Some(
            (created + Duration::seconds(CHECKPOINT_SECONDS))
                .format(&Rfc3339)
                .map_err(time_error)?,
        ),
        rollback: RollbackStatus::NotRequired,
        error: None,
    };
    let backups = read_backups(&device_ids, options).await?;
    let checkpoint_path = create_checkpoint(
        &device_ids
            .iter()
            .map(|id| runtime_by_id[id].dbus_path.clone())
            .collect::<Vec<_>>(),
        runner,
    )
    .await?;
    let mut transaction = PersistedTransaction {
        public,
        checkpoint_path: Some(checkpoint_path),
        backups,
    };
    write_transaction(options, &transaction).await?;

    let operation = async {
        for id in &device_ids {
            let entry = &desired.devices[id];
            let runtime = runtime_by_id[id];
            let path = managed_profile_path(options, id);
            reject_symlink(&path).await?;
            let content = render_profile(runtime, entry);
            atomic_write(&path, content.as_bytes(), 0o600, || async { Ok(()) }).await?;
        }
        run_checked(runner, "nmcli", &["connection", "reload"], None).await?;
        for id in &device_ids {
            let entry = &desired.devices[id];
            let runtime = runtime_by_id[id];
            run_checked(
                runner,
                "nmcli",
                &[
                    "connection",
                    "up",
                    "uuid",
                    &entry.managed_profile_id,
                    "ifname",
                    &runtime.name,
                ],
                None,
            )
            .await?;
        }
        wait_for_applied(&device_ids, &desired, runner, options).await
    }
    .await;

    if let Err(error) = operation {
        transaction.public.error = Some(error.to_string());
        rollback_persisted(&mut transaction, runner, options).await;
        write_transaction(options, &transaction).await?;
        return Err(HostdError::operation_failed(
            "Ethernet apply failed and rollback was attempted",
        )
        .with_details(serde_json::json!({ "rollback": transaction.public.rollback })));
    }
    transaction.public.status = "awaiting_confirmation".to_owned();
    write_transaction(options, &transaction).await?;
    Ok(transaction.public)
}

pub(super) async fn confirm(
    transaction_id: &str,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<EthernetApplyTransaction, HostdError> {
    validate_uuid(transaction_id)?;
    recover_expired(runner, options).await?;
    let mut transaction = read_transaction(options)
        .await?
        .ok_or_else(|| HostdError::not_found("Ethernet apply transaction not found"))?;
    if transaction.public.id != transaction_id {
        return Err(HostdError::not_found(
            "Ethernet apply transaction not found",
        ));
    }
    if transaction.public.status != "awaiting_confirmation" {
        return Err(HostdError::conflict(
            "Ethernet apply transaction can no longer be confirmed",
        ));
    }
    if let Some(path) = transaction.checkpoint_path.as_deref() {
        destroy_checkpoint(path, runner).await?;
    }
    let mut desired = read_desired(options).await?;
    for id in &transaction.public.device_ids {
        if let Some(entry) = desired.devices.get_mut(id) {
            entry.applied_revision = Some(entry.revision.clone());
            entry.source_profile_id = Some(entry.managed_profile_id.clone());
            entry.source_profile_revision = None;
        }
    }
    write_desired(options, &desired).await?;
    transaction.public.status = "confirmed".to_owned();
    transaction.public.deadline_at = None;
    transaction.checkpoint_path = None;
    transaction.backups.clear();
    write_transaction(options, &transaction).await?;
    Ok(transaction.public)
}

pub(super) async fn rollback(
    transaction_id: &str,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<EthernetApplyTransaction, HostdError> {
    validate_uuid(transaction_id)?;
    let mut transaction = read_transaction(options)
        .await?
        .ok_or_else(|| HostdError::not_found("Ethernet apply transaction not found"))?;
    if transaction.public.id != transaction_id {
        return Err(HostdError::not_found(
            "Ethernet apply transaction not found",
        ));
    }
    if !matches!(
        transaction.public.status.as_str(),
        "applying" | "awaiting_confirmation"
    ) {
        return Err(HostdError::conflict(
            "Ethernet apply transaction is not active",
        ));
    }
    rollback_persisted(&mut transaction, runner, options).await;
    write_transaction(options, &transaction).await?;
    if transaction.public.rollback == RollbackStatus::Failed {
        return Err(HostdError::operation_failed(
            "Ethernet rollback failed; recovery material was retained",
        )
        .with_details(serde_json::json!({ "rollback": transaction.public.rollback })));
    }
    Ok(transaction.public)
}

pub(super) async fn recover_on_startup(
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<(), HostdError> {
    let Some(mut transaction) = read_transaction(options).await? else {
        return Ok(());
    };
    if matches!(
        transaction.public.status.as_str(),
        "applying" | "awaiting_confirmation" | "rolling_back"
    ) {
        rollback_persisted(&mut transaction, runner, options).await;
        write_transaction(options, &transaction).await?;
    }
    Ok(())
}

pub(super) async fn recover_expired(
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<(), HostdError> {
    let Some(mut transaction) = read_transaction(options).await? else {
        return Ok(());
    };
    if transaction.public.status != "awaiting_confirmation" {
        return Ok(());
    }
    let expired = transaction
        .public
        .deadline_at
        .as_deref()
        .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
        .is_none_or(|deadline| deadline <= OffsetDateTime::now_utc());
    if expired {
        rollback_persisted(&mut transaction, runner, options).await;
        write_transaction(options, &transaction).await?;
    }
    Ok(())
}

async fn rollback_persisted(
    transaction: &mut PersistedTransaction,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) {
    transaction.public.status = "rolling_back".to_owned();
    let mut disk_ok = true;
    for backup in &transaction.backups {
        if validate_device_id(&backup.device_id).is_err()
            || backup.path != managed_profile_path(options, &backup.device_id)
        {
            disk_ok = false;
            continue;
        }
        let result = match &backup.content {
            Some(content) => {
                atomic_write(&backup.path, content.as_bytes(), 0o600, || async { Ok(()) }).await
            }
            None => remove_if_exists(&backup.path).await,
        };
        disk_ok &= result.is_ok();
    }
    let _ = run_checked(runner, "nmcli", &["connection", "reload"], None).await;
    let runtime_ok = match transaction.checkpoint_path.as_deref() {
        Some(path) => {
            rollback_checkpoint(path, runner).await.is_ok()
                || transaction
                    .public
                    .deadline_at
                    .as_deref()
                    .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
                    .is_some_and(|deadline| deadline <= OffsetDateTime::now_utc())
        }
        None => true,
    };
    transaction.public.rollback = if disk_ok && runtime_ok {
        RollbackStatus::Succeeded
    } else {
        RollbackStatus::Failed
    };
    transaction.public.status = if transaction.public.rollback == RollbackStatus::Succeeded {
        "rolled_back"
    } else {
        "failed"
    }
    .to_owned();
    transaction.public.deadline_at = None;
    if disk_ok && runtime_ok {
        transaction.checkpoint_path = None;
        transaction.backups.clear();
    } else {
        let _ = fs::create_dir_all(&options.state_dir).await;
    }
}

async fn collect_runtime_devices(
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<Vec<RuntimeDevice>, HostdError> {
    let output = run_checked(
        runner,
        "nmcli",
        &[
            "--terse",
            "--escape",
            "yes",
            "--fields",
            "DEVICE,TYPE,STATE,CONNECTION,CON-UUID",
            "device",
            "status",
        ],
        None,
    )
    .await?;
    let mut devices = Vec::new();
    for fields in output
        .lines()
        .filter(|line| !line.is_empty())
        .map(split_line)
    {
        if fields.len() < 5 || !matches!(fields[1].as_str(), "ethernet" | "802-3-ethernet") {
            continue;
        }
        let name = fields[0].clone();
        if !is_physical_device(&options.sys_class_net, &name).await {
            continue;
        }
        let core = nmcli_values(
            runner,
            &[
                "GENERAL.HWADDR",
                "GENERAL.DRIVER",
                "CAPABILITIES.SPEED",
                "WIRED-PROPERTIES.CARRIER",
                "GENERAL.DBUS-PATH",
            ],
            &["device", "show", &name],
        )
        .await?;
        let mac = core
            .first()
            .cloned()
            .unwrap_or_default()
            .replace("\\:", ":");
        let dbus_path = core
            .get(4)
            .cloned()
            .filter(|value| value.starts_with("/org/freedesktop/NetworkManager/Devices/"))
            .ok_or_else(|| {
                HostdError::unavailable("NetworkManager device D-Bus path is unavailable")
            })?;
        let permanent_mac = read_permanent_mac(&dbus_path, runner).await?;
        if mac_id(&permanent_mac).is_err() {
            continue;
        }
        let ipv4 = nmcli_lines(runner, "IP4.ADDRESS", &name).await?;
        let ipv6 = nmcli_lines(runner, "IP6.ADDRESS", &name).await?;
        let ipv4_routes = nmcli_lines(runner, "IP4.ROUTE", &name).await?;
        let ipv6_routes = nmcli_lines(runner, "IP6.ROUTE", &name).await?;
        let addresses = ipv4
            .into_iter()
            .filter_map(|cidr| ethernet_address("inet", &cidr, Some(name.clone())))
            .chain(
                ipv6.into_iter()
                    .filter_map(|cidr| ethernet_address("inet6", &cidr, Some(name.clone()))),
            )
            .collect();
        devices.push(RuntimeDevice {
            name,
            state: fields[2].clone(),
            connection_name: nullable(fields[3].clone()),
            connection_id: nullable(fields[4].clone()),
            mac,
            permanent_mac,
            driver: core.get(1).cloned().and_then(nullable),
            speed_mbps: core
                .get(2)
                .and_then(|value| value.trim_end_matches(" Mb/s").parse().ok())
                .filter(|speed| *speed > 0),
            carrier: core.get(3).is_some_and(|value| {
                matches!(value.to_ascii_lowercase().as_str(), "on" | "yes" | "true")
            }),
            ipv4_gateway: nmcli_lines(runner, "IP4.GATEWAY", &fields[0])
                .await?
                .into_iter()
                .next()
                .and_then(nullable),
            ipv6_gateway: nmcli_lines(runner, "IP6.GATEWAY", &fields[0])
                .await?
                .into_iter()
                .next()
                .and_then(nullable),
            ipv4_default_route_metric: default_route_metric(&ipv4_routes, 4),
            ipv6_default_route_metric: default_route_metric(&ipv6_routes, 6),
            dbus_path,
            addresses,
        });
    }
    Ok(devices)
}

async fn read_permanent_mac(
    dbus_path: &str,
    runner: &dyn CommandRunner,
) -> Result<String, HostdError> {
    let output = run_checked(
        runner,
        "busctl",
        &[
            "get-property",
            "org.freedesktop.NetworkManager",
            dbus_path,
            "org.freedesktop.NetworkManager.Device.Wired",
            "PermHwAddress",
        ],
        None,
    )
    .await
    .map_err(|_| HostdError::unavailable("NetworkManager permanent MAC is unavailable"))?;
    let value = output
        .split('"')
        .nth(1)
        .map(str::trim)
        .filter(|value| mac_id(value).is_ok())
        .ok_or_else(|| HostdError::unavailable("NetworkManager permanent MAC is unavailable"))?;
    Ok(value.to_owned())
}

async fn read_profile_config(
    profile_id: &str,
    runner: &dyn CommandRunner,
) -> Result<ProfileConfig, HostdError> {
    let properties = nmcli_properties(
        runner,
        &ETHERNET_PROFILE_FIELDS,
        &["connection", "show", "uuid", profile_id],
    )
    .await?;
    Ok(profile_config(&properties))
}

async fn find_saved_profile(
    device: &RuntimeDevice,
    runner: &dyn CommandRunner,
) -> Result<Option<SavedProfile>, HostdError> {
    let output = run_checked(
        runner,
        "nmcli",
        &[
            "--terse",
            "--escape",
            "yes",
            "--fields",
            "UUID,TYPE",
            "connection",
            "show",
        ],
        None,
    )
    .await?;
    let mut candidates = Vec::new();
    for fields in output
        .lines()
        .filter(|line| !line.is_empty())
        .map(split_line)
    {
        if fields.len() < 2 || !matches!(fields[1].as_str(), "ethernet" | "802-3-ethernet") {
            continue;
        }
        let profile = read_profile_config(&fields[0], runner).await?;
        if profile_matches_device(&profile, device) {
            candidates.push(SavedProfile {
                id: fields[0].clone(),
                profile,
            });
        }
    }
    candidates.sort_by(|left, right| {
        right
            .profile
            .autoconnect_priority
            .cmp(&left.profile.autoconnect_priority)
            .then_with(|| right.profile.timestamp.cmp(&left.profile.timestamp))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(candidates.into_iter().next())
}

fn profile_matches_device(profile: &ProfileConfig, device: &RuntimeDevice) -> bool {
    let explicitly_bound = profile.interface_name.is_some() || profile.mac_address.is_some();
    explicitly_bound
        && profile
            .interface_name
            .as_deref()
            .is_none_or(|name| name == device.name)
        && profile
            .mac_address
            .as_deref()
            .is_none_or(|mac| mac_id(mac).ok() == mac_id(&device.permanent_mac).ok())
}

fn profile_config(properties: &HashMap<String, String>) -> ProfileConfig {
    let values =
        ETHERNET_PROFILE_FIELDS.map(|field| properties.get(field).cloned().unwrap_or_default());
    let config = EthernetConfig {
        enabled: !matches!(
            values[26].to_ascii_lowercase().as_str(),
            "no" | "false" | "0"
        ),
        ipv4: ipv4_config(&values[3..11]),
        ipv6: ipv6_config(&values[11..19]),
    };
    let supported = matches!(values[0].as_str(), "ethernet" | "802-3-ethernet")
        && values[1].is_empty()
        && values[2].is_empty()
        && matches!(values[3].as_str(), "auto" | "manual" | "disabled")
        && matches!(
            values[11].as_str(),
            "auto" | "manual" | "disabled" | "ignore"
        )
        && !has_multiple(values[4].as_str())
        && !has_multiple(values[12].as_str())
        && values[10].is_empty()
        && values[18].is_empty()
        && values[19].is_empty()
        && matches!(values[20].as_str(), "" | "0" | "auto")
        && matches!(values[21].as_str(), "" | "default")
        && values[22].is_empty()
        && values[23].is_empty()
        && validate_config(&config).is_ok();
    ProfileConfig {
        config,
        supported,
        revision: profile_revision(&values),
        interface_name: nullable(values[24].clone()),
        mac_address: nullable(values[25].clone()).map(|value| value.replace("\\:", ":")),
        autoconnect_priority: values[27].parse().unwrap_or_default(),
        timestamp: values[28].parse().unwrap_or_default(),
    }
}

fn ipv4_config(values: &[String]) -> EthernetIpv4Config {
    let (address, prefix_length) = address_parts(values.get(1).map(String::as_str));
    let gateway = values.get(2).cloned().and_then(nullable);
    let use_default_route = !values.get(5).is_some_and(|value| yes(value));
    EthernetIpv4Config {
        mode: match values.first().map(String::as_str) {
            Some("manual") => "static",
            Some("disabled") => "disabled",
            _ => "dhcp",
        }
        .to_owned(),
        address,
        prefix_length,
        gateway: gateway.clone(),
        dns_mode: if values.get(3).is_some_and(|value| yes(value)) {
            "manual"
        } else {
            "automatic"
        }
        .to_owned(),
        dns: split_values(values.get(4)),
        use_default_route,
        route_metric: metric(values.get(6), use_default_route),
    }
}

fn ipv6_config(values: &[String]) -> EthernetIpv6Config {
    let (address, prefix_length) = address_parts(values.get(1).map(String::as_str));
    let gateway = values.get(2).cloned().and_then(nullable);
    let use_default_route = !values.get(5).is_some_and(|value| yes(value));
    EthernetIpv6Config {
        mode: match values.first().map(String::as_str) {
            Some("manual") => "static",
            Some("disabled" | "ignore") => "disabled",
            _ => "automatic",
        }
        .to_owned(),
        address,
        prefix_length,
        gateway: gateway.clone(),
        dns_mode: if values.get(3).is_some_and(|value| yes(value)) {
            "manual"
        } else {
            "automatic"
        }
        .to_owned(),
        dns: split_values(values.get(4)),
        use_default_route,
        route_metric: metric(values.get(6), use_default_route),
    }
}

fn render_profile(runtime: &RuntimeDevice, desired: &DesiredDevice) -> String {
    let config = &desired.config;
    let mut lines = vec![
        "# Managed by SigmaOS. Do not edit this file directly.".to_owned(),
        String::new(),
        "[connection]".to_owned(),
        format!("id=SigmaOS Ethernet {}", runtime.name),
        format!("uuid={}", desired.managed_profile_id),
        "type=ethernet".to_owned(),
        "autoconnect=true".to_owned(),
        format!("autoconnect-priority={MANAGED_AUTOCONNECT_PRIORITY}"),
        String::new(),
        "[ethernet]".to_owned(),
        format!("mac-address={}", normalize_mac(&runtime.permanent_mac)),
    ];
    render_family(
        &mut lines,
        "ipv4",
        if config.enabled {
            &config.ipv4.mode
        } else {
            "disabled"
        },
        config
            .enabled
            .then_some(config.ipv4.address.as_deref())
            .flatten(),
        config
            .enabled
            .then_some(config.ipv4.prefix_length)
            .flatten(),
        config
            .enabled
            .then_some(config.ipv4.gateway.as_deref())
            .flatten(),
        if config.enabled {
            &config.ipv4.dns_mode
        } else {
            "automatic"
        },
        if config.enabled {
            &config.ipv4.dns
        } else {
            &[]
        },
        config.enabled && config.ipv4.use_default_route,
        config.ipv4.route_metric,
    );
    render_family(
        &mut lines,
        "ipv6",
        if config.enabled {
            &config.ipv6.mode
        } else {
            "disabled"
        },
        config
            .enabled
            .then_some(config.ipv6.address.as_deref())
            .flatten(),
        config
            .enabled
            .then_some(config.ipv6.prefix_length)
            .flatten(),
        config
            .enabled
            .then_some(config.ipv6.gateway.as_deref())
            .flatten(),
        if config.enabled {
            &config.ipv6.dns_mode
        } else {
            "automatic"
        },
        if config.enabled {
            &config.ipv6.dns
        } else {
            &[]
        },
        config.enabled && config.ipv6.use_default_route,
        config.ipv6.route_metric,
    );
    lines.push(String::new());
    lines.join("\n")
}

#[allow(clippy::too_many_arguments)]
fn render_family(
    lines: &mut Vec<String>,
    family: &str,
    mode: &str,
    address: Option<&str>,
    prefix: Option<u8>,
    gateway: Option<&str>,
    dns_mode: &str,
    dns: &[String],
    default_route: bool,
    metric: u32,
) {
    lines.extend([
        String::new(),
        format!("[{family}]"),
        format!(
            "method={}",
            match mode {
                "static" => "manual",
                "dhcp" | "automatic" => "auto",
                _ => "disabled",
            }
        ),
    ]);
    if mode == "static" {
        lines.push(format!(
            "address1={}/{}{}",
            address.unwrap_or_default(),
            prefix.unwrap_or_default(),
            gateway.map(|value| format!(",{value}")).unwrap_or_default()
        ));
    }
    if dns_mode == "manual" && !dns.is_empty() {
        lines.push(format!("dns={};", dns.join(";")));
        lines.push("ignore-auto-dns=true".to_owned());
    }
    lines.push(format!("never-default={}", !default_route));
    lines.push(format!("route-metric={metric}"));
}

fn validate_config(config: &EthernetConfig) -> Result<(), HostdError> {
    validate_family(
        4,
        &config.ipv4.mode,
        config.ipv4.address.as_deref(),
        config.ipv4.prefix_length,
        config.ipv4.gateway.as_deref(),
        &config.ipv4.dns_mode,
        &config.ipv4.dns,
        config.ipv4.use_default_route,
        config.ipv4.route_metric,
    )?;
    validate_family(
        6,
        &config.ipv6.mode,
        config.ipv6.address.as_deref(),
        config.ipv6.prefix_length,
        config.ipv6.gateway.as_deref(),
        &config.ipv6.dns_mode,
        &config.ipv6.dns,
        config.ipv6.use_default_route,
        config.ipv6.route_metric,
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_family(
    family: u8,
    mode: &str,
    address: Option<&str>,
    prefix: Option<u8>,
    gateway: Option<&str>,
    dns_mode: &str,
    dns: &[String],
    default_route: bool,
    metric: u32,
) -> Result<(), HostdError> {
    let valid_mode = if family == 4 {
        matches!(mode, "disabled" | "dhcp" | "static")
    } else {
        matches!(mode, "disabled" | "automatic" | "static")
    };
    if !valid_mode
        || !matches!(dns_mode, "automatic" | "manual")
        || !(1..=65_535).contains(&metric)
        || dns.len() > 3
    {
        return Err(HostdError::validation(
            "Invalid Ethernet address-family configuration",
        ));
    }
    let matches_family = |value: &str| {
        value.parse::<IpAddr>().is_ok_and(|parsed| {
            if family == 4 {
                parsed.is_ipv4()
            } else {
                parsed.is_ipv6()
            }
        })
    };
    if mode == "static" {
        if !address.is_some_and(matches_family)
            || prefix.is_none_or(|value| value > if family == 4 { 32 } else { 128 })
        {
            return Err(HostdError::validation(
                "Static Ethernet configuration requires a valid address and prefix",
            ));
        }
        if gateway.is_some_and(|value| !matches_family(value)) {
            return Err(HostdError::validation(
                "Static Ethernet gateway has the wrong address family",
            ));
        }
        if default_route && gateway.is_none() {
            return Err(HostdError::validation(
                "A static default route requires a gateway",
            ));
        }
    } else if address.is_some() || prefix.is_some() || gateway.is_some() {
        return Err(HostdError::validation(
            "Automatic or disabled Ethernet modes cannot include a static address",
        ));
    }
    if dns.iter().any(|value| !matches_family(value))
        || (dns_mode == "automatic" && !dns.is_empty())
        || (dns_mode == "manual" && dns.is_empty())
    {
        return Err(HostdError::validation("Invalid Ethernet DNS configuration"));
    }
    Ok(())
}

fn validate_metric_conflicts(
    state: &DesiredState,
    present_device_ids: &HashSet<String>,
) -> Result<(), HostdError> {
    for family in [4_u8, 6_u8] {
        let mut metrics = HashSet::new();
        for entry in state.devices.iter().filter_map(|(id, entry)| {
            (present_device_ids.contains(id)
                && entry.config.enabled
                && family_default(&entry.config, family))
            .then_some(entry)
        }) {
            let metric = if family == 4 {
                entry.config.ipv4.route_metric
            } else {
                entry.config.ipv6.route_metric
            };
            if !metrics.insert(metric) {
                return Err(HostdError::conflict(format!(
                    "IPv{family} default routes must use different metrics"
                )));
            }
        }
    }
    Ok(())
}

fn source_profile_matches(
    entry: &DesiredDevice,
    active_profile_id: Option<&str>,
    source: Option<&ProfileConfig>,
) -> bool {
    if active_profile_id.is_some() && entry.source_profile_id.as_deref() != active_profile_id {
        return false;
    }
    if entry.source_profile_id.as_deref() == Some(entry.managed_profile_id.as_str()) {
        return source.is_some_and(|profile| {
            profile.supported
                && (is_blocking_profile(&profile.config)
                    || config_revision(&profile.config, &entry.managed_profile_id)
                        .ok()
                        .as_deref()
                        == entry.applied_revision.as_deref())
        });
    }
    match (
        entry.source_profile_id.as_deref(),
        entry.source_profile_revision.as_deref(),
        source,
    ) {
        (Some(_), Some(expected), Some(profile)) => {
            profile.supported && expected == profile.revision
        }
        (None, None, None) => active_profile_id.is_none(),
        _ => false,
    }
}

fn is_blocking_profile(config: &EthernetConfig) -> bool {
    config.enabled
        && config.ipv4.mode == "disabled"
        && config.ipv6.mode == "disabled"
        && config.ipv4.address.is_none()
        && config.ipv6.address.is_none()
        && config.ipv4.gateway.is_none()
        && config.ipv6.gateway.is_none()
        && config.ipv4.dns_mode == "automatic"
        && config.ipv6.dns_mode == "automatic"
        && config.ipv4.dns.is_empty()
        && config.ipv6.dns.is_empty()
        && !config.ipv4.use_default_route
        && !config.ipv6.use_default_route
}

fn desired_is_applied(
    entry: &DesiredDevice,
    device: &RuntimeDevice,
    active: Option<&ProfileConfig>,
) -> bool {
    if device.connection_id.as_deref() != Some(entry.managed_profile_id.as_str()) {
        return false;
    }
    active.is_some_and(|profile| {
        profile.supported
            && profile.autoconnect_priority == MANAGED_AUTOCONNECT_PRIORITY
            && if entry.config.enabled {
                profile.config == entry.config
            } else {
                is_blocking_profile(&profile.config)
                    && validate_device_applied(entry, device).is_ok()
            }
    })
}

fn effective_active_config(
    active: Option<&ProfileConfig>,
    entry: Option<&DesiredDevice>,
    runtime_matches: bool,
) -> Option<EthernetConfig> {
    active.filter(|profile| profile.supported).map(|profile| {
        let mut config = profile.config.clone();
        if is_blocking_profile(&config)
            || (runtime_matches && entry.is_some_and(|entry| !entry.config.enabled))
        {
            config.enabled = false;
        }
        config
    })
}

fn family_default(config: &EthernetConfig, family: u8) -> bool {
    if !config.enabled {
        return false;
    }
    if family == 4 {
        config.ipv4.mode != "disabled" && config.ipv4.use_default_route
    } else {
        config.ipv6.mode != "disabled" && config.ipv6.use_default_route
    }
}

fn has_asymmetric_subnet_routing(devices: &[EthernetDevice]) -> bool {
    for (index, left) in devices.iter().enumerate() {
        for right in &devices[index + 1..] {
            for family in [4_u8, 6_u8] {
                let same_subnet = left.addresses.iter().any(|left_address| {
                    right
                        .addresses
                        .iter()
                        .any(|right_address| same_network(left_address, right_address, family))
                });
                let left_default = left
                    .desired_config
                    .as_ref()
                    .is_some_and(|config| family_default(config, family));
                let right_default = right
                    .desired_config
                    .as_ref()
                    .is_some_and(|config| family_default(config, family));
                if same_subnet && left_default != right_default {
                    return true;
                }
            }
        }
    }
    false
}

fn same_network(left: &EthernetAddress, right: &EthernetAddress, family: u8) -> bool {
    if left.scope.as_deref() == Some("link")
        || right.scope.as_deref() == Some("link")
        || left.family != right.family
        || (family == 4 && left.family != "inet")
        || (family == 6 && left.family != "inet6")
        || left.prefix_length != right.prefix_length
    {
        return false;
    }
    let Some(prefix) = left.prefix_length else {
        return false;
    };
    match (
        left.address.parse::<IpAddr>().ok(),
        right.address.parse::<IpAddr>().ok(),
    ) {
        (Some(IpAddr::V4(left)), Some(IpAddr::V4(right))) if prefix <= 32 => {
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            u32::from(left) & mask == u32::from(right) & mask
        }
        (Some(IpAddr::V6(left)), Some(IpAddr::V6(right))) if prefix <= 128 => {
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            u128::from(left) & mask == u128::from(right) & mask
        }
        _ => false,
    }
}

async fn validate_applied(
    device_ids: &[String],
    desired: &DesiredState,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<(), HostdError> {
    let runtime = collect_runtime_devices(runner, options).await?;
    for id in device_ids {
        let entry = &desired.devices[id];
        let Some(device) = runtime
            .iter()
            .find(|device| mac_id(&device.permanent_mac).ok().as_deref() == Some(id))
        else {
            return Err(HostdError::operation_failed(
                "Ethernet device disappeared during apply",
            ));
        };
        validate_device_applied(entry, device)?;
    }
    Ok(())
}

async fn wait_for_applied(
    device_ids: &[String],
    desired: &DesiredState,
    runner: &dyn CommandRunner,
    options: &NetworkOptions,
) -> Result<(), HostdError> {
    // NetworkManager can report an activated connection before IPv6 SLAAC and
    // duplicate-address detection have installed the usable address.
    retry_applied_validation(
        || validate_applied(device_ids, desired, runner, options),
        APPLY_VALIDATION_ATTEMPTS,
        APPLY_VALIDATION_INTERVAL,
    )
    .await
}

async fn retry_applied_validation<F, Fut>(
    mut validate: F,
    attempts: usize,
    interval: StdDuration,
) -> Result<(), HostdError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<(), HostdError>>,
{
    let mut last_error = None;
    for attempt in 0..attempts {
        match validate().await {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < attempts {
            sleep(interval).await;
        }
    }
    Err(last_error
        .unwrap_or_else(|| HostdError::operation_failed("Ethernet apply validation failed")))
}

fn validate_device_applied(
    entry: &DesiredDevice,
    device: &RuntimeDevice,
) -> Result<(), HostdError> {
    if !entry.config.enabled {
        let has_usable_address = device.addresses.iter().any(|address| {
            address.family == "inet"
                || (address.family == "inet6" && address.scope.as_deref() != Some("link"))
        });
        if device.connection_id.as_deref() != Some(entry.managed_profile_id.as_str())
            || has_usable_address
            || device.ipv4_default_route_metric.is_some()
            || device.ipv6_default_route_metric.is_some()
        {
            return Err(HostdError::operation_failed(
                "Disabled Ethernet device is not held by its managed profile",
            ));
        }
        return Ok(());
    }
    if device.connection_id.as_deref() != Some(entry.managed_profile_id.as_str()) {
        return Err(HostdError::operation_failed(
            "Managed Ethernet profile did not activate",
        ));
    }
    validate_family_addresses(
        "IPv4",
        "inet",
        &entry.config.ipv4.mode,
        entry.config.ipv4.address.as_deref(),
        entry.config.ipv4.prefix_length,
        &device.addresses,
    )?;
    validate_family_addresses(
        "IPv6",
        "inet6",
        &entry.config.ipv6.mode,
        entry.config.ipv6.address.as_deref(),
        entry.config.ipv6.prefix_length,
        &device.addresses,
    )?;
    validate_static_gateway(
        "IPv4",
        &entry.config.ipv4.mode,
        entry.config.ipv4.use_default_route,
        entry.config.ipv4.gateway.as_deref(),
        device.ipv4_gateway.as_deref(),
    )?;
    validate_static_gateway(
        "IPv6",
        &entry.config.ipv6.mode,
        entry.config.ipv6.use_default_route,
        entry.config.ipv6.gateway.as_deref(),
        device.ipv6_gateway.as_deref(),
    )?;
    validate_default_route(
        "IPv4",
        entry.config.ipv4.mode != "disabled" && entry.config.ipv4.use_default_route,
        entry.config.ipv4.route_metric,
        device.ipv4_default_route_metric,
    )?;
    validate_default_route(
        "IPv6",
        entry.config.ipv6.mode != "disabled" && entry.config.ipv6.use_default_route,
        entry.config.ipv6.route_metric,
        device.ipv6_default_route_metric,
    )
}

fn validate_family_addresses(
    family_name: &str,
    family: &str,
    mode: &str,
    expected_address: Option<&str>,
    expected_prefix: Option<u8>,
    addresses: &[EthernetAddress],
) -> Result<(), HostdError> {
    let family_addresses = addresses
        .iter()
        .filter(|address| address.family == family)
        .collect::<Vec<_>>();
    let valid = match mode {
        "disabled" => family_addresses.is_empty(),
        "static" => family_addresses.iter().any(|address| {
            Some(address.address.as_str()) == expected_address
                && address.prefix_length == expected_prefix
        }),
        _ if family == "inet6" => family_addresses
            .iter()
            .any(|address| address.scope.as_deref() != Some("link")),
        _ => !family_addresses.is_empty(),
    };
    if valid {
        Ok(())
    } else {
        Err(HostdError::operation_failed(format!(
            "Ethernet {family_name} address configuration did not apply"
        )))
    }
}

fn validate_static_gateway(
    family: &str,
    mode: &str,
    use_default_route: bool,
    expected: Option<&str>,
    active: Option<&str>,
) -> Result<(), HostdError> {
    if mode == "static" && use_default_route && expected != active {
        Err(HostdError::operation_failed(format!(
            "Ethernet {family} gateway did not apply"
        )))
    } else {
        Ok(())
    }
}

fn validate_default_route(
    family: &str,
    expected: bool,
    expected_metric: u32,
    active_metric: Option<u32>,
) -> Result<(), HostdError> {
    match (expected, active_metric) {
        (true, Some(metric)) if metric == expected_metric => Ok(()),
        (true, Some(_)) => Err(HostdError::operation_failed(format!(
            "{family} default route metric did not apply"
        ))),
        (true, None) => Err(HostdError::operation_failed(format!(
            "{family} default route was not installed"
        ))),
        (false, Some(_)) => Err(HostdError::operation_failed(format!(
            "{family} default route was not removed"
        ))),
        (false, None) => Ok(()),
    }
}

async fn create_checkpoint(
    paths: &[String],
    runner: &dyn CommandRunner,
) -> Result<String, HostdError> {
    if paths.is_empty() {
        return Err(HostdError::conflict(
            "There are no Ethernet devices to apply",
        ));
    }
    let mut args = vec![
        "call",
        "org.freedesktop.NetworkManager",
        "/org/freedesktop/NetworkManager",
        "org.freedesktop.NetworkManager",
        "CheckpointCreate",
        "aouu",
        &paths.len().to_string(),
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    args.extend(paths.iter().cloned());
    args.extend([CHECKPOINT_SECONDS.to_string(), "0".to_owned()]);
    let output = run_checked(runner, "busctl", &args, None)
        .await
        .map_err(|_| HostdError::unavailable("NetworkManager checkpoint support is unavailable"))?;
    output
        .split('"')
        .nth(1)
        .filter(|value| value.starts_with("/org/freedesktop/NetworkManager/Checkpoint/"))
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            HostdError::operation_failed("NetworkManager returned an invalid checkpoint")
        })
}

async fn destroy_checkpoint(path: &str, runner: &dyn CommandRunner) -> Result<(), HostdError> {
    validate_checkpoint_path(path)?;
    run_checked(
        runner,
        "busctl",
        &[
            "call",
            "org.freedesktop.NetworkManager",
            "/org/freedesktop/NetworkManager",
            "org.freedesktop.NetworkManager",
            "CheckpointDestroy",
            "o",
            path,
        ],
        None,
    )
    .await
    .map(|_| ())
}

async fn rollback_checkpoint(path: &str, runner: &dyn CommandRunner) -> Result<(), HostdError> {
    validate_checkpoint_path(path)?;
    run_checked(
        runner,
        "busctl",
        &[
            "call",
            "org.freedesktop.NetworkManager",
            "/org/freedesktop/NetworkManager",
            "org.freedesktop.NetworkManager",
            "CheckpointRollback",
            "o",
            path,
        ],
        None,
    )
    .await
    .map(|_| ())
}

fn validate_checkpoint_path(path: &str) -> Result<(), HostdError> {
    if path
        .strip_prefix("/org/freedesktop/NetworkManager/Checkpoint/")
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit())
        })
    {
        Ok(())
    } else {
        Err(HostdError::validation(
            "Invalid NetworkManager checkpoint path",
        ))
    }
}

async fn nmcli_values(
    runner: &dyn CommandRunner,
    fields: &[&str],
    suffix: &[&str],
) -> Result<Vec<String>, HostdError> {
    let joined = fields.join(",");
    let mut args = vec!["--get-values", &joined];
    args.extend_from_slice(suffix);
    let output = run_checked(runner, "nmcli", &args, None).await?;
    let mut values = output
        .split('\n')
        .map(|line| line.trim_end_matches('\r').trim().to_owned())
        .collect::<Vec<_>>();
    if output.ends_with('\n') {
        values.pop();
    }
    while values.len() < fields.len() {
        values.push(String::new());
    }
    Ok(values)
}

async fn nmcli_properties(
    runner: &dyn CommandRunner,
    fields: &[&str],
    suffix: &[&str],
) -> Result<HashMap<String, String>, HostdError> {
    let joined = fields.join(",");
    let mut args = vec!["--terse", "--escape", "no", "--fields", &joined];
    args.extend_from_slice(suffix);
    let output = run_checked(runner, "nmcli", &args, None).await?;
    Ok(parse_nmcli_properties(&output))
}

fn parse_nmcli_properties(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| line.trim_end_matches('\r').split_once(':'))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        .collect()
}

async fn nmcli_lines(
    runner: &dyn CommandRunner,
    field: &str,
    device: &str,
) -> Result<Vec<String>, HostdError> {
    let output = run_checked(
        runner,
        "nmcli",
        &[
            "--terse", "--escape", "no", "--fields", field, "device", "show", device,
        ],
        None,
    )
    .await?;
    Ok(parse_nmcli_field_values(&output))
}

fn parse_nmcli_field_values(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| line.trim_end_matches('\r').split_once(':'))
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty() && *value != "--")
        .map(ToOwned::to_owned)
        .collect()
}

async fn read_desired(options: &NetworkOptions) -> Result<DesiredState, HostdError> {
    read_json(
        &options.state_dir.join(STATE_FILE),
        "Ethernet desired state",
    )
    .await
    .map(Option::unwrap_or_default)
}

async fn write_desired(options: &NetworkOptions, state: &DesiredState) -> Result<(), HostdError> {
    write_json(&options.state_dir.join(STATE_FILE), state).await
}

async fn read_transaction(
    options: &NetworkOptions,
) -> Result<Option<PersistedTransaction>, HostdError> {
    read_json(
        &options.state_dir.join(TRANSACTION_FILE),
        "Ethernet transaction state",
    )
    .await
}

async fn write_transaction(
    options: &NetworkOptions,
    transaction: &PersistedTransaction,
) -> Result<(), HostdError> {
    write_json(&options.state_dir.join(TRANSACTION_FILE), transaction).await
}

async fn read_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    label: &str,
) -> Result<Option<T>, HostdError> {
    match fs::read(path).await {
        Ok(content) => serde_json::from_slice(&content)
            .map(Some)
            .map_err(|_| HostdError::validation(format!("{label} is invalid"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), HostdError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
        fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
    }
    let mut content = serde_json::to_vec_pretty(value)
        .map_err(|error| HostdError::operation_failed(error.to_string()))?;
    content.push(b'\n');
    atomic_write(path, &content, 0o600, || async { Ok(()) }).await
}

async fn read_backups(
    device_ids: &[String],
    options: &NetworkOptions,
) -> Result<Vec<ProfileBackup>, HostdError> {
    let mut result = Vec::new();
    for id in device_ids {
        let path = managed_profile_path(options, id);
        reject_symlink(&path).await?;
        let content = match fs::read_to_string(&path).await {
            Ok(content) => Some(content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        result.push(ProfileBackup {
            device_id: id.clone(),
            path,
            content,
        });
    }
    Ok(result)
}

async fn ensure_no_active_transaction(options: &NetworkOptions) -> Result<(), HostdError> {
    if read_transaction(options).await?.is_some_and(|transaction| {
        matches!(
            transaction.public.status.as_str(),
            "applying" | "awaiting_confirmation" | "rolling_back"
        )
    }) {
        Err(HostdError::conflict(
            "An Ethernet apply transaction is already active",
        ))
    } else {
        Ok(())
    }
}

fn new_desired(
    config: EthernetConfig,
    source_profile_id: Option<String>,
    source_profile_revision: Option<String>,
) -> DesiredDevice {
    let managed_profile_id = Uuid::new_v4().to_string();
    let revision = config_revision(&config, &managed_profile_id).unwrap_or_default();
    DesiredDevice {
        config,
        revision,
        applied_revision: None,
        managed_profile_id,
        source_profile_id,
        source_profile_revision,
    }
}

fn profile_revision(values: &[String]) -> String {
    let mut digest = Sha256::new();
    for (field, value) in ETHERNET_PROFILE_FIELDS.iter().zip(values) {
        if *field == "connection.timestamp" {
            continue;
        }
        digest.update(field.as_bytes());
        digest.update([0]);
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

fn default_config(ipv4_default: bool, ipv6_default: bool) -> EthernetConfig {
    EthernetConfig {
        enabled: true,
        ipv4: EthernetIpv4Config {
            mode: "dhcp".to_owned(),
            address: None,
            prefix_length: None,
            gateway: None,
            dns_mode: "automatic".to_owned(),
            dns: Vec::new(),
            use_default_route: ipv4_default,
            route_metric: if ipv4_default { 100 } else { 600 },
        },
        ipv6: EthernetIpv6Config {
            mode: "automatic".to_owned(),
            address: None,
            prefix_length: None,
            gateway: None,
            dns_mode: "automatic".to_owned(),
            dns: Vec::new(),
            use_default_route: ipv6_default,
            route_metric: if ipv6_default { 100 } else { 600 },
        },
    }
}

fn config_revision(config: &EthernetConfig, profile_id: &str) -> Result<String, HostdError> {
    let content = serde_json::to_vec(&(config, profile_id))
        .map_err(|error| HostdError::operation_failed(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(content)))
}

fn managed_profile_path(options: &NetworkOptions, id: &str) -> PathBuf {
    options
        .connections_dir
        .join(format!("{ETHERNET_PREFIX}{id}.nmconnection"))
}

async fn is_physical_device(sys_class_net: &Path, name: &str) -> bool {
    if name.is_empty() || name.contains('/') {
        return false;
    }
    fs::metadata(sys_class_net.join(name).join("device"))
        .await
        .is_ok()
}

async fn regular_file_exists(path: &Path) -> Result<bool, HostdError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(HostdError::validation(
            "Managed Ethernet profile must be a regular file",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

async fn reject_symlink(path: &Path) -> Result<(), HostdError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if !metadata.is_file() => Err(HostdError::validation(
            "Managed Ethernet profile must be a regular file",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn validate_device_id(value: &str) -> Result<(), HostdError> {
    if value.len() == 12
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(HostdError::validation("Invalid Ethernet device id"))
    }
}

fn validate_uuid(value: &str) -> Result<(), HostdError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| HostdError::validation("Invalid Ethernet transaction id"))
}

fn mac_id(value: &str) -> Result<String, HostdError> {
    let id = value
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    validate_device_id(&id)?;
    Ok(id)
}

fn normalize_mac(value: &str) -> String {
    value.to_ascii_lowercase()
}

fn ethernet_address(family: &str, cidr: &str, label: Option<String>) -> Option<EthernetAddress> {
    let (address, prefix) = cidr.split_once('/')?;
    let prefix_length = prefix.parse().ok();
    Some(EthernetAddress {
        family: family.to_owned(),
        address: address.to_owned(),
        prefix_length,
        cidr: Some(cidr.to_owned()),
        scope: if family == "inet6" && address.to_ascii_lowercase().starts_with("fe80:") {
            Some("link".to_owned())
        } else {
            Some("global".to_owned())
        },
        label,
    })
}

fn address_parts(value: Option<&str>) -> (Option<String>, Option<u8>) {
    let first = value
        .and_then(|value| value.split([',', ';']).find(|part| !part.trim().is_empty()))
        .map(str::trim);
    let Some((address, prefix)) = first.and_then(|value| value.split_once('/')) else {
        return (None, None);
    };
    (Some(address.to_owned()), prefix.parse().ok())
}

fn split_values(value: Option<&String>) -> Vec<String> {
    value
        .into_iter()
        .flat_map(|value| value.split([',', ';', ' ']))
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "--")
        .map(ToOwned::to_owned)
        .collect()
}

fn has_multiple(value: &str) -> bool {
    value
        .split([',', ';'])
        .filter(|part| !part.trim().is_empty())
        .count()
        > 1
}

fn default_route_metric(routes: &[String], family: u8) -> Option<u32> {
    let target = if family == 4 { "0.0.0.0/0" } else { "::/0" };
    routes.iter().find_map(|route| {
        let fields = route.split(',').map(str::trim).collect::<Vec<_>>();
        let is_default = fields.iter().any(|field| {
            field
                .strip_prefix("dst = ")
                .is_some_and(|destination| destination == target || destination == "default")
        });
        if !is_default {
            return None;
        }
        fields
            .iter()
            .find_map(|field| field.strip_prefix("mt = "))
            .and_then(|metric| metric.parse().ok())
    })
}

fn metric(value: Option<&String>, default_route: bool) -> u32 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| (1..=65_535).contains(value))
        .map(|value| value as u32)
        .unwrap_or(if default_route { 100 } else { 600 })
}

fn yes(value: &str) -> bool {
    matches!(value.to_ascii_lowercase().as_str(), "yes" | "true" | "1")
}

fn nullable(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value != "--").then(|| value.to_owned())
}

fn ethernet_state(
    nm_state: &str,
    carrier: bool,
    has_address: bool,
    enabled: Option<bool>,
) -> String {
    if enabled == Some(false) {
        "disabled"
    } else if nm_state.contains("unavailable") {
        "unavailable"
    } else if has_address {
        "connected"
    } else if carrier {
        "up"
    } else {
        "down"
    }
    .to_owned()
}

fn now() -> Result<String, HostdError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(time_error)
}

fn time_error(error: time::error::Format) -> HostdError {
    HostdError::operation_failed(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::{CommandOutput, SystemCommandRunner};
    use async_trait::async_trait;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    #[derive(Default)]
    struct FakeRunner {
        calls: Mutex<Vec<(String, Vec<String>)>>,
    }

    #[async_trait]
    impl CommandRunner for FakeRunner {
        async fn run(
            &self,
            command: &str,
            args: &[String],
            _input: Option<&[u8]>,
            _timeout: StdDuration,
            _output_limit: usize,
        ) -> Result<CommandOutput, HostdError> {
            self.calls
                .lock()
                .unwrap()
                .push((command.to_owned(), args.to_vec()));
            let stdout = if command == "busctl"
                && args.first().is_some_and(|value| value == "get-property")
            {
                "s \"2C:CF:67:C9:68:07\"\n".to_owned()
            } else {
                String::new()
            };
            Ok(CommandOutput {
                stdout,
                stderr: String::new(),
                success: true,
            })
        }
    }

    fn runtime_device(name: &str, mac: &str) -> RuntimeDevice {
        RuntimeDevice {
            name: name.to_owned(),
            state: "connected".to_owned(),
            connection_name: None,
            connection_id: None,
            mac: mac.to_owned(),
            permanent_mac: mac.to_owned(),
            driver: None,
            speed_mbps: None,
            carrier: true,
            addresses: Vec::new(),
            ipv4_gateway: None,
            ipv6_gateway: None,
            ipv4_default_route_metric: None,
            ipv6_default_route_metric: None,
            dbus_path: "/org/freedesktop/NetworkManager/Devices/2".to_owned(),
        }
    }

    #[test]
    fn validates_static_families_and_dns() {
        let mut config = default_config(true, false);
        config.ipv4 = EthernetIpv4Config {
            mode: "static".to_owned(),
            address: Some("192.168.11.20".to_owned()),
            prefix_length: Some(24),
            gateway: Some("192.168.11.1".to_owned()),
            dns_mode: "manual".to_owned(),
            dns: vec!["1.1.1.1".to_owned()],
            use_default_route: true,
            route_metric: 100,
        };
        assert!(validate_config(&config).is_ok());
        config.ipv4.dns = vec!["2001:4860:4860::8888".to_owned()];
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn rejects_duplicate_default_route_metrics() {
        let mut state = DesiredState::default();
        state.devices.insert(
            "001122334455".to_owned(),
            new_desired(default_config(true, false), None, None),
        );
        state.devices.insert(
            "001122334466".to_owned(),
            new_desired(default_config(true, false), None, None),
        );
        let both = HashSet::from(["001122334455".to_owned(), "001122334466".to_owned()]);
        assert!(validate_metric_conflicts(&state, &both).is_err());
        let one = HashSet::from(["001122334455".to_owned()]);
        assert!(validate_metric_conflicts(&state, &one).is_ok());
    }

    #[test]
    fn permits_takeover_when_a_device_has_no_active_profile() {
        let desired = new_desired(default_config(false, false), None, None);
        assert!(source_profile_matches(&desired, None, None));
        assert!(!source_profile_matches(
            &desired,
            Some("550e8400-e29b-41d4-a716-446655440000"),
            None
        ));
    }

    #[test]
    fn matches_inactive_profiles_only_when_explicitly_bound_to_the_device() {
        let runtime = RuntimeDevice {
            name: "eth7".to_owned(),
            state: "disconnected".to_owned(),
            connection_name: None,
            connection_id: None,
            mac: "2c:cf:67:c9:68:07".to_owned(),
            permanent_mac: "2c:cf:67:c9:68:07".to_owned(),
            driver: None,
            speed_mbps: None,
            carrier: false,
            addresses: Vec::new(),
            ipv4_gateway: None,
            ipv6_gateway: None,
            ipv4_default_route_metric: None,
            ipv6_default_route_metric: None,
            dbus_path: "/org/freedesktop/NetworkManager/Devices/2".to_owned(),
        };
        let mut profile = ProfileConfig {
            config: default_config(false, false),
            supported: true,
            revision: "profile-revision".to_owned(),
            interface_name: Some("eth7".to_owned()),
            mac_address: Some("2C:CF:67:C9:68:07".to_owned()),
            autoconnect_priority: 100,
            timestamp: 1,
        };
        assert!(profile_matches_device(&profile, &runtime));

        let desired = new_desired(
            profile.config.clone(),
            Some("550e8400-e29b-41d4-a716-446655440000".to_owned()),
            Some(profile.revision.clone()),
        );
        assert!(source_profile_matches(&desired, None, Some(&profile)));
        assert!(source_profile_matches(
            &desired,
            Some("550e8400-e29b-41d4-a716-446655440000"),
            Some(&profile)
        ));
        assert!(!source_profile_matches(
            &desired,
            Some("550e8400-e29b-41d4-a716-446655440001"),
            Some(&profile)
        ));

        profile.interface_name = None;
        profile.mac_address = None;
        assert!(!profile_matches_device(&profile, &runtime));
        profile.mac_address = Some("2c:cf:67:c9:68:08".to_owned());
        assert!(!profile_matches_device(&profile, &runtime));
    }

    #[test]
    fn permits_reenabling_an_unchanged_managed_profile() {
        let disabled_config = EthernetConfig {
            enabled: false,
            ..default_config(false, false)
        };
        let mut desired = new_desired(disabled_config.clone(), None, None);
        desired.applied_revision = Some(desired.revision.clone());
        desired.source_profile_id = Some(desired.managed_profile_id.clone());
        desired.config.enabled = true;
        desired.revision = config_revision(&desired.config, &desired.managed_profile_id).unwrap();
        let mut profile = ProfileConfig {
            config: disabled_config,
            supported: true,
            revision: "profile-revision".to_owned(),
            interface_name: None,
            mac_address: Some("2c:cf:67:c9:68:07".to_owned()),
            autoconnect_priority: 1_000,
            timestamp: 0,
        };

        assert!(source_profile_matches(&desired, None, Some(&profile)));
        profile.config.ipv4.route_metric = 601;
        assert!(!source_profile_matches(&desired, None, Some(&profile)));

        profile.config = default_config(false, false);
        profile.config.ipv4.mode = "disabled".to_owned();
        profile.config.ipv6.mode = "disabled".to_owned();
        assert!(is_blocking_profile(&profile.config));
        assert!(source_profile_matches(&desired, None, Some(&profile)));
    }

    #[tokio::test]
    async fn reads_the_permanent_mac_from_network_manager_dbus() {
        let runner = FakeRunner::default();
        let value = read_permanent_mac("/org/freedesktop/NetworkManager/Devices/2", &runner)
            .await
            .unwrap();

        assert_eq!(value, "2C:CF:67:C9:68:07");
        assert_eq!(runner.calls.lock().unwrap()[0].0, "busctl");
    }

    #[tokio::test]
    async fn retries_applied_validation_while_ipv6_converges() {
        let attempts = AtomicUsize::new(0);

        retry_applied_validation(
            || {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt < 2 {
                        Err(HostdError::operation_failed(
                            "Ethernet IPv6 address configuration did not apply",
                        ))
                    } else {
                        Ok(())
                    }
                }
            },
            3,
            StdDuration::ZERO,
        )
        .await
        .unwrap();

        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn restores_profile_files_when_a_transaction_expires_without_polling() {
        let temp = TempDir::new().unwrap();
        let options = NetworkOptions {
            connections_dir: temp.path().join("connections"),
            state_dir: temp.path().join("state"),
            sys_class_net: temp.path().join("sys-class-net"),
        };
        fs::create_dir_all(&options.connections_dir).await.unwrap();
        let device_id = "2ccf67c96807";
        let profile_path = managed_profile_path(&options, device_id);
        fs::write(&profile_path, "new profile\n").await.unwrap();
        let transaction = PersistedTransaction {
            public: EthernetApplyTransaction {
                id: "550e8400-e29b-41d4-a716-446655440010".to_owned(),
                status: "awaiting_confirmation".to_owned(),
                device_ids: vec![device_id.to_owned()],
                created_at: "2000-01-01T00:00:00Z".to_owned(),
                deadline_at: Some("2000-01-01T00:01:30Z".to_owned()),
                rollback: RollbackStatus::NotRequired,
                error: None,
            },
            checkpoint_path: Some("/org/freedesktop/NetworkManager/Checkpoint/1".to_owned()),
            backups: vec![ProfileBackup {
                device_id: device_id.to_owned(),
                path: profile_path.clone(),
                content: Some("old profile\n".to_owned()),
            }],
        };
        write_transaction(&options, &transaction).await.unwrap();

        recover_expired(&FakeRunner::default(), &options)
            .await
            .unwrap();

        assert_eq!(
            fs::read_to_string(&profile_path).await.unwrap(),
            "old profile\n"
        );
        let recovered = read_transaction(&options).await.unwrap().unwrap();
        assert_eq!(recovered.public.status, "rolled_back");
        assert_eq!(recovered.public.rollback, RollbackStatus::Succeeded);
        assert!(recovered.backups.is_empty());
        assert!(recovered.checkpoint_path.is_none());
    }

    #[test]
    fn renders_mac_bound_profiles_without_interface_order_dependencies() {
        let runtime = RuntimeDevice {
            name: "eth7".to_owned(),
            state: "connected".to_owned(),
            connection_name: None,
            connection_id: None,
            mac: "2c:cf:67:c9:68:07".to_owned(),
            permanent_mac: "2c:cf:67:c9:68:07".to_owned(),
            driver: None,
            speed_mbps: None,
            carrier: true,
            addresses: Vec::new(),
            ipv4_gateway: None,
            ipv6_gateway: None,
            ipv4_default_route_metric: None,
            ipv6_default_route_metric: None,
            dbus_path: "/org/freedesktop/NetworkManager/Devices/2".to_owned(),
        };
        let desired = new_desired(default_config(false, false), None, None);
        let content = render_profile(&runtime, &desired);
        assert!(content.contains("mac-address=2c:cf:67:c9:68:07"));
        assert!(!content.contains("interface-name="));
        assert!(content.contains("never-default=true"));
    }

    #[test]
    fn renders_disabled_ports_as_persistent_blocking_profiles() {
        let runtime = runtime_device("eth0", "2c:cf:67:c9:68:07");
        let mut config = default_config(true, true);
        config.enabled = false;
        config.ipv4.dns_mode = "manual".to_owned();
        config.ipv4.dns = vec!["1.1.1.1".to_owned()];
        let desired = new_desired(config, None, None);

        let content = render_profile(&runtime, &desired);

        assert!(content.contains("autoconnect=true"));
        assert!(content.contains("autoconnect-priority=999"));
        assert_eq!(content.matches("method=disabled").count(), 2);
        assert!(!content.contains("dns=1.1.1.1"));
        assert_eq!(content.matches("never-default=true").count(), 2);
    }

    #[test]
    fn parses_profile_properties_when_nmcli_omits_inapplicable_sections() {
        let output = concat!(
            "connection.type:802-3-ethernet\n",
            "connection.controller:\n",
            "ipv4.method:auto\n",
            "ipv4.addresses:\n",
            "ipv4.gateway:\n",
            "ipv4.ignore-auto-dns:no\n",
            "ipv4.dns:\n",
            "ipv4.never-default:no\n",
            "ipv4.route-metric:-1\n",
            "ipv4.routes:\n",
            "ipv6.method:auto\n",
            "ipv6.addresses:\n",
            "ipv6.gateway:\n",
            "ipv6.ignore-auto-dns:no\n",
            "ipv6.dns:\n",
            "ipv6.never-default:no\n",
            "ipv6.route-metric:-1\n",
            "ipv6.routes:\n",
        );
        let profile = profile_config(&parse_nmcli_properties(output));

        assert!(profile.supported);
        assert_eq!(profile.config.ipv4.mode, "dhcp");
        assert!(profile.config.ipv4.use_default_route);
        assert_eq!(profile.config.ipv4.route_metric, 100);
        assert_eq!(profile.config.ipv6.mode, "automatic");
        assert!(profile.config.ipv6.use_default_route);
        assert_eq!(profile.revision.len(), 64);
    }

    #[test]
    fn excludes_activation_timestamp_from_external_profile_revision() {
        let mut properties = parse_nmcli_properties(concat!(
            "connection.type:802-3-ethernet\n",
            "connection.autoconnect:yes\n",
            "connection.timestamp:100\n",
            "ipv4.method:auto\n",
            "ipv4.never-default:no\n",
            "ipv6.method:auto\n",
            "ipv6.never-default:no\n",
        ));
        let original = profile_config(&properties).revision;

        properties.insert("connection.timestamp".to_owned(), "200".to_owned());
        assert_eq!(profile_config(&properties).revision, original);

        properties.insert("ipv4.never-default".to_owned(), "yes".to_owned());
        assert_ne!(profile_config(&properties).revision, original);
    }

    #[test]
    fn rejects_external_profiles_with_unrepresentable_methods() {
        let properties = parse_nmcli_properties(concat!(
            "connection.type:802-3-ethernet\n",
            "connection.controller:\n",
            "802-1x.eap:\n",
            "ipv4.method:shared\n",
            "ipv4.addresses:\n",
            "ipv4.gateway:\n",
            "ipv4.ignore-auto-dns:no\n",
            "ipv4.dns:\n",
            "ipv4.never-default:no\n",
            "ipv4.route-metric:100\n",
            "ipv4.routes:\n",
            "ipv6.method:ignore\n",
            "ipv6.addresses:\n",
            "ipv6.gateway:\n",
            "ipv6.ignore-auto-dns:no\n",
            "ipv6.dns:\n",
            "ipv6.never-default:yes\n",
            "ipv6.route-metric:600\n",
            "ipv6.routes:\n",
        ));

        assert!(!profile_config(&properties).supported);
    }

    #[test]
    fn parses_repeated_ipv6_addresses_without_escaping_or_merging() {
        let values = parse_nmcli_field_values(concat!(
            "IP6.ADDRESS[1]:fd0d:4094:88bf:4805:248:54ff:fe21:449a/64\n",
            "IP6.ADDRESS[2]:fe80::248:54ff:fe21:449a/64\n",
        ));

        assert_eq!(
            values,
            [
                "fd0d:4094:88bf:4805:248:54ff:fe21:449a/64",
                "fe80::248:54ff:fe21:449a/64",
            ]
        );
        let addresses = values
            .iter()
            .filter_map(|value| ethernet_address("inet6", value, Some("eth1".to_owned())))
            .collect::<Vec<_>>();
        assert_eq!(addresses[0].prefix_length, Some(64));
        assert_eq!(addresses[0].scope.as_deref(), Some("global"));
        assert_eq!(addresses[1].scope.as_deref(), Some("link"));
    }

    #[test]
    fn validates_optional_gateway_family_and_active_routes() {
        let mut invalid = default_config(false, false);
        invalid.ipv4 = EthernetIpv4Config {
            mode: "static".to_owned(),
            address: Some("192.168.11.20".to_owned()),
            prefix_length: Some(24),
            gateway: Some("2001:db8::1".to_owned()),
            dns_mode: "automatic".to_owned(),
            dns: Vec::new(),
            use_default_route: false,
            route_metric: 600,
        };
        assert!(validate_config(&invalid).is_err());

        let routes = vec![
            "dst = 192.168.11.0/24, nh = 0.0.0.0, mt = 100".to_owned(),
            "dst = 0.0.0.0/0, nh = 192.168.11.1, mt = 100".to_owned(),
        ];
        assert_eq!(default_route_metric(&routes, 4), Some(100));
        assert_eq!(default_route_metric(&routes, 6), None);
    }

    #[test]
    fn rejects_incomplete_enabled_and_disabled_runtime_state() {
        let desired = new_desired(default_config(true, true), None, None);
        let mut runtime = RuntimeDevice {
            name: "eth1".to_owned(),
            state: "connected".to_owned(),
            connection_name: Some("SigmaOS Ethernet eth1".to_owned()),
            connection_id: Some(desired.managed_profile_id.clone()),
            mac: "2c:cf:67:c9:68:08".to_owned(),
            permanent_mac: "2c:cf:67:c9:68:08".to_owned(),
            driver: Some("r8169".to_owned()),
            speed_mbps: Some(1_000),
            carrier: true,
            addresses: vec![
                ethernet_address("inet", "192.168.11.89/24", Some("eth1".to_owned())).unwrap(),
                ethernet_address("inet6", "fd00::89/64", Some("eth1".to_owned())).unwrap(),
            ],
            ipv4_gateway: Some("192.168.11.1".to_owned()),
            ipv6_gateway: Some("fe80::1".to_owned()),
            ipv4_default_route_metric: Some(100),
            ipv6_default_route_metric: Some(100),
            dbus_path: "/org/freedesktop/NetworkManager/Devices/3".to_owned(),
        };
        assert!(validate_device_applied(&desired, &runtime).is_ok());

        runtime
            .addresses
            .retain(|address| address.family != "inet6");
        assert!(validate_device_applied(&desired, &runtime).is_err());
        let active_profile = ProfileConfig {
            config: desired.config.clone(),
            supported: true,
            revision: "managed-profile-revision".to_owned(),
            interface_name: None,
            mac_address: Some(runtime.permanent_mac.clone()),
            autoconnect_priority: MANAGED_AUTOCONNECT_PRIORITY,
            timestamp: 0,
        };
        assert!(desired_is_applied(
            &desired,
            &runtime,
            Some(&active_profile)
        ));
        runtime
            .addresses
            .push(ethernet_address("inet6", "fd00::89/64", Some("eth1".to_owned())).unwrap());
        runtime.ipv4_default_route_metric = Some(600);
        assert!(validate_device_applied(&desired, &runtime).is_err());

        let mut static_desired = desired.clone();
        static_desired.config.ipv4.mode = "static".to_owned();
        static_desired.config.ipv4.address = Some("192.168.11.90".to_owned());
        static_desired.config.ipv4.prefix_length = Some(24);
        static_desired.config.ipv4.gateway = Some("192.168.11.1".to_owned());
        runtime.ipv4_default_route_metric = Some(100);
        assert!(validate_device_applied(&static_desired, &runtime).is_err());

        let mut disabled = desired.clone();
        disabled.config.enabled = false;
        runtime.ipv4_default_route_metric = None;
        runtime.ipv6_default_route_metric = None;
        runtime.addresses.clear();
        let mut blocking_profile = ProfileConfig {
            config: default_config(false, false),
            supported: true,
            revision: "blocking-profile-revision".to_owned(),
            interface_name: None,
            mac_address: Some(runtime.permanent_mac.clone()),
            autoconnect_priority: MANAGED_AUTOCONNECT_PRIORITY,
            timestamp: 0,
        };
        blocking_profile.config.ipv4.mode = "disabled".to_owned();
        blocking_profile.config.ipv6.mode = "disabled".to_owned();
        assert!(validate_device_applied(&disabled, &runtime).is_ok());
        assert!(desired_is_applied(
            &disabled,
            &runtime,
            Some(&blocking_profile)
        ));
        blocking_profile.autoconnect_priority = 0;
        assert!(!desired_is_applied(
            &disabled,
            &runtime,
            Some(&blocking_profile)
        ));
        runtime.connection_id = None;
        assert!(validate_device_applied(&disabled, &runtime).is_err());
        assert!(!desired_is_applied(&disabled, &runtime, None));
    }

    #[test]
    fn keeps_active_state_enabled_until_a_pending_disable_is_applied() {
        let active = ProfileConfig {
            config: default_config(false, false),
            supported: true,
            revision: "profile-revision".to_owned(),
            interface_name: None,
            mac_address: Some("2c:cf:67:c9:68:07".to_owned()),
            autoconnect_priority: 1_000,
            timestamp: 0,
        };
        let mut desired = new_desired(active.config.clone(), None, None);
        desired.config.enabled = false;

        let pending = effective_active_config(Some(&active), Some(&desired), false).unwrap();
        let applied = effective_active_config(Some(&active), Some(&desired), true).unwrap();

        assert!(pending.enabled);
        assert!(!applied.enabled);
        assert_eq!(
            ethernet_state("connected", true, true, Some(pending.enabled)),
            "connected"
        );
        assert_eq!(
            ethernet_state("connected", true, false, Some(applied.enabled)),
            "disabled"
        );
    }

    #[test]
    fn keeps_active_state_disabled_until_a_pending_enable_is_applied() {
        let mut active_config = default_config(false, false);
        active_config.ipv4.mode = "disabled".to_owned();
        active_config.ipv6.mode = "disabled".to_owned();
        let active = ProfileConfig {
            config: active_config,
            supported: true,
            revision: "blocking-profile-revision".to_owned(),
            interface_name: None,
            mac_address: Some("2c:cf:67:c9:68:07".to_owned()),
            autoconnect_priority: MANAGED_AUTOCONNECT_PRIORITY,
            timestamp: 0,
        };
        let mut desired = new_desired(default_config(false, false), None, None);
        desired.config.enabled = true;

        let pending = effective_active_config(Some(&active), Some(&desired), false).unwrap();

        assert!(!pending.enabled);
        assert_eq!(
            ethernet_state("connected", true, false, Some(pending.enabled)),
            "disabled"
        );
    }

    #[test]
    fn recognizes_same_subnet_addresses_without_link_local_noise() {
        let ipv4_left = ethernet_address("inet", "192.168.11.89/24", None).unwrap();
        let ipv4_right = ethernet_address("inet", "192.168.11.91/24", None).unwrap();
        let ipv4_other = ethernet_address("inet", "192.168.12.91/24", None).unwrap();
        let ipv6_link_left = ethernet_address("inet6", "fe80::1/64", None).unwrap();
        let ipv6_link_right = ethernet_address("inet6", "fe80::2/64", None).unwrap();

        assert!(same_network(&ipv4_left, &ipv4_right, 4));
        assert!(!same_network(&ipv4_left, &ipv4_other, 4));
        assert!(!same_network(&ipv6_link_left, &ipv6_link_right, 6));
    }

    #[tokio::test]
    async fn inspects_live_network_manager_when_explicitly_enabled() {
        if std::env::var("SIGMAOS_TEST_LIVE_NETWORK").as_deref() != Ok("1") {
            return;
        }
        let temp = TempDir::new().unwrap();
        let options = NetworkOptions {
            connections_dir: temp.path().join("connections"),
            state_dir: temp.path().join("state"),
            sys_class_net: "/sys/class/net".into(),
        };
        let result = status(&SystemCommandRunner, &options).await.unwrap();
        assert_eq!(result.backend, "NetworkManager");
        assert!(result.devices.len() >= 2);
        assert!(result.devices.iter().all(|device| device.id.len() == 12));
        assert!(result.devices.iter().any(|device| device.name == "eth0"));
        assert!(result.devices.iter().any(|device| device.name == "eth1"));
    }
}
