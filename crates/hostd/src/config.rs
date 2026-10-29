use std::env;
use std::path::{Path, PathBuf};

use crate::error::HostdError;

pub const DEFAULT_SOCKET_PATH: &str = "/run/cyberos/hostd.sock";

#[derive(Debug, Clone)]
pub struct HostdConfig {
    pub socket_path: PathBuf,
    pub socket_group: String,
    pub allowed_uids: Vec<u32>,
    pub data_root: PathBuf,
}

impl HostdConfig {
    pub fn load() -> Result<Self, HostdError> {
        let current_directory = env::current_dir()?;
        let production = env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production");
        let data_root = resolve_data_root(
            env::var("CYBEROS_ROOT").ok(),
            &current_directory,
            production,
        )?;
        let cyberos_uid = nix::unistd::User::from_name("cyberos")
            .map_err(|error| HostdError::unavailable(error.to_string()))?
            .map(|user| user.uid.as_raw())
            .unwrap_or_else(|| nix::unistd::Uid::current().as_raw());
        Ok(Self {
            socket_path: PathBuf::from(DEFAULT_SOCKET_PATH),
            socket_group: "cyberos".to_owned(),
            allowed_uids: vec![0, cyberos_uid],
            data_root,
        })
    }
}

fn resolve_data_root(
    environment_root: Option<String>,
    current_directory: &Path,
    production: bool,
) -> Result<PathBuf, HostdError> {
    let root = environment_root.unwrap_or_else(|| {
        if production {
            "/cyberos".to_owned()
        } else {
            current_directory
                .join(".cyberos/dev-root")
                .display()
                .to_string()
        }
    });
    if root.trim().is_empty() {
        return Err(HostdError::validation(
            "CyberOS root path must not be empty",
        ));
    }
    let root = PathBuf::from(root);
    if !root.is_absolute() {
        return Err(HostdError::validation("CyberOS root path must be absolute"));
    }
    if production && root != std::path::Path::new("/cyberos") {
        return Err(HostdError::validation(
            "production CyberOS root must be /cyberos",
        ));
    }
    Ok(root.join("data"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_data_root_from_bootstrap_root() {
        assert_eq!(
            resolve_data_root(
                Some("/srv/cyberos".to_owned()),
                Path::new("/workspace"),
                false,
            )
            .unwrap(),
            PathBuf::from("/srv/cyberos/data")
        );
        assert!(
            resolve_data_root(Some("relative".to_owned()), Path::new("/workspace"), false).is_err()
        );
    }

    #[test]
    fn rejects_empty_data_root() {
        assert!(resolve_data_root(Some("  ".to_owned()), Path::new("/workspace"), false).is_err());
    }

    #[test]
    fn production_rejects_a_nonstandard_root() {
        assert!(
            resolve_data_root(
                Some("/srv/cyberos".to_owned()),
                Path::new("/workspace"),
                true
            )
            .is_err()
        );
        assert_eq!(
            resolve_data_root(Some("/cyberos".to_owned()), Path::new("/workspace"), true,).unwrap(),
            PathBuf::from("/cyberos/data")
        );
    }
}
