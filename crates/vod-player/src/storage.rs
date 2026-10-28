use std::fs::{File, OpenOptions};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "linux")]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

#[cfg(target_os = "linux")]
use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};

use crate::config::VodPlayerConfig;
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
    storage_pool_id: &str,
    relative_path: &str,
) -> Result<OpenedMedia, VodError> {
    validate_relative_path(relative_path)?;
    validate_media_extension(relative_path)?;
    validate_storage_pool_id(storage_pool_id)?;
    let data_root = std::fs::canonicalize(&config.data_root).map_err(|_| {
        VodError::unavailable(
            ErrorCode::StorageUnavailable,
            "CyberOS data root is unavailable",
        )
    })?;
    let pool_path = data_root.join(storage_pool_id);
    let metadata = std::fs::symlink_metadata(&pool_path).map_err(|_| {
        VodError::unavailable(ErrorCode::StorageUnavailable, "Storage pool is unavailable")
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(VodError::invalid_path(
            "Storage pool must be a real directory",
        ));
    }
    let pool_path = std::fs::canonicalize(pool_path).map_err(|_| {
        VodError::unavailable(ErrorCode::StorageUnavailable, "Storage pool is unavailable")
    })?;
    if pool_path != data_root.join(storage_pool_id) {
        return Err(VodError::invalid_path(
            "Storage pool is not a direct child of the data root",
        ));
    }
    let mount = find_mountpoint(&pool_path, config.production)?;
    let mountpoint = std::fs::canonicalize(&mount.path).map_err(|_| {
        VodError::unavailable(ErrorCode::StorageUnavailable, "Storage pool is unavailable")
    })?;
    if mountpoint != pool_path {
        return Err(VodError::invalid_path(
            "Storage mount does not match the selected pool",
        ));
    }
    let requested = Path::new(relative_path);
    let file = open_beneath(&mountpoint, requested, mount.mount_id)?;
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

fn validate_storage_pool_id(value: &str) -> Result<(), VodError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(VodError::invalid_path("Invalid storage pool id"));
    }
    Ok(())
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
fn find_mountpoint(pool_path: &Path, required: bool) -> Result<MountLocation, VodError> {
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo")?;
    match find_mountpoint_in(&mountinfo, pool_path) {
        Some(location) => Ok(location),
        None if required => Err(VodError::unavailable(
            ErrorCode::StorageUnavailable,
            "Storage pool is not mounted",
        )),
        None => Ok(MountLocation {
            path: pool_path.to_owned(),
            mount_id: None,
        }),
    }
}

#[cfg(not(target_os = "linux"))]
fn find_mountpoint(pool_path: &Path, required: bool) -> Result<MountLocation, VodError> {
    if required {
        return Err(VodError::unavailable(
            ErrorCode::StorageUnavailable,
            "Production storage mount verification requires Linux",
        ));
    }
    Ok(MountLocation {
        path: pool_path.to_owned(),
        mount_id: None,
    })
}

#[cfg(any(target_os = "linux", test))]
fn find_mountpoint_in(mountinfo: &str, pool_path: &Path) -> Option<MountLocation> {
    let requested = std::fs::canonicalize(pool_path).ok()?;
    for line in mountinfo.lines() {
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        let left: Vec<_> = left.split_whitespace().collect();
        let right: Vec<_> = right.split_whitespace().collect();
        if left.len() >= 5 && right.len() >= 2 {
            let Ok(mount_id) = left[0].parse() else {
                continue;
            };
            let mountpoint = PathBuf::from(unescape_mount_field(left[4]));
            if std::fs::canonicalize(&mountpoint).ok().as_ref() == Some(&requested) {
                return Some(MountLocation {
                    path: mountpoint,
                    mount_id: Some(mount_id),
                });
            }
        }
    }
    None
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
    fn parses_mountinfo_for_the_exact_pool_path() {
        let directory = tempfile::tempdir().unwrap();
        let pool = directory.path().join("pool-a");
        std::fs::create_dir(&pool).unwrap();
        let mountinfo = format!("36 25 0:31 / {} rw - ext4 /dev/md0 rw\n", pool.display());
        assert_eq!(
            find_mountpoint_in(&mountinfo, &pool),
            Some(MountLocation {
                path: pool,
                mount_id: Some(36)
            })
        );
    }

    #[test]
    fn production_requires_the_pool_directory_to_be_a_mountpoint() {
        let directory = tempfile::tempdir().unwrap();
        let pool = directory.path().join("pool-a");
        std::fs::create_dir(&pool).unwrap();
        let error = find_mountpoint(&pool, true).unwrap_err();
        assert_eq!(error.code, ErrorCode::StorageUnavailable);
    }

    #[test]
    fn accepts_only_single_component_storage_pool_ids() {
        assert!(validate_storage_pool_id("media").is_ok());
        assert!(validate_storage_pool_id("../media").is_err());
        assert!(validate_storage_pool_id("nested/media").is_err());
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
