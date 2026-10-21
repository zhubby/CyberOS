use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const CONNECTIONS_DIR: &str = "/etc/NetworkManager/system-connections";
const STATE_DIR: &str = "/zos/state/hostd/network-manager";
pub(super) const MANAGED_PREFIX: &str = "zos-";

#[derive(Debug, Clone)]
pub struct NetworkOptions {
    pub connections_dir: PathBuf,
    pub state_dir: PathBuf,
    pub sys_class_net: PathBuf,
}

impl Default for NetworkOptions {
    fn default() -> Self {
        Self {
            connections_dir: CONNECTIONS_DIR.into(),
            state_dir: STATE_DIR.into(),
            sys_class_net: "/sys/class/net".into(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdNetworkManagerRequest")
)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum NetworkRequest {
    Ping,
    Inspect,
    EthernetStatus,
    Scan {
        input: ScanInput,
    },
    Connect {
        input: ConnectInput,
    },
    Disconnect {
        input: ConfirmedDeviceInput,
    },
    Radio {
        input: RadioInput,
    },
    UpdateProfile {
        #[serde(rename = "profileId")]
        profile_id: String,
        input: ProfileUpdateInput,
    },
    DeleteProfile {
        #[serde(rename = "profileId")]
        profile_id: String,
        confirmed: bool,
    },
    UpdateHotspot {
        input: HotspotUpdateInput,
    },
    StartHotspot {
        input: ConfirmedDeviceInput,
    },
    StopHotspot {
        input: ConfirmedDeviceInput,
    },
    DeleteHotspot {
        input: ConfirmedDeviceInput,
    },
    EthernetSave {
        #[serde(rename = "deviceId")]
        device_id: String,
        input: EthernetUpdateInput,
    },
    EthernetApply {
        confirmed: bool,
    },
    EthernetConfirm {
        #[serde(rename = "transactionId")]
        transaction_id: String,
    },
    EthernetRollback {
        #[serde(rename = "transactionId")]
        transaction_id: String,
    },
}

impl NetworkRequest {
    pub(crate) fn is_configuration_mutation(&self) -> bool {
        !matches!(
            self,
            Self::Ping | Self::Inspect | Self::Scan { .. } | Self::EthernetStatus
        )
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdNetworkScanInput"))]
pub(crate) struct ScanInput {
    pub(super) device: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdNetworkConnectInput"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectInput {
    pub(super) device: String,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) profile_id: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) ssid: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) security: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) password: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) bssid: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) autoconnect: Option<bool>,
    #[serde(rename = "confirmed")]
    pub(super) _confirmed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdNetworkConfirmedDeviceInput")
)]
pub(crate) struct ConfirmedDeviceInput {
    pub(super) device: String,
    pub(super) confirmed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdNetworkRadioInput"))]
pub(crate) struct RadioInput {
    pub(super) enabled: bool,
    pub(super) confirmed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdNetworkProfileUpdateInput")
)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileUpdateInput {
    pub(super) expected_revision: String,
    pub(super) confirmed: bool,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) ssid: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) security: Option<String>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) autoconnect: Option<bool>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) password: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdNetworkHotspotUpdateInput")
)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HotspotUpdateInput {
    pub(super) device: String,
    pub(super) ssid: String,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) password: Option<String>,
    pub(super) band: String,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) channel: Option<u16>,
    pub(super) autostart: bool,
    #[cfg_attr(test, ts(optional = nullable))]
    pub(super) expected_revision: Option<String>,
    pub(super) confirmed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdNetworkRollbackStatus")
)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RollbackStatus {
    NotRequired,
    Succeeded,
    Failed,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdNetworkMutationResult")
)]
pub(crate) struct MutationResult {
    pub(super) rollback: RollbackStatus,
    pub(super) message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdEthernetIpv4Config"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct EthernetIpv4Config {
    pub(super) mode: String,
    pub(super) address: Option<String>,
    pub(super) prefix_length: Option<u8>,
    pub(super) gateway: Option<String>,
    pub(super) dns_mode: String,
    pub(super) dns: Vec<String>,
    pub(super) use_default_route: bool,
    pub(super) route_metric: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdEthernetIpv6Config"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct EthernetIpv6Config {
    pub(super) mode: String,
    pub(super) address: Option<String>,
    pub(super) prefix_length: Option<u8>,
    pub(super) gateway: Option<String>,
    pub(super) dns_mode: String,
    pub(super) dns: Vec<String>,
    pub(super) use_default_route: bool,
    pub(super) route_metric: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdEthernetConfig"))]
pub(crate) struct EthernetConfig {
    pub(super) enabled: bool,
    pub(super) ipv4: EthernetIpv4Config,
    pub(super) ipv6: EthernetIpv6Config,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdEthernetUpdateInput"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct EthernetUpdateInput {
    pub(super) config: EthernetConfig,
    pub(super) expected_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdEthernetAddress"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct EthernetAddress {
    pub(super) family: String,
    pub(super) address: String,
    pub(super) prefix_length: Option<u8>,
    pub(super) cidr: Option<String>,
    pub(super) scope: Option<String>,
    pub(super) label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdEthernetDevice"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct EthernetDevice {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) permanent_mac: String,
    pub(super) mac: String,
    pub(super) driver: Option<String>,
    pub(super) speed_mbps: Option<u32>,
    pub(super) carrier: bool,
    pub(super) state: String,
    pub(super) addresses: Vec<EthernetAddress>,
    pub(super) ipv4_gateway: Option<String>,
    pub(super) ipv6_gateway: Option<String>,
    pub(super) active_profile_id: Option<String>,
    pub(super) active_profile_name: Option<String>,
    pub(super) management_state: String,
    pub(super) active_config: Option<EthernetConfig>,
    pub(super) desired_config: Option<EthernetConfig>,
    pub(super) revision: String,
    pub(super) needs_apply: bool,
    pub(super) warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdEthernetApplyTransaction")
)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EthernetApplyTransaction {
    pub(super) id: String,
    pub(super) status: String,
    pub(super) device_ids: Vec<String>,
    pub(super) created_at: String,
    pub(super) deadline_at: Option<String>,
    pub(super) rollback: RollbackStatus,
    pub(super) error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdEthernetStatus"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct EthernetStatus {
    pub(super) collected_at: String,
    pub(super) backend: String,
    pub(super) hostd_ready: bool,
    pub(super) devices: Vec<EthernetDevice>,
    pub(super) transaction: Option<EthernetApplyTransaction>,
    pub(super) warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdNetworkProfileInspection")
)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileInspection {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) ssid: String,
    pub(super) device: Option<String>,
    pub(super) security: String,
    pub(super) mode: String,
    pub(super) band: String,
    pub(super) channel: Option<u16>,
    pub(super) autoconnect: bool,
    pub(super) credential_configured: bool,
    pub(super) revision: String,
}

#[derive(Debug, Clone)]
pub(super) struct ManagedProfile {
    pub(super) path: PathBuf,
    pub(super) content: String,
    pub(super) inspection: ProfileInspection,
}

#[derive(Debug)]
pub(super) struct ProfileDefinition {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) ssid: String,
    pub(super) device: String,
    pub(super) security: String,
    pub(super) password: Option<String>,
    pub(super) mode: String,
    pub(super) band: String,
    pub(super) channel: Option<u16>,
    pub(super) autoconnect: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdNetworkRecoveryEntry"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryEntry {
    pub(super) restore_profile_id: Option<String>,
    pub(super) hotspot_profile_id: String,
}

pub(super) type RecoveryState = HashMap<String, RecoveryEntry>;

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdNetworkPingResult"))]
pub(crate) struct PingResult {
    #[cfg_attr(test, ts(type = "true"))]
    pub(super) ready: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdNetworkInspectionResult")
)]
pub(crate) struct InspectionResult {
    pub(super) profiles: Vec<ProfileInspection>,
    pub(super) recovery: RecoveryState,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdNetworkAccessPoint"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccessPoint {
    pub(super) active: bool,
    pub(super) ssid: String,
    pub(super) bssid: String,
    pub(super) channel: u16,
    #[serde(rename = "frequencyMHz")]
    pub(super) frequency_mhz: u32,
    pub(super) signal: i32,
    pub(super) band: String,
    pub(super) security: String,
    pub(super) saved_profile_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdNetworkScanResult"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanResult {
    pub(super) device: String,
    pub(super) scanned_at: String,
    pub(super) access_points: Vec<AccessPoint>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdNetworkManagerResult"))]
#[serde(untagged)]
pub(crate) enum NetworkResult {
    Ping(PingResult),
    Inspection(InspectionResult),
    Scan(ScanResult),
    Mutation(MutationResult),
    EthernetStatus(EthernetStatus),
    EthernetTransaction(EthernetApplyTransaction),
}
