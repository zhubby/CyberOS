use std::env;
use std::path::{Path, PathBuf};

use nix::unistd::User;
use serde::Deserialize;

use crate::error::{ErrorCode, VodError};

pub const DEFAULT_CONFIG_PATH: &str = "/cyberos/config/config.toml";
pub const DEFAULT_SOCKET_PATH: &str = "/run/cyberos/vod-player.sock";
pub const DEFAULT_STATE_PATH: &str = "/cyberos/state/vod-player/session.json";
pub const DEFAULT_ROOT_PATH: &str = "/cyberos";

#[derive(Debug, Clone)]
pub struct VodPlayerConfig {
    pub enabled: bool,
    pub socket_path: PathBuf,
    pub state_path: PathBuf,
    pub database_path: PathBuf,
    pub data_root: PathBuf,
    pub production: bool,
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
}

#[derive(Debug, Default, Deserialize)]
struct FileConfig {
    root_dir: Option<PathBuf>,
    #[serde(default)]
    vod_player: FileVodPlayer,
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

impl VodPlayerConfig {
    pub fn load() -> Result<Self, VodError> {
        let config_path = configured_path();
        let file = match std::fs::read_to_string(&config_path) {
            Ok(text) => toml_edit::de::from_str::<FileConfig>(&text)
                .map_err(|error| VodError::internal(format!("Invalid CyberOS config: {error}")))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => FileConfig::default(),
            Err(error) => return Err(error.into()),
        };
        let player = file.vod_player;
        let root_path = absolute_path(
            text_env("CYBEROS_ROOT")
                .map(PathBuf::from)
                .or(file.root_dir),
            DEFAULT_ROOT_PATH,
            "root_dir",
        )?;
        let enabled = bool_env("CYBEROS_VOD_PLAYER_ENABLED")?
            .or(player.enabled)
            .unwrap_or(false);
        let user = text_env("CYBEROS_VOD_PLAYER_USER")
            .or(player.user)
            .unwrap_or_else(|| "cyberos".to_owned());
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
        let peer_uid = User::from_name("cyberos")
            .map_err(|error| VodError::unavailable(ErrorCode::PermissionDenied, error.to_string()))?
            .map(|account| account.uid.as_raw())
            .or_else(|| (!enabled).then(|| nix::unistd::Uid::current().as_raw()))
            .ok_or_else(|| {
                VodError::unavailable(
                    ErrorCode::PermissionDenied,
                    "CyberOS API user does not exist",
                )
            })?;
        let socket_path = absolute_path(
            text_env("CYBEROS_VOD_PLAYER_SOCKET_PATH")
                .map(PathBuf::from)
                .or(player.socket_path),
            DEFAULT_SOCKET_PATH,
            "socket_path",
        )?;
        let state_path = absolute_path(
            text_env("CYBEROS_VOD_PLAYER_STATE_PATH")
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
        let retry_base_delay_ms = number_env("CYBEROS_VOD_PLAYER_RETRY_BASE_DELAY_MS")?
            .or(player.retry_base_delay_ms)
            .unwrap_or(2_000);
        let retry_max_delay_ms = number_env("CYBEROS_VOD_PLAYER_RETRY_MAX_DELAY_MS")?
            .or(player.retry_max_delay_ms)
            .unwrap_or(60_000);
        if retry_base_delay_ms == 0 || retry_max_delay_ms < retry_base_delay_ms {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "VOD player retry delays are invalid",
                400,
            ));
        }
        let video_output = text_env("CYBEROS_VOD_PLAYER_VIDEO_OUTPUT")
            .or(player.video_output)
            .unwrap_or_else(|| "drm".to_owned());
        let audio_output = text_env("CYBEROS_VOD_PLAYER_AUDIO_OUTPUT")
            .or(player.audio_output)
            .unwrap_or_else(|| "alsa".to_owned());
        let hwdec = text_env("CYBEROS_VOD_PLAYER_HWDEC")
            .or(player.hwdec)
            .unwrap_or_else(|| "auto-safe".to_owned());
        if !matches!(video_output.as_str(), "drm" | "wayland")
            || audio_output != "alsa"
            || !matches!(hwdec.as_str(), "auto-safe" | "auto" | "no")
        {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "VOD player output configuration is invalid",
                400,
            ));
        }
        Ok(Self {
            enabled,
            socket_path,
            state_path,
            database_path: root_path.join("state/cyberos.sqlite"),
            data_root: root_path.join("data"),
            production: env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production"),
            command_timeout_ms: positive_setting(
                number_env("CYBEROS_VOD_PLAYER_COMMAND_TIMEOUT_MS")?.or(player.command_timeout_ms),
                5_000,
                "command_timeout_ms",
            )?,
            startup_timeout_ms: positive_setting(
                number_env("CYBEROS_VOD_PLAYER_STARTUP_TIMEOUT_MS")?.or(player.startup_timeout_ms),
                15_000,
                "startup_timeout_ms",
            )?,
            checkpoint_interval_ms: positive_setting(
                number_env("CYBEROS_VOD_PLAYER_CHECKPOINT_INTERVAL_MS")?
                    .or(player.checkpoint_interval_ms),
                5_000,
                "checkpoint_interval_ms",
            )?,
            retry_base_delay_ms,
            retry_max_delay_ms,
            video_output,
            drm_connector: optional_text(
                text_env("CYBEROS_VOD_PLAYER_DRM_CONNECTOR").or(player.drm_connector),
            ),
            audio_output,
            audio_device: optional_text(
                text_env("CYBEROS_VOD_PLAYER_AUDIO_DEVICE").or(player.audio_device),
            ),
            hwdec,
            user,
            peer_uid,
        })
    }
}

pub fn configured_path() -> PathBuf {
    env::var_os("CYBEROS_CONFIG")
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
            "/run/cyberos/vod-player.sock"
        )));
    }
}
