use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
#[cfg(target_os = "linux")]
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::Stdio;
#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(not(target_os = "linux"))]
use nix::fcntl::openat;
use nix::fcntl::{Flock, FlockArg, OFlag};
use nix::sys::stat::Mode;
use nix::sys::statvfs::fstatvfs;
#[cfg(target_os = "linux")]
use tokio::process::Command;

#[cfg(target_os = "linux")]
use nix::fcntl::{OpenHow, RenameFlags, ResolveFlag, openat2, renameat2};

use crate::db::Task;
use crate::error::{DownloadError, ErrorCode};

#[derive(Debug)]
pub struct StorageTarget {
    directory: File,
    directory_path: PathBuf,
    target_name: OsString,
    partial_name: OsString,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
    pub size: u64,
}

impl StorageTarget {
    pub fn resolve(task: &Task) -> Result<Self, DownloadError> {
        validate_relative_path(Path::new(&task.target_directory))?;
        validate_relative_path(Path::new(&task.target_path))?;
        validate_relative_path(Path::new(&task.partial_path))?;
        let target_path = Path::new(&task.target_path);
        let partial_path = Path::new(&task.partial_path);
        if normalized_parent(target_path) != normalized_parent(partial_path)
            || normalized_parent(target_path)
                != normalize_relative(Path::new(&task.target_directory))
        {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "download partial file must share the target directory",
                false,
            ));
        }
        let target_name = target_path.file_name().ok_or_else(|| {
            DownloadError::new(
                ErrorCode::Storage,
                "download target has no file name",
                false,
            )
        })?;
        let partial_name = partial_path.file_name().ok_or_else(|| {
            DownloadError::new(
                ErrorCode::Storage,
                "download partial has no file name",
                false,
            )
        })?;
        let root = std::fs::canonicalize(&task.root_path).map_err(DownloadError::storage)?;
        let mountpoint = find_mountpoint(&task.storage_pool_id, &root)?;
        let mountpoint = std::fs::canonicalize(mountpoint).map_err(DownloadError::storage)?;
        if !mountpoint.starts_with(&root) {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "storage pool mountpoint is outside the configured NAS root",
                false,
            ));
        }
        let directory_relative =
            relative_directory_within_mount(&root, &mountpoint, Path::new(&task.target_directory))?;
        if target_name != OsStr::new(&task.target_file_name) {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "download target file name does not match its target path",
                false,
            ));
        }
        let mount = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&mountpoint)
            .map_err(DownloadError::storage)?;
        let directory_path = mountpoint.join(&directory_relative);
        let directory = open_directory_beneath(&mount, &directory_relative, &directory_path)?;
        Ok(Self {
            directory,
            directory_path,
            target_name: target_name.to_owned(),
            partial_name: partial_name.to_owned(),
        })
    }

    pub fn open_partial(&self, truncate: bool) -> Result<File, DownloadError> {
        let mut flags = OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW;
        if truncate {
            flags |= OFlag::O_TRUNC;
        }
        open_file_beneath(
            &self.directory,
            &self.partial_name,
            flags,
            Mode::from_bits_truncate(0o600),
        )
    }

    pub fn open_partial_readonly(&self) -> Result<File, DownloadError> {
        open_file_beneath(
            &self.directory,
            &self.partial_name,
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
    }

    pub fn lock_partial(&self) -> Result<Flock<File>, DownloadError> {
        let file = self.open_partial(false)?;
        Flock::lock(file, FlockArg::LockExclusiveNonblock).map_err(|(_, error)| {
            if error == nix::errno::Errno::EWOULDBLOCK {
                DownloadError::new(
                    ErrorCode::Storage,
                    "download partial file is already owned by another worker",
                    true,
                )
            } else {
                DownloadError::storage(error)
            }
        })
    }

    pub fn try_lock_existing_partial(&self) -> Result<Option<Flock<File>>, DownloadError> {
        if self.partial_identity()?.is_none() {
            return Ok(None);
        }
        let file = match self.open_partial_readonly() {
            Ok(file) => file,
            Err(_error) if self.partial_identity()?.is_none() => return Ok(None),
            Err(error) => return Err(error),
        };
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => Ok(Some(lock)),
            Err((_, error)) if error == nix::errno::Errno::EWOULDBLOCK => Ok(None),
            Err((_, error)) => Err(DownloadError::storage(error)),
        }
    }

    pub fn partial_identity(&self) -> Result<Option<FileIdentity>, DownloadError> {
        self.identity(&self.partial_name)
    }

    pub fn target_identity(&self) -> Result<Option<FileIdentity>, DownloadError> {
        self.identity(&self.target_name)
    }

    fn identity(&self, name: &OsStr) -> Result<Option<FileIdentity>, DownloadError> {
        match open_file_beneath(
            &self.directory,
            name,
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::empty(),
        ) {
            Ok(file) => {
                let metadata = file.metadata().map_err(DownloadError::storage)?;
                if !metadata.is_file() {
                    return Err(DownloadError::new(
                        ErrorCode::Storage,
                        "download path is not a regular file",
                        false,
                    ));
                }
                Ok(Some(identity(&metadata)))
            }
            Err(error) if error.message.contains("No such file") => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn available_bytes(&self) -> Result<u64, DownloadError> {
        let stats = fstatvfs(&self.directory).map_err(DownloadError::storage)?;
        Ok(block_count_to_u64(stats.blocks_available()).saturating_mul(stats.fragment_size()))
    }

    pub async fn prepare_publish(
        &self,
        file: &File,
        expected: FileIdentity,
    ) -> Result<(), DownloadError> {
        let metadata = file.metadata().map_err(DownloadError::storage)?;
        if identity(&metadata) != expected || !metadata.is_file() {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "download partial file changed before publication",
                false,
            ));
        }
        self.apply_default_acl(file).await?;
        file.set_permissions(std::fs::Permissions::from_mode(0o660))
            .map_err(DownloadError::storage)?;
        file.sync_all().map_err(DownloadError::storage)?;
        let current = file.metadata().map_err(DownloadError::storage)?;
        if identity(&current) != expected {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "download partial file changed while preparing publication",
                false,
            ));
        }
        Ok(())
    }

    pub fn publish(&self) -> Result<(), DownloadError> {
        if self.target_identity()?.is_some() {
            return Err(DownloadError::new(
                ErrorCode::TargetConflict,
                "download target already exists",
                false,
            ));
        }
        rename_no_replace(&self.directory, &self.partial_name, &self.target_name)?;
        self.sync_directory()
    }

    pub fn sync_directory(&self) -> Result<(), DownloadError> {
        self.directory.sync_all().map_err(DownloadError::storage)
    }

    pub fn remove_partial(&self) -> Result<(), DownloadError> {
        unlink_beneath(&self.directory, &self.directory_path, &self.partial_name)
    }

    async fn apply_default_acl(&self, _file: &File) -> Result<(), DownloadError> {
        #[cfg(target_os = "linux")]
        {
            let directory_path = format!(
                "/proc/{}/fd/{}",
                std::process::id(),
                self.directory.as_fd().as_raw_fd()
            );
            let output = tokio::time::timeout(
                Duration::from_secs(10),
                Command::new("getfacl")
                    .args(["-c", "-d", "--", &directory_path])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .map_err(|_| DownloadError::new(ErrorCode::Timeout, "getfacl timed out", false))?
            .map_err(DownloadError::storage)?;
            if !output.status.success() {
                return Err(DownloadError::new(
                    ErrorCode::Permission,
                    "getfacl failed",
                    false,
                ));
            }
            let entries = String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|line| {
                    let fields: Vec<_> = line.split(':').collect();
                    fields.len() == 3
                        && matches!(fields[0], "user" | "group")
                        && !fields[1].is_empty()
                        && fields[2].len() == 3
                })
                .collect::<Vec<_>>()
                .join(",");
            if !entries.is_empty() {
                let file_path = format!("/proc/{}/fd/{}", std::process::id(), _file.as_raw_fd());
                let status = tokio::time::timeout(
                    Duration::from_secs(10),
                    Command::new("setfacl")
                        .args(["-m", &entries, "--", &file_path])
                        .kill_on_drop(true)
                        .status(),
                )
                .await
                .map_err(|_| DownloadError::new(ErrorCode::Timeout, "setfacl timed out", false))?
                .map_err(DownloadError::storage)?;
                if !status.success() {
                    return Err(DownloadError::new(
                        ErrorCode::Permission,
                        "setfacl failed",
                        false,
                    ));
                }
            }
        }
        Ok(())
    }
}

fn block_count_to_u64<T: Into<u64>>(block_count: T) -> u64 {
    block_count.into()
}

fn validate_relative_path(path: &Path) -> Result<(), DownloadError> {
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(DownloadError::new(
            ErrorCode::Storage,
            "download path must remain beneath its storage pool",
            false,
        ));
    }
    Ok(())
}

fn normalized_parent(path: &Path) -> PathBuf {
    normalize_relative(path.parent().unwrap_or_else(|| Path::new(".")))
}

fn normalize_relative(path: &Path) -> PathBuf {
    let normalized: PathBuf = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value),
            Component::CurDir => None,
            _ => None,
        })
        .collect();
    if normalized.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        normalized
    }
}

fn relative_directory_within_mount(
    root: &Path,
    mountpoint: &Path,
    root_relative_directory: &Path,
) -> Result<PathBuf, DownloadError> {
    let mountpoint_relative = mountpoint.strip_prefix(root).map_err(|_| {
        DownloadError::new(
            ErrorCode::Storage,
            "storage pool mountpoint is outside the configured NAS root",
            false,
        )
    })?;
    let root_relative_directory = normalize_relative(root_relative_directory);
    if mountpoint_relative.as_os_str().is_empty() {
        return Ok(root_relative_directory);
    }
    root_relative_directory
        .strip_prefix(mountpoint_relative)
        .map(normalize_relative)
        .map_err(|_| {
            DownloadError::new(
                ErrorCode::Storage,
                "download target is outside the selected storage pool",
                false,
            )
        })
}

#[cfg(target_os = "linux")]
fn open_directory_beneath(
    mount: &File,
    relative: &Path,
    _fallback: &Path,
) -> Result<File, DownloadError> {
    let path = if relative.as_os_str().is_empty() {
        Path::new(".")
    } else {
        relative
    };
    let how = OpenHow::new()
        .flags(OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC)
        .resolve(
            ResolveFlag::RESOLVE_BENEATH
                | ResolveFlag::RESOLVE_NO_SYMLINKS
                | ResolveFlag::RESOLVE_NO_MAGICLINKS
                | ResolveFlag::RESOLVE_NO_XDEV,
        );
    openat2(mount, path, how)
        .map(File::from)
        .map_err(DownloadError::storage)
}

#[cfg(not(target_os = "linux"))]
fn open_directory_beneath(
    _mount: &File,
    _relative: &Path,
    fallback: &Path,
) -> Result<File, DownloadError> {
    OpenOptions::new()
        .read(true)
        .open(fallback)
        .map_err(DownloadError::storage)
}

#[cfg(target_os = "linux")]
fn open_file_beneath(
    directory: &File,
    name: &OsStr,
    flags: OFlag,
    mode: Mode,
) -> Result<File, DownloadError> {
    let how = OpenHow::new().flags(flags).mode(mode).resolve(
        ResolveFlag::RESOLVE_BENEATH
            | ResolveFlag::RESOLVE_NO_SYMLINKS
            | ResolveFlag::RESOLVE_NO_MAGICLINKS
            | ResolveFlag::RESOLVE_NO_XDEV,
    );
    openat2(directory, Path::new(name), how)
        .map(File::from)
        .map_err(DownloadError::storage)
}

#[cfg(not(target_os = "linux"))]
fn open_file_beneath(
    directory: &File,
    name: &OsStr,
    flags: OFlag,
    mode: Mode,
) -> Result<File, DownloadError> {
    openat(directory, Path::new(name), flags, mode)
        .map(File::from)
        .map_err(DownloadError::storage)
}

#[cfg(target_os = "linux")]
fn rename_no_replace(
    directory: &File,
    source: &OsStr,
    target: &OsStr,
) -> Result<(), DownloadError> {
    renameat2(
        directory,
        Path::new(source),
        directory,
        Path::new(target),
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|error| {
        if error == nix::errno::Errno::EEXIST {
            DownloadError::new(
                ErrorCode::TargetConflict,
                "download target already exists",
                false,
            )
        } else {
            DownloadError::storage(error)
        }
    })
}

#[cfg(not(target_os = "linux"))]
fn rename_no_replace(
    directory: &File,
    source: &OsStr,
    target: &OsStr,
) -> Result<(), DownloadError> {
    use std::os::fd::AsRawFd;
    let base = PathBuf::from(format!("/dev/fd/{}", directory.as_raw_fd()));
    if base.join(target).exists() {
        return Err(DownloadError::new(
            ErrorCode::TargetConflict,
            "download target already exists",
            false,
        ));
    }
    std::fs::rename(base.join(source), base.join(target)).map_err(DownloadError::storage)
}

#[cfg(target_os = "linux")]
fn unlink_beneath(directory: &File, _fallback: &Path, name: &OsStr) -> Result<(), DownloadError> {
    use nix::unistd::{UnlinkatFlags, unlinkat};
    match unlinkat(directory, Path::new(name), UnlinkatFlags::NoRemoveDir) {
        Ok(()) | Err(nix::errno::Errno::ENOENT) => Ok(()),
        Err(error) => Err(DownloadError::storage(error)),
    }
}

#[cfg(not(target_os = "linux"))]
fn unlink_beneath(_directory: &File, fallback: &Path, name: &OsStr) -> Result<(), DownloadError> {
    match std::fs::remove_file(fallback.join(name)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(DownloadError::storage(error)),
    }
}

fn identity(metadata: &std::fs::Metadata) -> FileIdentity {
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
    }
}

#[cfg(target_os = "linux")]
fn find_mountpoint(storage_pool_id: &str, root: &Path) -> Result<PathBuf, DownloadError> {
    let mountinfo =
        std::fs::read_to_string("/proc/self/mountinfo").map_err(DownloadError::storage)?;
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
        let source_matches = source == storage_pool_id
            || requested.as_ref().is_some_and(|requested| {
                std::fs::canonicalize(&source).ok().as_ref() == Some(requested)
            });
        if source_matches {
            return Ok(PathBuf::from(unescape_mount_field(left_fields[4])));
        }
    }
    if std::fs::canonicalize(storage_pool_id).ok().as_deref() == Some(root) {
        return Ok(root.to_owned());
    }
    Err(DownloadError::new(
        ErrorCode::Storage,
        "storage pool is not mounted",
        true,
    ))
}

#[cfg(not(target_os = "linux"))]
fn find_mountpoint(_storage_pool_id: &str, root: &Path) -> Result<PathBuf, DownloadError> {
    Ok(root.to_owned())
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
    fn rejects_parent_and_absolute_paths() {
        assert!(validate_relative_path(Path::new("downloads/file.bin")).is_ok());
        assert!(validate_relative_path(Path::new("../file.bin")).is_err());
        assert!(validate_relative_path(Path::new("/tmp/file.bin")).is_err());
    }

    #[test]
    fn decodes_mountinfo_paths() {
        assert_eq!(unescape_mount_field("/mnt/My\\040NAS"), "/mnt/My NAS");
    }

    #[test]
    fn converts_root_relative_paths_to_mount_relative_paths() {
        assert_eq!(
            relative_directory_within_mount(
                Path::new("/zos/data/primary"),
                Path::new("/zos/data/primary/pool-a"),
                Path::new("pool-a/downloads"),
            )
            .unwrap(),
            PathBuf::from("downloads")
        );
        assert_eq!(
            relative_directory_within_mount(
                Path::new("/zos/data/primary"),
                Path::new("/zos/data/primary"),
                Path::new("downloads"),
            )
            .unwrap(),
            PathBuf::from("downloads")
        );
        assert!(
            relative_directory_within_mount(
                Path::new("/zos/data/primary"),
                Path::new("/zos/data/primary/pool-a"),
                Path::new("pool-b/downloads"),
            )
            .is_err()
        );
    }
}
