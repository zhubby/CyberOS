use std::collections::BTreeMap;
use std::path::Path;

use sha2::{Digest, Sha256};
use tokio::fs;

use crate::command::{CommandRunner, run_checked};
use crate::error::HostdError;

use super::model::{MANAGED_PREFIX, ManagedProfile, ProfileDefinition, ProfileInspection};
use super::validation::validate_uuid;

pub(super) type Keyfile = BTreeMap<String, BTreeMap<String, String>>;

pub(super) async fn create_keyfile(
    definition: &ProfileDefinition,
    runner: &dyn CommandRunner,
) -> Result<String, HostdError> {
    let base = run_checked(
        runner,
        "nmcli",
        &[
            "--offline",
            "connection",
            "add",
            "type",
            "wifi",
            "ifname",
            &definition.device,
            "con-name",
            &definition.name,
            "ssid",
            &definition.ssid,
        ],
        None,
    )
    .await?;
    if base.trim().is_empty() {
        return Err(HostdError::unavailable(
            "NetworkManager could not generate a Wi-Fi profile",
        ));
    }
    let mut keyfile = parse_keyfile(&base);
    set_keyfile(&mut keyfile, "connection", "uuid", &definition.id);
    set_keyfile(&mut keyfile, "connection", "type", "wifi");
    set_keyfile(
        &mut keyfile,
        "connection",
        "interface-name",
        &definition.device,
    );
    set_keyfile(
        &mut keyfile,
        "connection",
        "autoconnect",
        if definition.autoconnect {
            "true"
        } else {
            "false"
        },
    );
    set_keyfile(
        &mut keyfile,
        "wifi",
        "mode",
        if definition.mode == "hotspot" {
            "ap"
        } else {
            "infrastructure"
        },
    );
    set_keyfile(
        &mut keyfile,
        "wifi",
        "band",
        match definition.band.as_str() {
            "2.4" => "bg",
            "5" => "a",
            _ => "",
        },
    );
    set_keyfile(
        &mut keyfile,
        "wifi",
        "channel",
        &definition
            .channel
            .map(|channel| channel.to_string())
            .unwrap_or_default(),
    );
    set_keyfile(
        &mut keyfile,
        "wifi",
        "ap-isolation",
        if definition.mode == "hotspot" {
            "1"
        } else {
            ""
        },
    );
    if definition.security == "open" {
        keyfile.remove("wifi-security");
        set_keyfile(&mut keyfile, "wifi", "security", "");
    } else {
        set_keyfile(&mut keyfile, "wifi", "security", "wifi-security");
        set_keyfile(
            &mut keyfile,
            "wifi-security",
            "key-mgmt",
            if definition.security == "wpa3" {
                "sae"
            } else {
                "wpa-psk"
            },
        );
        set_keyfile(
            &mut keyfile,
            "wifi-security",
            "psk",
            definition.password.as_deref().unwrap_or_default(),
        );
    }
    set_keyfile(
        &mut keyfile,
        "ipv4",
        "method",
        if definition.mode == "hotspot" {
            "shared"
        } else {
            "auto"
        },
    );
    set_keyfile(
        &mut keyfile,
        "ipv6",
        "method",
        if definition.mode == "hotspot" {
            "disabled"
        } else {
            "auto"
        },
    );
    Ok(render_keyfile(&keyfile))
}

pub(super) async fn read_profiles(directory: &Path) -> Result<Vec<ManagedProfile>, HostdError> {
    let mut entries = match fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut paths = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(MANAGED_PREFIX) && name.ends_with(".nmconnection") {
            paths.push(entry.path());
        }
    }
    paths.sort();
    let mut profiles = Vec::new();
    for path in paths {
        let metadata = fs::symlink_metadata(&path).await?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(HostdError::validation(
                "Managed NetworkManager profile must be a regular file",
            ));
        }
        let content = fs::read_to_string(&path).await?;
        let keyfile = parse_keyfile(&content);
        if matches!(
            keyfile_value(&keyfile, "connection", "type"),
            Some("wifi" | "802-11-wireless")
        ) {
            profiles.push(read_profile(&path).await?);
        }
    }
    Ok(profiles)
}

pub(super) async fn read_profile(path: &Path) -> Result<ManagedProfile, HostdError> {
    let metadata = fs::symlink_metadata(path).await?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(HostdError::validation(
            "Managed Wi-Fi profile must be a regular file",
        ));
    }
    let content = fs::read_to_string(path).await?;
    let keyfile = parse_keyfile(&content);
    let id = required_keyfile(&keyfile, "connection", "uuid")?;
    let name = required_keyfile(&keyfile, "connection", "id")?;
    let ssid = required_keyfile(&keyfile, "wifi", "ssid")?;
    validate_uuid(id)?;
    let mode = if keyfile_value(&keyfile, "wifi", "mode") == Some("ap") {
        "hotspot"
    } else {
        "client"
    };
    let band = match keyfile_value(&keyfile, "wifi", "band") {
        Some("a") => "5",
        Some("bg") => "2.4",
        _ => "auto",
    };
    let security = security_from_keyfile(keyfile_value(&keyfile, "wifi-security", "key-mgmt"));
    Ok(ManagedProfile {
        path: path.to_owned(),
        content: content.clone(),
        inspection: ProfileInspection {
            id: id.to_owned(),
            name: name.to_owned(),
            ssid: ssid.to_owned(),
            device: keyfile_value(&keyfile, "connection", "interface-name").map(ToOwned::to_owned),
            security: security.to_owned(),
            mode: mode.to_owned(),
            band: band.to_owned(),
            channel: keyfile_value(&keyfile, "wifi", "channel")
                .and_then(|value| value.parse().ok()),
            autoconnect: keyfile_value(&keyfile, "connection", "autoconnect") == Some("true"),
            credential_configured: security == "open"
                || keyfile_value(&keyfile, "wifi-security", "psk")
                    .is_some_and(|value| !value.is_empty()),
            revision: revision(&content),
        },
    })
}

pub(super) async fn find_profile(id: &str, directory: &Path) -> Result<ManagedProfile, HostdError> {
    read_profiles(directory)
        .await?
        .into_iter()
        .find(|profile| profile.inspection.id == id)
        .ok_or_else(|| HostdError::not_found("Managed Wi-Fi profile not found"))
}

pub(super) async fn find_hotspot(
    device: &str,
    directory: &Path,
) -> Result<ManagedProfile, HostdError> {
    read_profiles(directory)
        .await?
        .into_iter()
        .find(|profile| {
            profile.inspection.mode == "hotspot"
                && profile.inspection.device.as_deref() == Some(device)
        })
        .ok_or_else(|| HostdError::not_found("Hotspot configuration not found"))
}

pub(super) fn parse_keyfile(content: &str) -> Keyfile {
    let mut result = Keyfile::new();
    let mut section_name: Option<String> = None;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') && line.len() > 2 {
            let name = line[1..line.len() - 1].to_owned();
            result.entry(name.clone()).or_default();
            section_name = Some(name);
            continue;
        }
        if let (Some(section), Some(separator)) = (section_name.as_ref(), raw_line.find('='))
            && separator > 0
        {
            result.entry(section.clone()).or_default().insert(
                raw_line[..separator].trim().to_owned(),
                raw_line[separator + 1..].to_owned(),
            );
        }
    }
    result
}

fn render_keyfile(keyfile: &Keyfile) -> String {
    let mut lines = vec!["# Managed by SigmaOS. Do not edit this file directly.".to_owned()];
    for section_name in ["connection", "wifi", "wifi-security", "ipv4", "ipv6"] {
        let Some(section) = keyfile
            .get(section_name)
            .filter(|section| !section.is_empty())
        else {
            continue;
        };
        lines.extend([String::new(), format!("[{section_name}]")]);
        for (key, value) in section {
            if !value.is_empty() {
                lines.push(format!("{key}={value}"));
            }
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn set_keyfile(keyfile: &mut Keyfile, section: &str, key: &str, value: &str) {
    if value.is_empty() {
        if let Some(values) = keyfile.get_mut(section) {
            values.remove(key);
            if values.is_empty() {
                keyfile.remove(section);
            }
        }
    } else {
        keyfile
            .entry(section.to_owned())
            .or_default()
            .insert(key.to_owned(), value.to_owned());
    }
}

pub(super) fn keyfile_value<'a>(keyfile: &'a Keyfile, section: &str, key: &str) -> Option<&'a str> {
    keyfile.get(section)?.get(key).map(String::as_str)
}

fn required_keyfile<'a>(
    keyfile: &'a Keyfile,
    section: &str,
    key: &str,
) -> Result<&'a str, HostdError> {
    keyfile_value(keyfile, section, key)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| HostdError::validation("Managed Wi-Fi profile is invalid"))
}

fn security_from_keyfile(value: Option<&str>) -> &'static str {
    match value {
        None => "open",
        Some("sae") => "wpa3",
        Some("wpa-psk") => "wpa2",
        _ => "unsupported",
    }
}

fn revision(content: &str) -> String {
    Sha256::digest(content.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn wifi_discovery_ignores_managed_ethernet_profiles() {
        let temp = TempDir::new().unwrap();
        fs::write(
            temp.path().join("sigmaos-ethernet-aabbccddeeff.nmconnection"),
            "[connection]\nid=Ethernet\nuuid=550e8400-e29b-41d4-a716-446655440010\ntype=ethernet\n[ethernet]\nmac-address=aa:bb:cc:dd:ee:ff\n",
        )
        .await
        .unwrap();
        fs::write(
            temp.path().join("sigmaos-wifi.nmconnection"),
            "[connection]\nid=Wi-Fi\nuuid=550e8400-e29b-41d4-a716-446655440011\ntype=wifi\ninterface-name=wlan0\nautoconnect=true\n[wifi]\nssid=Home\nmode=infrastructure\n[ipv4]\nmethod=auto\n",
        )
        .await
        .unwrap();

        let profiles = read_profiles(temp.path()).await.unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].inspection.ssid, "Home");
    }
}
