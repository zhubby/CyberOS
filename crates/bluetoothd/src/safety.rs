use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};

use nix::sys::statvfs::statvfs;

use crate::error::TransferError;

pub fn open_send_file(root: &Path, relative: &str) -> Result<(File, PathBuf), TransferError> {
    let path = safe_existing(root, relative)?;
    let file = OpenOptions::new().read(true).open(&path)?;
    if !file.metadata()?.is_file() {
        return Err(TransferError(
            "Bluetooth transfer source is not a file".to_owned(),
        ));
    }
    Ok((file, path))
}

pub fn validate_storage_pool(
    root: &Path,
    storage_pool_id: &str,
    target: &Path,
) -> Result<(), TransferError> {
    let root = std::fs::canonicalize(root)
        .map_err(|_| TransferError("NAS root is unavailable".to_owned()))?;
    let target = std::fs::canonicalize(target)
        .map_err(|_| TransferError("Bluetooth transfer path is unavailable".to_owned()))?;
    if !target.starts_with(&root) {
        return Err(TransferError(
            "Bluetooth transfer path escaped the NAS root".to_owned(),
        ));
    }
    let mountpoint = mounted_pool_path(storage_pool_id, &root)?;
    if !target.starts_with(&mountpoint) {
        return Err(TransferError(
            "Bluetooth transfer path is outside the selected storage pool".to_owned(),
        ));
    }
    Ok(())
}

pub fn ensure_available_space(directory: &Path, required: u64) -> Result<(), TransferError> {
    if required == 0 {
        return Ok(());
    }
    let stats = statvfs(directory).map_err(|error| TransferError(error.to_string()))?;
    let available =
        u128::from(stats.blocks_available()).saturating_mul(u128::from(stats.fragment_size()));
    if available < u128::from(required) {
        return Err(TransferError(
            "Bluetooth inbox does not have enough free space".to_owned(),
        ));
    }
    Ok(())
}

pub fn validate_receive_name(requested_name: &str) -> Result<&str, TransferError> {
    Path::new(requested_name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty() && *value != "." && *value != ".." && *value == requested_name
        })
        .ok_or_else(|| TransferError("Invalid received file name".to_owned()))
}

pub fn safe_existing(root: &Path, relative: &str) -> Result<PathBuf, TransferError> {
    validate_relative(relative)?;
    let root = std::fs::canonicalize(root)
        .map_err(|_| TransferError("NAS root is unavailable".to_owned()))?;
    let requested = root.join(relative);
    reject_symlinks(&root, &requested)?;
    let real = std::fs::canonicalize(&requested)
        .map_err(|_| TransferError("Bluetooth transfer path is unavailable".to_owned()))?;
    if !real.starts_with(&root) {
        return Err(TransferError(
            "Bluetooth transfer path escaped the NAS root".to_owned(),
        ));
    }
    Ok(real)
}

fn validate_relative(value: &str) -> Result<(), TransferError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\0')
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(TransferError(
            "Bluetooth transfer path must stay inside the NAS root".to_owned(),
        ));
    }
    Ok(())
}

fn reject_symlinks(root: &Path, target: &Path) -> Result<(), TransferError> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| TransferError("Bluetooth transfer path escaped the NAS root".to_owned()))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(TransferError(
                    "Refusing Bluetooth transfer through a symlink".to_owned(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn mounted_pool_path(storage_pool_id: &str, root: &Path) -> Result<PathBuf, TransferError> {
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo")?;
    mounted_pool_path_in(&mountinfo, storage_pool_id, root)
        .ok_or_else(|| TransferError("Bluetooth storage pool is not mounted".to_owned()))
}

#[cfg(not(target_os = "linux"))]
fn mounted_pool_path(_storage_pool_id: &str, root: &Path) -> Result<PathBuf, TransferError> {
    Ok(root.to_owned())
}

#[cfg(any(target_os = "linux", test))]
fn mounted_pool_path_in(mountinfo: &str, storage_pool_id: &str, root: &Path) -> Option<PathBuf> {
    let requested = std::fs::canonicalize(storage_pool_id).ok();
    let mut best: Option<PathBuf> = None;
    for line in mountinfo.lines() {
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        let left: Vec<_> = left.split_whitespace().collect();
        let right: Vec<_> = right.split_whitespace().collect();
        if left.len() < 5 || right.len() < 2 {
            continue;
        }
        let source = unescape_mount_field(right[1]);
        let source_matches = source == storage_pool_id
            || requested.as_ref().is_some_and(|requested| {
                std::fs::canonicalize(&source).ok().as_ref() == Some(requested)
            });
        if !source_matches {
            continue;
        }
        let mountpoint = PathBuf::from(unescape_mount_field(left[4]));
        if (mountpoint == root || mountpoint.starts_with(root))
            && best.as_ref().is_none_or(|current| {
                mountpoint.components().count() > current.components().count()
            })
        {
            best = Some(mountpoint);
        }
    }
    if best.is_some() {
        best
    } else if requested.as_deref() == Some(root) || Path::new(storage_pool_id) == root {
        Some(root.to_owned())
    } else {
        None
    }
}

#[cfg(any(target_os = "linux", test))]
fn unescape_mount_field(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_symlinks_and_unsafe_receive_names() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("inbox")).unwrap();
        assert!(safe_existing(directory.path(), "../outside").is_err());
        std::os::unix::fs::symlink("inbox", directory.path().join("link")).unwrap();
        assert!(safe_existing(directory.path(), "link").is_err());
        assert_eq!(validate_receive_name("file.txt").unwrap(), "file.txt");
        assert!(validate_receive_name("../file.txt").is_err());
        assert!(validate_receive_name("nested/file.txt").is_err());
    }

    #[test]
    fn resolves_only_the_requested_pool_beneath_the_nas_root() {
        let mountinfo = concat!(
            "35 25 0:31 / /other rw - ext4 /dev/md0 rw\n",
            "36 25 0:31 / /zos/data/primary/media rw - ext4 /dev/md0 rw\n",
            "37 25 0:32 / /zos/data/primary/archive rw - ext4 /dev/md1 rw\n",
        );
        assert_eq!(
            mounted_pool_path_in(mountinfo, "/dev/md0", Path::new("/zos/data/primary")),
            Some(PathBuf::from("/zos/data/primary/media"))
        );
        assert_eq!(
            mounted_pool_path_in(mountinfo, "/dev/missing", Path::new("/zos/data/primary")),
            None
        );
    }
}
