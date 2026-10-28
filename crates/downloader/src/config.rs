use std::env;
use std::path::{Path, PathBuf};

use crate::error::{DownloadError, ErrorCode};

pub const DEFAULT_CONFIG_PATH: &str = "/cyberos/config/config.toml";

#[derive(Debug, Clone)]
pub struct Config {
    pub database_path: PathBuf,
    pub data_root: PathBuf,
    pub production: bool,
}

impl Config {
    pub fn load() -> Result<Self, DownloadError> {
        let config_path = env::var_os("CYBEROS_CONFIG")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH));
        let root_dir = resolve_root_dir(&config_path, env::var_os("CYBEROS_ROOT"))?;
        Ok(Self {
            database_path: root_dir.join("state/cyberos.sqlite"),
            data_root: root_dir.join("data"),
            production: env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production"),
        })
    }
}

fn resolve_root_dir(
    config_path: &Path,
    environment_override: Option<std::ffi::OsString>,
) -> Result<PathBuf, DownloadError> {
    match environment_override {
        Some(path) => Ok(PathBuf::from(path)),
        None if config_path.exists() => root_dir_from_file(config_path),
        None => Ok(PathBuf::from(".cyberos/dev-root")),
    }
}

fn root_dir_from_file(path: &Path) -> Result<PathBuf, DownloadError> {
    let text = std::fs::read_to_string(path).map_err(DownloadError::storage)?;
    let document = text.parse::<toml_edit::DocumentMut>().map_err(|error| {
        DownloadError::new(
            ErrorCode::Internal,
            format!("invalid CyberOS config: {error}"),
            false,
        )
    })?;
    Ok(document
        .get("root_dir")
        .and_then(toml_edit::Item::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".cyberos/dev-root")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_root_directory_overrides_the_config_file() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        std::fs::write(&config, "root_dir = '/production'\n").unwrap();
        assert_eq!(
            resolve_root_dir(&config, Some("/isolated".into())).unwrap(),
            PathBuf::from("/isolated")
        );
        assert_eq!(
            resolve_root_dir(&config, None).unwrap(),
            PathBuf::from("/production")
        );
    }
}
