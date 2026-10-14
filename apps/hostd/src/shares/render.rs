use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::error::HostdError;

use super::model::{ResolvedShare, ShareSettings};

pub fn render_samba(
    settings: &ShareSettings,
    shares: &[ResolvedShare<'_>],
) -> Result<String, HostdError> {
    let mut lines = header("Samba");
    if !settings.enabled {
        lines.extend(["# Sharing is disabled in ZOS.".to_owned(), String::new()]);
        return Ok(lines.join("\n"));
    }
    for resolved in shares
        .iter()
        .filter(|item| item.share.protocols.smb.enabled)
    {
        let share = resolved.share;
        lines.push(format!("[zos-{}]", safe_token(&share.id)));
        lines.push(format!("  comment = {}", safe_inline(&share.name)?));
        lines.push(format!("  path = {}", resolved.absolute_path.display()));
        if !share.protocols.smb.allow_guest {
            lines.push(format!("  valid users = {}", settings.account.username));
        }
        lines.push(format!(
            "  guest ok = {}",
            yes_no(share.protocols.smb.allow_guest)
        ));
        lines.push(format!(
            "  browseable = {}",
            yes_no(share.protocols.smb.browseable)
        ));
        lines.push(format!(
            "  read only = {}",
            yes_no(share.protocols.smb.read_only)
        ));
        lines.extend([
            "  create mask = 0660".to_owned(),
            "  directory mask = 0770".to_owned(),
            String::new(),
        ]);
    }
    Ok(lines.join("\n"))
}

pub fn render_webdav(
    settings: &ShareSettings,
    shares: &[ResolvedShare<'_>],
    htpasswd: &Path,
) -> Result<String, HostdError> {
    let mut lines = header("Apache WebDAV");
    lines.extend([
        "ServerRoot /etc/apache2".to_owned(),
        "ServerName localhost".to_owned(),
        "PidFile /run/zos/webdav/apache2.pid".to_owned(),
        "User www-data".to_owned(),
        "Group www-data".to_owned(),
        "ErrorLog /run/zos/webdav/error.log".to_owned(),
        "LogLevel warn".to_owned(),
        "IncludeOptional /etc/apache2/mods-enabled/*.load".to_owned(),
        "<IfModule !dav_module>".to_owned(),
        "  LoadModule dav_module /usr/lib/apache2/modules/mod_dav.so".to_owned(),
        "</IfModule>".to_owned(),
        "<IfModule !dav_fs_module>".to_owned(),
        "  LoadModule dav_fs_module /usr/lib/apache2/modules/mod_dav_fs.so".to_owned(),
        "</IfModule>".to_owned(),
        "IncludeOptional /etc/apache2/mods-enabled/*.conf".to_owned(),
        "DavLockDB /run/zos/webdav/DavLock".to_owned(),
        "<Directory />".to_owned(),
        "  Require all denied".to_owned(),
        "</Directory>".to_owned(),
    ]);
    if !settings.enabled {
        lines.push(String::new());
        return Ok(lines.join("\n"));
    }
    let mut by_port = BTreeMap::<u16, Vec<&ResolvedShare<'_>>>::new();
    for resolved in shares
        .iter()
        .filter(|item| item.share.protocols.webdav.enabled)
    {
        by_port
            .entry(resolved.share.protocols.webdav.port)
            .or_default()
            .push(resolved);
    }
    for (port, resolved_shares) in by_port {
        lines.push(format!("Listen {port}"));
        lines.push(format!("<VirtualHost *:{port}>"));
        for resolved in resolved_shares {
            let share = resolved.share;
            let path = apache_text(&resolved.absolute_path.to_string_lossy())?;
            let prefix = apache_text(&share.protocols.webdav.path_prefix)?;
            lines.push(format!("  Alias \"{prefix}\" \"{path}\""));
            lines.push(format!("  <Directory \"{path}\">"));
            lines.extend([
                "    DAV On".to_owned(),
                "    Options Indexes".to_owned(),
                "    AllowOverride None".to_owned(),
            ]);
            if share.protocols.webdav.allow_guest {
                lines.push("    Require all granted".to_owned());
            } else {
                lines.extend([
                    "    AuthType Basic".to_owned(),
                    format!("    AuthName \"{}\"", apache_text(&share.name)?),
                    format!(
                        "    AuthUserFile \"{}\"",
                        apache_text(&htpasswd.to_string_lossy())?
                    ),
                    "    Require valid-user".to_owned(),
                ]);
            }
            lines.push("  </Directory>".to_owned());
            if share.protocols.webdav.read_only {
                lines.extend([
                    format!("  <Location \"{prefix}\">"),
                    "    <LimitExcept GET HEAD OPTIONS PROPFIND>".to_owned(),
                    "      Require all denied".to_owned(),
                    "    </LimitExcept>".to_owned(),
                    "  </Location>".to_owned(),
                ]);
            }
        }
        lines.extend(["</VirtualHost>".to_owned(), String::new()]);
    }
    Ok(lines.join("\n"))
}

pub fn render_ftp(
    settings: &ShareSettings,
    shares: &[ResolvedShare<'_>],
    ftp_pam: &Path,
) -> Result<String, HostdError> {
    let mut lines = header("vsftpd");
    if !settings.enabled {
        lines.extend(["# Sharing is disabled in ZOS.".to_owned(), String::new()]);
        return Ok(lines.join("\n"));
    }
    let Some(resolved) = shares.iter().find(|item| item.share.protocols.ftp.enabled) else {
        lines.extend(["# No FTP shares are enabled.".to_owned(), String::new()]);
        return Ok(lines.join("\n"));
    };
    let ftp = &resolved.share.protocols.ftp;
    let guest_writes = ftp.allow_guest && !ftp.read_only;
    lines.extend([
        "listen=YES".to_owned(),
        "listen_ipv6=NO".to_owned(),
        format!("listen_port={}", ftp.port),
        format!(
            "anonymous_enable={}",
            if ftp.allow_guest { "YES" } else { "NO" }
        ),
        format!("anon_root={}", resolved.absolute_path.display()),
        format!(
            "anon_upload_enable={}",
            if guest_writes { "YES" } else { "NO" }
        ),
        format!(
            "anon_mkdir_write_enable={}",
            if guest_writes { "YES" } else { "NO" }
        ),
        format!(
            "anon_other_write_enable={}",
            if guest_writes { "YES" } else { "NO" }
        ),
        "anon_world_readable_only=NO".to_owned(),
        "local_enable=YES".to_owned(),
        format!("write_enable={}", if ftp.read_only { "NO" } else { "YES" }),
        "chroot_local_user=YES".to_owned(),
        "allow_writeable_chroot=YES".to_owned(),
        format!("local_root={}", resolved.absolute_path.display()),
        format!(
            "pam_service_name={}",
            ftp_pam
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("vsftpd-zos")
        ),
        "pasv_enable=YES".to_owned(),
        format!("pasv_min_port={}", ftp.passive_port_start),
        format!("pasv_max_port={}", ftp.passive_port_end),
        String::new(),
    ]);
    Ok(lines.join("\n"))
}

pub fn render_nfs(
    settings: &ShareSettings,
    shares: &[ResolvedShare<'_>],
) -> Result<String, HostdError> {
    let identity = if settings.enabled
        && shares
            .iter()
            .any(|item| item.share.protocols.nfs.enabled && !item.share.protocols.nfs.read_only)
    {
        let user = nix::unistd::User::from_name("zos-nfs")
            .map_err(|error| HostdError::unavailable(error.to_string()))?
            .ok_or_else(|| HostdError::validation("NFS identity zos-nfs does not exist"))?;
        Some((user.uid.as_raw(), user.gid.as_raw()))
    } else {
        None
    };
    render_nfs_with_identity(settings, shares, identity)
}

pub(super) fn render_nfs_with_identity(
    settings: &ShareSettings,
    shares: &[ResolvedShare<'_>],
    identity: Option<(u32, u32)>,
) -> Result<String, HostdError> {
    let mut lines = header("NFS exports");
    if !settings.enabled {
        lines.extend(["# Sharing is disabled in ZOS.".to_owned(), String::new()]);
        return Ok(lines.join("\n"));
    }
    for resolved in shares
        .iter()
        .filter(|item| item.share.protocols.nfs.enabled)
    {
        let nfs = &resolved.share.protocols.nfs;
        if !nfs.read_only && !nfs.root_squash {
            return Err(HostdError::validation(
                "Writable NFS shares require root squashing",
            ));
        }
        let path = safe_inline(&resolved.absolute_path.to_string_lossy())?.replace(' ', "\\040");
        let identity = if nfs.read_only {
            String::new()
        } else {
            let (uid, gid) = identity
                .ok_or_else(|| HostdError::validation("NFS identity zos-nfs does not exist"))?;
            format!(",all_squash,anonuid={uid},anongid={gid}")
        };
        for cidr in &nfs.allowed_cidrs {
            lines.push(format!(
                "{path} {}({},sync,subtree_check,{}{})",
                safe_inline(cidr)?,
                if nfs.read_only { "ro" } else { "rw" },
                if nfs.root_squash {
                    "root_squash"
                } else {
                    "no_root_squash"
                },
                identity
            ));
        }
    }
    lines.push(String::new());
    Ok(lines.join("\n"))
}

pub fn render_dlna(
    settings: &ShareSettings,
    shares: &[ResolvedShare<'_>],
) -> Result<String, HostdError> {
    let mut lines = header("MiniDLNA");
    if !settings.enabled {
        lines.extend(["# Sharing is disabled in ZOS.".to_owned(), String::new()]);
        return Ok(lines.join("\n"));
    }
    let enabled = shares
        .iter()
        .filter(|item| item.share.protocols.dlna.enabled)
        .collect::<Vec<_>>();
    for resolved in &enabled {
        for media_type in &resolved.share.protocols.dlna.media_types {
            lines.push(format!(
                "media_dir={},{}",
                media_prefix(media_type),
                resolved.absolute_path.display()
            ));
        }
    }
    let mut bindings = BTreeSet::new();
    for resolved in &enabled {
        let dlna = &resolved.share.protocols.dlna;
        if let Some(binding) = dlna.bind_interface.as_ref().or(dlna.bind_address.as_ref())
            && !binding.is_empty()
        {
            bindings.insert(safe_inline(binding)?.to_owned());
        }
    }
    for binding in bindings {
        lines.push(format!("network_interface={binding}"));
    }
    let friendly_name = enabled
        .first()
        .map(|item| item.share.protocols.dlna.friendly_name.as_str())
        .unwrap_or("ZOS DLNA");
    lines.extend([
        format!("friendly_name={}", safe_inline(friendly_name)?),
        "inotify=yes".to_owned(),
        String::new(),
    ]);
    Ok(lines.join("\n"))
}

pub fn render_ftp_pam(htpasswd: &Path) -> String {
    [
        "# Managed by ZOS. Do not edit this file directly.".to_owned(),
        format!(
            "auth required pam_pwdfile.so pwdfile {}",
            htpasswd.display()
        ),
        "account required pam_permit.so".to_owned(),
        String::new(),
    ]
    .join("\n")
}

fn header(name: &str) -> Vec<String> {
    vec![
        "# Managed by ZOS. Do not edit this file directly.".to_owned(),
        format!("# {name} share configuration."),
        String::new(),
    ]
}

fn media_prefix(value: &str) -> &'static str {
    match value {
        "audio" => "A",
        "pictures" => "P",
        _ => "V",
    }
}

fn safe_token(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || ['_', '.', '-'].contains(&character) {
                character
            } else {
                '-'
            }
        })
        .collect()
}

pub(super) fn safe_inline(value: &str) -> Result<&str, HostdError> {
    if value.contains(['\n', '\r', '\0']) {
        return Err(HostdError::validation(
            "Share config values cannot contain line breaks",
        ));
    }
    Ok(value)
}

fn apache_text(value: &str) -> Result<String, HostdError> {
    Ok(safe_inline(value)?.replace('"', "\\\""))
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}
