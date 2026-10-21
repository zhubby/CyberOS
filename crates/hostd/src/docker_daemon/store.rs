use std::future::Future;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::Path;

use nix::unistd::{Gid, Uid, chown};
use sha2::{Digest, Sha256};
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::command::{CommandRunner, run_checked};
use crate::error::HostdError;

use super::model::{
    CONFIG_PATH, DockerConfigFile, DockerOptions, DockerSnapshot, DockerTransaction, RollbackStatus,
};

pub(super) async fn read_snapshot(options: &DockerOptions) -> Result<DockerSnapshot, HostdError> {
    let current = read_config_file(&options.config_path).await?;
    Ok(DockerSnapshot {
        path: CONFIG_PATH,
        content: current.content,
        revision: current.revision,
        exists: current.exists,
        restart_pending: read_transaction(&options.state_dir).await?.is_some(),
    })
}

pub(super) async fn read_config_file(path: &Path) -> Result<DockerConfigFile, HostdError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || metadata.file_type().is_socket()
                || !metadata.is_file()
            {
                return Err(HostdError::validation(
                    "Docker daemon configuration must be a regular file",
                ));
            }
            let content = fs::read_to_string(path).await?;
            Ok(DockerConfigFile {
                revision: revision(true, &content),
                content,
                exists: true,
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DockerConfigFile {
            content: "{\n}\n".to_owned(),
            revision: revision(false, ""),
            exists: false,
        }),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn revision(exists: bool, content: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(if exists {
        &b"file\0"[..]
    } else {
        &b"missing\0"[..]
    });
    hash.update(content.as_bytes());
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn ensure_revision(
    file: &DockerConfigFile,
    expected: &str,
    action: &str,
) -> Result<(), HostdError> {
    if file.revision == expected {
        Ok(())
    } else {
        Err(conflict(action))
    }
}

pub(super) fn conflict(action: &str) -> HostdError {
    HostdError::conflict(format!(
        "Docker daemon configuration changed; reload before {action}"
    ))
}

pub(super) async fn create_baseline(
    state_dir: &Path,
    current: &DockerConfigFile,
) -> Result<DockerTransaction, HostdError> {
    fs::create_dir_all(state_dir).await?;
    fs::set_permissions(state_dir, std::fs::Permissions::from_mode(0o700)).await?;
    let baseline_path = state_dir.join("baseline.json");
    if current.exists {
        atomic_write(&baseline_path, current.content.as_bytes(), 0o600).await?;
    } else {
        remove_if_exists(&baseline_path).await?;
    }
    let transaction = DockerTransaction {
        baseline_exists: current.exists,
        baseline_revision: current.revision.clone(),
        pending_revision: current.revision.clone(),
    };
    write_transaction(state_dir, &transaction).await?;
    Ok(transaction)
}

pub(super) async fn rollback_config(
    options: &DockerOptions,
    transaction: &DockerTransaction,
    runner: &dyn CommandRunner,
) -> RollbackStatus {
    let result = async {
        if transaction.baseline_exists {
            let baseline = fs::read_to_string(options.state_dir.join("baseline.json")).await?;
            if revision(true, &baseline) != transaction.baseline_revision {
                return Err(HostdError::conflict("Docker daemon baseline changed"));
            }
            let expected = transaction.pending_revision.clone();
            atomic_write_checked(&options.config_path, baseline.as_bytes(), 0o644, || async {
                let current = read_config_file(&options.config_path).await?;
                ensure_revision(&current, &expected, "rollback")
            })
            .await?;
        } else {
            let current = read_config_file(&options.config_path).await?;
            ensure_revision(&current, &transaction.pending_revision, "rollback")?;
            remove_if_exists(&options.config_path).await?;
        }
        run_checked(runner, "systemctl", &["restart", "docker.service"], None).await?;
        clear_transaction(&options.state_dir).await?;
        Ok::<(), HostdError>(())
    }
    .await;
    if result.is_ok() {
        RollbackStatus::Succeeded
    } else {
        RollbackStatus::Failed
    }
}

pub(super) async fn read_transaction(
    state_dir: &Path,
) -> Result<Option<DockerTransaction>, HostdError> {
    match fs::read(state_dir.join("transaction.json")).await {
        Ok(content) => serde_json::from_slice(&content)
            .map(Some)
            .map_err(|_| HostdError::validation("Docker daemon transaction state is invalid")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn write_transaction(
    state_dir: &Path,
    transaction: &DockerTransaction,
) -> Result<(), HostdError> {
    fs::create_dir_all(state_dir).await?;
    fs::set_permissions(state_dir, std::fs::Permissions::from_mode(0o700)).await?;
    let mut content = serde_json::to_vec(transaction)
        .map_err(|error| HostdError::operation_failed(error.to_string()))?;
    content.push(b'\n');
    atomic_write(&state_dir.join("transaction.json"), &content, 0o600).await
}

pub(super) async fn clear_transaction(state_dir: &Path) -> Result<(), HostdError> {
    remove_if_exists(&state_dir.join("transaction.json")).await?;
    remove_if_exists(&state_dir.join("baseline.json")).await
}

async fn remove_if_exists(path: &Path) -> Result<(), HostdError> {
    match fs::remove_file(path).await {
        Ok(()) => {
            sync_parent(path).await?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn atomic_write(path: &Path, content: &[u8], mode: u32) -> Result<(), HostdError> {
    atomic_write_checked(path, content, mode, || async { Ok(()) }).await
}

pub(super) async fn atomic_write_checked<F, Fut>(
    path: &Path,
    content: &[u8],
    mode: u32,
    before_rename: F,
) -> Result<(), HostdError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), HostdError>>,
{
    let parent = path
        .parent()
        .ok_or_else(|| HostdError::validation("Managed file has no parent"))?;
    fs::create_dir_all(parent).await?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("hostd"),
        Uuid::new_v4()
    ));
    let result = async {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temp)
            .await?;
        file.write_all(content).await?;
        file.set_permissions(std::fs::Permissions::from_mode(mode))
            .await?;
        if Uid::effective().is_root() {
            chown(&temp, Some(Uid::from_raw(0)), Some(Gid::from_raw(0)))
                .map_err(|error| HostdError::operation_failed(error.to_string()))?;
        }
        file.sync_all().await?;
        drop(file);
        before_rename().await?;
        fs::rename(&temp, path).await?;
        sync_parent(path).await?;
        Ok::<(), HostdError>(())
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temp).await;
    }
    result
}

async fn sync_parent(path: &Path) -> Result<(), HostdError> {
    let parent = path
        .parent()
        .ok_or_else(|| HostdError::validation("Managed file has no parent"))?;
    fs::File::open(parent).await?.sync_all().await?;
    Ok(())
}
