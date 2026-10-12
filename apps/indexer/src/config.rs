use std::env;
use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, IndexerError};

pub const DEFAULT_CONFIG_PATH: &str = "/etc/sigmaos/config.toml";

#[derive(Debug, Clone)]
pub struct Config {
    pub database_path: PathBuf,
}

impl Config {
    pub fn load() -> Result<Self, IndexerError> {
        if let Some(path) = env::var_os("SIGMAOS_DATABASE_PATH") {
            return Ok(Self {
                database_path: PathBuf::from(path),
            });
        }
        let config_path = env::var_os("SIGMAOS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
        let data_dir = match env::var_os("SIGMAOS_DATA_DIR") {
            Some(path) => PathBuf::from(path),
            None if config_path.exists() => data_dir_from_file(&config_path)?,
            None => PathBuf::from(".sigmaos"),
        };
        Ok(Self {
            database_path: data_dir.join("sigmaos.sqlite"),
        })
    }
}

fn data_dir_from_file(path: &Path) -> Result<PathBuf, IndexerError> {
    let text = std::fs::read_to_string(path).map_err(IndexerError::storage)?;
    let document = text.parse::<toml_edit::DocumentMut>().map_err(|error| {
        IndexerError::new(
            ErrorCode::Internal,
            format!("Invalid SigmaOS config: {error}"),
            false,
        )
    })?;
    Ok(document
        .get("data_dir")
        .and_then(toml_edit::Item::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".sigmaos")))
}
