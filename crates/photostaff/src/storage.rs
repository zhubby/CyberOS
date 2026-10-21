use std::fs::{File, OpenOptions, ReadDir};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

#[cfg(target_os = "linux")]
use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};
#[cfg(not(target_os = "linux"))]
use nix::fcntl::{OFlag, openat};
#[cfg(not(target_os = "linux"))]
use nix::sys::stat::Mode;
use nix::sys::statvfs::fstatvfs;

use crate::error::{ErrorCode, PhotostaffError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
    pub size: u64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
}

impl FileIdentity {
    pub fn from_file(file: &File) -> Result<Self, PhotostaffError> {
        let metadata = file.metadata().map_err(PhotostaffError::storage)?;
        if !metadata.is_file() {
            return Err(PhotostaffError::new(
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
    library_relative: PathBuf,
    mountpoint_relative_to_root: PathBuf,
    initial_directory_identity: (u64, u64),
}

impl Library {
    pub fn resolve(
        root_path: &Path,
        storage_pool_id: &str,
        library_path: &Path,
    ) -> Result<Self, PhotostaffError> {
        validate_relative_path(library_path)?;
        let root = std::fs::canonicalize(root_path).map_err(PhotostaffError::storage)?;
        let mount_location = find_mountpoint(storage_pool_id, &root)?;
        let mountpoint =
            std::fs::canonicalize(&mount_location.path).map_err(PhotostaffError::storage)?;
        if !mountpoint.starts_with(&root) {
            return Err(PhotostaffError::new(
                ErrorCode::InvalidPath,
                "Storage pool mountpoint is outside its NAS root",
                false,
            ));
        }
        let mount = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&mountpoint)
            .map_err(PhotostaffError::storage)?;
        let mountpoint_relative_to_root = mountpoint
            .strip_prefix(&root)
            .map_err(|_| {
                PhotostaffError::new(
                    ErrorCode::InvalidPath,
                    "Storage pool is outside the configured NAS root",
                    false,
                )
            })?
            .to_owned();
        let library_relative =
            root_relative_within_mount(&mountpoint_relative_to_root, library_path)?;
        let directory = open_beneath(&mount, &library_relative, true)?;
        let metadata = directory.metadata().map_err(PhotostaffError::storage)?;
        Ok(Self {
            mount,
            root,
            mountpoint,
            storage_pool_id: storage_pool_id.to_owned(),
            mount_id: mount_location.mount_id,
            library_relative,
            mountpoint_relative_to_root,
            initial_directory_identity: (metadata.dev(), metadata.ino()),
        })
    }

    pub fn open_media(
        &self,
        root_relative_path: &Path,
    ) -> Result<(File, FileIdentity), PhotostaffError> {
        validate_relative_path(root_relative_path)?;
        let relative =
            root_relative_within_mount(&self.mountpoint_relative_to_root, root_relative_path)?;
        if !relative.starts_with(&self.library_relative) {
            return Err(PhotostaffError::new(
                ErrorCode::InvalidPath,
                "Media path is outside the configured Photostaff library",
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
    ) -> Result<(), PhotostaffError> {
        let (_, current) = self.open_media(root_relative_path)?;
        if current != expected {
            return Err(PhotostaffError::new(
                ErrorCode::SourceChanged,
                "Media pathname changed during processing",
                false,
            ));
        }
        Ok(())
    }

    pub fn open_directory(&self, root_relative_path: &Path) -> Result<File, PhotostaffError> {
        validate_relative_path(root_relative_path)?;
        let relative =
            root_relative_within_mount(&self.mountpoint_relative_to_root, root_relative_path)?;
        if !relative.starts_with(&self.library_relative) {
            return Err(PhotostaffError::new(
                ErrorCode::InvalidPath,
                "Directory is outside the configured Photostaff library",
                false,
            ));
        }
        open_beneath(&self.mount, &relative, true)
    }

    pub fn read_directory(&self, root_relative_path: &Path) -> Result<ReadDir, PhotostaffError> {
        let directory = self.open_directory(root_relative_path)?;
        let path = process_fd_path(&directory);
        std::fs::read_dir(path).map_err(PhotostaffError::storage)
    }

    pub fn verify_unchanged(&self) -> Result<(), PhotostaffError> {
        let current_mount = find_mountpoint(&self.storage_pool_id, &self.root)?;
        let current_mountpoint =
            std::fs::canonicalize(&current_mount.path).map_err(PhotostaffError::storage)?;
        if current_mountpoint != self.mountpoint || current_mount.mount_id != self.mount_id {
            return Err(PhotostaffError::new(
                ErrorCode::SourceChanged,
                "Photostaff storage mount changed during scanning",
                false,
            ));
        }
        let directory = open_beneath(&self.mount, &self.library_relative, true)?;
        let metadata = directory.metadata().map_err(PhotostaffError::storage)?;
        if (metadata.dev(), metadata.ino()) != self.initial_directory_identity {
            return Err(PhotostaffError::new(
                ErrorCode::SourceChanged,
                "Photostaff library identity changed during scanning",
                false,
            ));
        }
        Ok(())
    }

    pub fn available_bytes(&self) -> Result<u64, PhotostaffError> {
        let stats = fstatvfs(&self.mount).map_err(PhotostaffError::storage)?;
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

pub fn validate_relative_path(path: &Path) -> Result<(), PhotostaffError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(PhotostaffError::new(
            ErrorCode::InvalidPath,
            "Photostaff path must remain beneath its storage pool",
            false,
        ));
    }
    if path.to_str().is_none() {
        return Err(PhotostaffError::new(
            ErrorCode::InvalidPath,
            "Photostaff paths must be valid UTF-8",
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

fn root_relative_within_mount(
    mountpoint_relative_to_root: &Path,
    root_relative_path: &Path,
) -> Result<PathBuf, PhotostaffError> {
    let root_relative_path = normalize_relative(root_relative_path);
    if mountpoint_relative_to_root.as_os_str().is_empty() {
        return Ok(root_relative_path);
    }
    root_relative_path
        .strip_prefix(mountpoint_relative_to_root)
        .map(normalize_relative)
        .map_err(|_| {
            PhotostaffError::new(
                ErrorCode::InvalidPath,
                "Photostaff path is outside the selected storage pool",
                false,
            )
        })
}

#[cfg(target_os = "linux")]
fn open_beneath(
    directory: &File,
    relative: &Path,
    is_directory: bool,
) -> Result<File, PhotostaffError> {
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
) -> Result<File, PhotostaffError> {
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

fn open_error(error: nix::errno::Errno) -> PhotostaffError {
    match error {
        nix::errno::Errno::EXDEV | nix::errno::Errno::ELOOP => PhotostaffError::new(
            ErrorCode::InvalidPath,
            "Photostaff path crosses a storage or symlink boundary",
            false,
        ),
        nix::errno::Errno::ENOENT | nix::errno::Errno::ENOTDIR => PhotostaffError::new(
            ErrorCode::SourceChanged,
            "Photostaff path changed during scanning",
            false,
        ),
        nix::errno::Errno::EACCES | nix::errno::Errno::EPERM => PhotostaffError::new(
            ErrorCode::PermissionDenied,
            "Photostaff cannot access the media path",
            false,
        ),
        nix::errno::Errno::ENOSPC | nix::errno::Errno::EDQUOT => PhotostaffError::new(
            ErrorCode::DiskSpace,
            "Photostaff storage has insufficient space",
            false,
        ),
        _ => PhotostaffError::storage(error),
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
fn find_mountpoint(storage_pool_id: &str, root: &Path) -> Result<MountLocation, PhotostaffError> {
    let mountinfo =
        std::fs::read_to_string("/proc/self/mountinfo").map_err(PhotostaffError::storage)?;
    find_mountpoint_in(&mountinfo, storage_pool_id, root).ok_or_else(|| {
        PhotostaffError::new(
            ErrorCode::PhotostaffStorageUnavailable,
            "Photostaff storage pool is not mounted",
            true,
        )
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
        let left_fields: Vec<_> = left.split_whitespace().collect();
        let right_fields: Vec<_> = right.split_whitespace().collect();
        if left_fields.len() < 5 || right_fields.len() < 2 {
            continue;
        }
        let source = unescape_mount_field(right_fields[1]);
        let matches = source == storage_pool_id
            || requested.as_ref().is_some_and(|expected| {
                std::fs::canonicalize(&source).ok().as_ref() == Some(expected)
            });
        let mountpoint = PathBuf::from(unescape_mount_field(left_fields[4]));
        if matches
            && (mountpoint == root || mountpoint.starts_with(root))
            && let Ok(mount_id) = left_fields[0].parse()
        {
            return Some(MountLocation {
                path: mountpoint,
                mount_id: Some(mount_id),
            });
        }
    }
    if requested.as_deref() == Some(root) || Path::new(storage_pool_id) == root {
        return Some(MountLocation {
            path: root.to_owned(),
            mount_id: None,
        });
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn find_mountpoint(_storage_pool_id: &str, root: &Path) -> Result<MountLocation, PhotostaffError> {
    Ok(MountLocation {
        path: root.to_owned(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escape_absolute_and_non_utf8_paths() {
        assert!(validate_relative_path(Path::new("Photostaff/a.jpg")).is_ok());
        assert!(validate_relative_path(Path::new("../a.jpg")).is_err());
        assert!(validate_relative_path(Path::new("/a.jpg")).is_err());
    }

    #[test]
    fn parses_mountinfo_escapes() {
        assert_eq!(unescape_mount_field("/mnt/My\\040NAS"), "/mnt/My NAS");
    }

    #[test]
    fn selects_the_pool_mount_inside_the_configured_root_and_tracks_mount_id() {
        let mountinfo = concat!(
            "35 25 0:31 / /other rw - ext4 /dev/md0 rw\n",
            "36 25 0:31 / /mnt/My\\040NAS rw - ext4 /dev/md0 rw\n",
        );
        assert_eq!(
            find_mountpoint_in(mountinfo, "/dev/md0", Path::new("/mnt")),
            Some(MountLocation {
                path: PathBuf::from("/mnt/My NAS"),
                mount_id: Some(36),
            })
        );
    }

    #[test]
    fn converts_root_relative_library_paths_to_pool_relative_paths() {
        assert_eq!(
            root_relative_within_mount(Path::new("pool-a"), Path::new("pool-a/Photostaff"))
                .unwrap(),
            PathBuf::from("Photostaff")
        );
        assert_eq!(
            root_relative_within_mount(Path::new(""), Path::new("Photostaff")).unwrap(),
            PathBuf::from("Photostaff")
        );
        assert!(
            root_relative_within_mount(Path::new("pool-a"), Path::new("pool-a"))
                .unwrap()
                .as_os_str()
                .is_empty()
        );
        assert!(
            root_relative_within_mount(Path::new("pool-a"), Path::new("pool-b/Photostaff"))
                .is_err()
        );
    }

    #[test]
    fn detects_path_replacement_while_the_original_fd_remains_open() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("media.jpg");
        let replaced = directory.path().join("original.jpg");
        std::fs::write(&source, b"original").unwrap();
        let library = Library::resolve(
            directory.path(),
            directory.path().to_str().unwrap(),
            Path::new("."),
        )
        .unwrap();
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
