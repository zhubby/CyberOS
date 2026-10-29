use std::env;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, PhotosError};

#[derive(Debug, Clone)]
pub struct Config {
    pub database_path: PathBuf,
    pub data_root: PathBuf,
    pub cache_root: PathBuf,
    pub production: bool,
}

impl Config {
    pub fn load() -> Result<Self, PhotosError> {
        let production = env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production");
        let root_dir =
            resolve_root_dir(env::var_os("CYBEROS_ROOT"), production, env::current_dir()?)?;
        let data_dir = root_dir.join("state");
        let database_path = data_dir.join("cyberos.sqlite");
        Ok(Self {
            database_path,
            data_root: root_dir.join("data"),
            cache_root: data_dir.join("photos"),
            production,
        })
    }
}

fn resolve_root_dir(
    environment_root: Option<std::ffi::OsString>,
    production: bool,
    current_dir: PathBuf,
) -> Result<PathBuf, PhotosError> {
    let root = environment_root.map(PathBuf::from).unwrap_or_else(|| {
        if production {
            PathBuf::from("/cyberos")
        } else {
            current_dir.join(".cyberos/dev-root")
        }
    });
    if !root.is_absolute() {
        return Err(PhotosError::internal(
            "CYBEROS_ROOT must be an absolute path",
        ));
    }
    if production && root != std::path::Path::new("/cyberos") {
        return Err(PhotosError::internal(
            "production CyberOS root must be /cyberos",
        ));
    }
    Ok(root)
}

pub fn verify_tools() -> Result<(), PhotosError> {
    for tool in [
        "exiftool",
        "vipsthumbnail",
        "vipsheader",
        "ffprobe",
        "ffmpeg",
        "dcraw_emu",
        "heif-convert",
    ] {
        if find_in_path(tool).is_none() {
            return Err(PhotosError::new(
                ErrorCode::ToolUnavailable,
                format!("Required media tool is unavailable: {tool}"),
                true,
            ));
        }
    }
    Ok(())
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|value| {
        env::split_paths(&value)
            .map(|directory| directory.join(name))
            .find(|candidate| {
                candidate.metadata().is_ok_and(|metadata| {
                    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
                })
            })
    })
}

fn sync_parent(path: &Path) -> Result<(), PhotosError> {
    let parent = path
        .parent()
        .ok_or_else(|| PhotosError::internal("Cache has no parent"))?;
    let directory = OpenOptions::new()
        .read(true)
        .open(parent)
        .map_err(PhotosError::storage)?;
    directory.sync_all().map_err(PhotosError::storage)
}

pub fn sync_file_and_parent(path: &Path) -> Result<(), PhotosError> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(PhotosError::storage)?;
    sync_parent(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_rejects_a_nonstandard_root() {
        assert!(
            resolve_root_dir(Some("/isolated".into()), true, PathBuf::from("/workspace")).is_err()
        );
        assert_eq!(
            resolve_root_dir(Some("/cyberos".into()), true, PathBuf::from("/workspace")).unwrap(),
            PathBuf::from("/cyberos")
        );
    }
}
