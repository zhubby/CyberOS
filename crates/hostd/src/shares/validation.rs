use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};

use tokio::fs;

use crate::error::HostdError;

use super::model::{ResolvedShare, ShareApplyRequest, ShareSettings};
use super::render::safe_inline;

pub(super) async fn resolve_shares<'a>(
    settings: &'a ShareSettings,
    data_root: &Path,
) -> Result<Vec<ResolvedShare<'a>>, HostdError> {
    let mut resolved = Vec::with_capacity(settings.shares.len());
    for share in &settings.shares {
        validate_storage_pool_id(&share.storage_pool_id)?;
        let root_path = normalize_path(&data_root.join(&share.storage_pool_id));
        let candidate_path = normalize_path(&root_path.join(&share.path));
        if !path_inside(&root_path, &candidate_path) {
            return Err(HostdError::validation(format!(
                "Share {} escapes storage pool {}",
                share.id, share.storage_pool_id
            )));
        }
        let real_root = fs::canonicalize(&root_path).await.map_err(|_| {
            HostdError::validation(format!(
                "Storage pool {} is unavailable",
                share.storage_pool_id
            ))
        })?;
        if real_root != root_path {
            return Err(HostdError::validation(format!(
                "Storage pool {} contains a symlink or non-canonical component",
                share.storage_pool_id
            )));
        }
        let absolute_path = fs::canonicalize(&candidate_path).await.map_err(|_| {
            HostdError::validation(format!("Share {} path is unavailable", share.id))
        })?;
        if !path_inside(&real_root, &absolute_path) {
            return Err(HostdError::validation(format!(
                "Share {} resolves outside storage pool {}",
                share.id, share.storage_pool_id
            )));
        }
        let config_path = absolute_path.to_str().ok_or_else(|| {
            HostdError::validation(format!("Share {} path is not valid UTF-8", share.id))
        })?;
        safe_inline(config_path)?;
        resolved.push(ResolvedShare {
            share,
            absolute_path,
            root_path: real_root,
        });
    }
    Ok(resolved)
}

pub(super) fn validate_requested_data_root(
    requested_data_root: &Path,
    configured_data_root: &Path,
) -> Result<(), HostdError> {
    if normalize_path(requested_data_root) != normalize_path(configured_data_root) {
        return Err(HostdError::validation(
            "Requested data root does not match hostd configuration",
        ));
    }
    Ok(())
}

fn validate_storage_pool_id(value: &str) -> Result<(), HostdError> {
    let mut components = Path::new(value).components();
    if value.is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(HostdError::validation("Storage pool id is invalid"));
    }
    Ok(())
}

pub(super) fn validate_request(request: &ShareApplyRequest) -> Result<(), HostdError> {
    let username = &request.settings.account.username;
    let valid_username = !username.is_empty()
        && username.len() <= 32
        && username.chars().enumerate().all(|(index, character)| {
            if index == 0 {
                character == '_' || character.is_ascii_lowercase()
            } else {
                character == '_'
                    || character == '-'
                    || character.is_ascii_lowercase()
                    || character.is_ascii_digit()
            }
        });
    if !valid_username {
        return Err(HostdError::validation("Share account username is invalid"));
    }
    for share in &request.settings.shares {
        safe_inline(&share.id)?;
        safe_inline(&share.name)?;
        safe_inline(&share.description)?;
        if share.protocols.nfs.enabled && share.protocols.nfs.allowed_cidrs.is_empty() {
            return Err(HostdError::validation(
                "Enabled NFS shares require at least one allowed CIDR",
            ));
        }
        if share.protocols.nfs.enabled
            && !share.protocols.nfs.read_only
            && !share.protocols.nfs.root_squash
        {
            return Err(HostdError::validation(
                "Writable NFS shares require root squashing",
            ));
        }
        for cidr in &share.protocols.nfs.allowed_cidrs {
            validate_cidr(cidr)?;
        }
    }
    Ok(())
}

fn validate_cidr(value: &str) -> Result<(), HostdError> {
    let Some((address, prefix)) = value.split_once('/') else {
        return Err(HostdError::validation("Invalid NFS allowed CIDR"));
    };
    let address = address
        .parse::<IpAddr>()
        .map_err(|_| HostdError::validation("Invalid NFS allowed CIDR"))?;
    let prefix = prefix
        .parse::<u8>()
        .map_err(|_| HostdError::validation("Invalid NFS allowed CIDR"))?;
    let maximum = if address.is_ipv4() { 32 } else { 128 };
    if prefix == 0 || prefix > maximum {
        return Err(HostdError::validation("Invalid NFS allowed CIDR"));
    }
    Ok(())
}

pub(super) fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    normalized
}

pub(super) fn path_inside(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}
