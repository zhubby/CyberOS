use std::env;
use std::path::{Path, PathBuf};

use nix::unistd::User;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;

use crate::error::{ErrorCode, VodError};

pub const DEFAULT_SOCKET_PATH: &str = "/run/cyberos/vod-player.sock";

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredTvSettings {
    enabled: bool,
    video_output: String,
    drm_connector: Option<String>,
    audio_device: Option<String>,
    hardware_decoding: String,
    updated_at: String,
}

impl Default for StoredTvSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            video_output: "drm".to_owned(),
            drm_connector: None,
            audio_device: None,
            hardware_decoding: "auto-safe".to_owned(),
            updated_at: "1970-01-01T00:00:00.000Z".to_owned(),
        }
    }
}

impl VodPlayerConfig {
    pub fn load() -> Result<Self, VodError> {
        let production = env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("production");
        let root_path = env::var_os("CYBEROS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if production {
                    PathBuf::from("/cyberos")
                } else {
                    env::current_dir()
                        .unwrap_or_else(|_| PathBuf::from("."))
                        .join(".cyberos/dev-root")
                }
            });
        if !root_path.is_absolute() {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "CYBEROS_ROOT must be an absolute path",
                400,
            ));
        }
        if production && root_path != std::path::Path::new("/cyberos") {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "production CyberOS root must be /cyberos",
                400,
            ));
        }
        let database_path = root_path.join("state/cyberos.sqlite");
        let settings = load_tv_settings(&database_path)?;
        validate_settings(&settings)?;
        let tv_transition_enabled = root_path.join("state/tv/enabled").is_file();
        let enabled = settings.enabled || tv_transition_enabled;
        let video_output = if tv_transition_enabled && !settings.enabled {
            "wayland".to_owned()
        } else {
            settings.video_output.clone()
        };
        let user = "cyberos".to_owned();
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
        Ok(Self {
            enabled,
            socket_path: PathBuf::from(DEFAULT_SOCKET_PATH),
            state_path: root_path.join("state/vod-player/session.json"),
            database_path,
            data_root: root_path.join("data"),
            production,
            command_timeout_ms: 5_000,
            startup_timeout_ms: 15_000,
            checkpoint_interval_ms: 5_000,
            retry_base_delay_ms: 2_000,
            retry_max_delay_ms: 60_000,
            video_output,
            drm_connector: optional_text(settings.drm_connector),
            audio_output: "alsa".to_owned(),
            audio_device: optional_text(settings.audio_device),
            hwdec: settings.hardware_decoding,
            user,
            peer_uid,
        })
    }
}

fn load_tv_settings(path: &Path) -> Result<StoredTvSettings, VodError> {
    if !path.exists() {
        return Ok(StoredTvSettings::default());
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| VodError::internal(format!("Failed to read TV settings: {error}")))?;
    let value = connection
        .query_row(
            "SELECT value_json FROM system_settings WHERE key = 'tv_settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| VodError::internal(format!("Failed to read TV settings: {error}")))?;
    value
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| VodError::internal(format!("Invalid TV settings: {error}")))
        })
        .transpose()
        .map(|settings| settings.unwrap_or_default())
}

fn validate_settings(settings: &StoredTvSettings) -> Result<(), VodError> {
    if settings.updated_at.trim().is_empty()
        || !matches!(settings.video_output.as_str(), "drm" | "wayland")
        || !matches!(
            settings.hardware_decoding.as_str(),
            "auto-safe" | "auto" | "no"
        )
    {
        return Err(VodError::new(
            ErrorCode::InvalidCommand,
            "TV output settings are invalid",
            400,
        ));
    }
    Ok(())
}

fn optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let normalized = value.trim();
        (!normalized.is_empty()).then(|| normalized.to_owned())
    })
}

pub fn is_absolute(path: &Path) -> bool {
    path.is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_current_tv_settings() {
        let mut settings = StoredTvSettings::default();
        assert!(validate_settings(&settings).is_ok());
        settings.video_output = "invalid".to_owned();
        assert!(validate_settings(&settings).is_err());
        assert_eq!(
            optional_text(Some("  HDMI-A-1  ".to_owned())).as_deref(),
            Some("HDMI-A-1")
        );
        assert_eq!(optional_text(Some("  ".to_owned())), None);
        assert!(Path::new(DEFAULT_SOCKET_PATH).is_absolute());
    }
}
