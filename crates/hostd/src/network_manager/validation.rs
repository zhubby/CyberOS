use uuid::Uuid;

use crate::error::HostdError;

use super::model::NetworkRequest;

pub(super) fn validate_request(request: &NetworkRequest) -> Result<(), HostdError> {
    match request {
        NetworkRequest::Ping | NetworkRequest::Inspect | NetworkRequest::EthernetStatus => Ok(()),
        NetworkRequest::Scan { input } => validate_device(&input.device),
        NetworkRequest::Connect { input } => {
            validate_device(&input.device)?;
            if let Some(profile_id) = &input.profile_id {
                validate_uuid(profile_id)?;
                if let Some(bssid) = &input.bssid {
                    validate_bssid(bssid)?;
                }
                return Ok(());
            }
            validate_ssid(input.ssid.as_deref().unwrap_or_default())?;
            let security = input
                .security
                .as_deref()
                .ok_or_else(|| HostdError::validation("Unsupported Wi-Fi security"))?;
            validate_security(security)?;
            validate_credential(security, input.password.as_deref())?;
            if let Some(bssid) = &input.bssid {
                validate_bssid(bssid)?;
            }
            Ok(())
        }
        NetworkRequest::Disconnect { input }
        | NetworkRequest::StartHotspot { input }
        | NetworkRequest::StopHotspot { input }
        | NetworkRequest::DeleteHotspot { input } => {
            validate_device(&input.device)?;
            if !input.confirmed {
                return Err(HostdError::validation("Confirmation is required"));
            }
            Ok(())
        }
        NetworkRequest::Radio { input } => {
            if !input.enabled && !input.confirmed {
                return Err(HostdError::validation(
                    "Wi-Fi radio confirmation is required",
                ));
            }
            Ok(())
        }
        NetworkRequest::UpdateProfile { profile_id, input } => {
            validate_uuid(profile_id)?;
            validate_revision(&input.expected_revision)?;
            if let Some(ssid) = &input.ssid {
                validate_ssid(ssid)?;
            }
            if let Some(security) = &input.security {
                validate_security(security)?;
            }
            if let Some(password) = &input.password {
                validate_credential(input.security.as_deref().unwrap_or("wpa2"), Some(password))?;
            }
            Ok(())
        }
        NetworkRequest::DeleteProfile {
            profile_id,
            confirmed,
        } => {
            validate_uuid(profile_id)?;
            if !confirmed {
                return Err(HostdError::validation("Confirmation is required"));
            }
            Ok(())
        }
        NetworkRequest::UpdateHotspot { input } => {
            validate_device(&input.device)?;
            validate_ssid(&input.ssid)?;
            if !matches!(input.band.as_str(), "auto" | "2.4" | "5") {
                return Err(HostdError::validation("Invalid hotspot band"));
            }
            if input
                .channel
                .is_some_and(|channel| !(1..=233).contains(&channel) || input.band == "auto")
            {
                return Err(HostdError::validation("Invalid hotspot channel"));
            }
            if let Some(password) = &input.password {
                validate_credential("wpa2", Some(password))?;
            }
            if let Some(revision) = &input.expected_revision {
                validate_revision(revision)?;
            }
            Ok(())
        }
        NetworkRequest::EthernetSave { device_id, input } => {
            if device_id.len() != 12
                || !device_id.chars().all(|character| {
                    character.is_ascii_hexdigit() && !character.is_ascii_uppercase()
                })
                || input.expected_revision.len() != 64
                || !input.expected_revision.chars().all(|character| {
                    character.is_ascii_hexdigit() && !character.is_ascii_uppercase()
                })
            {
                return Err(HostdError::validation("Invalid Ethernet update request"));
            }
            Ok(())
        }
        NetworkRequest::EthernetApply { confirmed } => {
            if *confirmed {
                Ok(())
            } else {
                Err(HostdError::validation(
                    "Ethernet apply confirmation is required",
                ))
            }
        }
        NetworkRequest::EthernetConfirm { transaction_id }
        | NetworkRequest::EthernetRollback { transaction_id } => validate_uuid(transaction_id),
    }
}

fn validate_device(value: &str) -> Result<(), HostdError> {
    if valid_device(value) {
        Ok(())
    } else {
        Err(HostdError::validation("Invalid wireless device"))
    }
}

pub(super) fn valid_device(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || ['_', '.', ':', '-'].contains(&character)
        })
}

fn validate_ssid(value: &str) -> Result<(), HostdError> {
    if !value.is_empty() && value.len() <= 32 && !value.contains(['\0', '\r', '\n']) {
        Ok(())
    } else {
        Err(HostdError::validation("SSID must contain 1 to 32 bytes"))
    }
}

fn validate_security(value: &str) -> Result<(), HostdError> {
    if matches!(value, "open" | "wpa2" | "wpa3") {
        Ok(())
    } else {
        Err(HostdError::validation("Unsupported Wi-Fi security"))
    }
}

pub(super) fn validate_credential(
    security: &str,
    password: Option<&str>,
) -> Result<(), HostdError> {
    if security == "open" {
        if password.is_some_and(|password| !password.is_empty()) {
            return Err(HostdError::validation(
                "Open Wi-Fi networks cannot have a password",
            ));
        }
        return Ok(());
    }
    let valid = password.is_some_and(|password| {
        ((8..=63).contains(&password.len())
            && password.bytes().all(|byte| (0x20..=0x7e).contains(&byte)))
            || (password.len() == 64
                && password
                    .chars()
                    .all(|character| character.is_ascii_hexdigit()))
    });
    if valid {
        Ok(())
    } else {
        Err(HostdError::validation(
            "Wi-Fi password must be 8-63 printable characters or 64 hexadecimal characters",
        ))
    }
}

pub(super) fn validate_uuid(value: &str) -> Result<(), HostdError> {
    if is_uuid(value) {
        Ok(())
    } else {
        Err(HostdError::validation("Invalid Wi-Fi profile id"))
    }
}

pub(super) fn is_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}

fn validate_revision(value: &str) -> Result<(), HostdError> {
    if value.len() == 64
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(HostdError::validation("Invalid Wi-Fi profile revision"))
    }
}

fn validate_bssid(value: &str) -> Result<(), HostdError> {
    let valid = value.len() == 17
        && value.split(':').count() == 6
        && value.split(':').all(|part| {
            part.len() == 2 && part.chars().all(|character| character.is_ascii_hexdigit())
        });
    if valid {
        Ok(())
    } else {
        Err(HostdError::validation("Invalid Wi-Fi BSSID"))
    }
}
