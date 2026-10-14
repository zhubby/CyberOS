use std::collections::HashSet;
use std::path::PathBuf;

use crate::error::HostdError;

use super::model::{StorageCommand, StorageOperation};

pub(super) fn validate_command(request: &StorageCommand) -> Result<(), HostdError> {
    if request.args.is_empty()
        || request
            .args
            .iter()
            .any(|arg| arg.is_empty() || arg.len() >= 256)
    {
        return Err(HostdError::validation("Invalid storage command arguments"));
    }
    let valid = match request.command.as_str() {
        "mdadm" => {
            request.args == ["--detail", "--scan"]
                || (request.args.len() == 2
                    && request.args[0] == "--detail"
                    && is_mdadm_path(&request.args[1]))
        }
        "smartctl" => {
            request.args == ["--scan-open", "--json"]
                || (request.args.len() == 3
                    && request.args[0] == "--all"
                    && request.args[1] == "--json"
                    && is_device_path(&request.args[2]))
                || (request.args.len() == 5
                    && request.args[0] == "--all"
                    && request.args[1] == "--json"
                    && request.args[2] == "-d"
                    && is_safe_token(&request.args[3])
                    && is_device_path(&request.args[4]))
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(HostdError::validation(
            "Unsupported storage command request",
        ))
    }
}

pub(super) fn validate_operation(operation: &StorageOperation) -> Result<(), HostdError> {
    let (name, devices, mountpoint, risk) = match operation {
        StorageOperation::CreatePool {
            name,
            devices,
            mountpoint,
            risk,
            ..
        }
        | StorageOperation::DeletePool {
            name,
            devices,
            mountpoint,
            risk,
            ..
        } => (name, devices, mountpoint, risk),
    };
    let unique = devices.iter().collect::<HashSet<_>>();
    if !is_pool_name(name)
        || name == "backup"
        || risk != "high"
        || devices.iter().any(|device| !is_device_path(device))
        || unique.len() != devices.len()
        || mountpoint != &PathBuf::from(format!("/zos/data/{name}"))
    {
        return Err(HostdError::validation("Invalid storage operation request"));
    }
    match operation {
        StorageOperation::CreatePool {
            raid_level,
            filesystem,
            devices,
            ..
        } => {
            let minimum = match raid_level.as_str() {
                "0" | "1" => 2,
                "5" => 3,
                "6" | "10" => 4,
                _ => return Err(HostdError::validation("Invalid storage operation request")),
            };
            if !matches!(filesystem.as_str(), "ext4" | "btrfs")
                || devices.len() < minimum
                || (raid_level == "10" && devices.len() % 2 != 0)
            {
                return Err(HostdError::validation(format!(
                    "Invalid disk count for RAID {raid_level}"
                )));
            }
        }
        StorageOperation::DeletePool {
            md_device, devices, ..
        } => {
            if devices.is_empty() || !is_mdadm_path(&md_device.to_string_lossy()) {
                return Err(HostdError::validation("Invalid storage operation request"));
            }
        }
    }
    Ok(())
}

fn is_pool_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.chars().enumerate().all(|(index, character)| {
            (index == 0 && character.is_ascii_lowercase())
                || (index > 0
                    && (character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || character == '_'
                        || character == '-'))
        })
}

fn is_safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '_'
                || character == '-'
        })
}

fn is_device_path(value: &str) -> bool {
    value
        .strip_prefix("/dev/")
        .is_some_and(|name| !name.is_empty() && !name.contains('/') && safe_device_name(name))
}

fn is_mdadm_path(value: &str) -> bool {
    value.strip_prefix("/dev/md").is_some_and(|suffix| {
        (!suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit()))
            || suffix.strip_prefix('/').is_some_and(|name| {
                !name.is_empty() && !name.contains('/') && safe_device_name(name)
            })
    })
}

fn safe_device_name(value: &str) -> bool {
    value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || ['.', '_', '-'].contains(&character))
}
