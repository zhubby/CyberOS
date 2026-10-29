use std::env;
use std::path::PathBuf;

use crate::error::DownloadError;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_path: PathBuf,
    pub data_root: PathBuf,
    pub production: bool,
}

impl Config {
    pub fn load() -> Result<Self, DownloadError> {
        let production = env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production");
        let root_dir = resolve_root_dir(env::var_os("CYBEROS_ROOT"), production)?;
        Ok(Self {
            database_path: root_dir.join("state/cyberos.sqlite"),
            data_root: root_dir.join("data"),
            production,
        })
    }
}

fn resolve_root_dir(
    environment_override: Option<std::ffi::OsString>,
    production: bool,
) -> Result<PathBuf, DownloadError> {
    let root = environment_override.map(PathBuf::from).unwrap_or_else(|| {
        if production {
            PathBuf::from("/cyberos")
        } else {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(".cyberos/dev-root")
        }
    });
    validate_root(root, production)
}

fn validate_root(root: PathBuf, production: bool) -> Result<PathBuf, DownloadError> {
    if !root.is_absolute() {
        return Err(DownloadError::new(
            crate::error::ErrorCode::Internal,
            "CYBEROS_ROOT must be an absolute path",
            false,
        ));
    }
    if production && root != std::path::Path::new("/cyberos") {
        return Err(DownloadError::new(
            crate::error::ErrorCode::Internal,
            "production CyberOS root must be /cyberos",
            false,
        ));
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_root_directory_overrides_the_default() {
        assert_eq!(
            resolve_root_dir(Some("/isolated".into()), false).unwrap(),
            PathBuf::from("/isolated")
        );
    }

    #[test]
    fn production_rejects_a_nonstandard_root() {
        assert!(resolve_root_dir(Some("/isolated".into()), true).is_err());
        assert_eq!(
            resolve_root_dir(Some("/cyberos".into()), true).unwrap(),
            PathBuf::from("/cyberos")
        );
    }
}
