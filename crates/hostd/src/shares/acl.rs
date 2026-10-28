use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::command::{CommandRunner, DEFAULT_OUTPUT_LIMIT};
use crate::error::HostdError;

use super::model::{ResolvedShare, ShareOptions, ShareSettings};

const ACL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Serialize)]
pub(super) struct Grant {
    path: PathBuf,
    pub(super) principal: String,
    pub(super) access: &'static str,
    scope: &'static str,
}

fn insert(
    grants: &mut BTreeMap<(PathBuf, String), Grant>,
    path: &Path,
    principal: &str,
    access: &'static str,
    scope: &'static str,
) {
    let key = (path.to_path_buf(), principal.to_owned());
    let rank = |value| match value {
        "write" => 3,
        "read" => 2,
        _ => 1,
    };
    let existing = grants.get(&key);
    if existing.is_none_or(|entry| {
        rank(access) > rank(entry.access) || (scope == "tree" && entry.scope == "parent")
    }) {
        grants.insert(
            key,
            Grant {
                path: path.to_path_buf(),
                principal: principal.to_owned(),
                access,
                scope,
            },
        );
    }
}

pub(super) fn grants_for(
    settings: &ShareSettings,
    shares: &[ResolvedShare<'_>],
) -> Result<Vec<Grant>, HostdError> {
    let mut grants = BTreeMap::new();
    if !settings.enabled {
        return Ok(Vec::new());
    }
    for resolved in shares {
        let protocols = &resolved.share.protocols;
        let mut identities = Vec::new();
        if protocols.smb.enabled {
            let access = if protocols.smb.read_only {
                "read"
            } else {
                "write"
            };
            identities.push((settings.account.username.as_str(), access));
            if protocols.smb.allow_guest {
                identities.push(("nobody", access));
            }
        }
        if protocols.ftp.enabled {
            identities.push((
                settings.account.username.as_str(),
                if protocols.ftp.read_only {
                    "read"
                } else {
                    "write"
                },
            ));
            if protocols.ftp.allow_guest {
                identities.push((
                    "ftp",
                    if protocols.ftp.read_only {
                        "read"
                    } else {
                        "write"
                    },
                ));
            }
        }
        if protocols.webdav.enabled {
            identities.push((
                "www-data",
                if protocols.webdav.read_only {
                    "read"
                } else {
                    "write"
                },
            ));
        }
        if protocols.dlna.enabled {
            identities.push(("minidlna", "read"));
        }
        if protocols.nfs.enabled {
            identities.push((
                "cyberos-nfs",
                if protocols.nfs.read_only {
                    "read"
                } else {
                    "write"
                },
            ));
        }
        for (principal, access) in identities {
            insert(
                &mut grants,
                &resolved.absolute_path,
                principal,
                access,
                "tree",
            );
            let mut parent = resolved.absolute_path.parent();
            while let Some(path) = parent {
                if !path.starts_with(&resolved.root_path) {
                    break;
                }
                insert(&mut grants, path, principal, "traverse", "parent");
                parent = path.parent();
            }
        }
    }
    Ok(grants.into_values().collect())
}

pub(super) async fn command(
    runner: &dyn CommandRunner,
    options: &ShareOptions,
    action: &str,
    input: Option<&[u8]>,
    transaction: Option<&str>,
) -> Result<String, HostdError> {
    let mut args = vec![
        options.acl_script.to_string_lossy().into_owned(),
        action.to_owned(),
        options.acl_state.to_string_lossy().into_owned(),
    ];
    if let Some(transaction) = transaction {
        args.push(transaction.to_owned());
    }
    let output = runner
        .run("node", &args, input, ACL_TIMEOUT, DEFAULT_OUTPUT_LIMIT)
        .await?;
    if !output.success {
        return Err(HostdError::operation_failed(format!(
            "Share ACL {action} failed: {}",
            output.stderr.trim()
        )));
    }
    Ok(output.stdout.trim().to_owned())
}

pub(super) async fn prepare(
    runner: &dyn CommandRunner,
    options: &ShareOptions,
    settings: &ShareSettings,
    shares: &[ResolvedShare<'_>],
) -> Result<String, HostdError> {
    let payload = serde_json::json!({ "grants": grants_for(settings, shares)? });
    let input = serde_json::to_vec(&payload)
        .map_err(|error| HostdError::operation_failed(error.to_string()))?;
    command(runner, options, "prepare", Some(&input), None).await
}
