use std::env;
use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, IndexerError};

pub const DEFAULT_CONFIG_PATH: &str = "/zos/config/config.toml";

#[derive(Debug, Clone)]
pub struct Config {
    pub database_path: PathBuf,
}

impl Config {
    pub fn load() -> Result<Self, IndexerError> {
        let config_path = env::var_os("ZOS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
        let root_dir = match env::var_os("ZOS_ROOT") {
            Some(path) => PathBuf::from(path),
            None if config_path.exists() => root_dir_from_file(&config_path)?,
            None => PathBuf::from(".zos/dev-root"),
        };
        Ok(Self {
            database_path: root_dir.join("state/zos.sqlite"),
        })
    }
}

fn root_dir_from_file(path: &Path) -> Result<PathBuf, IndexerError> {
    let text = std::fs::read_to_string(path).map_err(IndexerError::storage)?;
    let document = text.parse::<toml_edit::DocumentMut>().map_err(|error| {
        IndexerError::new(
            ErrorCode::Internal,
            format!("Invalid ZOS config: {error}"),
            false,
        )
    })?;
    Ok(document
        .get("root_dir")
        .and_then(toml_edit::Item::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".zos/dev-root")))
}
