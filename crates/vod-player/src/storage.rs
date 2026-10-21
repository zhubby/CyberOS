use std::fs::{File, OpenOptions};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "linux")]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

#[cfg(target_os = "linux")]
use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};

use crate::config::{NasRoot, VodPlayerConfig};
use crate::error::{ErrorCode, VodError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
    pub size: u64,
    pub modified_seconds: i64,
    pub modified_nanoseconds: i64,
    pub changed_seconds: i64,
    pub changed_nanoseconds: i64,
}

pub struct OpenedMedia {
    pub file: File,
    pub identity: FileIdentity,
    pub file_name: String,
}

impl OpenedMedia {
    pub fn try_clone(&self) -> Result<Self, VodError> {
        Ok(Self {
            file: self.file.try_clone()?,
            identity: self.identity,
            file_name: self.file_name.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MountLocation {
    path: PathBuf,
    mount_id: Option<u64>,
}

pub fn open_media(
    config: &VodPlayerConfig,
    root_id: &str,
    storage_pool_id: &str,
    relative_path: &str,
) -> Result<OpenedMedia, VodError> {
    validate_relative_path(relative_path)?;
    validate_media_extension(relative_path)?;
    let root = config
        .nas_roots
        .iter()
        .find(|root| root.id == root_id)
        .ok_or_else(|| VodError::invalid_path("NAS root not found"))?;
    open_media_for_root(root, storage_pool_id, relative_path)
}

fn open_media_for_root(
    root: &NasRoot,
    storage_pool_id: &str,
    relative_path: &str,
) -> Result<OpenedMedia, VodError> {
    let root_path = std::fs::canonicalize(&root.path).map_err(|_| {
        VodError::unavailable(ErrorCode::StorageUnavailable, "NAS root is unavailable")
    })?;
    let mount = find_mountpoint(storage_pool_id, &root_path)?;
    let mountpoint = std::fs::canonicalize(&mount.path).map_err(|_| {
        VodError::unavailable(ErrorCode::StorageUnavailable, "Storage pool is unavailable")
    })?;
    if !mountpoint.starts_with(&root_path) {
        return Err(VodError::invalid_path(
            "Storage pool is outside the selected NAS root",
        ));
    }
    let mount_relative = mountpoint
        .strip_prefix(&root_path)
        .map_err(|_| VodError::invalid_path("Invalid storage pool"))?;
    let requested = Path::new(relative_path);
    let pool_relative = if mount_relative.as_os_str().is_empty() {
        requested
    } else {
        requested.strip_prefix(mount_relative).map_err(|_| {
            VodError::invalid_path("Media path is outside the selected storage pool")
        })?
    };
    let file = open_beneath(&mountpoint, pool_relative, mount.mount_id)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(VodError::invalid_path(
            "Selected media is not a regular file",
        ));
    }
    Ok(OpenedMedia {
        file,
        identity: identity(&metadata),
        file_name: requested
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("video")
            .to_owned(),
    })
}

pub fn identity_matches(file: &File, expected: FileIdentity) -> Result<bool, VodError> {
    let metadata = file.metadata()?;
    Ok(metadata.is_file() && identity(&metadata) == expected)
}

fn validate_relative_path(value: &str) -> Result<(), VodError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\0')
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(VodError::invalid_path(
            "Media path must remain inside the storage pool",
        ));
    }
    Ok(())
}

fn validate_media_extension(value: &str) -> Result<(), VodError> {
    let extension = Path::new(value)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    if extension.as_deref().is_some_and(|extension| {
        matches!(
            extension,
            "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "ts" | "mts" | "m2ts" | "mpeg" | "mpg"
        )
    }) {
        Ok(())
    } else {
        Err(VodError::new(
            ErrorCode::UnsupportedMedia,
            "Selected file is not a supported video",
            415,
        ))
    }
}

#[cfg(target_os = "linux")]
fn open_beneath(
    mountpoint: &Path,
    relative: &Path,
    expected_mount_id: Option<u64>,
) -> Result<File, VodError> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(mountpoint)?;
    if let Some(expected_mount_id) = expected_mount_id
        && mount_id_for_fd(&directory)? != expected_mount_id
    {
        return Err(VodError::unavailable(
            ErrorCode::StorageUnavailable,
            "Storage pool mount changed while opening media",
        ));
    }
    let how = OpenHow::new()
        .flags(OFlag::O_RDONLY | OFlag::O_CLOEXEC)
        .resolve(
            ResolveFlag::RESOLVE_BENEATH
                | ResolveFlag::RESOLVE_NO_MAGICLINKS
                | ResolveFlag::RESOLVE_NO_XDEV,
        );
    openat2(&directory, relative, how)
        .map(File::from)
        .map_err(|error| match error {
            nix::errno::Errno::EXDEV | nix::errno::Errno::ELOOP => {
                VodError::invalid_path("Media path escapes the selected storage pool")
            }
            nix::errno::Errno::ENOENT | nix::errno::Errno::ENOTDIR => {
                VodError::invalid_path("Media file does not exist")
            }
            other => VodError::from(other),
        })
}

#[cfg(not(target_os = "linux"))]
fn open_beneath(
    mountpoint: &Path,
    relative: &Path,
    _expected_mount_id: Option<u64>,
) -> Result<File, VodError> {
    let mountpoint = std::fs::canonicalize(mountpoint)?;
    let requested = mountpoint.join(relative);
    let resolved = std::fs::canonicalize(&requested).map_err(|error| {
        if matches!(
            error.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
        ) {
            VodError::invalid_path("Media file does not exist")
        } else {
            VodError::from(error)
        }
    })?;
    if !resolved.starts_with(mountpoint) {
        return Err(VodError::invalid_path(
            "Media path escapes the selected storage pool",
        ));
    }
    Ok(OpenOptions::new().read(true).open(resolved)?)
}

#[cfg(target_os = "linux")]
fn mount_id_for_fd(file: &File) -> Result<u64, VodError> {
    let fdinfo = std::fs::read_to_string(format!("/proc/self/fdinfo/{}", file.as_raw_fd()))?;
    fdinfo
        .lines()
        .find_map(|line| line.strip_prefix("mnt_id:").map(str::trim))
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| VodError::internal("Unable to determine storage pool mount identity"))
}

fn identity(metadata: &std::fs::Metadata) -> FileIdentity {
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanoseconds: metadata.ctime_nsec(),
    }
}

#[cfg(target_os = "linux")]
fn find_mountpoint(storage_pool_id: &str, root: &Path) -> Result<MountLocation, VodError> {
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo")?;
    find_mountpoint_in(&mountinfo, storage_pool_id, root).ok_or_else(|| {
        VodError::unavailable(ErrorCode::StorageUnavailable, "Storage pool is not mounted")
    })
}

#[cfg(not(target_os = "linux"))]
fn find_mountpoint(_storage_pool_id: &str, root: &Path) -> Result<MountLocation, VodError> {
    Ok(MountLocation {
        path: root.to_owned(),
        mount_id: None,
    })
}

#[cfg(any(target_os = "linux", test))]
fn find_mountpoint_in(
    mountinfo: &str,
    storage_pool_id: &str,
    root: &Path,
) -> Option<MountLocation> {
    let requested = std::fs::canonicalize(storage_pool_id).ok();
    for line in mountinfo.lines() {
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        let left: Vec<_> = left.split_whitespace().collect();
        let right: Vec<_> = right.split_whitespace().collect();
        if left.len() >= 5 && right.len() >= 2 {
            let source = unescape_mount_field(right[1]);
            let source_matches = source == storage_pool_id
                || requested.as_ref().is_some_and(|requested| {
                    std::fs::canonicalize(&source).ok().as_ref() == Some(requested)
                });
            if !source_matches {
                continue;
            }
            let Ok(mount_id) = left[0].parse() else {
                continue;
            };
            let mountpoint = PathBuf::from(unescape_mount_field(left[4]));
            if mountpoint == root || mountpoint.starts_with(root) {
                return Some(MountLocation {
                    path: mountpoint,
                    mount_id: Some(mount_id),
                });
            }
        }
    }
    if requested.as_deref() == Some(root) || Path::new(storage_pool_id) == root {
        Some(MountLocation {
            path: root.to_owned(),
            mount_id: None,
        })
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
    fn validates_media_paths_and_extensions() {
        assert!(validate_relative_path("movies/a.mkv").is_ok());
        assert!(validate_relative_path("../a.mkv").is_err());
        assert!(validate_relative_path("/tmp/a.mkv").is_err());
        assert!(validate_media_extension("movies/a.MP4").is_ok());
        assert_eq!(
            validate_media_extension("movies/a.txt").unwrap_err().code,
            ErrorCode::UnsupportedMedia
        );
    }

    #[test]
    fn parses_mountinfo_and_escaped_mountpoints() {
        let mountinfo = concat!(
            "malformed line\n",
            "35 25 0:31 / /other rw - ext4 /dev/md0 rw\n",
            "36 25 0:31 / /mnt/My\\040NAS rw - ext4 /dev/md0 rw\n",
        );
        assert_eq!(
            find_mountpoint_in(mountinfo, "/dev/md0", Path::new("/mnt")),
            Some(MountLocation {
                path: PathBuf::from("/mnt/My NAS"),
                mount_id: Some(36)
            })
        );
    }

    #[test]
    fn matches_canonical_storage_device_aliases() {
        let directory = tempfile::tempdir().unwrap();
        let device = directory.path().join("md127");
        let alias = directory.path().join("media");
        std::fs::write(&device, b"").unwrap();
        std::os::unix::fs::symlink(&device, &alias).unwrap();
        let root = directory.path().join("nas");
        let mountinfo = format!(
            "36 25 0:31 / {} rw - ext4 {} rw\n",
            root.display(),
            device.display()
        );
        assert_eq!(
            find_mountpoint_in(&mountinfo, alias.to_str().unwrap(), &root),
            Some(MountLocation {
                path: root,
                mount_id: Some(36)
            })
        );
    }

    #[test]
    fn opens_relative_symlinks_without_escaping_the_root() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("movie.mp4"), b"video").unwrap();
        std::os::unix::fs::symlink("movie.mp4", directory.path().join("link.mp4")).unwrap();
        let file = open_beneath(directory.path(), Path::new("link.mp4"), None).unwrap();
        assert_eq!(file.metadata().unwrap().len(), 5);
        std::os::unix::fs::symlink("/etc/passwd", directory.path().join("escape.mp4")).unwrap();
        assert!(open_beneath(directory.path(), Path::new("escape.mp4"), None).is_err());
    }
}
