use std::env;
use std::path::PathBuf;

use crate::error::TransferError;

pub struct Config {
    pub database_path: PathBuf,
    pub data_root: PathBuf,
    pub incoming_path: PathBuf,
    pub production: bool,
}

impl Config {
    pub fn load() -> Result<Self, TransferError> {
        let production = env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production");
        let root = resolve_root_dir(env::var_os("CYBEROS_ROOT"), production, env::current_dir()?)?;
        Ok(Self {
            database_path: root.join("state/cyberos.sqlite"),
            data_root: root.join("data"),
            incoming_path: root.join("state/bluetooth/incoming"),
            production,
        })
    }
}

fn resolve_root_dir(
    environment_root: Option<std::ffi::OsString>,
    production: bool,
    current_dir: PathBuf,
) -> Result<PathBuf, TransferError> {
    let root = environment_root.map(PathBuf::from).unwrap_or_else(|| {
        if production {
            PathBuf::from("/cyberos")
        } else {
            current_dir.join(".cyberos/dev-root")
        }
    });
    if !root.is_absolute() {
        return Err(TransferError(
            "CYBEROS_ROOT must be an absolute path".to_owned(),
        ));
    }
    if production && root != std::path::Path::new("/cyberos") {
        return Err(TransferError(
            "production CyberOS root must be /cyberos".to_owned(),
        ));
    }
    Ok(root)
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
