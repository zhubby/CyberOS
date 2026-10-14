use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct StorageOptions {
    pub fstab_path: PathBuf,
    pub mount_root: PathBuf,
    pub md_device_root: PathBuf,
    pub mdadm_runtime_path: PathBuf,
    pub sys_block_path: PathBuf,
}

impl Default for StorageOptions {
    fn default() -> Self {
        Self {
            fstab_path: "/etc/fstab".into(),
            mount_root: "/zos/data".into(),
            md_device_root: "/dev/md".into(),
            mdadm_runtime_path: "/run/mdadm".into(),
            sys_block_path: "/sys/block".into(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdStorageCommand"))]
pub(crate) struct StorageCommand {
    pub(super) command: String,
    pub(super) args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdStorageOperation"))]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum StorageOperation {
    CreatePool {
        name: String,
        #[serde(rename = "raidLevel")]
        raid_level: String,
        devices: Vec<String>,
        filesystem: String,
        mountpoint: PathBuf,
        risk: String,
    },
    DeletePool {
        name: String,
        #[serde(rename = "mdDevice")]
        md_device: PathBuf,
        devices: Vec<String>,
        mountpoint: PathBuf,
        risk: String,
    },
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "hostd.ts", rename = "HostdStorageOperationResult")
)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum StorageResult {
    CreatePool {
        name: String,
        #[serde(rename = "raidLevel")]
        raid_level: String,
        devices: Vec<String>,
        filesystem: String,
        mountpoint: PathBuf,
        #[serde(rename = "mdDevice")]
        md_device: PathBuf,
        uuid: String,
    },
    DeletePool {
        name: String,
        mountpoint: PathBuf,
        #[serde(rename = "mdDevice")]
        md_device: PathBuf,
        devices: Vec<String>,
    },
}
