use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::error::HostdError;

pub(super) async fn append_entry(
    uuid: &str,
    mountpoint: &Path,
    filesystem: &str,
    path: &Path,
) -> Result<String, HostdError> {
    let current = fs::read_to_string(path).await?;
    if current
        .lines()
        .any(|line| mountpoint_from_line(line) == Some(mountpoint))
    {
        return Err(HostdError::conflict(format!(
            "Mountpoint already exists in {}: {}",
            path.display(),
            mountpoint.display()
        )));
    }
    let next = format!(
        "{}\nUUID={uuid} {} {filesystem} defaults,nofail,x-systemd.device-timeout=30s 0 2\n",
        current.trim_end(),
        mountpoint.display()
    );
    replace(path, &next).await?;
    Ok(current)
}

pub(super) async fn remove_entry(mountpoint: &Path, path: &Path) -> Result<String, HostdError> {
    let current = fs::read_to_string(path).await?;
    let mut lines = current
        .split('\n')
        .filter(|line| mountpoint_from_line(line) != Some(mountpoint))
        .collect::<Vec<_>>()
        .join("\n");
    if current.ends_with('\n') && !lines.ends_with('\n') {
        lines.push('\n');
    }
    if lines != current {
        replace(path, &lines).await?;
    }
    Ok(current)
}

pub(super) async fn replace(path: &Path, content: &str) -> Result<(), HostdError> {
    let parent = path
        .parent()
        .ok_or_else(|| HostdError::validation("fstab path has no parent"))?;
    let mode = fs::metadata(path).await?.permissions().mode();
    let temporary = parent.join(format!(".fstab.{}.tmp", Uuid::new_v4()));
    let result = async {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temporary)
            .await?;
        file.write_all(content.as_bytes()).await?;
        file.flush().await?;
        fs::set_permissions(&temporary, std::fs::Permissions::from_mode(mode)).await?;
        file.sync_all().await?;
        fs::rename(&temporary, path).await?;
        fs::File::open(parent).await?.sync_all().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary).await;
        return Err(error.into());
    }
    Ok(())
}

fn mountpoint_from_line(line: &str) -> Option<&Path> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    trimmed.split_whitespace().nth(1).map(Path::new)
}

pub(super) fn mount_unit_name(mountpoint: &Path) -> String {
    let segments = mountpoint
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(segment) => {
                Some(segment.to_string_lossy().replace('-', "\\x2d"))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    format!(
        "{}.mount",
        if segments.is_empty() {
            "-".to_owned()
        } else {
            segments.join("-")
        }
    )
}
