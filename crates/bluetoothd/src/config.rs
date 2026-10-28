use std::env;
use std::path::{Path, PathBuf};

use crate::error::TransferError;

pub struct Config {
    pub database_path: PathBuf,
    pub data_root: PathBuf,
    pub incoming_path: PathBuf,
    pub production: bool,
}

impl Config {
    pub fn load() -> Result<Self, TransferError> {
        let config_path = env::var_os("CYBEROS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/cyberos/config/config.toml"));
        let root = match env::var_os("CYBEROS_ROOT") {
            Some(path) => PathBuf::from(path),
            None if config_path.exists() => root_from_file(&config_path)?,
            None => PathBuf::from(".cyberos/dev-root"),
        };
        Ok(Self {
            database_path: root.join("state/cyberos.sqlite"),
            data_root: root.join("data"),
            incoming_path: root.join("state/bluetooth/incoming"),
            production: env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production"),
        })
    }
}

fn root_from_file(path: &Path) -> Result<PathBuf, TransferError> {
    let text = std::fs::read_to_string(path)?;
    let document = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| TransferError(format!("invalid CyberOS config: {error}")))?;
    Ok(document
        .get("root_dir")
        .and_then(toml_edit::Item::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".cyberos/dev-root")))
}
