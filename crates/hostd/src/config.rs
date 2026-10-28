use std::env;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use crate::error::HostdError;

pub const DEFAULT_SOCKET_PATH: &str = "/run/cyberos/hostd.sock";
pub const DEFAULT_CONFIG_PATH: &str = "/cyberos/config/config.toml";

#[derive(Debug, Clone)]
pub struct HostdConfig {
    pub socket_path: PathBuf,
    pub socket_group: String,
    pub allowed_uids: Vec<u32>,
    pub data_root: PathBuf,
    pub mutation_policy: HostMutationPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostMutationPolicy {
    Mutable,
    Declarative,
}

impl HostMutationPolicy {
    pub fn from_environment(value: Option<String>) -> Result<Self, HostdError> {
        match value.as_deref().unwrap_or("mutable") {
            "mutable" => Ok(Self::Mutable),
            "declarative" => Ok(Self::Declarative),
            _ => Err(HostdError::validation(
                "CYBEROS_HOST_MUTATION_POLICY must be mutable or declarative",
            )),
        }
    }

    pub fn allows_host_configuration_mutation(self) -> bool {
        matches!(self, Self::Mutable)
    }
}

#[derive(Debug, Default, Deserialize)]
struct FileConfig {
    root_dir: Option<String>,
    hostd: Option<FileHostdConfig>,
}

#[derive(Debug, Deserialize)]
struct FileHostdConfig {
    socket_path: Option<String>,
}

impl HostdConfig {
    pub fn load() -> Result<Self, HostdError> {
        let config_path =
            env::var("CYBEROS_CONFIG").unwrap_or_else(|_| DEFAULT_CONFIG_PATH.to_owned());
        let file_config = load_file_config(Path::new(&config_path))?;
        let socket_path = resolve_socket_path(
            env::var("CYBEROS_HOSTD_SOCKET_PATH").ok(),
            file_config.hostd.and_then(|config| config.socket_path),
        )?;
        let current_directory = env::current_dir()?;
        let data_root = resolve_data_root(
            env::var("CYBEROS_ROOT").ok(),
            file_config.root_dir,
            &current_directory,
        )?;
        let cyberos_uid = nix::unistd::User::from_name("cyberos")
            .map_err(|error| HostdError::unavailable(error.to_string()))?
            .map(|user| user.uid.as_raw())
            .unwrap_or_else(|| nix::unistd::Uid::current().as_raw());
        Ok(Self {
            socket_path,
            socket_group: env::var("CYBEROS_HOSTD_GROUP").unwrap_or_else(|_| "cyberos".to_owned()),
            allowed_uids: vec![0, cyberos_uid],
            data_root,
            mutation_policy: HostMutationPolicy::from_environment(
                env::var("CYBEROS_HOST_MUTATION_POLICY").ok(),
            )?,
        })
    }
}

fn resolve_socket_path(
    environment_value: Option<String>,
    file_value: Option<String>,
) -> Result<PathBuf, HostdError> {
    let socket_path = PathBuf::from(
        environment_value
            .or(file_value)
            .unwrap_or_else(|| DEFAULT_SOCKET_PATH.to_owned()),
    );
    if !socket_path.is_absolute() {
        return Err(HostdError::validation("hostd socket path must be absolute"));
    }
    Ok(socket_path)
}

fn load_file_config(path: &Path) -> Result<FileConfig, HostdError> {
    match std::fs::read_to_string(path) {
        Ok(content) => toml_edit::de::from_str(&content)
            .map_err(|_| HostdError::validation("CyberOS configuration is invalid TOML")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileConfig::default()),
        Err(error) => Err(error.into()),
    }
}

fn resolve_data_root(
    environment_root: Option<String>,
    file_root: Option<String>,
    current_directory: &Path,
) -> Result<PathBuf, HostdError> {
    let root = environment_root
        .or(file_root)
        .unwrap_or_else(|| "/cyberos".to_owned());
    if root.trim().is_empty() {
        return Err(HostdError::validation(
            "CyberOS root path must not be empty",
        ));
    }
    Ok(absolute_path(current_directory, &root).join("data"))
}

fn absolute_path(current_directory: &Path, value: &str) -> PathBuf {
    let path = Path::new(value);
    normalize_path(if path.is_absolute() {
        path.to_owned()
    } else {
        current_directory.join(path)
    })
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_socket_path_with_environment_precedence() {
        assert_eq!(
            resolve_socket_path(
                Some("/run/env-hostd.sock".to_owned()),
                Some("/run/file-hostd.sock".to_owned()),
            )
            .unwrap(),
            PathBuf::from("/run/env-hostd.sock")
        );
        assert_eq!(
            resolve_socket_path(None, Some("/run/file-hostd.sock".to_owned())).unwrap(),
            PathBuf::from("/run/file-hostd.sock")
        );
        assert_eq!(
            resolve_socket_path(None, None).unwrap(),
            PathBuf::from(DEFAULT_SOCKET_PATH)
        );
        assert!(resolve_socket_path(Some("relative.sock".to_owned()), None).is_err());
    }

    #[test]
    fn resolves_host_mutation_policy_with_mutable_default() {
        assert_eq!(
            HostMutationPolicy::from_environment(None).unwrap(),
            HostMutationPolicy::Mutable
        );
        assert_eq!(
            HostMutationPolicy::from_environment(Some("declarative".to_owned())).unwrap(),
            HostMutationPolicy::Declarative
        );
        assert!(HostMutationPolicy::from_environment(Some("invalid".to_owned())).is_err());
    }

    #[test]
    fn resolves_data_root_with_environment_precedence() {
        assert_eq!(
            resolve_data_root(
                Some("relative/tmp/../cyberos".to_owned()),
                Some("/ignored".to_owned()),
                Path::new("/workspace"),
            )
            .unwrap(),
            PathBuf::from("/workspace/relative/cyberos/data")
        );
        assert_eq!(
            resolve_data_root(
                None,
                Some("/srv/cyberos".to_owned()),
                Path::new("/workspace")
            )
            .unwrap(),
            PathBuf::from("/srv/cyberos/data")
        );
        assert_eq!(
            resolve_data_root(None, None, Path::new("/workspace")).unwrap(),
            PathBuf::from("/cyberos/data")
        );
    }

    #[test]
    fn rejects_empty_data_root() {
        assert!(resolve_data_root(Some("  ".to_owned()), None, Path::new("/workspace"),).is_err());
    }
}
