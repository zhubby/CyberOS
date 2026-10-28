use std::env;
use std::path::{Path, PathBuf};

use crate::error::{ErrorCode, IndexerError};

pub const DEFAULT_CONFIG_PATH: &str = "/cyberos/config/config.toml";

#[derive(Debug, Clone)]
pub struct Config {
    pub database_path: PathBuf,
    pub data_root: PathBuf,
    pub production: bool,
}

impl Config {
    pub fn load() -> Result<Self, IndexerError> {
        let config_path = env::var_os("CYBEROS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
        let root_dir = match env::var_os("CYBEROS_ROOT") {
            Some(path) => PathBuf::from(path),
            None if config_path.exists() => root_dir_from_file(&config_path)?,
            None => PathBuf::from(".cyberos/dev-root"),
        };
        Ok(Self {
            database_path: root_dir.join("state/cyberos.sqlite"),
            data_root: root_dir.join("data"),
            production: env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production"),
        })
    }
}

fn root_dir_from_file(path: &Path) -> Result<PathBuf, IndexerError> {
    let text = std::fs::read_to_string(path).map_err(IndexerError::storage)?;
    let document = text.parse::<toml_edit::DocumentMut>().map_err(|error| {
        IndexerError::new(
            ErrorCode::Internal,
            format!("Invalid CyberOS config: {error}"),
            false,
        )
    })?;
    Ok(document
        .get("root_dir")
        .and_then(toml_edit::Item::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".cyberos/dev-root")))
}
