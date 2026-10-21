use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify, OnceCell};
use tokio::time::{Instant, timeout};
use uuid::Uuid;
use zbus::{Connection, ObjectPath, OwnedObjectPath, OwnedVariant, Proxy, interface};

use crate::error::HostdError;

const BLUEZ: &str = "org.bluez";
const OBJECT_MANAGER: &str = "org.freedesktop.DBus.ObjectManager";
const DEFAULT_ADAPTER_PATH: &str = "/zos/state/hostd/bluetooth/default-adapter";
const AGENT_PATH: &str = "/org/zos/BluetoothAgent";
const CHALLENGE_TTL: Duration = Duration::from_secs(60);
const SCAN_DURATION: Duration = Duration::from_secs(15);

static RUNTIME: OnceCell<Arc<BluetoothRuntime>> = OnceCell::const_new();

struct BluetoothRuntime {
    connection: Connection,
    agent: PairingAgent,
    state: Mutex<BluetoothRuntimeState>,
}

#[derive(Default)]
struct BluetoothRuntimeState {
    scans: HashMap<String, ScanWindow>,
    error: Option<String>,
}

#[derive(Clone)]
struct ScanWindow {
    id: Uuid,
    started_at: String,
    ends_at: String,
}

#[derive(Clone)]
struct PairingAgent {
    shared: Arc<AgentShared>,
}

struct AgentShared {
    pending: Mutex<Option<PendingChallenge>>,
    notify: Notify,
}

struct PendingChallenge {
    challenge: Challenge,
    deadline: Instant,
    response: Option<ChallengeResponse>,
}

struct ChallengeResponse {
    accepted: bool,
    pin: Option<String>,
}

impl BluetoothRuntimeState {
    fn reserve_scan(&mut self, adapter_id: &str, scan: ScanWindow) -> Result<(), HostdError> {
        if self.scans.contains_key(adapter_id) {
            return Err(HostdError::conflict(
                "Bluetooth discovery is already active for this adapter",
            ));
        }
        if !self.scans.is_empty() {
            return Err(HostdError::conflict(
                "Bluetooth discovery is already active for another adapter",
            ));
        }
        self.scans.insert(adapter_id.to_owned(), scan);
        Ok(())
    }
}

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.bluez.Error")]
enum AgentError {
    Rejected(String),
    Canceled(String),
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdBluetoothManagerRequest")
)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum BluetoothRequest {
    Status,
    AdapterPower {
        #[serde(rename = "adapterId")]
        adapter_id: String,
        powered: bool,
    },
    SetDefaultAdapter {
        #[serde(rename = "adapterId")]
        adapter_id: String,
    },
    ScanStart {
        #[serde(rename = "adapterId")]
        adapter_id: String,
    },
    ScanStop {
        #[serde(rename = "adapterId")]
        adapter_id: String,
    },
    Pair {
        #[serde(rename = "adapterId")]
        adapter_id: String,
        address: String,
    },
    CancelPairing {
        #[serde(rename = "adapterId")]
        adapter_id: String,
        address: String,
    },
    ConfirmPin {
        #[serde(rename = "adapterId")]
        adapter_id: String,
        address: String,
        #[serde(rename = "challengeId")]
        challenge_id: String,
        accept: bool,
        pin: Option<String>,
    },
    RejectPairing {
        #[serde(rename = "adapterId")]
        adapter_id: String,
        address: String,
        #[serde(rename = "challengeId")]
        challenge_id: String,
    },
    Trust {
        #[serde(rename = "adapterId")]
        adapter_id: String,
        address: String,
        trusted: bool,
    },
    Connect {
        #[serde(rename = "adapterId")]
        adapter_id: String,
        address: String,
    },
    Disconnect {
        #[serde(rename = "adapterId")]
        adapter_id: String,
        address: String,
    },
    Unpair {
        #[serde(rename = "adapterId")]
        adapter_id: String,
        address: String,
    },
}

pub(crate) fn request_has_exact_fields(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(action) = object.get("action").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let (required, optional): (&[&str], &[&str]) = match action {
        "status" => (&["action"], &[]),
        "adapter_power" => (&["action", "adapterId", "powered"], &[]),
        "set_default_adapter" | "scan_start" | "scan_stop" => (&["action", "adapterId"], &[]),
        "pair" | "cancel_pairing" | "connect" | "disconnect" | "unpair" => {
            (&["action", "adapterId", "address"], &[])
        }
        "confirm_pin" => (
            &["action", "adapterId", "address", "challengeId", "accept"],
            &["pin"],
        ),
        "reject_pairing" => (&["action", "adapterId", "address", "challengeId"], &[]),
        "trust" => (&["action", "adapterId", "address", "trusted"], &[]),
        _ => return false,
    };
    required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdBluetoothManagerResult")
)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BluetoothResult {
    collected_at: String,
    backend: String,
    available: bool,
    adapters: Vec<Adapter>,
    devices: Vec<Device>,
    scan: ScanStatus,
    challenge: Option<Challenge>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdBluetoothAdapter"))]
#[serde(rename_all = "camelCase")]
struct Adapter {
    id: String,
    address: String,
    name: String,
    alias: String,
    state: String,
    powered: bool,
    discovering: bool,
    default_adapter: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdBluetoothDevice"))]
#[serde(rename_all = "camelCase")]
struct Device {
    adapter_id: String,
    address: String,
    name: Option<String>,
    alias: Option<String>,
    #[serde(rename = "type")]
    device_type: String,
    rssi: Option<i16>,
    paired: bool,
    trusted: bool,
    connected: bool,
    services_resolved: bool,
    last_seen_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdBluetoothScanStatus"))]
#[serde(rename_all = "camelCase")]
struct ScanStatus {
    active: bool,
    adapter_id: Option<String>,
    started_at: Option<String>,
    ends_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdBluetoothPairingChallenge")
)]
#[serde(rename_all = "camelCase")]
struct Challenge {
    id: String,
    adapter_id: String,
    device_address: String,
    kind: String,
    pin: Option<String>,
    passkey: Option<u32>,
    expires_at: String,
}

impl BluetoothRuntime {
    async fn initialize() -> Result<Arc<Self>, HostdError> {
        let connection = Connection::system()
            .await
            .map_err(|_| HostdError::unavailable("BlueZ system D-Bus is unavailable"))?;
        let agent = PairingAgent {
            shared: Arc::new(AgentShared {
                pending: Mutex::new(None),
                notify: Notify::new(),
            }),
        };
        connection
            .object_server()
            .at(AGENT_PATH, agent.clone())
            .await
            .map_err(|_| {
                HostdError::unavailable("Could not register the Bluetooth pairing agent")
            })?;
        let manager = Proxy::new(&connection, BLUEZ, "/org/bluez", "org.bluez.AgentManager1")
            .await
            .map_err(|_| HostdError::unavailable("BlueZ AgentManager is unavailable"))?;
        let path = ObjectPath::try_from(AGENT_PATH)
            .map_err(|_| HostdError::validation("Invalid Bluetooth agent path"))?;
        manager
            .call::<_, _, ()>("RegisterAgent", &(path.clone(), "KeyboardDisplay"))
            .await
            .map_err(|_| HostdError::unavailable("BlueZ rejected the ZOS pairing agent"))?;
        let _ = manager
            .call::<_, _, ()>("RequestDefaultAgent", &(path,))
            .await;
        Ok(Arc::new(Self {
            connection,
            agent,
            state: Mutex::new(BluetoothRuntimeState::default()),
        }))
    }

    async fn begin_scan(&self, adapter_id: &str) -> Result<ScanWindow, HostdError> {
        let now = time::OffsetDateTime::now_utc();
        let scan = ScanWindow {
            id: Uuid::new_v4(),
            started_at: format_timestamp(now),
            ends_at: format_timestamp(
                now + time::Duration::seconds(SCAN_DURATION.as_secs() as i64),
            ),
        };
        self.state
            .lock()
            .await
            .reserve_scan(adapter_id, scan.clone())?;
        Ok(scan)
    }

    async fn finish_scan(&self, adapter_id: &str, expected_id: Option<Uuid>) -> bool {
        let mut state = self.state.lock().await;
        if expected_id
            .is_some_and(|id| state.scans.get(adapter_id).is_none_or(|scan| scan.id != id))
        {
            return false;
        }
        state.scans.remove(adapter_id);
        true
    }

    async fn reconcile_scan(&self, active_adapter: Option<&str>) -> Option<ScanWindow> {
        let mut state = self.state.lock().await;
        state
            .scans
            .retain(|adapter_id, _| Some(adapter_id.as_str()) == active_adapter);
        active_adapter.and_then(|adapter_id| state.scans.get(adapter_id).cloned())
    }

    async fn clear_error(&self) {
        self.state.lock().await.error = None;
    }

    async fn record_error(&self, message: impl Into<String>) {
        self.state.lock().await.error = Some(message.into());
    }

    async fn error(&self) -> Option<String> {
        self.state.lock().await.error.clone()
    }
}

impl PairingAgent {
    async fn challenge(&self) -> Option<Challenge> {
        let mut pending = self.shared.pending.lock().await;
        if pending
            .as_ref()
            .is_some_and(|value| value.deadline <= Instant::now())
        {
            *pending = None;
        }
        pending.as_ref().map(|value| value.challenge.clone())
    }

    async fn respond(
        &self,
        challenge_id: &str,
        adapter_id: &str,
        address: &str,
        accepted: bool,
        pin: Option<String>,
    ) -> Result<(), HostdError> {
        let mut pending = self.shared.pending.lock().await;
        let Some(current) = pending.as_mut() else {
            return Err(HostdError::not_found(
                "Bluetooth pairing challenge was not found",
            ));
        };
        if current.deadline <= Instant::now() {
            *pending = None;
            return Err(HostdError::conflict(
                "Bluetooth pairing challenge has expired",
            ));
        }
        if current.challenge.id != challenge_id {
            return Err(HostdError::conflict(
                "Bluetooth pairing challenge does not match the active request",
            ));
        }
        if current.challenge.adapter_id != adapter_id
            || !current
                .challenge
                .device_address
                .eq_ignore_ascii_case(address)
        {
            return Err(HostdError::conflict(
                "Bluetooth pairing challenge does not match the target device",
            ));
        }
        current.response = Some(ChallengeResponse { accepted, pin });
        drop(pending);
        self.shared.notify.notify_waiters();
        Ok(())
    }

    async fn prompt(
        &self,
        device: &ObjectPath<'_>,
        kind: &str,
        passkey: Option<u32>,
    ) -> Result<ChallengeResponse, AgentError> {
        self.prompt_with_ttl(device, kind, passkey, CHALLENGE_TTL)
            .await
    }

    async fn prompt_with_ttl(
        &self,
        device: &ObjectPath<'_>,
        kind: &str,
        passkey: Option<u32>,
        ttl: Duration,
    ) -> Result<ChallengeResponse, AgentError> {
        let (adapter_id, address) = device_identity(device.as_str())
            .ok_or_else(|| AgentError::Rejected("Invalid BlueZ device path".to_owned()))?;
        let deadline = Instant::now() + ttl;
        let expires_at = time::OffsetDateTime::now_utc()
            + time::Duration::try_from(ttl).unwrap_or(time::Duration::seconds(60));
        let challenge = Challenge {
            id: Uuid::new_v4().to_string(),
            adapter_id,
            device_address: address,
            kind: kind.to_owned(),
            pin: None,
            passkey,
            expires_at: format_timestamp(expires_at),
        };
        {
            let mut pending = self.shared.pending.lock().await;
            if pending
                .as_ref()
                .is_some_and(|value| value.deadline > Instant::now())
            {
                return Err(AgentError::Rejected(
                    "Another Bluetooth pairing challenge is active".to_owned(),
                ));
            }
            *pending = Some(PendingChallenge {
                challenge,
                deadline,
                response: None,
            });
        }
        loop {
            let notified = self.shared.notify.notified();
            {
                let mut pending = self.shared.pending.lock().await;
                if let Some(response) = pending.as_mut().and_then(|value| value.response.take()) {
                    *pending = None;
                    return if response.accepted {
                        Ok(response)
                    } else {
                        Err(AgentError::Rejected("Pairing was rejected".to_owned()))
                    };
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || timeout(remaining, notified).await.is_err() {
                let mut pending = self.shared.pending.lock().await;
                *pending = None;
                return Err(AgentError::Canceled("Pairing challenge expired".to_owned()));
            }
        }
    }

    async fn cancel_pending(&self) {
        let mut pending = self.shared.pending.lock().await;
        if let Some(current) = pending.as_mut() {
            current.response = Some(ChallengeResponse {
                accepted: false,
                pin: None,
            });
        }
        drop(pending);
        self.shared.notify.notify_waiters();
    }
}

#[interface(name = "org.bluez.Agent1")]
impl PairingAgent {
    async fn release(&self) {
        self.cancel_pending().await;
    }

    async fn request_pin_code(&self, device: ObjectPath<'_>) -> Result<String, AgentError> {
        let response = self.prompt(&device, "pin", None).await?;
        let pin = response.pin.unwrap_or_default();
        if pin.is_empty()
            || pin.len() > 16
            || !pin.chars().all(|value| value.is_ascii_alphanumeric())
        {
            return Err(AgentError::Rejected("Invalid Bluetooth PIN".to_owned()));
        }
        Ok(pin)
    }

    async fn display_pin_code(&self, _device: ObjectPath<'_>, _pin_code: String) {}

    async fn request_passkey(&self, device: ObjectPath<'_>) -> Result<u32, AgentError> {
        let response = self.prompt(&device, "pin", None).await?;
        response
            .pin
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|value| *value <= 999_999)
            .ok_or_else(|| AgentError::Rejected("Invalid Bluetooth passkey".to_owned()))
    }

    async fn display_passkey(&self, _device: ObjectPath<'_>, _passkey: u32, _entered: u16) {}

    async fn request_confirmation(
        &self,
        device: ObjectPath<'_>,
        passkey: u32,
    ) -> Result<(), AgentError> {
        self.prompt(&device, "numeric_comparison", Some(passkey))
            .await
            .map(|_| ())
    }

    async fn request_authorization(&self, device: ObjectPath<'_>) -> Result<(), AgentError> {
        self.prompt(&device, "confirmation", None).await.map(|_| ())
    }

    async fn authorize_service(
        &self,
        _device: ObjectPath<'_>,
        _uuid: String,
    ) -> Result<(), AgentError> {
        Ok(())
    }

    async fn cancel(&self) {
        self.cancel_pending().await;
    }
}

async fn runtime() -> Result<Arc<BluetoothRuntime>, HostdError> {
    RUNTIME
        .get_or_try_init(BluetoothRuntime::initialize)
        .await
        .map(Arc::clone)
}

type ManagedObjects = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedVariant>>>;

pub(crate) async fn handle(request: BluetoothRequest) -> Result<BluetoothResult, HostdError> {
    let runtime = runtime().await?;
    let connection = &runtime.connection;
    if !matches!(&request, BluetoothRequest::Status) {
        runtime.clear_error().await;
    }
    match request {
        BluetoothRequest::Status => collect_status(&runtime).await,
        BluetoothRequest::AdapterPower {
            adapter_id,
            powered,
        } => {
            let path = adapter_path(connection, &adapter_id).await?;
            set_property(connection, &path, "org.bluez.Adapter1", "Powered", powered).await?;
            collect_status(&runtime).await
        }
        BluetoothRequest::SetDefaultAdapter { adapter_id } => {
            let _ = adapter_path(connection, &adapter_id).await?;
            if let Some(parent) = std::path::Path::new(DEFAULT_ADAPTER_PATH).parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(DEFAULT_ADAPTER_PATH, format!("{adapter_id}\n")).await?;
            collect_status(&runtime).await
        }
        BluetoothRequest::ScanStart { adapter_id } => {
            let path = adapter_path(connection, &adapter_id).await?;
            let scan = runtime.begin_scan(&adapter_id).await?;
            if let Err(error) = adapter_call(connection, &path, "StartDiscovery").await {
                runtime.finish_scan(&adapter_id, Some(scan.id)).await;
                return Err(error);
            }
            let scan_runtime = Arc::clone(&runtime);
            tokio::spawn(async move {
                tokio::time::sleep(SCAN_DURATION).await;
                if !scan_runtime.finish_scan(&adapter_id, Some(scan.id)).await {
                    return;
                }
                if let Err(error) =
                    adapter_call(&scan_runtime.connection, &path, "StopDiscovery").await
                {
                    tracing::warn!(message = %error.message, "Bluetooth discovery auto-stop failed");
                    scan_runtime.record_error(error.message).await;
                }
            });
            collect_status(&runtime).await
        }
        BluetoothRequest::ScanStop { adapter_id } => {
            let path = adapter_path(connection, &adapter_id).await?;
            adapter_call(connection, &path, "StopDiscovery").await?;
            runtime.finish_scan(&adapter_id, None).await;
            collect_status(&runtime).await
        }
        BluetoothRequest::Pair {
            adapter_id,
            address,
        } => {
            let device = device_path(connection, &adapter_id, &address).await?;
            let pair_connection = connection.clone();
            let pair_runtime = Arc::clone(&runtime);
            tokio::spawn(async move {
                if let Err(error) = device_call(&pair_connection, &device, "Pair").await {
                    tracing::warn!(message = %error.message, "Bluetooth pairing failed");
                    pair_runtime.record_error(error.message).await;
                }
            });
            collect_status(&runtime).await
        }
        BluetoothRequest::CancelPairing {
            adapter_id,
            address,
        }
        | BluetoothRequest::RejectPairing {
            adapter_id,
            address,
            ..
        } => {
            let device = device_path(connection, &adapter_id, &address).await?;
            runtime.agent.cancel_pending().await;
            device_call(connection, &device, "CancelPairing").await?;
            collect_status(&runtime).await
        }
        BluetoothRequest::ConfirmPin {
            adapter_id,
            address,
            challenge_id,
            accept,
            pin,
        } => {
            let _ = device_path(connection, &adapter_id, &address).await?;
            runtime
                .agent
                .respond(&challenge_id, &adapter_id, &address, accept, pin)
                .await?;
            collect_status(&runtime).await
        }
        BluetoothRequest::Trust {
            adapter_id,
            address,
            trusted,
        } => {
            let device = device_path(connection, &adapter_id, &address).await?;
            set_property(connection, &device, "org.bluez.Device1", "Trusted", trusted).await?;
            collect_status(&runtime).await
        }
        BluetoothRequest::Connect {
            adapter_id,
            address,
        } => {
            let device = device_path(connection, &adapter_id, &address).await?;
            device_call(connection, &device, "Connect").await?;
            collect_status(&runtime).await
        }
        BluetoothRequest::Disconnect {
            adapter_id,
            address,
        } => {
            let device = device_path(connection, &adapter_id, &address).await?;
            device_call(connection, &device, "Disconnect").await?;
            collect_status(&runtime).await
        }
        BluetoothRequest::Unpair {
            adapter_id,
            address,
        } => {
            let device = device_path(connection, &adapter_id, &address).await?;
            adapter_call_path(connection, &adapter_id, "RemoveDevice", &device).await?;
            collect_status(&runtime).await
        }
    }
}

async fn collect_status(runtime: &BluetoothRuntime) -> Result<BluetoothResult, HostdError> {
    let connection = &runtime.connection;
    let objects = managed_objects(connection).await?;
    let preferred_adapter = tokio::fs::read_to_string(DEFAULT_ADAPTER_PATH)
        .await
        .ok()
        .map(|value| value.trim().to_owned());
    let mut adapters = Vec::new();
    let mut devices = Vec::new();
    for (path, interfaces) in objects {
        if let Some(properties) = interfaces.get("org.bluez.Adapter1") {
            let name = path.as_str().rsplit('/').next().unwrap_or("hci").to_owned();
            let address = string_property(properties, "Address").unwrap_or_default();
            let powered = bool_property(properties, "Powered").unwrap_or(false);
            let discovering = bool_property(properties, "Discovering").unwrap_or(false);
            let alias = string_property(properties, "Alias").unwrap_or_else(|| name.clone());
            let id = format!("adapter-{name}");
            adapters.push(Adapter {
                default_adapter: preferred_adapter.as_deref() == Some(&id),
                id,
                address,
                name: name.clone(),
                alias,
                state: if powered { "powered" } else { "off" }.to_owned(),
                powered,
                discovering,
            });
        }
        if let Some(properties) = interfaces.get("org.bluez.Device1") {
            let mut segments = path.as_str().rsplit('/');
            let _device = segments.next();
            let Some(adapter_name) = segments.next() else {
                continue;
            };
            let adapter_id = format!("adapter-{adapter_name}");
            let address = string_property(properties, "Address").unwrap_or_default();
            if !valid_address(&address) {
                continue;
            }
            devices.push(Device {
                adapter_id,
                address,
                name: string_property(properties, "Name"),
                alias: string_property(properties, "Alias"),
                device_type: device_type(string_property(properties, "Icon").as_deref()).to_owned(),
                rssi: integer_property(properties, "RSSI"),
                paired: bool_property(properties, "Paired").unwrap_or(false),
                trusted: bool_property(properties, "Trusted").unwrap_or(false),
                connected: bool_property(properties, "Connected").unwrap_or(false),
                services_resolved: bool_property(properties, "ServicesResolved").unwrap_or(false),
                last_seen_at: None,
            });
        }
    }
    if !adapters.is_empty() && !adapters.iter().any(|adapter| adapter.default_adapter) {
        adapters[0].default_adapter = true;
    }
    let active_adapter = adapters
        .iter()
        .find(|adapter| adapter.discovering)
        .map(|adapter| adapter.id.clone());
    let scan_window = runtime.reconcile_scan(active_adapter.as_deref()).await;
    Ok(BluetoothResult {
        collected_at: format_timestamp(time::OffsetDateTime::now_utc()),
        backend: "BlueZ".to_owned(),
        available: !adapters.is_empty(),
        adapters,
        devices,
        scan: ScanStatus {
            active: active_adapter.is_some(),
            adapter_id: active_adapter,
            started_at: scan_window.as_ref().map(|scan| scan.started_at.clone()),
            ends_at: scan_window.map(|scan| scan.ends_at),
        },
        challenge: runtime.agent.challenge().await,
        error: runtime.error().await,
    })
}

fn format_timestamp(value: time::OffsetDateTime) -> String {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

async fn managed_objects(connection: &Connection) -> Result<ManagedObjects, HostdError> {
    let proxy = Proxy::new(connection, BLUEZ, "/", OBJECT_MANAGER)
        .await
        .map_err(|_| HostdError::unavailable("BlueZ object manager is unavailable"))?;
    proxy
        .call("GetManagedObjects", &())
        .await
        .map_err(|_| HostdError::unavailable("BlueZ object enumeration failed"))
}

async fn adapter_path(connection: &Connection, adapter_id: &str) -> Result<String, HostdError> {
    if !adapter_id.starts_with("adapter-") {
        return Err(HostdError::validation("Invalid Bluetooth adapter id"));
    }
    let name = adapter_id.trim_start_matches("adapter-");
    if name.is_empty()
        || !name
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '_' | '.' | ':' | '-'))
    {
        return Err(HostdError::validation("Invalid Bluetooth adapter id"));
    }
    let path = format!("/org/bluez/{name}");
    let objects = managed_objects(connection).await?;
    if objects.keys().any(|value| {
        value.as_str() == path
            && objects
                .get(value)
                .is_some_and(|interfaces| interfaces.contains_key("org.bluez.Adapter1"))
    }) {
        Ok(path)
    } else {
        Err(HostdError::not_found("Bluetooth adapter was not found"))
    }
}

async fn device_path(
    connection: &Connection,
    adapter_id: &str,
    address: &str,
) -> Result<String, HostdError> {
    if !valid_address(address) {
        return Err(HostdError::validation("Invalid Bluetooth device address"));
    }
    let _ = adapter_path(connection, adapter_id).await?;
    let suffix = address.replace(':', "_");
    let path = format!(
        "/org/bluez/{}/dev_{suffix}",
        adapter_id.trim_start_matches("adapter-")
    );
    let objects = managed_objects(connection).await?;
    if objects.keys().any(|value| {
        value.as_str() == path
            && objects
                .get(value)
                .is_some_and(|interfaces| interfaces.contains_key("org.bluez.Device1"))
    }) {
        Ok(path)
    } else {
        Err(HostdError::not_found("Bluetooth device was not found"))
    }
}

async fn adapter_call(connection: &Connection, path: &str, method: &str) -> Result<(), HostdError> {
    let proxy = Proxy::new(connection, BLUEZ, path, "org.bluez.Adapter1")
        .await
        .map_err(|_| HostdError::unavailable("BlueZ adapter is unavailable"))?;
    proxy
        .call::<_, _, ()>(method, &())
        .await
        .map_err(|_| HostdError::operation_failed("BlueZ adapter operation failed"))
}

async fn adapter_call_path(
    connection: &Connection,
    adapter_id: &str,
    method: &str,
    device: &str,
) -> Result<(), HostdError> {
    let path = adapter_path(connection, adapter_id).await?;
    let proxy = Proxy::new(connection, BLUEZ, path.as_str(), "org.bluez.Adapter1")
        .await
        .map_err(|_| HostdError::unavailable("BlueZ adapter is unavailable"))?;
    let object = OwnedObjectPath::try_from(device)
        .map_err(|_| HostdError::validation("Invalid Bluetooth device path"))?;
    proxy
        .call::<_, _, ()>(method, &(object,))
        .await
        .map_err(|_| HostdError::operation_failed("BlueZ adapter operation failed"))
}

async fn device_call(connection: &Connection, path: &str, method: &str) -> Result<(), HostdError> {
    let proxy = Proxy::new(connection, BLUEZ, path, "org.bluez.Device1")
        .await
        .map_err(|_| HostdError::unavailable("BlueZ device is unavailable"))?;
    proxy
        .call::<_, _, ()>(method, &())
        .await
        .map_err(|_| HostdError::operation_failed("BlueZ device operation failed"))
}

async fn set_property<T>(
    connection: &Connection,
    path: &str,
    interface: &str,
    name: &str,
    value: T,
) -> Result<(), HostdError>
where
    T: serde::Serialize + zbus::Type,
{
    let proxy = Proxy::new(connection, BLUEZ, path, interface)
        .await
        .map_err(|_| HostdError::unavailable("BlueZ properties are unavailable"))?;
    proxy
        .set_property::<T>(name, value)
        .await
        .map_err(|_| HostdError::operation_failed("BlueZ property update failed"))
}

fn string_property(properties: &HashMap<String, OwnedVariant>, key: &str) -> Option<String> {
    properties
        .get(key)
        .and_then(|value| value.downcast_ref::<String>().ok())
}

fn bool_property(properties: &HashMap<String, OwnedVariant>, key: &str) -> Option<bool> {
    properties
        .get(key)
        .and_then(|value| value.downcast_ref::<bool>().ok())
}

fn integer_property(properties: &HashMap<String, OwnedVariant>, key: &str) -> Option<i16> {
    properties
        .get(key)
        .and_then(|value| value.downcast_ref::<i16>().ok())
}

fn valid_address(value: &str) -> bool {
    value.len() == 17
        && value.split(':').count() == 6
        && value.split(':').all(|part| {
            part.len() == 2 && part.chars().all(|character| character.is_ascii_hexdigit())
        })
}

fn device_identity(path: &str) -> Option<(String, String)> {
    let mut segments = path.rsplit('/');
    let device = segments.next()?.strip_prefix("dev_")?;
    let adapter = segments.next()?;
    let address = device.replace('_', ":");
    if !adapter.starts_with("hci") || !valid_address(&address) {
        return None;
    }
    Some((format!("adapter-{adapter}"), address))
}

fn device_type(icon: Option<&str>) -> &'static str {
    match icon.unwrap_or_default() {
        value if value.contains("phone") => "phone",
        value if value.contains("computer") => "computer",
        value if value.contains("headset") || value.contains("headphones") => "headset",
        value if value.contains("audio") || value.contains("speaker") => "speaker",
        value if value.contains("keyboard") => "keyboard",
        value if value.contains("mouse") => "mouse",
        value if value.contains("game") => "gamepad",
        value if value.contains("wearable") || value.contains("watch") => "wearable",
        _ => "unknown",
    }
}

#[cfg(test)]
pub(crate) fn export_protocol_bindings(config: &ts_rs::Config) {
    use ts_rs::TS;
    BluetoothRequest::export_all(config).unwrap();
    BluetoothResult::export_all(config).unwrap();
    Adapter::export_all(config).unwrap();
    Device::export_all(config).unwrap();
    ScanStatus::export_all(config).unwrap();
    Challenge::export_all(config).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> PairingAgent {
        PairingAgent {
            shared: Arc::new(AgentShared {
                pending: Mutex::new(None),
                notify: Notify::new(),
            }),
        }
    }

    #[test]
    fn validates_bluetooth_addresses_and_device_paths() {
        assert!(valid_address("AA:BB:CC:DD:EE:FF"));
        assert!(!valid_address("AA:BB:CC:DD:EE"));
        assert_eq!(
            device_identity("/org/bluez/hci2/dev_AA_BB_CC_DD_EE_FF"),
            Some(("adapter-hci2".to_owned(), "AA:BB:CC:DD:EE:FF".to_owned()))
        );
        assert_eq!(
            device_identity("/org/bluez/not-an-adapter/dev_AA_BB_CC_DD_EE_FF"),
            None
        );
    }

    #[tokio::test]
    async fn pairing_agent_returns_an_accepted_pin() {
        let agent = agent();
        let prompt_agent = agent.clone();
        let prompt = tokio::spawn(async move {
            let device = ObjectPath::try_from("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF").unwrap();
            prompt_agent
                .prompt_with_ttl(&device, "pin", None, Duration::from_secs(1))
                .await
        });
        let challenge = wait_for_challenge(&agent).await;
        agent
            .respond(
                &challenge.id,
                &challenge.adapter_id,
                &challenge.device_address,
                true,
                Some("123456".to_owned()),
            )
            .await
            .unwrap();
        let response = prompt.await.unwrap().unwrap();
        assert!(response.accepted);
        assert_eq!(response.pin.as_deref(), Some("123456"));
        assert!(agent.challenge().await.is_none());
    }

    #[tokio::test]
    async fn pairing_agent_rejects_and_validates_challenge_ids() {
        let agent = agent();
        let prompt_agent = agent.clone();
        let prompt = tokio::spawn(async move {
            let device = ObjectPath::try_from("/org/bluez/hci1/dev_11_22_33_44_55_66").unwrap();
            prompt_agent
                .prompt_with_ttl(&device, "confirmation", None, Duration::from_secs(1))
                .await
        });
        let challenge = wait_for_challenge(&agent).await;
        assert!(
            agent
                .respond(
                    "different-challenge",
                    &challenge.adapter_id,
                    &challenge.device_address,
                    true,
                    None,
                )
                .await
                .is_err()
        );
        assert!(
            agent
                .respond(
                    &challenge.id,
                    "adapter-hci0",
                    "AA:BB:CC:DD:EE:FF",
                    true,
                    None,
                )
                .await
                .is_err()
        );
        agent
            .respond(
                &challenge.id,
                &challenge.adapter_id,
                &challenge.device_address,
                false,
                None,
            )
            .await
            .unwrap();
        assert!(matches!(
            prompt.await.unwrap(),
            Err(AgentError::Rejected(_))
        ));
    }

    #[tokio::test]
    async fn pairing_agent_expires_challenges() {
        let agent = agent();
        let device = ObjectPath::try_from("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF").unwrap();
        let result = agent
            .prompt_with_ttl(
                &device,
                "numeric_comparison",
                Some(123_456),
                Duration::from_millis(5),
            )
            .await;
        assert!(matches!(result, Err(AgentError::Canceled(_))));
        assert!(agent.challenge().await.is_none());
    }

    #[test]
    fn only_one_adapter_can_own_the_scan_window() {
        let mut state = BluetoothRuntimeState::default();
        let scan = ScanWindow {
            id: Uuid::new_v4(),
            started_at: "2026-10-20T00:00:00Z".to_owned(),
            ends_at: "2026-10-20T00:00:15Z".to_owned(),
        };
        state.reserve_scan("adapter-hci0", scan.clone()).unwrap();
        assert!(state.reserve_scan("adapter-hci0", scan.clone()).is_err());
        assert!(state.reserve_scan("adapter-hci1", scan).is_err());
    }

    async fn wait_for_challenge(agent: &PairingAgent) -> Challenge {
        for _ in 0..50 {
            if let Some(challenge) = agent.challenge().await {
                return challenge;
            }
            tokio::task::yield_now().await;
        }
        panic!("pairing challenge was not published");
    }
}
