use crate::error::VodError;
use serde::{Deserialize, Serialize};
use std::os::unix::fs::OpenOptionsExt;
use std::{collections::BTreeMap, fs, io::Write, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "vod-player.ts"))]
#[serde(rename_all = "camelCase", default)]
pub struct PlaybackPreferences {
    pub video_volume: f64,
    pub video_muted: bool,
    pub music_muted: bool,
    pub video_audio_device_id: Option<String>,
    pub audio_delays: BTreeMap<String, f64>,
}
impl Default for PlaybackPreferences {
    fn default() -> Self {
        Self {
            video_volume: 100.0,
            video_muted: false,
            music_muted: false,
            video_audio_device_id: None,
            audio_delays: BTreeMap::new(),
        }
    }
}
impl PlaybackPreferences {
    pub fn load(session: &Path) -> Result<Self, VodError> {
        match fs::read(session.with_file_name("playback-preferences.json")) {
            Ok(bytes) => {
                let value: Self = serde_json::from_slice(&bytes)
                    .map_err(|_| VodError::internal("Invalid playback preferences"))?;
                if !value.video_volume.is_finite()
                    || !(0.0..=100.0).contains(&value.video_volume)
                    || value
                        .audio_delays
                        .values()
                        .any(|n| !n.is_finite() || n.abs() > 5000.0)
                {
                    return Err(VodError::internal("Invalid playback preferences"));
                }
                if let Some(id) = &value.video_audio_device_id {
                    crate::protocol::validate_bluetooth_audio_device_id(id)?;
                }
                Ok(value)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }
    pub fn save(&self, session: &Path) -> Result<(), VodError> {
        let parent = session
            .parent()
            .ok_or_else(|| VodError::internal("Missing preferences directory"))?;
        fs::create_dir_all(parent)?;
        let target = parent.join("playback-preferences.json");
        let temp = parent.join(format!(".preferences-{}", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp)?;
            file.write_all(
                &serde_json::to_vec(self).map_err(|_| VodError::internal("Invalid preferences"))?,
            )?;
            file.sync_all()?;
            fs::rename(&temp, target)?;
            fs::File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_video_volume_and_device_without_changing_music_mute() {
        let d = tempfile::tempdir().unwrap();
        let session = d.path().join("session.json");
        let mut p = PlaybackPreferences {
            video_volume: 35.0,
            music_muted: true,
            ..Default::default()
        };
        p.audio_delays.insert("tv".into(), 125.0);
        p.save(&session).unwrap();
        let saved = PlaybackPreferences::load(&session).unwrap();
        assert_eq!(saved.video_volume, 35.0);
        assert!(saved.music_muted);
        assert!(!saved.video_muted);
        assert_eq!(saved.audio_delays["tv"], 125.0);
    }
}
