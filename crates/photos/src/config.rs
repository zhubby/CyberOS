use std::env;
use std::fs::{File, OpenOptions};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, PhotosError};

pub const DEFAULT_CONFIG_PATH: &str = "/cyberos/config/config.toml";

#[derive(Debug, Clone)]
pub struct Config {
    pub database_path: PathBuf,
    pub data_root: PathBuf,
    pub cache_root: PathBuf,
    pub production: bool,
}

impl Config {
    pub fn load() -> Result<Self, PhotosError> {
        let config_path = env::var_os("CYBEROS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
        let root_dir = match env::var_os("CYBEROS_ROOT") {
            Some(path) => PathBuf::from(path),
            None if config_path.exists() => root_dir_from_file(&config_path)?,
            None => PathBuf::from(".cyberos/dev-root"),
        };
        let data_dir = root_dir.join("state");
        let database_path = data_dir.join("cyberos.sqlite");
        Ok(Self {
            database_path,
            data_root: root_dir.join("data"),
            cache_root: data_dir.join("photos"),
            production: env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production"),
        })
    }
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

fn root_dir_from_file(path: &Path) -> Result<PathBuf, PhotosError> {
    let text = std::fs::read_to_string(path).map_err(PhotosError::storage)?;
    let document = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| PhotosError::internal(format!("Invalid CyberOS config: {error}")))?;
    Ok(document
        .get("root_dir")
        .and_then(toml_edit::Item::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".cyberos/dev-root")))
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
