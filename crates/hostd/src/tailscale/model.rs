use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdTailscaleRequest"))]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum TailscaleRequest {
    Status {},
    Login { input: LoginInput },
    Service { input: ServiceInput },
    Action { input: ActionInput },
    Settings { input: SettingsInput },
    Confirm { id: String },
    Rollback { id: String },
}

impl std::fmt::Debug for TailscaleRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TailscaleRequest { payload: [redacted] }")
    }
}

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleLoginInput"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginInput {
    pub control_url: String,
    pub method: LoginMethod,
    pub auth_key: Option<String>,
    pub expected_revision: String,
    pub confirmed: bool,
}

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleLoginMethod"))]
#[serde(rename_all = "snake_case")]
pub enum LoginMethod {
    Browser,
    AuthKey,
}

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleServiceInput"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceInput {
    pub auto_start: bool,
    pub expected_revision: String,
    pub confirmed: bool,
}

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleActionInput"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionInput {
    pub action: ConnectionAction,
    pub expected_revision: String,
    pub confirmed: bool,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleAction"))]
#[serde(rename_all = "snake_case")]
pub enum ConnectionAction {
    Connect,
    Disconnect,
    Logout,
    Start,
    Restart,
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleSettingsPatch"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_dns: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_routes: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_node_allow_lan_access: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advertised_routes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advertise_exit_node: Option<bool>,
}

#[derive(Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleSettingsInput"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsInput {
    pub settings: SettingsPatch,
    pub expected_revision: String,
    pub confirmed: bool,
}

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleSettings"))]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub hostname: String,
    pub accept_dns: bool,
    pub accept_routes: bool,
    pub exit_node_id: String,
    pub exit_node_allow_lan_access: bool,
    pub advertised_routes: Vec<String>,
    pub advertise_exit_node: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscalePeer"))]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub hostname: String,
    pub dns_name: String,
    pub os: String,
    pub ips: Vec<String>,
    pub online: bool,
    pub active: bool,
    pub direct_address: Option<String>,
    pub relay: Option<String>,
    pub rx_bytes: f64,
    pub tx_bytes: f64,
    pub last_seen: Option<String>,
    pub exit_node_option: bool,
}

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleServiceStatus"))]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub installed: bool,
    pub active: bool,
    pub auto_start: bool,
    pub state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleApplyTransaction"))]
#[serde(rename_all = "camelCase")]
pub struct ApplyTransaction {
    pub id: String,
    pub deadline_at: String,
    pub state: TransactionState,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleTransactionState"))]
#[serde(rename_all = "snake_case")]
pub enum TransactionState {
    Pending,
    Confirmed,
    RolledBack,
    Conflict,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "TailscaleStatus"))]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub collected_at: String,
    pub available: bool,
    pub service: ServiceStatus,
    pub version: Option<String>,
    pub backend_state: String,
    pub revision: String,
    pub control_url: String,
    pub login_url: Option<String>,
    pub hostname: String,
    pub dns_name: String,
    pub ips: Vec<String>,
    pub account: Option<String>,
    pub tailnet: Option<String>,
    pub key_expiry: Option<String>,
    pub settings: Settings,
    pub peers: Vec<Peer>,
    pub peers_truncated: bool,
    pub primary_routes: Vec<String>,
    pub exit_node_approved: Option<bool>,
    pub ipv4_forwarding: bool,
    pub ipv6_forwarding: bool,
    pub health: Vec<String>,
    pub transaction: Option<ApplyTransaction>,
    pub error: Option<String>,
}
