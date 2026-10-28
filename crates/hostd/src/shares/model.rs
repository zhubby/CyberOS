use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub(super) const DEFAULT_MANAGED_ROOTS: &[&str] = &[
    "/cyberos/config",
    "/etc/samba/smb.conf.d",
    "/etc/apache2/sites-available",
    "/etc/vsftpd.d",
    "/etc/exports.d",
    "/etc/minidlna.d",
    "/etc/pam.d",
];

pub(super) const ALL_SERVICES: &[&str] = &[
    "smbd.service",
    "nmbd.service",
    "cyberos-webdav.service",
    "vsftpd.service",
    "nfs-server.service",
    "minidlna.service",
];

#[derive(Debug, Clone)]
pub struct SharePaths {
    pub samba_config: PathBuf,
    pub webdav_site: PathBuf,
    pub ftp_config: PathBuf,
    pub nfs_exports: PathBuf,
    pub dlna_config: PathBuf,
    pub htpasswd: PathBuf,
    pub ftp_pam: PathBuf,
}

impl Default for SharePaths {
    fn default() -> Self {
        Self {
            samba_config: "/etc/samba/smb.conf.d/cyberos-shares.conf".into(),
            webdav_site: "/etc/apache2/sites-available/cyberos-webdav.conf".into(),
            ftp_config: "/etc/vsftpd.d/cyberos-shares.conf".into(),
            nfs_exports: "/etc/exports.d/cyberos.exports".into(),
            dlna_config: "/etc/minidlna.d/cyberos.conf".into(),
            htpasswd: "/cyberos/config/shares.htpasswd".into(),
            ftp_pam: "/etc/pam.d/vsftpd-cyberos".into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ShareOptions {
    pub paths: SharePaths,
    pub credential_group: String,
    pub managed_roots: Vec<PathBuf>,
    pub acl_script: PathBuf,
    pub acl_state: PathBuf,
}

impl Default for ShareOptions {
    fn default() -> Self {
        Self {
            paths: SharePaths::default(),
            credential_group: "www-data".to_owned(),
            managed_roots: DEFAULT_MANAGED_ROOTS.iter().map(PathBuf::from).collect(),
            acl_script: "/usr/lib/cyberos/scripts/cyberos-share-acl.mjs".into(),
            acl_state: "/cyberos/config/share-acl.json".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdShareApplyRequest"))]
#[serde(rename_all = "camelCase")]
pub struct ShareApplyRequest {
    pub settings: ShareSettings,
    pub data_root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdShareSettings"))]
#[serde(rename_all = "camelCase")]
pub struct ShareSettings {
    pub enabled: bool,
    pub account: ShareAccount,
    pub shares: Vec<ShareDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdShareAccount"))]
#[serde(rename_all = "camelCase")]
pub struct ShareAccount {
    pub username: String,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdShareDefinition"))]
#[serde(rename_all = "camelCase")]
pub struct ShareDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub storage_pool_id: String,
    pub path: PathBuf,
    pub protocols: ShareProtocols,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdShareProtocols"))]
pub struct ShareProtocols {
    pub smb: SmbConfig,
    pub webdav: WebDavConfig,
    pub ftp: FtpConfig,
    pub nfs: NfsConfig,
    pub dlna: DlnaConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdSmbConfig"))]
#[serde(rename_all = "camelCase")]
pub struct SmbConfig {
    pub enabled: bool,
    pub read_only: bool,
    pub browseable: bool,
    pub allow_guest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdWebDavConfig"))]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub enabled: bool,
    pub read_only: bool,
    pub allow_guest: bool,
    pub port: u16,
    pub path_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdFtpConfig"))]
#[serde(rename_all = "camelCase")]
pub struct FtpConfig {
    pub enabled: bool,
    pub read_only: bool,
    pub allow_guest: bool,
    pub port: u16,
    pub passive_port_start: u16,
    pub passive_port_end: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdNfsConfig"))]
#[serde(rename_all = "camelCase")]
pub struct NfsConfig {
    pub enabled: bool,
    pub read_only: bool,
    pub allowed_cidrs: Vec<String>,
    pub root_squash: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdDlnaConfig"))]
#[serde(rename_all = "camelCase")]
pub struct DlnaConfig {
    pub enabled: bool,
    pub media_types: Vec<String>,
    pub bind_interface: Option<String>,
    pub bind_address: Option<String>,
    pub friendly_name: String,
}

#[derive(Debug)]
pub struct ResolvedShare<'a> {
    pub share: &'a ShareDefinition,
    pub absolute_path: PathBuf,
    pub root_path: PathBuf,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "hostd.ts", rename = "HostdShareApplyResult"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareApplyResult {
    pub(super) applied_at: String,
    pub(super) files: Vec<String>,
    pub(super) services: Vec<String>,
}
