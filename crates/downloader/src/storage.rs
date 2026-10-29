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
use nix::sys::stat::mkdirat;
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

#[derive(Debug)]
pub struct TorrentStorageTarget {
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
    pub fn resolve(
        task: &Task,
        data_root: &Path,
        require_mount: bool,
    ) -> Result<Self, DownloadError> {
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
        validate_storage_pool_id(&task.storage_pool_id)?;
        let root = std::fs::canonicalize(data_root).map_err(DownloadError::storage)?;
        let pool_path = root.join(&task.storage_pool_id);
        let metadata = std::fs::symlink_metadata(&pool_path).map_err(DownloadError::storage)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "storage pool must be a real directory",
                false,
            ));
        }
        let mountpoint = std::fs::canonicalize(pool_path).map_err(DownloadError::storage)?;
        if mountpoint != root.join(&task.storage_pool_id) {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "storage pool is not a direct child of the CyberOS data root",
                false,
            ));
        }
        let expected_mount_id = require_exact_mountpoint(&mountpoint, require_mount)?;
        let directory_relative = normalize_relative(Path::new(&task.target_directory));
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
        verify_mount_id(&mount, expected_mount_id)?;
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

impl TorrentStorageTarget {
    pub fn resolve(
        task: &Task,
        data_root: &Path,
        require_mount: bool,
    ) -> Result<Self, DownloadError> {
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
                "torrent staging directory must share the target directory",
                false,
            ));
        }
        let target_name = target_path.file_name().ok_or_else(|| {
            DownloadError::new(ErrorCode::Storage, "torrent target has no name", false)
        })?;
        let partial_name = partial_path.file_name().ok_or_else(|| {
            DownloadError::new(
                ErrorCode::Storage,
                "torrent staging directory has no name",
                false,
            )
        })?;
        if target_name != OsStr::new(&task.target_file_name) {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "torrent target name does not match its target path",
                false,
            ));
        }
        validate_storage_pool_id(&task.storage_pool_id)?;
        let root = std::fs::canonicalize(data_root).map_err(DownloadError::storage)?;
        let pool_path = root.join(&task.storage_pool_id);
        let metadata = std::fs::symlink_metadata(&pool_path).map_err(DownloadError::storage)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "storage pool must be a real directory",
                false,
            ));
        }
        let mountpoint = std::fs::canonicalize(pool_path).map_err(DownloadError::storage)?;
        if mountpoint != root.join(&task.storage_pool_id) {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "storage pool is not a direct child of the CyberOS data root",
                false,
            ));
        }
        let expected_mount_id = require_exact_mountpoint(&mountpoint, require_mount)?;
        let directory_relative = normalize_relative(Path::new(&task.target_directory));
        let mount = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&mountpoint)
            .map_err(DownloadError::storage)?;
        verify_mount_id(&mount, expected_mount_id)?;
        let directory_path = mountpoint.join(&directory_relative);
        let directory = open_directory_beneath(&mount, &directory_relative, &directory_path)?;
        Ok(Self {
            directory,
            directory_path,
            target_name: target_name.to_owned(),
            partial_name: partial_name.to_owned(),
        })
    }

    pub fn prepare_partial(&self) -> Result<PathBuf, DownloadError> {
        if path_exists(&self.directory_path.join(&self.target_name))? {
            return Err(DownloadError::new(
                ErrorCode::TargetConflict,
                "torrent target already exists",
                false,
            ));
        }
        let partial_path = self.directory_path.join(&self.partial_name);
        match std::fs::symlink_metadata(&partial_path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                return Ok(partial_path);
            }
            Ok(_) => {
                return Err(DownloadError::new(
                    ErrorCode::Storage,
                    "torrent staging path is not a real directory",
                    false,
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(DownloadError::storage(error)),
        }
        mkdirat(
            &self.directory,
            Path::new(&self.partial_name),
            Mode::from_bits_truncate(0o700),
        )
        .map_err(DownloadError::storage)?;
        self.directory.sync_all().map_err(DownloadError::storage)?;
        Ok(partial_path)
    }

    pub fn available_bytes(&self) -> Result<u64, DownloadError> {
        let stats = fstatvfs(&self.directory).map_err(DownloadError::storage)?;
        Ok(block_count_to_u64(stats.blocks_available()).saturating_mul(stats.fragment_size()))
    }

    pub fn final_path(&self) -> PathBuf {
        self.directory_path.join(&self.target_name)
    }

    pub fn recover_published_path(&self) -> Result<Option<PathBuf>, DownloadError> {
        let target = self.final_path();
        let metadata = match std::fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(DownloadError::storage(error)),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "published torrent path is not a real directory",
                false,
            ));
        }
        if path_exists(&self.directory_path.join(&self.partial_name))? {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "torrent staging and published directories both exist",
                false,
            ));
        }
        Ok(Some(target))
    }

    pub fn publish(&self) -> Result<(), DownloadError> {
        let partial_path = self.directory_path.join(&self.partial_name);
        let partial = std::fs::symlink_metadata(&partial_path).map_err(DownloadError::storage)?;
        if !partial.is_dir() || partial.file_type().is_symlink() {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "torrent staging path changed before publication",
                false,
            ));
        }
        normalize_torrent_tree(&partial_path)?;
        if path_exists(&self.directory_path.join(&self.target_name))? {
            return Err(DownloadError::new(
                ErrorCode::TargetConflict,
                "torrent target already exists",
                false,
            ));
        }
        rename_directory_no_replace(
            &self.directory,
            &self.directory_path,
            &self.partial_name,
            &self.target_name,
        )?;
        self.directory.sync_all().map_err(DownloadError::storage)
    }

    pub fn remove_partial(&self) -> Result<(), DownloadError> {
        let partial = self.directory_path.join(&self.partial_name);
        match std::fs::symlink_metadata(&partial) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                std::fs::remove_dir_all(partial).map_err(DownloadError::storage)?;
                self.directory.sync_all().map_err(DownloadError::storage)
            }
            Ok(_) => Err(DownloadError::new(
                ErrorCode::Storage,
                "torrent staging path is not a real directory",
                false,
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(DownloadError::storage(error)),
        }
    }
}

fn normalize_torrent_tree(directory: &Path) -> Result<(), DownloadError> {
    for entry in std::fs::read_dir(directory).map_err(DownloadError::storage)? {
        let entry = entry.map_err(DownloadError::storage)?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(DownloadError::storage)?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "torrent staging directory contains a symbolic link",
                false,
            ));
        }
        if file_type.is_dir() {
            normalize_torrent_tree(&path)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o770))
                .map_err(DownloadError::storage)?;
            continue;
        }
        if file_type.is_file() {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660))
                .map_err(DownloadError::storage)?;
            continue;
        }
        return Err(DownloadError::new(
            ErrorCode::Storage,
            "torrent staging directory contains a special file",
            false,
        ));
    }
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o770))
        .map_err(DownloadError::storage)
}

fn path_exists(path: &Path) -> Result<bool, DownloadError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(DownloadError::storage(error)),
    }
}

#[cfg(target_os = "linux")]
fn rename_directory_no_replace(
    directory: &File,
    _directory_path: &Path,
    source: &OsStr,
    target: &OsStr,
) -> Result<(), DownloadError> {
    rename_no_replace(directory, source, target)
}

#[cfg(not(target_os = "linux"))]
fn rename_directory_no_replace(
    _directory: &File,
    directory_path: &Path,
    source: &OsStr,
    target: &OsStr,
) -> Result<(), DownloadError> {
    let target_path = directory_path.join(target);
    if path_exists(&target_path)? {
        return Err(DownloadError::new(
            ErrorCode::TargetConflict,
            "torrent target already exists",
            false,
        ));
    }
    std::fs::rename(directory_path.join(source), target_path).map_err(DownloadError::storage)
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

fn require_exact_mountpoint(_path: &Path, required: bool) -> Result<Option<u64>, DownloadError> {
    if !required {
        return Ok(None);
    }
    #[cfg(target_os = "linux")]
    {
        // systemd may stack a writable bind mount over the pool mount. Resolve
        // the visible mount through a descriptor instead of trusting table order.
        // The caller opens it again and verifies this ID to detect replacement.
        let mount = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(_path)
            .map_err(DownloadError::storage)?;
        let visible_id = read_mount_id(&mount)?;
        let mountinfo =
            std::fs::read_to_string("/proc/self/mountinfo").map_err(DownloadError::storage)?;
        if let Some(mount_id) = exact_mount_id(&mountinfo, _path, visible_id) {
            return Ok(Some(mount_id));
        }
    }
    Err(DownloadError::new(
        ErrorCode::Storage,
        "storage pool is not mounted",
        true,
    ))
}

#[cfg(any(target_os = "linux", test))]
fn exact_mount_id(mountinfo: &str, path: &Path, visible_id: u64) -> Option<u64> {
    mountinfo.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let mount_id = fields.next()?.parse().ok()?;
        let mountpoint = fields.nth(3).map(unescape_mount_field)?;
        (mount_id == visible_id && Path::new(&mountpoint) == path).then_some(mount_id)
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
fn read_mount_id(file: &File) -> Result<u64, DownloadError> {
    let fdinfo = std::fs::read_to_string(format!("/proc/self/fdinfo/{}", file.as_raw_fd()))
        .map_err(DownloadError::storage)?;
    fdinfo
        .lines()
        .find_map(|line| line.strip_prefix("mnt_id:").map(str::trim))
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| {
            DownloadError::new(
                ErrorCode::Storage,
                "storage pool descriptor has no mount identity",
                true,
            )
        })
}

#[cfg(target_os = "linux")]
fn verify_mount_id(file: &File, expected: Option<u64>) -> Result<(), DownloadError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    if read_mount_id(file)? == expected {
        Ok(())
    } else {
        Err(DownloadError::new(
            ErrorCode::Storage,
            "storage pool mount changed while opening the download target",
            true,
        ))
    }
}

#[cfg(not(target_os = "linux"))]
fn verify_mount_id(_file: &File, _expected: Option<u64>) -> Result<(), DownloadError> {
    Ok(())
}

fn validate_storage_pool_id(storage_pool_id: &str) -> Result<(), DownloadError> {
    let path = Path::new(storage_pool_id);
    if storage_pool_id.is_empty()
        || path.is_absolute()
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(DownloadError::new(
            ErrorCode::Storage,
            "invalid storage pool id",
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
    fn accepts_only_single_component_storage_pool_ids() {
        assert!(validate_storage_pool_id("pool-a").is_ok());
        assert!(validate_storage_pool_id("../pool-a").is_err());
        assert!(validate_storage_pool_id("nested/pool-a").is_err());
        assert!(validate_storage_pool_id("").is_err());
    }

    #[test]
    fn recognizes_only_the_exact_pool_mountpoint() {
        let mountinfo = concat!(
            "22 1 8:1 / / rw - ext4 /dev/root rw\n",
            "23 22 8:2 / /cyberos/data/My\\040Pool rw - ext4 /dev/sda1 rw\n",
        );
        assert_eq!(
            exact_mount_id(mountinfo, Path::new("/cyberos/data/My Pool"), 23),
            Some(23)
        );
        assert_eq!(
            exact_mount_id(mountinfo, Path::new("/cyberos/data/My Pool/nested"), 23),
            None
        );
        assert_eq!(
            exact_mount_id(mountinfo, Path::new("/cyberos/data/My Pool"), 22),
            None
        );
    }

    #[test]
    fn selects_the_opened_mount_identity_among_stacked_systemd_mounts() {
        let mountinfo = concat!(
            "1074 1040 0:46 / /cyberos/data/pool1 rw - btrfs /dev/md127 rw\n",
            "1075 1040 259:2 /cyberos/data /cyberos/data rw - ext4 /dev/nvme0n1p2 rw\n",
            "1076 1075 0:46 / /cyberos/data/pool1 rw - btrfs /dev/md127 rw\n",
        );
        let pool = Path::new("/cyberos/data/pool1");
        assert_eq!(exact_mount_id(mountinfo, pool, 1076), Some(1076));
        assert_eq!(exact_mount_id(mountinfo, pool, 1074), Some(1074));
        assert_eq!(exact_mount_id(mountinfo, pool, 1075), None);
        assert_eq!(exact_mount_id(mountinfo, pool, 1077), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_descriptor_mount_identity_changes() {
        let directory = File::open("/").unwrap();
        let id = read_mount_id(&directory).unwrap();
        verify_mount_id(&directory, Some(id)).unwrap();
        assert!(verify_mount_id(&directory, Some(id + 1)).is_err());
    }

    #[test]
    fn torrent_directory_publish_stays_in_pool_and_never_overwrites() {
        let root = tempfile::tempdir().unwrap();
        let pool = root.path().join("pool-1");
        std::fs::create_dir(&pool).unwrap();
        std::fs::create_dir(pool.join("Downloads")).unwrap();
        let task = torrent_task();
        let target = TorrentStorageTarget::resolve(&task, root.path(), false).unwrap();
        let staging = target.prepare_partial().unwrap();
        std::fs::write(staging.join("file.bin"), b"new").unwrap();
        target.publish().unwrap();
        assert_eq!(
            std::fs::metadata(pool.join("Downloads/release"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o770
        );
        assert_eq!(
            std::fs::metadata(pool.join("Downloads/release/file.bin"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o660
        );
        assert_eq!(
            target.recover_published_path().unwrap(),
            Some(
                std::fs::canonicalize(&pool)
                    .unwrap()
                    .join("Downloads/release")
            )
        );
        assert_eq!(
            std::fs::read(pool.join("Downloads/release/file.bin")).unwrap(),
            b"new"
        );

        let target = TorrentStorageTarget::resolve(&task, root.path(), false).unwrap();
        assert!(target.prepare_partial().is_err());
        assert_eq!(
            std::fs::read(pool.join("Downloads/release/file.bin")).unwrap(),
            b"new"
        );
    }

    #[test]
    fn torrent_publish_rejects_symlinks_inside_the_staging_directory() {
        let root = tempfile::tempdir().unwrap();
        let pool = root.path().join("pool-1");
        std::fs::create_dir(&pool).unwrap();
        std::fs::create_dir(pool.join("Downloads")).unwrap();
        let outside = root.path().join("outside.bin");
        std::fs::write(&outside, b"outside").unwrap();
        let target = TorrentStorageTarget::resolve(&torrent_task(), root.path(), false).unwrap();
        let staging = target.prepare_partial().unwrap();
        std::os::unix::fs::symlink(&outside, staging.join("linked.bin")).unwrap();

        let error = target.publish().unwrap_err();

        assert_eq!(error.code, ErrorCode::Storage);
        assert!(error.to_string().contains("symbolic link"));
        assert!(!pool.join("Downloads/release").exists());
        assert_eq!(std::fs::read(outside).unwrap(), b"outside");
    }

    fn torrent_task() -> Task {
        Task {
            id: "torrent".to_owned(),
            url: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789".to_owned(),
            storage_pool_id: "pool-1".to_owned(),
            target_directory: "Downloads".to_owned(),
            target_file_name: "release".to_owned(),
            target_path: "Downloads/release".to_owned(),
            partial_path: "Downloads/.release.cyberos-part".to_owned(),
            status: "running".to_owned(),
            received_bytes: 0,
            total_bytes: Some(3),
            speed_bytes_per_second: 0,
            etag: None,
            last_modified: None,
            worker_id: Some("worker".to_owned()),
            lease_expires_at: None,
            phase: None,
            download_mode: Some("torrent".to_owned()),
            expected_sha256: None,
            actual_sha256: None,
            retry_count: 0,
            next_retry_at: None,
            control_requested: None,
            segment_count: 0,
            source_kind: "magnet".to_owned(),
            torrent_info_hash: Some("0123456789012345678901234567890123456789".to_owned()),
            torrent_name: Some("release".to_owned()),
            torrent_metainfo: Some(b"torrent".to_vec()),
            selected_file_count: 1,
            selected_file_indices: vec![0],
            uploaded_bytes: 0,
            upload_speed_bytes_per_second: 0,
            peer_count: 0,
            seed_ratio_limit: 1.0,
            seed_time_limit_seconds: 7_200,
            content_completed_at: None,
            seed_started_at: None,
            engine_torrent_id: None,
        }
    }
}
