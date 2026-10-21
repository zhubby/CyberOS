use std::env;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, PhotostaffError};

pub const DEFAULT_CONFIG_PATH: &str = "/zos/config/config.toml";

#[derive(Debug, Clone)]
pub struct Config {
    pub database_path: PathBuf,
    pub cache_root: PathBuf,
}

impl Config {
    pub fn load() -> Result<Self, PhotostaffError> {
        let config_path = env::var_os("ZOS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
        let root_dir = match env::var_os("ZOS_ROOT") {
            Some(path) => PathBuf::from(path),
            None if config_path.exists() => root_dir_from_file(&config_path)?,
            None => PathBuf::from(".zos/dev-root"),
        };
        let data_dir = root_dir.join("state");
        let database_path = data_dir.join("zos.sqlite");
        Ok(Self {
            database_path,
            cache_root: data_dir.join("photostaff"),
        })
    }
}

pub fn verify_tools() -> Result<(), PhotostaffError> {
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
            return Err(PhotostaffError::new(
                ErrorCode::ToolUnavailable,
                format!("Required media tool is unavailable: {tool}"),
                true,
            ));
        }
    }
    Ok(())
}

fn root_dir_from_file(path: &Path) -> Result<PathBuf, PhotostaffError> {
    let text = std::fs::read_to_string(path).map_err(PhotostaffError::storage)?;
    let document = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| PhotostaffError::internal(format!("Invalid ZOS config: {error}")))?;
    Ok(document
        .get("root_dir")
        .and_then(toml_edit::Item::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".zos/dev-root")))
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

fn sync_parent(path: &Path) -> Result<(), PhotostaffError> {
    let parent = path
        .parent()
        .ok_or_else(|| PhotostaffError::internal("Cache has no parent"))?;
    let directory = OpenOptions::new()
        .read(true)
        .open(parent)
        .map_err(PhotostaffError::storage)?;
    directory.sync_all().map_err(PhotostaffError::storage)
}

pub fn sync_file_and_parent(path: &Path) -> Result<(), PhotostaffError> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(PhotostaffError::storage)?;
    sync_parent(path)
}
