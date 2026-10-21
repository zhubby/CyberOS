use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};

use nix::unistd::User;
use serde::Deserialize;

use crate::error::{ErrorCode, VodError};

pub const DEFAULT_CONFIG_PATH: &str = "/zos/config/config.toml";
pub const DEFAULT_SOCKET_PATH: &str = "/run/zos/vod-player.sock";
pub const DEFAULT_STATE_PATH: &str = "/zos/state/vod-player/session.json";

#[derive(Debug, Clone)]
pub struct VodPlayerConfig {
    pub enabled: bool,
    pub socket_path: PathBuf,
    pub state_path: PathBuf,
    pub command_timeout_ms: u64,
    pub startup_timeout_ms: u64,
    pub checkpoint_interval_ms: u64,
    pub retry_base_delay_ms: u64,
    pub retry_max_delay_ms: u64,
    pub video_output: String,
    pub drm_connector: Option<String>,
    pub audio_output: String,
    pub audio_device: Option<String>,
    pub hwdec: String,
    pub user: String,
    pub peer_uid: u32,
    pub nas_roots: Vec<NasRoot>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NasRoot {
    pub id: String,
    pub path: PathBuf,
}

#[derive(Debug, Default, Deserialize)]
struct FileConfig {
    #[serde(default)]
    vod_player: FileVodPlayer,
    #[serde(default)]
    nas_roots: Vec<FileNasRoot>,
}

#[derive(Debug, Default, Deserialize)]
struct FileVodPlayer {
    enabled: Option<bool>,
    socket_path: Option<PathBuf>,
    state_path: Option<PathBuf>,
    command_timeout_ms: Option<u64>,
    startup_timeout_ms: Option<u64>,
    checkpoint_interval_ms: Option<u64>,
    retry_base_delay_ms: Option<u64>,
    retry_max_delay_ms: Option<u64>,
    video_output: Option<String>,
    drm_connector: Option<String>,
    audio_output: Option<String>,
    audio_device: Option<String>,
    hwdec: Option<String>,
    user: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileNasRoot {
    id: Option<String>,
    path: Option<PathBuf>,
}

impl VodPlayerConfig {
    pub fn load() -> Result<Self, VodError> {
        let config_path = configured_path();
        let file = match std::fs::read_to_string(&config_path) {
            Ok(text) => toml_edit::de::from_str::<FileConfig>(&text)
                .map_err(|error| VodError::internal(format!("Invalid ZOS config: {error}")))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => FileConfig::default(),
            Err(error) => return Err(error.into()),
        };
        let player = file.vod_player;
        let enabled = bool_env("ZOS_VOD_PLAYER_ENABLED")?
            .or(player.enabled)
            .unwrap_or(false);
        let user = text_env("ZOS_VOD_PLAYER_USER")
            .or(player.user)
            .unwrap_or_else(|| "zos".to_owned());
        if user == "root"
            || !user
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
        {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "VOD player user must name a non-root local account",
                400,
            ));
        }
        let playback_uid = User::from_name(&user)
            .map_err(|error| VodError::unavailable(ErrorCode::PermissionDenied, error.to_string()))?
            .map(|account| account.uid.as_raw())
            .or_else(|| (!enabled).then(|| nix::unistd::Uid::current().as_raw()))
            .ok_or_else(|| {
                VodError::unavailable(
                    ErrorCode::PermissionDenied,
                    "VOD player user does not exist",
                )
            })?;
        if enabled && nix::unistd::Uid::current().as_raw() != playback_uid {
            return Err(VodError::unavailable(
                ErrorCode::PermissionDenied,
                "VOD player daemon is running as the wrong user",
            ));
        }
        let peer_uid = User::from_name("zos")
            .map_err(|error| VodError::unavailable(ErrorCode::PermissionDenied, error.to_string()))?
            .map(|account| account.uid.as_raw())
            .or_else(|| (!enabled).then(|| nix::unistd::Uid::current().as_raw()))
            .ok_or_else(|| {
                VodError::unavailable(ErrorCode::PermissionDenied, "ZOS API user does not exist")
            })?;
        let socket_path = absolute_path(
            text_env("ZOS_VOD_PLAYER_SOCKET_PATH")
                .map(PathBuf::from)
                .or(player.socket_path),
            DEFAULT_SOCKET_PATH,
            "socket_path",
        )?;
        let state_path = absolute_path(
            text_env("ZOS_VOD_PLAYER_STATE_PATH")
                .map(PathBuf::from)
                .or(player.state_path),
            DEFAULT_STATE_PATH,
            "state_path",
        )?;
        if is_private_temporary_path(&socket_path) || is_private_temporary_path(&state_path) {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "VOD player socket_path and state_path cannot use /tmp or /var/tmp",
                400,
            ));
        }
        let retry_base_delay_ms = number_env("ZOS_VOD_PLAYER_RETRY_BASE_DELAY_MS")?
            .or(player.retry_base_delay_ms)
            .unwrap_or(2_000);
        let retry_max_delay_ms = number_env("ZOS_VOD_PLAYER_RETRY_MAX_DELAY_MS")?
            .or(player.retry_max_delay_ms)
            .unwrap_or(60_000);
        if retry_base_delay_ms == 0 || retry_max_delay_ms < retry_base_delay_ms {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "VOD player retry delays are invalid",
                400,
            ));
        }
        let video_output = text_env("ZOS_VOD_PLAYER_VIDEO_OUTPUT")
            .or(player.video_output)
            .unwrap_or_else(|| "drm".to_owned());
        let audio_output = text_env("ZOS_VOD_PLAYER_AUDIO_OUTPUT")
            .or(player.audio_output)
            .unwrap_or_else(|| "alsa".to_owned());
        let hwdec = text_env("ZOS_VOD_PLAYER_HWDEC")
            .or(player.hwdec)
            .unwrap_or_else(|| "auto-safe".to_owned());
        if video_output != "drm"
            || audio_output != "alsa"
            || !matches!(hwdec.as_str(), "auto-safe" | "auto" | "no")
        {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "VOD player output configuration is invalid",
                400,
            ));
        }
        let nas_roots = resolve_nas_roots(text_env("ZOS_NAS_ROOTS"), file.nas_roots)?;
        Ok(Self {
            enabled,
            socket_path,
            state_path,
            command_timeout_ms: positive_setting(
                number_env("ZOS_VOD_PLAYER_COMMAND_TIMEOUT_MS")?.or(player.command_timeout_ms),
                5_000,
                "command_timeout_ms",
            )?,
            startup_timeout_ms: positive_setting(
                number_env("ZOS_VOD_PLAYER_STARTUP_TIMEOUT_MS")?.or(player.startup_timeout_ms),
                15_000,
                "startup_timeout_ms",
            )?,
            checkpoint_interval_ms: positive_setting(
                number_env("ZOS_VOD_PLAYER_CHECKPOINT_INTERVAL_MS")?
                    .or(player.checkpoint_interval_ms),
                5_000,
                "checkpoint_interval_ms",
            )?,
            retry_base_delay_ms,
            retry_max_delay_ms,
            video_output,
            drm_connector: optional_text(
                text_env("ZOS_VOD_PLAYER_DRM_CONNECTOR").or(player.drm_connector),
            ),
            audio_output,
            audio_device: optional_text(
                text_env("ZOS_VOD_PLAYER_AUDIO_DEVICE").or(player.audio_device),
            ),
            hwdec,
            user,
            peer_uid,
            nas_roots,
        })
    }
}

pub fn configured_path() -> PathBuf {
    env::var_os("ZOS_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH))
}

fn text_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let normalized = value.trim();
        (!normalized.is_empty()).then(|| normalized.to_owned())
    })
}

fn bool_env(name: &str) -> Result<Option<bool>, VodError> {
    match text_env(name).as_deref() {
        None => Ok(None),
        Some("1" | "true") => Ok(Some(true)),
        Some("0" | "false") => Ok(Some(false)),
        Some(_) => Err(VodError::new(
            ErrorCode::InvalidCommand,
            format!("{name} must be 0 or 1"),
            400,
        )),
    }
}

fn number_env(name: &str) -> Result<Option<u64>, VodError> {
    text_env(name)
        .map(|value| {
            value.parse::<u64>().map_err(|_| {
                VodError::new(
                    ErrorCode::InvalidCommand,
                    format!("{name} must be an integer"),
                    400,
                )
            })
        })
        .transpose()
}

fn positive_setting(value: Option<u64>, fallback: u64, name: &str) -> Result<u64, VodError> {
    match value.unwrap_or(fallback) {
        0 => Err(VodError::new(
            ErrorCode::InvalidCommand,
            format!("{name} must be positive"),
            400,
        )),
        value => Ok(value),
    }
}

fn absolute_path(value: Option<PathBuf>, fallback: &str, name: &str) -> Result<PathBuf, VodError> {
    let value = value.unwrap_or_else(|| PathBuf::from(fallback));
    if !value.is_absolute() {
        return Err(VodError::new(
            ErrorCode::InvalidCommand,
            format!("{name} must be absolute"),
            400,
        ));
    }
    Ok(value)
}

fn resolve_nas_roots(
    environment: Option<String>,
    file_roots: Vec<FileNasRoot>,
) -> Result<Vec<NasRoot>, VodError> {
    let current_directory = env::current_dir()?;
    let roots = if let Some(environment) = environment {
        environment
            .split(',')
            .enumerate()
            .filter_map(|(index, entry)| {
                parse_environment_root(entry.trim(), index, &current_directory)
            })
            .collect::<Vec<_>>()
    } else {
        file_roots
            .into_iter()
            .enumerate()
            .map(|(index, root)| {
                let id = root.id.unwrap_or_else(|| format!("root-{}", index + 1));
                let path = root.path.ok_or_else(|| {
                    VodError::new(
                        ErrorCode::InvalidCommand,
                        format!("NAS root {id} has no configured path"),
                        400,
                    )
                })?;
                Ok(NasRoot {
                    id,
                    path: make_absolute(&current_directory, &path),
                })
            })
            .collect::<Result<Vec<_>, VodError>>()?
    };
    let mut ids = HashSet::new();
    for root in &roots {
        if root.id.is_empty() || !root.path.is_absolute() || !ids.insert(root.id.clone()) {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "VOD player NAS roots must have unique ids and absolute paths",
                400,
            ));
        }
    }
    Ok(roots)
}

fn parse_environment_root(entry: &str, index: usize, current_directory: &Path) -> Option<NasRoot> {
    if entry.is_empty() {
        return None;
    }
    let parts = entry.split(':').collect::<Vec<_>>();
    if parts.len() >= 3 {
        let fallback_id = format!("root-{}", index + 1);
        return Some(NasRoot {
            id: if parts[0].is_empty() {
                fallback_id
            } else {
                parts[0].to_owned()
            },
            path: make_absolute(current_directory, Path::new(&parts[2..].join(":"))),
        });
    }
    Some(NasRoot {
        id: format!("root-{}", index + 1),
        path: make_absolute(current_directory, Path::new(entry)),
    })
}

fn make_absolute(current_directory: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        current_directory.join(path)
    }
}

fn is_private_temporary_path(path: &Path) -> bool {
    path.starts_with("/tmp") || path.starts_with("/var/tmp")
}

pub fn is_absolute(path: &Path) -> bool {
    path.is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_paths_and_positive_values() {
        assert!(
            absolute_path(
                Some(PathBuf::from("relative")),
                DEFAULT_SOCKET_PATH,
                "socket"
            )
            .is_err()
        );
        assert_eq!(positive_setting(Some(5), 1, "value").unwrap(), 5);
        assert!(positive_setting(Some(0), 1, "value").is_err());
        assert_eq!(
            optional_text(Some("  HDMI-A-1  ".to_owned())).as_deref(),
            Some("HDMI-A-1")
        );
        assert_eq!(optional_text(Some("  ".to_owned())), None);
        assert!(is_private_temporary_path(Path::new("/tmp/vod-player.sock")));
        assert!(is_private_temporary_path(Path::new(
            "/var/tmp/session.json"
        )));
        assert!(!is_private_temporary_path(Path::new(
            "/run/zos/vod-player.sock"
        )));
    }

    #[test]
    fn resolves_environment_nas_roots_with_precedence_and_validation() {
        let directory = tempfile::tempdir().unwrap();
        let roots = resolve_nas_roots(
            Some(format!("media:Media:{}", directory.path().display())),
            vec![FileNasRoot {
                id: Some("ignored".to_owned()),
                path: Some(PathBuf::from("/ignored")),
            }],
        )
        .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, "media");
        assert_eq!(roots[0].path, directory.path());

        assert!(
            resolve_nas_roots(
                None,
                vec![
                    FileNasRoot {
                        id: Some("duplicate".to_owned()),
                        path: Some(PathBuf::from("/one")),
                    },
                    FileNasRoot {
                        id: Some("duplicate".to_owned()),
                        path: Some(PathBuf::from("/two")),
                    },
                ],
            )
            .is_err()
        );
        assert!(
            resolve_nas_roots(
                None,
                vec![FileNasRoot {
                    id: Some("missing".to_owned()),
                    path: None,
                }],
            )
            .is_err()
        );
    }
}
