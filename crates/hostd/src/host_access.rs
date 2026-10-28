use std::fs::OpenOptions;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use tokio::fs;

use crate::error::HostdError;

pub const CAPACITY_ANCHOR_NAME: &str = ".cyberos-host-access-capacity";

pub async fn reconcile_capacity_anchors(data_root: &Path) {
    let mountinfo = match fs::read_to_string("/proc/self/mountinfo").await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(message = %error, "could not inspect mount identities for Host Access anchors");
            return;
        }
    };
    let mut entries = match fs::read_dir(data_root).await {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(data_root = %data_root.display(), message = %error, "could not discover storage pools for Host Access anchors");
            return;
        }
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        match fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => continue,
            Err(error) => {
                tracing::warn!(path = %path.display(), message = %error, "could not inspect storage pool for Host Access anchor");
                continue;
            }
        }
        let storage_pool_id = entry.file_name().to_string_lossy().into_owned();
        if let Err(error) = reconcile_capacity_anchor(&storage_pool_id, &path, &mountinfo).await {
            tracing::warn!(storage_pool_id, code = ?error.code, message = %error.message, "Host Access storage pool capacity anchor is unavailable");
        }
    }
}

async fn reconcile_capacity_anchor(
    storage_pool_id: &str,
    storage_pool_path: &Path,
    mountinfo: &str,
) -> Result<(), HostdError> {
    let metadata = fs::symlink_metadata(storage_pool_path).await.map_err(|_| {
        HostdError::unavailable(format!("Storage pool {storage_pool_id} is not available"))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(HostdError::validation(format!(
            "Storage pool {storage_pool_id} is not a symlink-free directory"
        )));
    }
    let canonical = fs::canonicalize(storage_pool_path).await?;
    if canonical != storage_pool_path {
        return Err(HostdError::validation(format!(
            "Storage pool {storage_pool_id} contains a symlink or non-canonical component"
        )));
    }
    if !has_exact_mount(storage_pool_path, mountinfo) {
        return Err(HostdError::unavailable(format!(
            "Storage pool {storage_pool_id} is not backed by a non-root mount"
        )));
    }

    let anchor = storage_pool_path.join(CAPACITY_ANCHOR_NAME);
    secure_capacity_anchor(anchor).await?;
    Ok(())
}

async fn secure_capacity_anchor(path: PathBuf) -> Result<(), HostdError> {
    tokio::task::spawn_blocking(move || secure_capacity_anchor_sync(&path))
        .await
        .map_err(|error| {
            HostdError::new(500, crate::error::ErrorCode::Internal, error.to_string())
        })?
}

fn secure_capacity_anchor_sync(path: &Path) -> Result<(), HostdError> {
    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| {
            HostdError::validation("Storage pool capacity anchor is not a symlink-free directory")
        })?;
    if directory.metadata()?.uid() != nix::unistd::Uid::effective().as_raw() {
        return Err(HostdError::validation(
            "Storage pool capacity anchor is not owned by hostd",
        ));
    }
    let mut entries =
        nix::dir::Dir::from_fd(directory.try_clone()?.into()).map_err(nix_io_error)?;
    for entry in entries.iter() {
        let entry = entry.map_err(nix_io_error)?;
        if !matches!(entry.file_name().to_bytes(), b"." | b"..") {
            return Err(HostdError::validation(
                "Storage pool capacity anchor must remain empty",
            ));
        }
    }
    directory.set_permissions(std::fs::Permissions::from_mode(0o555))?;
    Ok(())
}

fn nix_io_error(error: nix::errno::Errno) -> std::io::Error {
    std::io::Error::from_raw_os_error(error as i32)
}

fn has_exact_mount(root: &Path, mountinfo: &str) -> bool {
    root != Path::new("/")
        && mountinfo
            .lines()
            .filter_map(mount_point)
            .any(|mount| mount == root)
}

fn mount_point(line: &str) -> Option<PathBuf> {
    let encoded = line.split_whitespace().nth(4)?;
    let mut decoded = Vec::with_capacity(encoded.len());
    let bytes = encoded.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 3 < bytes.len() {
            let octal = &encoded[index + 1..index + 4];
            if octal.bytes().all(|byte| matches!(byte, b'0'..=b'7')) {
                decoded.push(u8::from_str_radix(octal, 8).ok()?);
                index += 4;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    Some(PathBuf::from(std::ffi::OsString::from_vec(decoded)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn requires_an_exact_pool_mount_and_decodes_mountinfo_paths() {
        let mountinfo = "22 1 8:1 / / rw - ext4 /dev/root rw\n23 22 8:2 / /mnt/My\\040NAS rw - ext4 /dev/sda1 rw\n";
        assert!(has_exact_mount(Path::new("/mnt/My NAS"), mountinfo));
        assert!(!has_exact_mount(Path::new("/mnt/My NAS/media"), mountinfo));
        assert!(!has_exact_mount(
            Path::new("/cyberos/data/media"),
            mountinfo
        ));
        assert!(!has_exact_mount(Path::new("/"), mountinfo));
    }

    #[tokio::test]
    async fn creates_only_an_empty_fixed_anchor() {
        let temp = TempDir::new().unwrap();
        let storage_pool_path = std::fs::canonicalize(temp.path()).unwrap();
        let mountinfo = format!(
            "23 22 8:2 / {} rw - ext4 /dev/sda1 rw\n",
            storage_pool_path.display()
        );
        reconcile_capacity_anchor("media", &storage_pool_path, &mountinfo)
            .await
            .unwrap();
        let anchor = storage_pool_path.join(CAPACITY_ANCHOR_NAME);
        assert!(anchor.is_dir());
        assert_eq!(
            std::fs::metadata(&anchor).unwrap().permissions().mode() & 0o777,
            0o555
        );

        std::fs::set_permissions(&anchor, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(anchor.join("unexpected"), b"data").unwrap();
        assert!(
            reconcile_capacity_anchor("media", &storage_pool_path, &mountinfo)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn refuses_symlink_anchors_without_changing_the_target() {
        let temp = TempDir::new().unwrap();
        let root_path = temp.path().join("root");
        let target = temp.path().join("target");
        std::fs::create_dir(&root_path).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&target, root_path.join(CAPACITY_ANCHOR_NAME)).unwrap();
        let storage_pool_path = std::fs::canonicalize(&root_path).unwrap();
        let mountinfo = format!(
            "23 22 8:2 / {} rw - ext4 /dev/sda1 rw\n",
            storage_pool_path.display()
        );

        assert!(
            reconcile_capacity_anchor("media", &storage_pool_path, &mountinfo)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}
