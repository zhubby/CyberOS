use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};

use tokio::fs;

use crate::config::ConfiguredNasRoot;
use crate::error::HostdError;

use super::model::{NasRoot, ResolvedShare, ShareApplyRequest, ShareSettings};
use super::render::safe_inline;

pub(super) async fn resolve_shares<'a>(
    settings: &'a ShareSettings,
    roots: &[ConfiguredNasRoot],
) -> Result<Vec<ResolvedShare<'a>>, HostdError> {
    let roots = roots
        .iter()
        .map(|root| (&root.id, root))
        .collect::<HashMap<_, _>>();
    let mut resolved = Vec::with_capacity(settings.shares.len());
    for share in &settings.shares {
        let root = roots.get(&share.root_id).ok_or_else(|| {
            HostdError::validation(format!("NAS root {} is not configured", share.root_id))
        })?;
        let root_path = normalize_path(&root.path);
        let candidate_path = normalize_path(&root_path.join(&share.path));
        if !path_inside(&root_path, &candidate_path) {
            return Err(HostdError::validation(format!(
                "Share {} escapes NAS root {}",
                share.id, root.id
            )));
        }
        let real_root = fs::canonicalize(&root_path)
            .await
            .map_err(|_| HostdError::validation(format!("NAS root {} is unavailable", root.id)))?;
        let absolute_path = fs::canonicalize(&candidate_path).await.map_err(|_| {
            HostdError::validation(format!("Share {} path is unavailable", share.id))
        })?;
        if !path_inside(&real_root, &absolute_path) {
            return Err(HostdError::validation(format!(
                "Share {} resolves outside NAS root {}",
                share.id, root.id
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

pub(super) fn validate_requested_roots(
    requested_roots: &[NasRoot],
    configured_roots: &[ConfiguredNasRoot],
) -> Result<(), HostdError> {
    let configured = configured_roots
        .iter()
        .map(|root| (root.id.as_str(), normalize_path(&root.path)))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    for root in requested_roots {
        let Some(configured_path) = configured.get(root.id.as_str()) else {
            return Err(HostdError::validation(format!(
                "NAS root {} is not configured by hostd",
                root.id
            )));
        };
        if !seen.insert(root.id.as_str()) || normalize_path(&root.path) != *configured_path {
            return Err(HostdError::validation(format!(
                "NAS root {} does not match hostd configuration",
                root.id
            )));
        }
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
