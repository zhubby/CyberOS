use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, VodError};
use crate::music::{MusicCommand, QueueState};

pub const PROTOCOL_VERSION: u8 = 3;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "vod-player.ts", rename = "VodPlayerRequestEnvelope")
)]
#[serde(deny_unknown_fields)]
pub struct RequestEnvelope {
    pub version: u8,
    pub id: String,
    pub command: Command,
}

impl RequestEnvelope {
    pub fn parse(bytes: &[u8]) -> Result<Self, VodError> {
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(VodError::protocol("VOD player request exceeds 1 MiB"));
        }
        let value: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|_| VodError::protocol("Invalid VOD player request"))?;
        validate_command_fields(&value)?;
        let request: Self = serde_json::from_value(value)
            .map_err(|_| VodError::protocol("Invalid VOD player request"))?;
        if request.version != PROTOCOL_VERSION {
            return Err(VodError::protocol(
                "Unsupported VOD player protocol version",
            ));
        }
        if request.id.is_empty() || request.id.len() > 128 || request.id.contains('\0') {
            return Err(VodError::protocol("Invalid VOD player request id"));
        }
        request.command.validate()?;
        Ok(request)
    }
}

fn validate_command_fields(value: &serde_json::Value) -> Result<(), VodError> {
    let command = value
        .get("command")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| VodError::protocol("Invalid VOD player request"))?;
    let command_type = command
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| VodError::protocol("Invalid VOD player command"))?;
    let allowed: &[&str] = match command_type {
        "status" => &["type"],
        "play" => &[
            "type",
            "storagePoolId",
            "relativePath",
            "startPositionSeconds",
            "audioDeviceId",
            "mediaFileId",
            "expectedSessionId",
        ],
        "music" => &["type", "command"],
        "pause"
        | "resume"
        | "toggle-pause"
        | "stop"
        | "stop-video"
        | "retry"
        | "cycle-audio-track"
        | "cycle-subtitle-track" => &["type", "sessionId"],
        "seek" => &["type", "sessionId", "seconds"],
        "seek-relative" => &["type", "sessionId", "seconds"],
        "set-volume" => &["type", "sessionId", "volume"],
        "set-audio-track" | "set-subtitle-track" => &["type", "sessionId", "trackId"],
        _ => {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "Unsupported VOD player command",
                400,
            ));
        }
    };
    if command.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(VodError::protocol(
            "VOD player command contains unknown fields",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "vod-player.ts", rename = "VodPlayerWireCommand"))]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Command {
    Status,
    Play {
        #[serde(rename = "storagePoolId")]
        storage_pool_id: String,
        #[serde(rename = "relativePath")]
        relative_path: String,
        #[serde(rename = "startPositionSeconds")]
        #[cfg_attr(test, ts(optional = nullable))]
        start_position_seconds: Option<f64>,
        #[serde(rename = "audioDeviceId")]
        #[cfg_attr(test, ts(optional = nullable))]
        audio_device_id: Option<String>,
        #[serde(rename = "mediaFileId")]
        #[cfg_attr(test, ts(optional = nullable))]
        media_file_id: Option<String>,
        #[serde(rename = "expectedSessionId")]
        #[cfg_attr(test, ts(optional = nullable))]
        expected_session_id: Option<String>,
    },
    Music {
        command: MusicCommand,
    },
    StopVideo {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Pause {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Resume {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    TogglePause {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Stop {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Retry {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Seek {
        #[serde(rename = "sessionId")]
        session_id: String,
        seconds: f64,
    },
    SeekRelative {
        #[serde(rename = "sessionId")]
        session_id: String,
        seconds: f64,
    },
    SetVolume {
        #[serde(rename = "sessionId")]
        session_id: String,
        volume: f64,
    },
    SetAudioTrack {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "trackId")]
        track_id: i64,
    },
    SetSubtitleTrack {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "trackId")]
        track_id: Option<i64>,
    },
    CycleAudioTrack {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    CycleSubtitleTrack {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

impl Command {
    fn validate(&self) -> Result<(), VodError> {
        match self {
            Self::Status => Ok(()),
            Self::Play {
                storage_pool_id,
                relative_path,
                start_position_seconds,
                audio_device_id,
                media_file_id,
                expected_session_id,
            } => {
                validate_id(storage_pool_id)?;
                validate_relative_path(relative_path)?;
                if start_position_seconds.is_some_and(|value| !value.is_finite() || value < 0.0) {
                    return Err(VodError::new(
                        ErrorCode::InvalidCommand,
                        "Start position must be a non-negative number",
                        400,
                    ));
                }
                if let Some(audio_device_id) = audio_device_id {
                    validate_bluetooth_audio_device_id(audio_device_id)?;
                }
                if let Some(media_file_id) = media_file_id {
                    validate_id(media_file_id)?;
                }
                if let Some(session_id) = expected_session_id {
                    validate_id(session_id)?;
                }
                Ok(())
            }
            Self::Music { command } => command.validate(),
            Self::Pause { session_id }
            | Self::Resume { session_id }
            | Self::TogglePause { session_id }
            | Self::Stop { session_id }
            | Self::StopVideo { session_id }
            | Self::Retry { session_id }
            | Self::CycleAudioTrack { session_id }
            | Self::CycleSubtitleTrack { session_id } => validate_id(session_id),
            Self::Seek {
                session_id,
                seconds,
            } => {
                validate_id(session_id)?;
                validate_number(*seconds, 0.0, f64::MAX, "seek position")
            }
            Self::SeekRelative {
                session_id,
                seconds,
            } => {
                validate_id(session_id)?;
                validate_number(*seconds, -3_600.0, 3_600.0, "relative seek offset")
            }
            Self::SetVolume { session_id, volume } => {
                validate_id(session_id)?;
                validate_number(*volume, 0.0, 100.0, "volume")
            }
            Self::SetAudioTrack {
                session_id,
                track_id,
            } => {
                validate_id(session_id)?;
                validate_track_id(*track_id)
            }
            Self::SetSubtitleTrack {
                session_id,
                track_id,
            } => {
                validate_id(session_id)?;
                if let Some(track_id) = track_id {
                    validate_track_id(*track_id)?;
                }
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "vod-player.ts", rename = "VodPlayerTrack"))]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub language: Option<String>,
    pub title: Option<String>,
    pub default: bool,
    pub forced: bool,
    pub external: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "vod-player.ts", rename = "VodPlayerState"))]
#[serde(rename_all = "lowercase")]
pub enum PlayerState {
    Idle,
    Starting,
    Playing,
    Paused,
    Recovering,
    Stopped,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "vod-player.ts", rename = "VodPlayerCapabilities")
)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub mpv_available: bool,
    pub drm_available: bool,
    pub audio_available: bool,
    pub hardware_decode: HardwareDecode,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "vod-player.ts", rename = "VodPlayerHardwareDecode")
)]
#[serde(rename_all = "lowercase")]
pub enum HardwareDecode {
    Enabled,
    Software,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "vod-player.ts", rename = "PlaybackOwner"))]
#[serde(rename_all = "lowercase")]
pub enum PlaybackOwner {
    Music,
    Video,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "vod-player.ts", rename = "VodPlayerStatus"))]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(default)]
    pub owner: Option<PlaybackOwner>,
    #[serde(default)]
    pub music: QueueState,
    pub state: PlayerState,
    pub session_id: Option<String>,
    pub service_instance_id: String,
    pub revision: u64,
    pub storage_pool_id: Option<String>,
    pub relative_path: Option<String>,
    pub file_name: Option<String>,
    pub media_file_id: Option<String>,
    pub video_output: String,
    pub position_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub volume: f64,
    pub retry_count: u32,
    pub next_retry_at: Option<String>,
    pub audio_device_id: Option<String>,
    pub effective_audio_device_id: Option<String>,
    pub audio_fallback_reason: Option<String>,
    pub audio_tracks: Vec<Track>,
    pub subtitle_tracks: Vec<Track>,
    pub selected_audio_track_id: Option<i64>,
    pub selected_subtitle_track_id: Option<i64>,
    pub capabilities: Capabilities,
    pub error: Option<String>,
    pub error_code: Option<ErrorCode>,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "vod-player.ts", rename = "VodPlayerSuccessResponse")
)]
#[serde(rename_all = "camelCase")]
pub struct SuccessResponse<'a> {
    pub version: u8,
    pub id: &'a str,
    pub ok: bool,
    pub status: &'a Status,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "vod-player.ts", rename = "VodPlayerErrorResponse")
)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse<'a> {
    pub version: u8,
    pub id: &'a str,
    pub ok: bool,
    pub error: &'a str,
    pub code: ErrorCode,
    pub status_code: u16,
}

pub(crate) fn validate_id(value: &str) -> Result<(), VodError> {
    if value.is_empty() || value.len() > 256 || value.contains('\0') {
        return Err(VodError::new(
            ErrorCode::InvalidCommand,
            "Invalid VOD player identifier",
            400,
        ));
    }
    Ok(())
}

pub(crate) fn validate_bluetooth_audio_device_id(value: &str) -> Result<(), VodError> {
    let Some(target) = value.strip_prefix("bluetooth:") else {
        return Err(VodError::new(
            ErrorCode::InvalidCommand,
            "Invalid Bluetooth audio device id",
            400,
        ));
    };
    let address = if let Some((adapter_id, address)) = target.split_once('/') {
        if !adapter_id.starts_with("adapter-")
            || adapter_id.len() == "adapter-".len()
            || adapter_id.len() > 72
            || !adapter_id["adapter-".len()..].chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-')
            })
        {
            return Err(VodError::new(
                ErrorCode::InvalidCommand,
                "Invalid Bluetooth audio device id",
                400,
            ));
        }
        address
    } else {
        target
    };
    if address.len() != 17
        || address.split(':').count() != 6
        || !address.split(':').all(|part| {
            part.len() == 2 && part.chars().all(|character| character.is_ascii_hexdigit())
        })
    {
        return Err(VodError::new(
            ErrorCode::InvalidCommand,
            "Invalid Bluetooth audio device id",
            400,
        ));
    }
    Ok(())
}

pub(crate) fn validate_relative_path(value: &str) -> Result<(), VodError> {
    if value.starts_with('/')
        || value
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        || value.contains('\0')
    {
        return Err(VodError::invalid_path(
            "Media path must remain inside the selected storage pool",
        ));
    }
    Ok(())
}

fn validate_number(value: f64, minimum: f64, maximum: f64, name: &str) -> Result<(), VodError> {
    if !value.is_finite() || value < minimum || value > maximum {
        return Err(VodError::new(
            ErrorCode::InvalidCommand,
            format!("Invalid {name}"),
            400,
        ));
    }
    Ok(())
}

fn validate_track_id(value: i64) -> Result<(), VodError> {
    if value <= 0 {
        return Err(VodError::new(
            ErrorCode::InvalidCommand,
            "Invalid media track id",
            400,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use ts_rs::{Config, TS};

    #[derive(Deserialize)]
    struct GoldenFixtures {
        requests: Vec<String>,
        responses: Vec<String>,
    }

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum GoldenResponse {
        Success(Box<GoldenSuccessResponse>),
        Error(GoldenErrorResponse),
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct GoldenSuccessResponse {
        version: u8,
        id: String,
        ok: bool,
        status: Status,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct GoldenErrorResponse {
        version: u8,
        id: String,
        ok: bool,
        error: String,
        code: ErrorCode,
        status_code: u16,
    }

    #[test]
    #[ignore = "writes checked-in TypeScript protocol bindings"]
    fn export_protocol_bindings() {
        let config = Config::from_env();
        RequestEnvelope::export_all(&config).unwrap();
        SuccessResponse::<'static>::export_all(&config).unwrap();
        ErrorResponse::<'static>::export_all(&config).unwrap();
    }

    #[test]
    fn parses_strict_versioned_commands() {
        let request = RequestEnvelope::parse(
            br#"{"version":3,"id":"r1","command":{"type":"play","storagePoolId":"pool","relativePath":"movies/a.mp4","startPositionSeconds":4,"mediaFileId":"file-1"}}"#,
        )
        .unwrap();
        assert!(matches!(request.command, Command::Play { .. }));
        assert!(RequestEnvelope::parse(br#"{"id":"r1","command":{"type":"status"}}"#).is_err());
        assert!(
            RequestEnvelope::parse(
                br#"{"version":3,"id":"r1","command":{"type":"status","extra":true}}"#
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_unsafe_paths_and_unbound_controls() {
        assert!(RequestEnvelope::parse(br#"{"version":3,"id":"r1","command":{"type":"play","storagePoolId":"pool","relativePath":"../a.mp4"}}"#).is_err());
        assert!(
            RequestEnvelope::parse(br#"{"version":3,"id":"r1","command":{"type":"pause"}}"#)
                .is_err()
        );
        assert!(RequestEnvelope::parse(br#"{"version":3,"id":"r1","command":{"type":"seek-relative","sessionId":"session-1","seconds":-10}}"#).is_ok());
        assert!(RequestEnvelope::parse(br#"{"version":3,"id":"r1","command":{"type":"set-subtitle-track","sessionId":"session-1","trackId":null}}"#).is_ok());
        assert!(
            validate_bluetooth_audio_device_id("bluetooth:adapter-hci1/AA:BB:CC:DD:EE:FF").is_ok()
        );
        assert!(
            validate_bluetooth_audio_device_id("bluetooth:adapter-/AA:BB:CC:DD:EE:FF").is_err()
        );
    }

    #[test]
    fn accepts_the_shared_golden_frames() {
        let fixtures: GoldenFixtures = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/shared/fixtures/vod-player-protocol-v3.json"
        )))
        .unwrap();
        for frame in fixtures.requests {
            RequestEnvelope::parse(frame.as_bytes()).unwrap();
        }
        for frame in fixtures.responses {
            let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
            let encoded = match serde_json::from_value(value.clone()).unwrap() {
                GoldenResponse::Success(response) => {
                    assert_eq!(response.version, PROTOCOL_VERSION);
                    assert!(response.ok);
                    serde_json::to_value(SuccessResponse {
                        version: response.version,
                        id: &response.id,
                        ok: response.ok,
                        status: &response.status,
                    })
                    .unwrap()
                }
                GoldenResponse::Error(response) => {
                    assert_eq!(response.version, PROTOCOL_VERSION);
                    assert!(!response.ok);
                    serde_json::to_value(ErrorResponse {
                        version: response.version,
                        id: &response.id,
                        ok: response.ok,
                        error: &response.error,
                        code: response.code,
                        status_code: response.status_code,
                    })
                    .unwrap()
                }
            };
            assert_eq!(encoded, value);
        }
    }
}
