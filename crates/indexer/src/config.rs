use std::env;
use std::path::PathBuf;

use crate::error::IndexerError;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_path: PathBuf,
    pub data_root: PathBuf,
    pub production: bool,
}

impl Config {
    pub fn load() -> Result<Self, IndexerError> {
        let production = env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production");
        let root_dir = root_dir(env::var_os("CYBEROS_ROOT"), production, env::current_dir()?)?;
        Ok(Self {
            database_path: root_dir.join("state/cyberos.sqlite"),
            data_root: root_dir.join("data"),
            production,
        })
    }
}

fn root_dir(
    environment_root: Option<std::ffi::OsString>,
    production: bool,
    current_dir: PathBuf,
) -> Result<PathBuf, IndexerError> {
    let root = environment_root.map(PathBuf::from).unwrap_or_else(|| {
        if production {
            PathBuf::from("/cyberos")
        } else {
            current_dir.join(".cyberos/dev-root")
        }
    });
    if !root.is_absolute() {
        return Err(IndexerError::internal(
            "CYBEROS_ROOT must be an absolute path",
        ));
    }
    if production && root != std::path::Path::new("/cyberos") {
        return Err(IndexerError::internal(
            "production CyberOS root must be /cyberos",
        ));
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_rejects_a_nonstandard_root() {
        assert!(root_dir(Some("/isolated".into()), true, PathBuf::from("/workspace")).is_err());
        assert_eq!(
            root_dir(Some("/cyberos".into()), true, PathBuf::from("/workspace")).unwrap(),
            PathBuf::from("/cyberos")
        );
    }
}
