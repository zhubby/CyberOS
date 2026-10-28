use std::collections::HashSet;
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
    pub nas_roots: Vec<ConfiguredNasRoot>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfiguredNasRoot {
    pub id: String,
    pub path: PathBuf,
}

#[derive(Debug, Default, Deserialize)]
struct FileConfig {
    hostd: Option<FileHostdConfig>,
    #[serde(default)]
    nas_roots: Vec<FileNasRoot>,
}

#[derive(Debug, Deserialize)]
struct FileHostdConfig {
    socket_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileNasRoot {
    id: Option<String>,
    path: Option<String>,
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
        let nas_roots = resolve_nas_roots(
            env::var("CYBEROS_NAS_ROOTS").ok(),
            file_config.nas_roots,
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
            nas_roots,
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

fn resolve_nas_roots(
    environment_value: Option<String>,
    file_values: Vec<FileNasRoot>,
    current_directory: &Path,
) -> Result<Vec<ConfiguredNasRoot>, HostdError> {
    let roots = if let Some(environment_value) = environment_value {
        environment_value
            .split(',')
            .enumerate()
            .filter_map(|(index, entry)| {
                parse_environment_root(entry.trim(), index, current_directory)
            })
            .collect::<Vec<_>>()
    } else {
        file_values
            .into_iter()
            .enumerate()
            .map(|(index, root)| {
                let id = root.id.unwrap_or_else(|| format!("root-{}", index + 1));
                let path = root.path.ok_or_else(|| {
                    HostdError::validation(format!("NAS root {id} has no configured path"))
                })?;
                Ok(ConfiguredNasRoot {
                    id,
                    path: absolute_path(current_directory, &path),
                })
            })
            .collect::<Result<Vec<_>, HostdError>>()?
    };
    let mut ids = HashSet::new();
    for root in &roots {
        if root.id.is_empty() || !root.path.is_absolute() || !ids.insert(root.id.clone()) {
            return Err(HostdError::validation(
                "hostd NAS roots must have unique ids and absolute paths",
            ));
        }
    }
    Ok(roots)
}

fn parse_environment_root(
    entry: &str,
    index: usize,
    current_directory: &Path,
) -> Option<ConfiguredNasRoot> {
    if entry.is_empty() {
        return None;
    }
    let parts = entry.split(':').collect::<Vec<_>>();
    if parts.len() >= 3 {
        let fallback_id = format!("root-{}", index + 1);
        return Some(ConfiguredNasRoot {
            id: if parts[0].is_empty() {
                fallback_id
            } else {
                parts[0].to_owned()
            },
            path: absolute_path(current_directory, &parts[2..].join(":")),
        });
    }
    Some(ConfiguredNasRoot {
        id: format!("root-{}", index + 1),
        path: absolute_path(current_directory, entry),
    })
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
    fn resolves_configured_nas_roots_with_environment_precedence() {
        let roots = resolve_nas_roots(
            Some("dev:Development NAS:relative/tmp/../nas,/mnt/archive".to_owned()),
            vec![FileNasRoot {
                id: Some("ignored".to_owned()),
                path: Some("/mnt/ignored".to_owned()),
            }],
            Path::new("/workspace"),
        )
        .unwrap();

        assert_eq!(
            roots,
            vec![
                ConfiguredNasRoot {
                    id: "dev".to_owned(),
                    path: PathBuf::from("/workspace/relative/nas"),
                },
                ConfiguredNasRoot {
                    id: "root-2".to_owned(),
                    path: PathBuf::from("/mnt/archive"),
                },
            ]
        );
    }

    #[test]
    fn rejects_duplicate_or_pathless_nas_roots() {
        assert!(
            resolve_nas_roots(
                None,
                vec![
                    FileNasRoot {
                        id: Some("primary".to_owned()),
                        path: Some("/mnt/one".to_owned()),
                    },
                    FileNasRoot {
                        id: Some("primary".to_owned()),
                        path: Some("/mnt/two".to_owned()),
                    },
                ],
                Path::new("/workspace"),
            )
            .is_err()
        );
        assert!(
            resolve_nas_roots(
                None,
                vec![FileNasRoot {
                    id: Some("primary".to_owned()),
                    path: None,
                }],
                Path::new("/workspace"),
            )
            .is_err()
        );
    }
}
