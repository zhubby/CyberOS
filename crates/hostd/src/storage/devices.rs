use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use serde_json::Value;
use tokio::fs;

use crate::command::{CommandRunner, run_checked};
use crate::error::HostdError;

use super::run_checked_owned;

pub(super) async fn assert_devices_available(
    devices: &[String],
    runner: &dyn CommandRunner,
    sys_block: &Path,
) -> Result<Vec<String>, HostdError> {
    let mut args = vec![
        "--json".to_owned(),
        "--bytes".to_owned(),
        "--tree".to_owned(),
        "--output".to_owned(),
        "PATH,TYPE,FSTYPE,MOUNTPOINTS,PKNAME".to_owned(),
    ];
    args.extend(devices.to_owned());
    let output = run_checked_owned(runner, "lsblk", &args).await?;
    let parsed: Value = serde_json::from_str(&output)
        .map_err(|_| HostdError::operation_failed("Unable to validate block devices"))?;
    let rows = parsed
        .get("blockdevices")
        .and_then(Value::as_array)
        .ok_or_else(|| HostdError::operation_failed("Unable to validate block devices"))?;
    let by_path = rows
        .iter()
        .filter_map(|row| Some((row.get("path")?.as_str()?.to_owned(), row)))
        .collect::<HashMap<_, _>>();
    let mut stale = Vec::new();
    for device in devices {
        let row = by_path.get(device).ok_or_else(|| {
            HostdError::validation(format!(
                "Block device is not an available whole disk: {device}"
            ))
        })?;
        if row.get("type").and_then(Value::as_str) != Some("disk") {
            return Err(HostdError::validation(format!(
                "Block device is not an available whole disk: {device}"
            )));
        }
        let filesystem = row.get("fstype").and_then(Value::as_str);
        assert_node_unused(row, device, filesystem == Some("linux_raid_member"))?;
        if filesystem == Some("linux_raid_member") {
            let holders = sys_block
                .join(Path::new(device).file_name().unwrap_or_default())
                .join("holders");
            match fs::read_dir(&holders).await {
                Ok(mut entries) => {
                    if entries.next_entry().await?.is_some() {
                        return Err(HostdError::validation(format!(
                            "Block device belongs to an active RAID array and cannot be reused: {device}"
                        )));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            stale.push(device.clone());
        }
        if let Some(children) = row.get("children").and_then(Value::as_array) {
            for child in children {
                assert_node_unused(child, device, false)?;
            }
        }
    }
    Ok(stale)
}

pub(super) async fn assert_array_members(
    md_device: &Path,
    devices: &[String],
    runner: &dyn CommandRunner,
) -> Result<(), HostdError> {
    let output = run_checked(
        runner,
        "mdadm",
        &["--detail", "--export", &md_device.to_string_lossy()],
        None,
    )
    .await?;
    let actual = output
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(key, _)| key.starts_with("MD_DEVICE_") && key.ends_with("_DEV"))
        .map(|(_, device)| device.trim().to_owned())
        .collect::<BTreeSet<_>>();
    let expected = devices.iter().cloned().collect::<BTreeSet<_>>();
    if actual.is_empty() || actual != expected {
        return Err(HostdError::conflict(
            "RAID members changed; refresh storage inventory before deleting the pool",
        ));
    }
    Ok(())
}

fn assert_node_unused(row: &Value, device: &str, allow_stale_raid: bool) -> Result<(), HostdError> {
    let filesystem = row.get("fstype").and_then(Value::as_str);
    let has_mount = row
        .get("mountpoints")
        .and_then(Value::as_array)
        .is_some_and(|mounts| {
            mounts
                .iter()
                .any(|mount| mount.as_str().is_some_and(|value| !value.is_empty()))
        });
    if (filesystem.is_some() && !(allow_stale_raid && filesystem == Some("linux_raid_member")))
        || has_mount
    {
        return Err(HostdError::validation(format!(
            "Block device contains a filesystem or mount and cannot be used: {device}"
        )));
    }
    Ok(())
}

pub async fn cleanup_orphan_md_devices(
    runner: &dyn CommandRunner,
    sys_block: &Path,
) -> Result<bool, HostdError> {
    let mut entries = match fs::read_dir(sys_block).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.strip_prefix("md").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
        }) {
            names.push(name);
        }
    }
    names.sort();
    let mut cleaned = false;
    for name in names {
        let device_root = sys_block.join(&name);
        let state = match fs::read_to_string(device_root.join("md/array_state")).await {
            Ok(state) => state.trim().to_ascii_lowercase(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if state != "clear" {
            continue;
        }
        let mut holders = match fs::read_dir(device_root.join("holders")).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                run_checked(runner, "mdadm", &["--stop", &format!("/dev/{name}")], None).await?;
                cleaned = true;
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        if holders.next_entry().await?.is_none() {
            run_checked(runner, "mdadm", &["--stop", &format!("/dev/{name}")], None).await?;
            cleaned = true;
        }
    }
    Ok(cleaned)
}

pub(super) async fn assert_mountpoint_available(
    mountpoint: &Path,
    mount_root: &Path,
) -> Result<bool, HostdError> {
    if mountpoint.parent() != Some(mount_root) {
        return Err(HostdError::validation(
            "Storage pool mountpoint is outside /zos/data",
        ));
    }
    match fs::read_dir(mountpoint).await {
        Ok(mut entries) => {
            if entries.next_entry().await?.is_some() {
                return Err(HostdError::validation(format!(
                    "Storage pool mountpoint is not empty: {}",
                    mountpoint.display()
                )));
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn assert_path_missing(path: &Path) -> Result<(), HostdError> {
    match fs::symlink_metadata(path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) | Err(_) => Err(HostdError::validation(format!(
            "Target device already exists: {}",
            path.display()
        ))),
    }
}
