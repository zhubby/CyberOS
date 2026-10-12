use std::fs::{File, OpenOptions};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use nix::fcntl::OFlag;
#[cfg(not(target_os = "linux"))]
use nix::fcntl::openat;
#[cfg(target_os = "linux")]
use nix::fcntl::{OpenHow, ResolveFlag, openat2};
use nix::sys::stat::Mode;
use serde::Deserialize;

use crate::error::{ErrorCode, IndexerError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
    pub size: u64,
    pub mtime_ns: i64,
    pub ctime_ns: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountIdentity {
    pub source: Option<String>,
    pub uuid: Option<String>,
    pub fstype: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FindmntOutput {
    #[serde(default)]
    filesystems: Vec<FindmntFilesystem>,
}

#[derive(Debug, Deserialize)]
struct FindmntFilesystem {
    source: Option<String>,
    uuid: Option<String>,
    fstype: Option<String>,
    target: Option<String>,
}

pub async fn probe_mount_identity(
    root_path: &Path,
    mount_policy: &str,
    expected_source: Option<&str>,
    expected_uuid: Option<&str>,
    expected_fstype: Option<&str>,
) -> Result<Option<MountIdentity>, IndexerError> {
    if mount_policy != "required" {
        return Ok(None);
    }
    let mut command = tokio::process::Command::new("findmnt");
    command
        .args(["--json", "--target"])
        .arg(root_path)
        .args(["--output", "SOURCE,UUID,FSTYPE,TARGET"])
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| {
            IndexerError::new(
                ErrorCode::CommandTimeout,
                "findmnt exceeded the mount probe timeout",
                true,
            )
        })?
        .map_err(|_| IndexerError::new(ErrorCode::ToolUnavailable, "findmnt unavailable", true))?;
    if !output.status.success() {
        return Err(IndexerError::new(
            ErrorCode::StorageUnavailable,
            "findmnt could not resolve NAS mount identity",
            true,
        ));
    }
    let stdout = String::from_utf8(output.stdout).map_err(|_| {
        IndexerError::new(
            ErrorCode::StorageUnavailable,
            "findmnt returned invalid UTF-8",
            true,
        )
    })?;
    let row = parse_findmnt(&stdout).ok_or_else(|| {
        IndexerError::new(
            ErrorCode::StorageUnavailable,
            "unable to parse mount identity",
            true,
        )
    })?;
    let target = row.target.as_deref().ok_or_else(|| {
        IndexerError::new(
            ErrorCode::StorageUnavailable,
            "mount target is missing",
            true,
        )
    })?;
    let root = std::fs::canonicalize(root_path).map_err(IndexerError::storage)?;
    let target = std::fs::canonicalize(target).map_err(IndexerError::storage)?;
    let covered = root == target || root.starts_with(&target);
    let matches = covered
        && expected_source.is_none_or(|value| row.source.as_deref() == Some(value))
        && expected_uuid.is_none_or(|value| row.uuid.as_deref() == Some(value))
        && expected_fstype.is_none_or(|value| row.fstype.as_deref() == Some(value));
    if !matches {
        return Err(IndexerError::new(
            ErrorCode::SourceChanged,
            if covered {
                "mount identity mismatch"
            } else {
                "path is not covered by a dedicated mount"
            },
            true,
        ));
    }
    Ok(Some(MountIdentity {
        source: row.source,
        uuid: row.uuid,
        fstype: row.fstype,
    }))
}

fn parse_findmnt(output: &str) -> Option<FindmntFilesystem> {
    if let Ok(mut parsed) = serde_json::from_str::<FindmntOutput>(output)
        && !parsed.filesystems.is_empty()
    {
        return Some(parsed.filesystems.remove(0));
    }
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    if line.starts_with("SOURCE") {
        return None;
    }
    let mut parts = line.split_whitespace();
    Some(FindmntFilesystem {
        source: parts.next().map(str::to_owned),
        uuid: parts.next().map(str::to_owned),
        fstype: parts.next().map(str::to_owned),
        target: parts.next().map(str::to_owned),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone)]
pub struct DirectoryEntry {
    pub name: String,
    pub kind: EntryKind,
}

#[derive(Debug)]
pub struct RootStorage {
    root: File,
    path: PathBuf,
    identity: FileIdentity,
}

impl RootStorage {
    pub fn open(path: &Path) -> Result<Self, IndexerError> {
        let metadata = std::fs::symlink_metadata(path).map_err(IndexerError::storage)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(IndexerError::invalid_path(
                "NAS root must be a real directory",
            ));
        }
        let canonical = std::fs::canonicalize(path).map_err(IndexerError::storage)?;
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&canonical)
            .map_err(IndexerError::storage)?;
        let identity = identity(&root.metadata().map_err(IndexerError::storage)?);
        Ok(Self {
            root,
            path: canonical,
            identity,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn initial_identity(&self) -> FileIdentity {
        self.identity
    }

    pub fn verify_unchanged(&self) -> Result<(), IndexerError> {
        let metadata = std::fs::symlink_metadata(&self.path).map_err(IndexerError::storage)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || identity(&metadata) != self.identity
        {
            return Err(IndexerError::new(
                ErrorCode::SourceChanged,
                "mount identity changed during indexing",
                true,
            ));
        }
        Ok(())
    }

    pub fn open_file(&self, relative: &Path) -> Result<File, IndexerError> {
        validate_relative_path(relative)?;
        #[cfg(not(target_os = "linux"))]
        self.verify_fallback_beneath(relative)?;
        let file = open_beneath(
            &self.root,
            relative,
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            false,
            &self.path.join(relative),
        )?;
        let metadata = file.metadata().map_err(IndexerError::storage)?;
        if !metadata.is_file() {
            return Err(IndexerError::invalid_path(
                "Index source is not a regular file",
            ));
        }
        Ok(file)
    }

    pub fn open_directory(&self, relative: &Path) -> Result<File, IndexerError> {
        validate_relative_path(relative)?;
        #[cfg(not(target_os = "linux"))]
        self.verify_fallback_beneath(relative)?;
        open_beneath(
            &self.root,
            relative,
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW,
            true,
            &self.path.join(relative),
        )
    }

    pub fn list_directory(&self, relative: &Path) -> Result<Vec<DirectoryEntry>, IndexerError> {
        let directory = self.open_directory(relative)?;
        #[cfg(target_os = "linux")]
        let descriptor_path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        #[cfg(not(target_os = "linux"))]
        let descriptor_path = {
            drop(directory);
            self.path.join(relative)
        };
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(descriptor_path).map_err(IndexerError::storage)? {
            let entry = entry.map_err(IndexerError::storage)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| IndexerError::invalid_path("Indexer paths must be valid UTF-8"))?;
            let file_type = entry.file_type().map_err(IndexerError::storage)?;
            let kind = if file_type.is_symlink() {
                EntryKind::Symlink
            } else if file_type.is_dir() {
                EntryKind::Directory
            } else if file_type.is_file() {
                EntryKind::File
            } else {
                EntryKind::Other
            };
            entries.push(DirectoryEntry { name, kind });
        }
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(entries)
    }

    pub fn identity_for(&self, relative: &Path) -> Result<FileIdentity, IndexerError> {
        let file = self.open_file(relative)?;
        Self::file_identity(&file)
    }

    pub fn file_identity(file: &File) -> Result<FileIdentity, IndexerError> {
        file.metadata()
            .map(|metadata| identity(&metadata))
            .map_err(IndexerError::storage)
    }

    #[cfg(not(target_os = "linux"))]
    fn verify_fallback_beneath(&self, relative: &Path) -> Result<(), IndexerError> {
        let resolved = self
            .path
            .join(relative)
            .canonicalize()
            .map_err(IndexerError::storage)?;
        if !resolved.starts_with(&self.path) {
            return Err(IndexerError::invalid_path(
                "Resolved path escapes the NAS root",
            ));
        }
        Ok(())
    }
}

pub fn validate_relative_path(path: &Path) -> Result<(), IndexerError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(IndexerError::invalid_path(
            "Path must be relative to the NAS root",
        ));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_) | Component::CurDir) {
            return Err(IndexerError::invalid_path("Path traversal is not allowed"));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_beneath(
    root: &File,
    relative: &Path,
    flags: OFlag,
    _directory: bool,
    _fallback: &Path,
) -> Result<File, IndexerError> {
    let how = OpenHow::new().flags(flags).mode(Mode::empty()).resolve(
        ResolveFlag::RESOLVE_BENEATH
            | ResolveFlag::RESOLVE_NO_SYMLINKS
            | ResolveFlag::RESOLVE_NO_MAGICLINKS,
    );
    openat2(root, relative, how)
        .map(File::from)
        .map_err(IndexerError::storage)
}

#[cfg(not(target_os = "linux"))]
fn open_beneath(
    root: &File,
    relative: &Path,
    flags: OFlag,
    _directory: bool,
    _fallback: &Path,
) -> Result<File, IndexerError> {
    openat(root, relative, flags, Mode::empty())
        .map(File::from)
        .map_err(IndexerError::storage)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_traversal_and_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("ok.txt"), "ok").unwrap();
        std::fs::write(directory.path().join("outside.txt"), "secret").unwrap();
        symlink(directory.path().join("outside.txt"), root.join("link.txt")).unwrap();
        let storage = RootStorage::open(&root).unwrap();

        let opened = storage.open_file(Path::new("ok.txt"));
        assert!(opened.is_ok(), "{opened:?}");
        assert!(storage.open_file(Path::new("../outside.txt")).is_err());
        assert!(storage.open_file(Path::new("link.txt")).is_err());
    }

    #[test]
    fn parses_findmnt_json_identity() {
        let row = parse_findmnt(r#"{"filesystems":[{"source":"/dev/sda1","uuid":"abc","fstype":"ext4","target":"/srv/nas"}]}"#).unwrap();
        assert_eq!(row.source.as_deref(), Some("/dev/sda1"));
        assert_eq!(row.uuid.as_deref(), Some("abc"));
        assert_eq!(row.fstype.as_deref(), Some("ext4"));
        assert_eq!(row.target.as_deref(), Some("/srv/nas"));
    }
}
