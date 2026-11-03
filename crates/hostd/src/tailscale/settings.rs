use super::model::{SettingsPatch, Status};
use crate::error::HostdError;
use serde_json::{Map, Value, json};
use std::net::IpAddr;
use url::Url;

pub(super) fn control_url(value: &str) -> Result<String, HostdError> {
    let url = Url::parse(value)
        .map_err(|_| HostdError::validation("Invalid Tailscale control server URL"))?;
    if value.len() > 1024
        || !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(HostdError::validation(
            "Control server must be an HTTP(S) URL without credentials, query or fragment",
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub(super) fn safe_login_url(value: &str, control: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Ok(control) = Url::parse(control) else {
        return false;
    };
    if control.host_str() == Some("controlplane.tailscale.com") {
        url.scheme() == "https"
            && url.host_str().is_some_and(|host| {
                host == "login.tailscale.com" || host == "controlplane.tailscale.com"
            })
    } else {
        url.origin() == control.origin()
    }
}

pub(super) fn changes(
    patch: SettingsPatch,
    current: &Status,
    prefs: &Value,
) -> Result<Map<String, Value>, HostdError> {
    // Refuse a partial/unsupported prefs response rather than inventing defaults for a write.
    for field in [
        "WantRunning",
        "CorpDNS",
        "RouteAll",
        "ExitNodeAllowLANAccess",
    ] {
        if !prefs[field].is_boolean() {
            return Err(HostdError::unsupported(
                "Tailscale preferences are incompatible; update the system package",
            ));
        }
    }
    if !prefs["AdvertiseRoutes"].is_null() && !prefs["AdvertiseRoutes"].is_array() {
        return Err(HostdError::unsupported(
            "Tailscale route preferences are incompatible",
        ));
    }
    let mut updates = Map::new();
    if let Some(name) = patch.hostname {
        if name.len() > 63
            || (!name.is_empty()
                && (name.starts_with('-')
                    || name.ends_with('-')
                    || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')))
        {
            return Err(HostdError::validation(
                "Tailscale hostname must be empty or a valid DNS label of up to 63 characters",
            ));
        }
        updates.insert("Hostname".into(), json!(name));
    }
    if let Some(value) = patch.accept_dns {
        updates.insert("CorpDNS".into(), json!(value));
    }
    if let Some(value) = patch.accept_routes {
        updates.insert("RouteAll".into(), json!(value));
    }
    if let Some(value) = patch.exit_node_allow_lan_access {
        updates.insert("ExitNodeAllowLANAccess".into(), json!(value));
    }
    let exit_id = patch
        .exit_node_id
        .as_deref()
        .unwrap_or(&current.settings.exit_node_id);
    let advertise_exit = patch
        .advertise_exit_node
        .unwrap_or(current.settings.advertise_exit_node);
    if advertise_exit && !exit_id.is_empty() {
        return Err(HostdError::validation(
            "An exit node cannot use another exit node",
        ));
    }
    if let Some(id) = patch.exit_node_id {
        if !id.is_empty()
            && id != current.settings.exit_node_id
            && !current
                .peers
                .iter()
                .any(|p| p.id == id && p.online && p.exit_node_option)
        {
            return Err(HostdError::validation(
                "Select an online, approved exit node",
            ));
        }
        // Clearing both representations also handles exits configured by IP using the CLI.
        if id != current.settings.exit_node_id {
            updates.insert("ExitNodeID".into(), json!(id));
            updates.insert("ExitNodeIP".into(), json!(""));
        }
    }
    if patch.advertised_routes.is_some() || patch.advertise_exit_node.is_some() {
        let mut routes = patch
            .advertised_routes
            .unwrap_or_else(|| current.settings.advertised_routes.clone());
        if routes.len() > 128 {
            return Err(HostdError::validation(
                "At most 128 subnet routes are supported",
            ));
        }
        routes = routes
            .iter()
            .map(|route| normalize_route(route))
            .collect::<Result<_, _>>()?;
        routes.sort();
        routes.dedup();
        if advertise_exit {
            routes.extend(["0.0.0.0/0".into(), "::/0".into()]);
        }
        updates.insert("AdvertiseRoutes".into(), json!(routes));
    }
    updates.retain(|key, value| prefs.get(key).unwrap_or(&Value::Null) != value);
    Ok(updates)
}

fn normalize_route(value: &str) -> Result<String, HostdError> {
    let invalid = || {
        HostdError::validation(
            "Subnet routes must be network CIDRs; use the exit node switch for default routes",
        )
    };
    let (address, prefix) = value.split_once('/').ok_or_else(invalid)?;
    let address: IpAddr = address.parse().map_err(|_| invalid())?;
    let prefix: u32 = prefix.parse().map_err(|_| invalid())?;
    let valid = match address {
        IpAddr::V4(ip) => {
            (1..=32).contains(&prefix)
                && !ip.is_loopback()
                && !ip.is_multicast()
                && u32::from(ip) & (u32::MAX.checked_shr(prefix).unwrap_or(0)) == 0
        }
        IpAddr::V6(ip) => {
            (1..=128).contains(&prefix)
                && !ip.is_loopback()
                && !ip.is_multicast()
                && u128::from(ip) & (u128::MAX.checked_shr(prefix).unwrap_or(0)) == 0
        }
    };
    if !valid {
        return Err(invalid());
    }
    // Go's netip.Prefix marshals canonical IPs and prefix lengths. Record the
    // same values in recovery state so confirmation/rollback comparisons hold.
    Ok(format!("{address}/{prefix}"))
}

pub(super) fn masked(fields: &Map<String, Value>) -> Value {
    let mut value = fields.clone();
    for key in fields.keys() {
        value.insert(format!("{key}Set"), Value::Bool(true));
    }
    Value::Object(value)
}
