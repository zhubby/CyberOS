use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use super::{Options, Status, localapi::LocalApi, model::*, revision, settings};
use crate::command::{CommandRunner, run_checked};
use crate::error::HostdError;

const MARKER: &str = "# Managed by CyberOS Tailscale\n";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Transaction {
    pub public: ApplyTransaction,
    identity: String,
    before: Map<String, Value>,
    after: Map<String, Value>,
    forwarding_before: Option<String>,
    forwarding_after: Option<String>,
}

fn identity(native: &Value, prefs: &Value) -> String {
    format!(
        "{}\0{}",
        native["Self"]["ID"].as_str().unwrap_or(""),
        prefs["ControlURL"].as_str().unwrap_or("")
    )
}

pub(super) async fn read(options: &Options) -> Result<Option<Transaction>, HostdError> {
    let path = options.state_dir.join("transaction.json");
    match fs::symlink_metadata(&path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(meta) => {
            if !meta.is_file()
                || meta.file_type().is_symlink()
                || meta.len() > 128 * 1024
                || meta.uid() != nix::unistd::Uid::current().as_raw()
                || meta.permissions().mode() & 0o077 != 0
            {
                return Err(HostdError::operation_failed(
                    "Tailscale recovery state must be a private, owned regular file",
                ));
            }
            let transaction: Transaction = serde_json::from_slice(&fs::read(path).await?)
                .map_err(|_| HostdError::operation_failed("Tailscale recovery state is invalid"))?;
            if Uuid::parse_str(&transaction.public.id).is_err()
                || OffsetDateTime::parse(&transaction.public.deadline_at, &Rfc3339).is_err()
                || transaction
                    .before
                    .keys()
                    .chain(transaction.after.keys())
                    .any(|k| {
                        !matches!(
                            k.as_str(),
                            "Hostname"
                                | "CorpDNS"
                                | "RouteAll"
                                | "ExitNodeID"
                                | "ExitNodeIP"
                                | "ExitNodeAllowLANAccess"
                                | "AdvertiseRoutes"
                        )
                    })
            {
                return Err(HostdError::operation_failed(
                    "Tailscale recovery state is invalid",
                ));
            }
            Ok(Some(transaction))
        }
    }
}

pub(super) async fn atomic_write(path: &Path, content: &[u8], mode: u32) -> Result<(), HostdError> {
    let parent = path
        .parent()
        .ok_or_else(|| HostdError::validation("Invalid Tailscale state path"))?;
    if let Ok(meta) = fs::symlink_metadata(path).await
        && (!meta.is_file() || meta.file_type().is_symlink())
    {
        return Err(HostdError::conflict(
            "Tailscale managed path must be a regular file",
        ));
    }
    let temporary = parent.join(format!(".tailscale-{}", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(mode)
        .open(&temporary)
        .await?;
    let result = async {
        file.write_all(content).await?;
        file.sync_all().await?;
        fs::rename(&temporary, path).await?;
        fs::File::open(parent).await?.sync_all().await?;
        Ok::<_, std::io::Error>(())
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temporary).await;
    }
    result.map_err(Into::into)
}

async fn write(options: &Options, transaction: &Transaction) -> Result<(), HostdError> {
    match fs::symlink_metadata(&options.state_dir).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&options.state_dir).await?;
        }
        Err(error) => return Err(error.into()),
        Ok(meta)
            if !meta.is_dir()
                || meta.file_type().is_symlink()
                || meta.uid() != nix::unistd::Uid::current().as_raw() =>
        {
            return Err(HostdError::conflict(
                "Tailscale recovery directory must be owned by hostd",
            ));
        }
        _ => {}
    }
    fs::set_permissions(&options.state_dir, std::fs::Permissions::from_mode(0o700)).await?;
    atomic_write(
        &options.state_dir.join("transaction.json"),
        &serde_json::to_vec(transaction)
            .map_err(|_| HostdError::operation_failed("Could not save Tailscale recovery state"))?,
        0o600,
    )
    .await
}

async fn forwarding_file(options: &Options) -> Result<Option<String>, HostdError> {
    match fs::symlink_metadata(&options.forwarding_config).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(meta) => {
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 32 * 1024 {
                return Err(HostdError::conflict(
                    "Tailscale forwarding configuration must be a regular file",
                ));
            }
            let content = fs::read_to_string(&options.forwarding_config).await?;
            if !content.starts_with(MARKER) {
                return Err(HostdError::conflict(
                    "Tailscale forwarding configuration is administrator managed",
                ));
            }
            Ok(Some(content))
        }
    }
}

async fn set_forwarding_file(
    options: &Options,
    content: &Option<String>,
) -> Result<(), HostdError> {
    if let Some(content) = content {
        atomic_write(&options.forwarding_config, content.as_bytes(), 0o644).await
    } else {
        match fs::remove_file(&options.forwarding_config).await {
            Ok(()) => {
                fs::File::open(options.forwarding_config.parent().unwrap())
                    .await?
                    .sync_all()
                    .await?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

fn forwarding_content(prefs: &Value, updates: &Map<String, Value>) -> Option<String> {
    let routes = updates
        .get("AdvertiseRoutes")
        .unwrap_or(&prefs["AdvertiseRoutes"]);
    let routes = routes.as_array()?;
    if routes.is_empty() {
        return None;
    }
    let ipv4 = routes
        .iter()
        .filter_map(Value::as_str)
        .any(|r| r.contains('.'));
    let ipv6 = routes
        .iter()
        .filter_map(Value::as_str)
        .any(|r| r.contains(':'));
    let mut content = MARKER.to_owned();
    if ipv4 {
        content.push_str("net.ipv4.ip_forward = 1\n");
    }
    if ipv6 {
        content.push_str("net.ipv6.conf.all.forwarding = 1\n");
    }
    Some(content)
}

async fn apply_forwarding(runner: &dyn CommandRunner) -> Result<(), HostdError> {
    run_checked(
        runner,
        "systemctl",
        &["restart", "cyberos-tailscale-forwarding.service"],
        None,
    )
    .await
    .map(|_| ())
    .map_err(|_| {
        HostdError::operation_failed("Tailscale forwarding configuration could not be applied")
    })
}

pub(super) async fn apply(
    patch: SettingsPatch,
    current: &Status,
    api: &dyn LocalApi,
    runner: &dyn CommandRunner,
    options: &Options,
) -> Result<(), HostdError> {
    let (native, prefs) = tokio::try_join!(
        api.request("GET", "status", None),
        api.request("GET", "prefs", None)
    )?;
    if revision(&native, &prefs, &current.service) != current.revision {
        return Err(HostdError::conflict(
            "Tailscale configuration changed; refresh before retrying",
        ));
    }
    let updates = settings::changes(patch, current, &prefs)?;
    if updates.is_empty() {
        return Ok(());
    }
    let forwarding_before = forwarding_file(options).await?;
    let forwarding_after = if updates.contains_key("AdvertiseRoutes") {
        forwarding_content(&prefs, &updates)
    } else {
        forwarding_before.clone()
    };
    let transaction = Transaction {
        public: ApplyTransaction {
            id: Uuid::new_v4().to_string(),
            deadline_at: (OffsetDateTime::now_utc() + time::Duration::seconds(60))
                .format(&Rfc3339)
                .unwrap_or_default(),
            state: TransactionState::Pending,
            error: None,
        },
        identity: identity(&native, &prefs),
        before: updates
            .keys()
            .map(|key| (key.clone(), prefs[key].clone()))
            .collect(),
        after: updates,
        forwarding_before,
        forwarding_after,
    };
    // Durable intent precedes both forwarding and preference changes.
    write(options, &transaction).await?;
    let result = async {
        if transaction.forwarding_before != transaction.forwarding_after {
            set_forwarding_file(options, &transaction.forwarding_after).await?;
            if transaction.forwarding_after.is_some() {
                apply_forwarding(runner).await?;
            }
        }
        api.request("PATCH", "prefs", Some(settings::masked(&transaction.after)))
            .await?;
        Ok::<_, HostdError>(())
    }
    .await;
    if let Err(error) = result {
        if restore(transaction, api, runner, options).await.is_err() {
            return Err(HostdError::operation_failed(
                "Tailscale apply failed and rollback is pending; manual recovery may be required",
            ));
        }
        return Err(error);
    }
    Ok(())
}

pub(super) async fn recover_expired(
    api: &dyn LocalApi,
    runner: &dyn CommandRunner,
    options: &Options,
    now: OffsetDateTime,
) -> Result<(), HostdError> {
    let Some(transaction) = read(options).await? else {
        return Ok(());
    };
    if transaction.public.state == TransactionState::Pending
        && OffsetDateTime::parse(&transaction.public.deadline_at, &Rfc3339)
            .is_ok_and(|deadline| deadline <= now)
    {
        restore(transaction, api, runner, options).await?;
    }
    Ok(())
}

pub(super) async fn finish(
    id: &str,
    confirm: bool,
    api: &dyn LocalApi,
    runner: &dyn CommandRunner,
    options: &Options,
) -> Result<(), HostdError> {
    let Some(mut transaction) = read(options).await? else {
        return Err(HostdError::not_found("Tailscale transaction was not found"));
    };
    if transaction.public.id != id || Uuid::parse_str(id).is_err() {
        return Err(HostdError::not_found("Tailscale transaction was not found"));
    }
    if transaction.public.state != TransactionState::Pending {
        return Err(HostdError::conflict(
            "Tailscale transaction is no longer pending",
        ));
    }
    if !confirm {
        return restore(transaction, api, runner, options).await;
    }
    if OffsetDateTime::parse(&transaction.public.deadline_at, &Rfc3339)
        .is_ok_and(|deadline| deadline <= OffsetDateTime::now_utc())
    {
        restore(transaction, api, runner, options).await?;
        return Err(HostdError::conflict(
            "Tailscale confirmation deadline expired; changes were rolled back",
        ));
    }
    let (native, prefs) = tokio::try_join!(
        api.request("GET", "status", None),
        api.request("GET", "prefs", None)
    )?;
    if transaction.identity != identity(&native, &prefs)
        || transaction
            .after
            .iter()
            .any(|(key, value)| prefs.get(key).unwrap_or(&Value::Null) != value)
        || forwarding_file(options).await? != transaction.forwarding_after
    {
        restore(transaction, api, runner, options).await?;
        return Err(HostdError::conflict(
            "Tailscale configuration changed before confirmation",
        ));
    }
    transaction.public.state = TransactionState::Confirmed;
    write(options, &transaction).await
}

async fn restore(
    mut transaction: Transaction,
    api: &dyn LocalApi,
    runner: &dyn CommandRunner,
    options: &Options,
) -> Result<(), HostdError> {
    let (native, prefs) = tokio::try_join!(
        api.request("GET", "status", None),
        api.request("GET", "prefs", None)
    )?;
    if transaction.identity != identity(&native, &prefs) {
        transaction.public.state = TransactionState::Conflict;
        transaction.public.error = Some(
            "Tailscale identity changed; previous account configuration was not restored".into(),
        );
        write(options, &transaction).await?;
        return Err(HostdError::conflict(
            "Tailscale identity changed during rollback",
        ));
    }
    let mut restore = Map::new();
    let mut conflict = false;
    let mut routes_changed_externally = false;
    for (key, after) in &transaction.after {
        let before = &transaction.before[key];
        let latest = prefs.get(key).unwrap_or(&Value::Null);
        if latest == after {
            restore.insert(key.clone(), before.clone());
        } else if latest != before {
            conflict = true;
            routes_changed_externally |= key == "AdvertiseRoutes";
        }
    }
    if !restore.is_empty() {
        api.request("PATCH", "prefs", Some(settings::masked(&restore)))
            .await?;
    }
    let forwarding = forwarding_file(options).await?;
    if forwarding == transaction.forwarding_after && !routes_changed_externally {
        set_forwarding_file(options, &transaction.forwarding_before).await?;
        if transaction.forwarding_before.is_some() {
            // A system reboot during a pending gateway withdrawal may have reset
            // the runtime sysctls. Restoring the file alone would leave routes unusable.
            apply_forwarding(runner).await?;
        }
    } else if forwarding != transaction.forwarding_before {
        conflict = true;
    }
    // Forwarding is shared with Docker/VMs. Revoke advertisements, but never force global sysctls off.
    transaction.public.state = if conflict {
        TransactionState::Conflict
    } else {
        TransactionState::RolledBack
    };
    transaction.public.error = conflict.then(|| "Some settings changed outside CyberOS and were preserved; review the current configuration".into());
    write(options, &transaction).await?;
    if conflict {
        return Err(HostdError::conflict(
            "External Tailscale changes were preserved during rollback",
        ));
    }
    Ok(())
}
