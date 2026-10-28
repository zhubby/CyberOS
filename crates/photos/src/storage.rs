use std::fs::{File, OpenOptions, ReadDir};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

#[cfg(target_os = "linux")]
use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};
#[cfg(not(target_os = "linux"))]
use nix::fcntl::{OFlag, openat};
#[cfg(not(target_os = "linux"))]
use nix::sys::stat::Mode;
use nix::sys::statvfs::fstatvfs;

use crate::error::{ErrorCode, PhotosError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
    pub size: u64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
}

impl FileIdentity {
    pub fn from_file(file: &File) -> Result<Self, PhotosError> {
        let metadata = file.metadata().map_err(PhotosError::storage)?;
        if !metadata.is_file() {
            return Err(PhotosError::new(
                ErrorCode::InvalidPath,
                "Media source is not a regular file",
                false,
            ));
        }
        Ok(identity(&metadata))
    }
}

pub struct Library {
    mount: File,
    root: PathBuf,
    mountpoint: PathBuf,
    storage_pool_id: String,
    mount_id: Option<u64>,
    require_mount: bool,
    library_relative: PathBuf,
    initial_directory_identity: (u64, u64),
}

impl Library {
    pub fn resolve(
        data_root: &Path,
        storage_pool_id: &str,
        library_path: &Path,
        require_mount: bool,
    ) -> Result<Self, PhotosError> {
        validate_relative_path(library_path)?;
        validate_storage_pool_id(storage_pool_id)?;
        let root = std::fs::canonicalize(data_root).map_err(PhotosError::storage)?;
        let pool_path = root.join(storage_pool_id);
        let metadata = std::fs::symlink_metadata(&pool_path).map_err(PhotosError::storage)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(PhotosError::new(
                ErrorCode::InvalidPath,
                "Storage pool must be a real directory",
                false,
            ));
        }
        let pool_path = std::fs::canonicalize(pool_path).map_err(PhotosError::storage)?;
        if pool_path != root.join(storage_pool_id) {
            return Err(PhotosError::new(
                ErrorCode::InvalidPath,
                "Storage pool is not a direct child of the CyberOS data root",
                false,
            ));
        }
        let mount_location = find_mountpoint(&pool_path, require_mount)?;
        let mountpoint =
            std::fs::canonicalize(&mount_location.path).map_err(PhotosError::storage)?;
        if mountpoint != pool_path {
            return Err(PhotosError::new(
                ErrorCode::InvalidPath,
                "Storage mount does not match the selected pool",
                false,
            ));
        }
        let mount = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&mountpoint)
            .map_err(PhotosError::storage)?;
        verify_mount_id(&mount, mount_location.mount_id)?;
        let library_relative = normalize_relative(library_path);
        let directory = open_beneath(&mount, &library_relative, true)?;
        let metadata = directory.metadata().map_err(PhotosError::storage)?;
        Ok(Self {
            mount,
            root,
            mountpoint,
            storage_pool_id: storage_pool_id.to_owned(),
            mount_id: mount_location.mount_id,
            require_mount,
            library_relative,
            initial_directory_identity: (metadata.dev(), metadata.ino()),
        })
    }

    pub fn open_media(
        &self,
        root_relative_path: &Path,
    ) -> Result<(File, FileIdentity), PhotosError> {
        validate_relative_path(root_relative_path)?;
        let relative = normalize_relative(root_relative_path);
        if !relative.starts_with(&self.library_relative) {
            return Err(PhotosError::new(
                ErrorCode::InvalidPath,
                "Media path is outside the configured Photos library",
                false,
            ));
        }
        let file = open_beneath(&self.mount, &relative, false)?;
        let identity = FileIdentity::from_file(&file)?;
        Ok((file, identity))
    }

    pub fn verify_media_identity(
        &self,
        root_relative_path: &Path,
        expected: FileIdentity,
    ) -> Result<(), PhotosError> {
        let (_, current) = self.open_media(root_relative_path)?;
        if current != expected {
            return Err(PhotosError::new(
                ErrorCode::SourceChanged,
                "Media pathname changed during processing",
                false,
            ));
        }
        Ok(())
    }

    pub fn open_directory(&self, root_relative_path: &Path) -> Result<File, PhotosError> {
        validate_relative_path(root_relative_path)?;
        let relative = normalize_relative(root_relative_path);
        if !relative.starts_with(&self.library_relative) {
            return Err(PhotosError::new(
                ErrorCode::InvalidPath,
                "Directory is outside the configured Photos library",
                false,
            ));
        }
        open_beneath(&self.mount, &relative, true)
    }

    pub fn read_directory(&self, root_relative_path: &Path) -> Result<ReadDir, PhotosError> {
        let directory = self.open_directory(root_relative_path)?;
        let path = process_fd_path(&directory);
        std::fs::read_dir(path).map_err(PhotosError::storage)
    }

    pub fn verify_unchanged(&self) -> Result<(), PhotosError> {
        let current_mount =
            find_mountpoint(&self.root.join(&self.storage_pool_id), self.require_mount)?;
        let current_mountpoint =
            std::fs::canonicalize(&current_mount.path).map_err(PhotosError::storage)?;
        if current_mountpoint != self.mountpoint || current_mount.mount_id != self.mount_id {
            return Err(PhotosError::new(
                ErrorCode::SourceChanged,
                "Photos storage mount changed during scanning",
                false,
            ));
        }
        let directory = open_beneath(&self.mount, &self.library_relative, true)?;
        let metadata = directory.metadata().map_err(PhotosError::storage)?;
        if (metadata.dev(), metadata.ino()) != self.initial_directory_identity {
            return Err(PhotosError::new(
                ErrorCode::SourceChanged,
                "Photos library identity changed during scanning",
                false,
            ));
        }
        Ok(())
    }

    pub fn available_bytes(&self) -> Result<u64, PhotosError> {
        let stats = fstatvfs(&self.mount).map_err(PhotosError::storage)?;
        #[cfg(target_os = "linux")]
        let blocks_available = stats.blocks_available();
        #[cfg(not(target_os = "linux"))]
        let blocks_available = u64::from(stats.blocks_available());
        Ok(blocks_available.saturating_mul(stats.fragment_size()))
    }

    pub fn mountpoint(&self) -> &Path {
        &self.mountpoint
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MountLocation {
    path: PathBuf,
    mount_id: Option<u64>,
}

pub fn process_fd_path(file: &File) -> PathBuf {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "linux")]
    return PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
    #[cfg(not(target_os = "linux"))]
    PathBuf::from(format!("/dev/fd/{}", file.as_raw_fd()))
}

pub fn validate_relative_path(path: &Path) -> Result<(), PhotosError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(PhotosError::new(
            ErrorCode::InvalidPath,
            "Photos path must remain beneath its storage pool",
            false,
        ));
    }
    if path.to_str().is_none() {
        return Err(PhotosError::new(
            ErrorCode::InvalidPath,
            "Photos paths must be valid UTF-8",
            false,
        ));
    }
    Ok(())
}

fn normalize_relative(path: &Path) -> PathBuf {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value),
            Component::CurDir => None,
            _ => None,
        })
        .collect()
}

fn validate_storage_pool_id(storage_pool_id: &str) -> Result<(), PhotosError> {
    let path = Path::new(storage_pool_id);
    if storage_pool_id.is_empty()
        || path.is_absolute()
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(PhotosError::new(
            ErrorCode::InvalidPath,
            "Invalid storage pool id",
            false,
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_beneath(
    directory: &File,
    relative: &Path,
    is_directory: bool,
) -> Result<File, PhotosError> {
    let relative = if relative.as_os_str().is_empty() {
        Path::new(".")
    } else {
        relative
    };
    let mut flags = OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW;
    if is_directory {
        flags |= OFlag::O_DIRECTORY;
    }
    let how = OpenHow::new().flags(flags).resolve(
        ResolveFlag::RESOLVE_BENEATH
            | ResolveFlag::RESOLVE_NO_SYMLINKS
            | ResolveFlag::RESOLVE_NO_MAGICLINKS
            | ResolveFlag::RESOLVE_NO_XDEV,
    );
    openat2(directory, relative, how)
        .map(File::from)
        .map_err(open_error)
}

#[cfg(not(target_os = "linux"))]
fn open_beneath(
    directory: &File,
    relative: &Path,
    is_directory: bool,
) -> Result<File, PhotosError> {
    let relative = if relative.as_os_str().is_empty() {
        Path::new(".")
    } else {
        relative
    };
    let mut flags = OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW;
    if is_directory {
        flags |= OFlag::O_DIRECTORY;
    }
    openat(directory, relative, flags, Mode::empty())
        .map(File::from)
        .map_err(open_error)
}

fn open_error(error: nix::errno::Errno) -> PhotosError {
    match error {
        nix::errno::Errno::EXDEV | nix::errno::Errno::ELOOP => PhotosError::new(
            ErrorCode::InvalidPath,
            "Photos path crosses a storage or symlink boundary",
            false,
        ),
        nix::errno::Errno::ENOENT | nix::errno::Errno::ENOTDIR => PhotosError::new(
            ErrorCode::SourceChanged,
            "Photos path changed during scanning",
            false,
        ),
        nix::errno::Errno::EACCES | nix::errno::Errno::EPERM => PhotosError::new(
            ErrorCode::PermissionDenied,
            "Photos cannot access the media path",
            false,
        ),
        nix::errno::Errno::ENOSPC | nix::errno::Errno::EDQUOT => PhotosError::new(
            ErrorCode::DiskSpace,
            "Photos storage has insufficient space",
            false,
        ),
        _ => PhotosError::storage(error),
    }
}

fn identity(metadata: &std::fs::Metadata) -> FileIdentity {
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
        mtime_ns: metadata.mtime().saturating_mul(1_000_000_000) + metadata.mtime_nsec(),
        ctime_ns: metadata.ctime().saturating_mul(1_000_000_000) + metadata.ctime_nsec(),
    }
}

#[cfg(target_os = "linux")]
fn find_mountpoint(pool_path: &Path, required: bool) -> Result<MountLocation, PhotosError> {
    let mountinfo =
        std::fs::read_to_string("/proc/self/mountinfo").map_err(PhotosError::storage)?;
    match find_mountpoint_in(&mountinfo, pool_path) {
        Some(location) => Ok(location),
        None if required => Err(PhotosError::new(
            ErrorCode::PhotosStorageUnavailable,
            "Storage pool is not mounted",
            true,
        )),
        None => Ok(MountLocation {
            path: pool_path.to_owned(),
            mount_id: None,
        }),
    }
}

#[cfg(any(target_os = "linux", test))]
fn find_mountpoint_in(mountinfo: &str, pool_path: &Path) -> Option<MountLocation> {
    let requested = std::fs::canonicalize(pool_path).ok()?;
    for line in mountinfo.lines() {
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        let left_fields: Vec<_> = left.split_whitespace().collect();
        if left_fields.len() < 5 || right.split_whitespace().count() < 2 {
            continue;
        }
        let mountpoint = PathBuf::from(unescape_mount_field(left_fields[4]));
        if std::fs::canonicalize(&mountpoint).ok().as_ref() == Some(&requested)
            && let Ok(mount_id) = left_fields[0].parse()
        {
            return Some(MountLocation {
                path: mountpoint,
                mount_id: Some(mount_id),
            });
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn find_mountpoint(pool_path: &Path, required: bool) -> Result<MountLocation, PhotosError> {
    if required {
        return Err(PhotosError::new(
            ErrorCode::PhotosStorageUnavailable,
            "Production storage mount verification requires Linux",
            true,
        ));
    }
    Ok(MountLocation {
        path: pool_path.to_owned(),
        mount_id: None,
    })
}

#[cfg(any(target_os = "linux", test))]
fn unescape_mount_field(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(target_os = "linux")]
fn verify_mount_id(file: &File, expected: Option<u64>) -> Result<(), PhotosError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let fdinfo = std::fs::read_to_string(format!("/proc/self/fdinfo/{}", file.as_raw_fd()))
        .map_err(PhotosError::storage)?;
    let actual = fdinfo
        .lines()
        .find_map(|line| line.strip_prefix("mnt_id:").map(str::trim))
        .and_then(|value| value.parse().ok());
    if actual == Some(expected) {
        Ok(())
    } else {
        Err(PhotosError::new(
            ErrorCode::PhotosStorageUnavailable,
            "Storage pool mount changed while opening the media library",
            true,
        ))
    }
}

#[cfg(not(target_os = "linux"))]
fn verify_mount_id(_file: &File, _expected: Option<u64>) -> Result<(), PhotosError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escape_absolute_and_non_utf8_paths() {
        assert!(validate_relative_path(Path::new("Photos/a.jpg")).is_ok());
        assert!(validate_relative_path(Path::new("../a.jpg")).is_err());
        assert!(validate_relative_path(Path::new("/a.jpg")).is_err());
    }

    #[test]
    fn parses_mountinfo_escapes() {
        assert_eq!(unescape_mount_field("/mnt/My\\040NAS"), "/mnt/My NAS");
    }

    #[test]
    fn selects_the_pool_mount_inside_the_configured_root_and_tracks_mount_id() {
        let directory = tempfile::tempdir().unwrap();
        let pool = directory.path().join("pool-a");
        std::fs::create_dir(&pool).unwrap();
        let mountinfo = concat!(
            "35 25 0:31 / /other rw - ext4 /dev/md0 rw\n",
            "36 25 0:31 / POOL_PATH rw - ext4 /dev/md0 rw\n",
        );
        let mountinfo = mountinfo.replace("POOL_PATH", pool.to_str().unwrap());
        assert_eq!(
            find_mountpoint_in(&mountinfo, &pool),
            Some(MountLocation {
                path: pool,
                mount_id: Some(36),
            })
        );
    }

    #[test]
    fn production_requires_the_pool_directory_to_be_a_mountpoint() {
        let directory = tempfile::tempdir().unwrap();
        let pool = directory.path().join("pool-a");
        std::fs::create_dir(&pool).unwrap();
        let error = find_mountpoint(&pool, true).unwrap_err();
        assert_eq!(error.code, ErrorCode::PhotosStorageUnavailable);
        assert!(error.retryable);
    }

    #[test]
    fn accepts_only_single_component_storage_pool_ids() {
        assert!(validate_storage_pool_id("pool-a").is_ok());
        assert!(validate_storage_pool_id("../pool-a").is_err());
        assert!(validate_storage_pool_id("nested/pool-a").is_err());
        assert!(validate_storage_pool_id("").is_err());
    }

    #[test]
    fn detects_path_replacement_while_the_original_fd_remains_open() {
        let directory = tempfile::tempdir().unwrap();
        let pool = directory.path().join("pool-a");
        std::fs::create_dir(&pool).unwrap();
        let source = pool.join("media.jpg");
        let replaced = pool.join("original.jpg");
        std::fs::write(&source, b"original").unwrap();
        let library = Library::resolve(directory.path(), "pool-a", Path::new("."), false).unwrap();
        let (open_file, identity) = library.open_media(Path::new("media.jpg")).unwrap();

        std::fs::rename(&source, &replaced).unwrap();
        std::fs::write(&source, b"replacement").unwrap();

        assert_eq!(
            std::fs::read(crate::storage::process_fd_path(&open_file)).unwrap(),
            b"original"
        );
        assert_eq!(
            library
                .verify_media_identity(Path::new("media.jpg"), identity)
                .unwrap_err()
                .code,
            ErrorCode::SourceChanged
        );
    }
}
