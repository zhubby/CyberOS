mod localapi;
mod model;
mod settings;
#[cfg(test)]
mod tests;
mod transaction;

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::command::{CommandRunner, DEFAULT_OUTPUT_LIMIT};
use crate::error::HostdError;
use localapi::{LocalApi, SocketApi};
use model::*;
pub(crate) use model::{Status, TailscaleRequest};

const OFFICIAL_CONTROL: &str = "https://controlplane.tailscale.com";

pub(super) struct Options {
    socket: PathBuf,
    state_dir: PathBuf,
    forwarding_config: PathBuf,
    proc_sys: PathBuf,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            socket: "/run/tailscale/tailscaled.sock".into(),
            state_dir: "/cyberos/state/hostd/tailscale".into(),
            forwarding_config: "/etc/sysctl.d/99-cyberos-tailscale.conf".into(),
            proc_sys: "/proc/sys".into(),
        }
    }
}

#[cfg(test)]
pub(crate) fn export_protocol_bindings(config: &ts_rs::Config) {
    use ts_rs::TS;
    TailscaleRequest::export_all(config).unwrap();
    Status::export_all(config).unwrap();
}

pub(crate) async fn handle(
    request: TailscaleRequest,
    runner: &dyn CommandRunner,
) -> Result<Status, HostdError> {
    let options = Options::default();
    let api = SocketApi::new(&options.socket)?;
    execute(request, runner, &api, &options).await
}

pub(crate) async fn recover(runner: &dyn CommandRunner) -> Result<(), HostdError> {
    let options = Options::default();
    if !options.state_dir.join("transaction.json").exists() {
        return Ok(());
    }
    let api = SocketApi::new(&options.socket)?;
    transaction::recover_expired(&api, runner, &options, OffsetDateTime::now_utc()).await
}

async fn execute(
    request: TailscaleRequest,
    runner: &dyn CommandRunner,
    api: &dyn LocalApi,
    options: &Options,
) -> Result<Status, HostdError> {
    // Recovery failures remain visible and are retried; they never block unrelated hostd subsystems.
    let recovery_error =
        transaction::recover_expired(api, runner, options, OffsetDateTime::now_utc())
            .await
            .err();
    if let TailscaleRequest::Status {} = request {
        let mut result = status(runner, api, options).await?;
        if recovery_error.is_some() {
            result.error = Some(
                "Tailscale configuration rollback is pending; restore service access to retry"
                    .into(),
            );
        }
        return Ok(result);
    }
    match request {
        TailscaleRequest::Confirm { id } => {
            transaction::finish(&id, true, api, runner, options).await?
        }
        TailscaleRequest::Rollback { id } => {
            transaction::finish(&id, false, api, runner, options).await?
        }
        TailscaleRequest::Status {} => unreachable!(),
        request => {
            if transaction::read(options)
                .await?
                .is_some_and(|t| t.public.state == TransactionState::Pending)
            {
                return Err(HostdError::conflict(
                    "Confirm or roll back the pending Tailscale configuration first",
                ));
            }
            let current = status(runner, api, options).await?;
            match request {
                TailscaleRequest::Login { input } => {
                    ensure_input(input.confirmed, &input.expected_revision, &current)?;
                    let control = settings::control_url(&input.control_url)?;
                    if (current.account.is_some() && current.backend_state != "NeedsLogin")
                        || matches!(
                            current.backend_state.as_str(),
                            "Running" | "Stopped" | "Starting" | "NeedsMachineAuth"
                        )
                    {
                        return Err(HostdError::conflict(
                            "Log out before starting another Tailscale login",
                        ));
                    }
                    if current.account.is_some() && control != current.control_url {
                        return Err(HostdError::conflict(
                            "Log out before changing the control server",
                        ));
                    }
                    let key = match input.method {
                        LoginMethod::Browser if input.auth_key.is_none() => None,
                        LoginMethod::AuthKey => {
                            let key = input.auth_key.as_deref().unwrap_or("").trim();
                            if key.is_empty()
                                || key.len() > 4096
                                || key.chars().any(char::is_control)
                            {
                                return Err(HostdError::validation(
                                    "A valid Tailscale authentication key is required",
                                ));
                            }
                            Some(key.to_owned())
                        }
                        _ => {
                            return Err(HostdError::validation(
                                "Browser login does not accept an authentication key",
                            ));
                        }
                    };
                    if !current.service.active {
                        systemctl(runner, "start").await?;
                    }
                    if control != current.control_url {
                        let (native, prefs) = tokio::try_join!(
                            api.request("GET", "status", None),
                            api.request("GET", "prefs", None)
                        )?;
                        if boolean(&native, "HaveNodeKey") && !boolean(&prefs, "LoggedOut") {
                            return Err(HostdError::conflict(
                                "Log out before changing the control server",
                            ));
                        }
                    }
                    api.request("PATCH", "prefs", Some(json!({"ControlURL":control,"ControlURLSet":true,"WantRunning":true,"WantRunningSet":true,"LoggedOut":false,"LoggedOutSet":true}))).await?;
                    let body = key.map_or_else(|| json!({}), |key| json!({"AuthKey":key}));
                    api.request("POST", "start", Some(body)).await?;
                    // Start prepares the control client; a logged-out/no-key profile also needs
                    // an explicit login trigger, including when Start supplied an AuthKey.
                    api.request("POST", "login-interactive", None).await?;
                }
                TailscaleRequest::Service { input } => {
                    ensure_input(input.confirmed, &input.expected_revision, &current)?;
                    if !current.service.installed {
                        return Err(HostdError::unavailable("Tailscale is not installed"));
                    }
                    systemctl(
                        runner,
                        if input.auto_start {
                            "enable"
                        } else {
                            "disable"
                        },
                    )
                    .await?;
                }
                TailscaleRequest::Action { input } => {
                    ensure_input(input.confirmed, &input.expected_revision, &current)?;
                    if !current.service.installed {
                        return Err(HostdError::unavailable("Tailscale is not installed"));
                    }
                    match input.action {
                        ConnectionAction::Start => systemctl(runner, "start").await?,
                        ConnectionAction::Restart => systemctl(runner, "restart").await?,
                        ConnectionAction::Logout => {
                            api.request("POST", "logout", None).await?;
                        }
                        ConnectionAction::Connect | ConnectionAction::Disconnect => {
                            if !current.service.active
                                && matches!(input.action, ConnectionAction::Connect)
                            {
                                systemctl(runner, "start").await?;
                            }
                            api.request("PATCH", "prefs", Some(json!({"WantRunning":matches!(input.action, ConnectionAction::Connect),"WantRunningSet":true}))).await?;
                        }
                    }
                }
                TailscaleRequest::Settings { input } => {
                    ensure_input(input.confirmed, &input.expected_revision, &current)?;
                    if !current.available {
                        return Err(HostdError::unavailable(
                            "Start Tailscale before editing its configuration",
                        ));
                    }
                    transaction::apply(input.settings, &current, api, runner, options).await?;
                }
                _ => unreachable!(),
            }
        }
    }
    status(runner, api, options).await
}

fn ensure_input(confirmed: bool, expected: &str, current: &Status) -> Result<(), HostdError> {
    if !confirmed {
        return Err(HostdError::validation(
            "Tailscale operation confirmation is required",
        ));
    }
    if expected != current.revision {
        return Err(HostdError::conflict(
            "Tailscale configuration changed; refresh before retrying",
        ));
    }
    Ok(())
}

async fn systemctl(runner: &dyn CommandRunner, action: &str) -> Result<(), HostdError> {
    let result = runner
        .run(
            "systemctl",
            &[action.into(), "tailscaled.service".into()],
            None,
            Duration::from_secs(15),
            DEFAULT_OUTPUT_LIMIT,
        )
        .await?;
    if !result.success {
        return Err(HostdError::operation_failed(
            "Tailscale service operation failed",
        ));
    }
    Ok(())
}

async fn service_status(runner: &dyn CommandRunner) -> ServiceStatus {
    let result = runner
        .run(
            "systemctl",
            &[
                "show".into(),
                "tailscaled.service".into(),
                "--property=LoadState,ActiveState,UnitFileState".into(),
            ],
            None,
            Duration::from_secs(5),
            4096,
        )
        .await;
    let Ok(result) = result else {
        return ServiceStatus {
            state: "unavailable".into(),
            ..Default::default()
        };
    };
    let values = result
        .stdout
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect::<std::collections::HashMap<_, _>>();
    ServiceStatus {
        installed: values.get("LoadState") == Some(&"loaded"),
        active: values.get("ActiveState") == Some(&"active"),
        auto_start: matches!(
            values.get("UnitFileState"),
            Some(&"enabled") | Some(&"enabled-runtime")
        ),
        state: values.get("ActiveState").unwrap_or(&"unknown").to_string(),
    }
}

async fn status(
    runner: &dyn CommandRunner,
    api: &dyn LocalApi,
    options: &Options,
) -> Result<Status, HostdError> {
    let service = service_status(runner).await;
    let (native, prefs, error) = if service.active {
        match tokio::try_join!(
            api.request("GET", "status", None),
            api.request("GET", "prefs", None)
        ) {
            Ok((native, prefs)) if native.is_object() && prefs.is_object() => (native, prefs, None),
            Ok(_) => (
                Value::Null,
                Value::Null,
                Some("Invalid Tailscale status response".to_owned()),
            ),
            Err(error) => (Value::Null, Value::Null, Some(error.message)),
        }
    } else {
        (
            Value::Null,
            Value::Null,
            Some(
                if service.installed {
                    "Tailscale service is stopped"
                } else {
                    "Tailscale is not installed"
                }
                .into(),
            ),
        )
    };
    let mut result = normalize(&native, &prefs, service);
    result.error = error;
    result.transaction = transaction::read(options).await?.map(|t| t.public);
    result.ipv4_forwarding = forwarding_enabled(options, "net/ipv4/ip_forward").await;
    result.ipv6_forwarding = forwarding_enabled(options, "net/ipv6/conf/all/forwarding").await;
    Ok(result)
}

async fn forwarding_enabled(options: &Options, key: &str) -> bool {
    tokio::fs::read_to_string(options.proc_sys.join(key))
        .await
        .is_ok_and(|v| v.trim() == "1")
}

fn string(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(1024)
        .collect()
}
fn optional_string(value: &Value, key: &str) -> Option<String> {
    let s = string(value, key);
    (!s.is_empty()).then_some(s)
}
fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .take(1024)
                .map(|v| v.chars().take(1024).collect())
                .collect()
        })
        .unwrap_or_default()
}
fn boolean(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
}
fn stamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

fn normalize(native: &Value, prefs: &Value, service: ServiceStatus) -> Status {
    let me = &native["Self"];
    let user = native["User"].as_object().and_then(|users| {
        me["UserID"]
            .as_i64()
            .and_then(|id| users.get(&id.to_string()))
    });
    let routes = strings(&prefs["AdvertiseRoutes"]);
    let settings = Settings {
        hostname: string(prefs, "Hostname"),
        accept_dns: boolean(prefs, "CorpDNS"),
        accept_routes: boolean(prefs, "RouteAll"),
        exit_node_id: optional_string(prefs, "ExitNodeID")
            .unwrap_or_else(|| string(prefs, "ExitNodeIP")),
        exit_node_allow_lan_access: boolean(prefs, "ExitNodeAllowLANAccess"),
        advertise_exit_node: routes.iter().any(|r| r == "0.0.0.0/0" || r == "::/0"),
        advertised_routes: routes
            .into_iter()
            .filter(|r| r != "0.0.0.0/0" && r != "::/0")
            .collect(),
    };
    let peer_map = native["Peer"].as_object();
    let mut peers = peer_map
        .map(|p| {
            p.values()
                .take(1000)
                .map(|p| Peer {
                    id: string(p, "ID"),
                    hostname: string(p, "HostName"),
                    dns_name: string(p, "DNSName"),
                    os: string(p, "OS"),
                    ips: strings(&p["TailscaleIPs"]),
                    online: boolean(p, "Online"),
                    active: boolean(p, "Active"),
                    direct_address: optional_string(p, "CurAddr"),
                    relay: optional_string(p, "Relay"),
                    rx_bytes: p["RxBytes"].as_f64().unwrap_or(0.0).max(0.0),
                    tx_bytes: p["TxBytes"].as_f64().unwrap_or(0.0).max(0.0),
                    last_seen: optional_string(p, "LastSeen"),
                    exit_node_option: boolean(p, "ExitNodeOption"),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    peers.sort_by(|a, b| {
        b.online
            .cmp(&a.online)
            .then(a.hostname.cmp(&b.hostname))
            .then(a.id.cmp(&b.id))
    });
    let control_url =
        optional_string(prefs, "ControlURL").unwrap_or_else(|| OFFICIAL_CONTROL.into());
    let login_url = optional_string(native, "AuthURL")
        .filter(|value| settings::safe_login_url(value, &control_url));
    let revision = revision(native, prefs, &service);
    Status {
        collected_at: stamp(),
        available: native.is_object() && prefs.is_object(),
        service,
        version: optional_string(native, "Version"),
        backend_state: optional_string(native, "BackendState")
            .unwrap_or_else(|| "Unavailable".into()),
        revision,
        control_url,
        login_url,
        hostname: string(me, "HostName"),
        dns_name: string(me, "DNSName"),
        ips: strings(&native["TailscaleIPs"]),
        account: user.and_then(|u| optional_string(u, "LoginName")),
        tailnet: optional_string(&native["CurrentTailnet"], "Name"),
        key_expiry: optional_string(me, "KeyExpiry"),
        settings,
        peers,
        peers_truncated: peer_map.is_some_and(|p| p.len() > 1000),
        primary_routes: strings(&me["PrimaryRoutes"]),
        exit_node_approved: me["ExitNodeOption"].as_bool(),
        ipv4_forwarding: false,
        ipv6_forwarding: false,
        health: strings(&native["Health"]),
        transaction: None,
        error: None,
    }
}

fn revision(native: &Value, prefs: &Value, service: &ServiceStatus) -> String {
    let fields = [
        "ControlURL",
        "WantRunning",
        "LoggedOut",
        "Hostname",
        "CorpDNS",
        "RouteAll",
        "ExitNodeID",
        "ExitNodeIP",
        "ExitNodeAllowLANAccess",
        "AdvertiseRoutes",
    ];
    let mut canonical = serde_json::Map::new();
    for key in fields {
        canonical.insert(key.into(), prefs[key].clone());
    }
    canonical.insert("identity".into(), native["Self"]["ID"].clone());
    canonical.insert("nodeKeyPresent".into(), native["HaveNodeKey"].clone());
    canonical.insert("service".into(), json!(service));
    format!(
        "{:x}",
        Sha256::digest(Value::Object(canonical).to_string().as_bytes())
    )
}
