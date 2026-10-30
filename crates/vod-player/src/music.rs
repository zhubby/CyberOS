use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{ErrorCode, VodError};
use crate::protocol::{validate_bluetooth_audio_device_id, validate_id, validate_relative_path};

pub const MAX_QUEUE_ITEMS: usize = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "vod-player.ts", rename = "MusicQueueEntry"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueEntry {
    pub id: String,
    pub track_id: String,
    pub storage_pool_id: String,
    pub relative_path: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_seconds: Option<f64>,
    pub cover_key: Option<String>,
}

impl QueueEntry {
    pub fn validate(&self) -> Result<(), VodError> {
        validate_id(&self.id)?;
        validate_id(&self.track_id)?;
        validate_id(&self.storage_pool_id)?;
        validate_relative_path(&self.relative_path)?;
        if self.title.len() > 4_096
            || self.artist.len() > 4_096
            || self.album.as_ref().is_some_and(|value| value.len() > 4_096)
            || self
                .duration_seconds
                .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err(invalid("Music queue metadata is invalid"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "vod-player.ts", rename = "MusicRepeatMode"))]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    #[default]
    Off,
    One,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export_to = "vod-player.ts", rename = "MusicQueueState"))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueState {
    pub queue_version: u64,
    pub queue: Vec<QueueEntry>,
    pub current_item_id: Option<String>,
    pub repeat: RepeatMode,
    pub shuffle: bool,
    pub position_seconds: f64,
    pub volume: f64,
    pub audio_device_id: Option<String>,
}

impl Default for QueueState {
    fn default() -> Self {
        Self {
            queue_version: 0,
            queue: Vec::new(),
            current_item_id: None,
            repeat: RepeatMode::Off,
            shuffle: false,
            position_seconds: 0.0,
            volume: 100.0,
            audio_device_id: None,
        }
    }
}

impl QueueState {
    pub fn current(&self) -> Option<&QueueEntry> {
        self.queue
            .iter()
            .find(|entry| Some(&entry.id) == self.current_item_id.as_ref())
    }

    pub fn next_id(&self, backwards: bool, natural_end: bool) -> Option<String> {
        if self.queue.is_empty() {
            return None;
        }
        let position = self
            .queue
            .iter()
            .position(|entry| Some(&entry.id) == self.current_item_id.as_ref())
            .unwrap_or(0);
        if natural_end && self.repeat == RepeatMode::One {
            return Some(self.queue[position].id.clone());
        }
        // An order derived from item UUIDs is stable across reconnects and never repeats
        // an item before the shuffled cycle has been traversed.
        let mut order: Vec<&QueueEntry> = self.queue.iter().collect();
        if self.shuffle {
            order.sort_by(|left, right| left.id.cmp(&right.id));
        }
        let index = order
            .iter()
            .position(|entry| Some(&entry.id) == self.current_item_id.as_ref())
            .unwrap_or(0);
        let next = if backwards {
            if index > 0 {
                index - 1
            } else if self.repeat == RepeatMode::All {
                order.len() - 1
            } else {
                0
            }
        } else if index + 1 < order.len() {
            index + 1
        } else if self.repeat == RepeatMode::All {
            0
        } else {
            return None;
        };
        Some(order[next].id.clone())
    }

    pub fn validate(&self) -> Result<(), VodError> {
        validate_entries(&self.queue)?;
        if !self.position_seconds.is_finite()
            || self.position_seconds < 0.0
            || !self.volume.is_finite()
            || !(0.0..=100.0).contains(&self.volume)
            || self
                .current_item_id
                .as_ref()
                .is_some_and(|id| !self.queue.iter().any(|entry| &entry.id == id))
        {
            return Err(invalid("Music checkpoint is invalid"));
        }
        if let Some(device) = &self.audio_device_id {
            validate_bluetooth_audio_device_id(device)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(export_to = "vod-player.ts", rename = "MusicPlayerWireCommand")
)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MusicCommand {
    Replace {
        entries: Vec<QueueEntry>,
        expected_queue_version: u64,
        #[cfg_attr(test, ts(optional = nullable))]
        expected_session_id: Option<String>,
    },
    Append {
        entries: Vec<QueueEntry>,
        expected_queue_version: u64,
    },
    InsertNext {
        entries: Vec<QueueEntry>,
        expected_queue_version: u64,
    },
    Remove {
        item_id: String,
        expected_queue_version: u64,
    },
    Reorder {
        item_ids: Vec<String>,
        expected_queue_version: u64,
    },
    Clear {
        expected_queue_version: u64,
    },
    Jump {
        item_id: String,
        expected_queue_version: u64,
        #[cfg_attr(test, ts(optional = nullable))]
        expected_session_id: Option<String>,
    },
    Next {
        expected_queue_version: u64,
    },
    Previous {
        expected_queue_version: u64,
    },
    Pause {
        expected_queue_version: u64,
    },
    Resume {
        expected_queue_version: u64,
        #[cfg_attr(test, ts(optional = nullable))]
        expected_session_id: Option<String>,
    },
    Seek {
        seconds: f64,
        expected_queue_version: u64,
    },
    Volume {
        volume: f64,
        expected_queue_version: u64,
    },
    Mode {
        repeat: RepeatMode,
        shuffle: bool,
        expected_queue_version: u64,
    },
    Output {
        audio_device_id: Option<String>,
        expected_queue_version: u64,
    },
}

impl MusicCommand {
    pub fn expected_version(&self) -> u64 {
        match self {
            Self::Replace {
                expected_queue_version,
                ..
            }
            | Self::Append {
                expected_queue_version,
                ..
            }
            | Self::InsertNext {
                expected_queue_version,
                ..
            }
            | Self::Remove {
                expected_queue_version,
                ..
            }
            | Self::Reorder {
                expected_queue_version,
                ..
            }
            | Self::Clear {
                expected_queue_version,
            }
            | Self::Jump {
                expected_queue_version,
                ..
            }
            | Self::Next {
                expected_queue_version,
            }
            | Self::Previous {
                expected_queue_version,
            }
            | Self::Pause {
                expected_queue_version,
            }
            | Self::Resume {
                expected_queue_version,
                ..
            }
            | Self::Seek {
                expected_queue_version,
                ..
            }
            | Self::Volume {
                expected_queue_version,
                ..
            }
            | Self::Mode {
                expected_queue_version,
                ..
            }
            | Self::Output {
                expected_queue_version,
                ..
            } => *expected_queue_version,
        }
    }

    pub fn validate(&self) -> Result<(), VodError> {
        match self {
            Self::Replace {
                entries,
                expected_session_id,
                ..
            } => {
                validate_entries(entries)?;
                if entries.is_empty() {
                    return Err(invalid("Choose at least one song"));
                }
                if let Some(session_id) = expected_session_id {
                    validate_id(session_id)?;
                }
            }
            Self::Append { entries, .. } | Self::InsertNext { entries, .. } => {
                validate_entries(entries)?
            }
            Self::Remove { item_id, .. } | Self::Jump { item_id, .. } => validate_id(item_id)?,
            Self::Reorder { item_ids, .. } => {
                if item_ids.len() > MAX_QUEUE_ITEMS
                    || item_ids.iter().collect::<HashSet<_>>().len() != item_ids.len()
                {
                    return Err(invalid("Queue order is invalid"));
                }
                for id in item_ids {
                    validate_id(id)?;
                }
            }
            Self::Seek { seconds, .. } if !seconds.is_finite() || *seconds < 0.0 => {
                return Err(invalid("Seek position must be non-negative"));
            }
            Self::Volume { volume, .. }
                if !volume.is_finite() || !(0.0..=100.0).contains(volume) =>
            {
                return Err(invalid("Volume must be between 0 and 100"));
            }
            Self::Output {
                audio_device_id: Some(device),
                ..
            } => validate_bluetooth_audio_device_id(device)?,
            _ => {}
        }
        Ok(())
    }
}

pub fn validate_entries(entries: &[QueueEntry]) -> Result<(), VodError> {
    if entries.len() > MAX_QUEUE_ITEMS
        || entries
            .iter()
            .map(|entry| &entry.id)
            .collect::<HashSet<_>>()
            .len()
            != entries.len()
    {
        return Err(invalid(
            "Music queue is too large or contains duplicate item IDs",
        ));
    }
    for entry in entries {
        entry.validate()?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlayEvent {
    pub id: String,
    pub track_id: String,
    pub played_at: String,
    pub listened_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub version: u8,
    pub state: QueueState,
    pub event_id: String,
    pub listened_seconds: f64,
    pub counted: bool,
    pub pending_events: Vec<PlayEvent>,
}

impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            version: 1,
            state: QueueState::default(),
            event_id: Uuid::new_v4().to_string(),
            listened_seconds: 0.0,
            counted: false,
            pending_events: Vec::new(),
        }
    }
}

pub fn checkpoint_path(video_path: &Path) -> PathBuf {
    video_path.with_extension("music.json")
}

pub fn load_checkpoint(path: &Path) -> Result<Checkpoint, VodError> {
    match fs::read(path) {
        Ok(bytes) => {
            let checkpoint =
                serde_json::from_slice::<Checkpoint>(&bytes)
                    .ok()
                    .filter(|checkpoint| {
                        checkpoint.version == 1
                            && checkpoint.state.validate().is_ok()
                            && checkpoint.listened_seconds.is_finite()
                            && checkpoint.listened_seconds >= 0.0
                            && checkpoint.pending_events.len() <= 10_000
                    });
            if let Some(checkpoint) = checkpoint {
                return Ok(checkpoint);
            }
            let quarantined = path.with_extension(format!("corrupt.{}.json", Uuid::new_v4()));
            fs::rename(path, quarantined)?;
            Ok(Checkpoint::default())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Checkpoint::default()),
        Err(error) => Err(error.into()),
    }
}

pub fn persist_checkpoint(path: &Path, checkpoint: &Checkpoint) -> Result<(), VodError> {
    let parent = path
        .parent()
        .ok_or_else(|| VodError::internal("Music state path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".music.{}.json", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        serde_json::to_writer(&mut file, checkpoint)
            .map_err(|error| VodError::internal(error.to_string()))?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn verify_track(database_path: &Path, entry: &QueueEntry) -> Result<(), VodError> {
    let connection = open_database(database_path)?;
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM music_tracks WHERE id=? AND storage_pool_id=? AND relative_path=? AND missing=0)",
        params![entry.track_id, entry.storage_pool_id, entry.relative_path], |row| row.get(0)).map_err(database_error)?;
    if exists {
        Ok(())
    } else {
        Err(invalid("Song is no longer available in this music library"))
    }
}

pub fn save_play_event(database_path: &Path, event: &PlayEvent) -> Result<(), VodError> {
    let connection = open_database(database_path)?;
    connection.execute("INSERT OR IGNORE INTO music_play_events(id,track_id,played_at,listened_seconds) VALUES (?,?,?,?)",
        params![event.id, event.track_id, event.played_at, event.listened_seconds]).map_err(database_error)?;
    Ok(())
}

fn open_database(path: &Path) -> Result<Connection, VodError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(database_error)?;
    connection
        .busy_timeout(std::time::Duration::from_millis(250))
        .map_err(database_error)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(database_error)?;
    Ok(connection)
}
fn database_error(error: rusqlite::Error) -> VodError {
    VodError::unavailable(
        ErrorCode::StorageUnavailable,
        format!("Music database is unavailable: {error}"),
    )
}
fn invalid(message: &str) -> VodError {
    VodError::new(ErrorCode::InvalidCommand, message, 400)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn entry(id: &str) -> QueueEntry {
        QueueEntry {
            id: id.to_owned(),
            track_id: format!("track-{id}"),
            storage_pool_id: "pool-1".to_owned(),
            relative_path: format!("music/{id}.flac"),
            title: id.to_owned(),
            artist: "Artist".to_owned(),
            album: None,
            duration_seconds: Some(30.0),
            cover_key: None,
        }
    }

    #[test]
    fn queue_advances_and_obeys_repeat_without_a_browser() {
        let mut state = QueueState {
            queue: vec![entry("b"), entry("a"), entry("c")],
            current_item_id: Some("a".to_owned()),
            ..Default::default()
        };
        assert_eq!(state.next_id(false, true).as_deref(), Some("c"));
        state.repeat = RepeatMode::One;
        assert_eq!(state.next_id(false, true).as_deref(), Some("a"));
        assert_eq!(state.next_id(false, false).as_deref(), Some("c"));
        state.current_item_id = Some("c".to_owned());
        state.repeat = RepeatMode::All;
        assert_eq!(state.next_id(false, true).as_deref(), Some("b"));
        state.shuffle = true;
        assert_eq!(state.next_id(false, true).as_deref(), Some("a"));
    }

    #[test]
    fn duplicate_songs_are_allowed_but_item_ids_must_be_unique() {
        let mut copy = entry("b");
        copy.track_id = "track-a".to_owned();
        assert!(validate_entries(&[entry("a"), copy]).is_ok());
        assert!(validate_entries(&[entry("a"), entry("a")]).is_err());
    }

    #[test]
    fn music_checkpoint_preserves_queue_progress_and_pending_history() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("music.json");
        let mut checkpoint = Checkpoint::default();
        checkpoint.state.queue = vec![entry("a")];
        checkpoint.state.current_item_id = Some("a".to_owned());
        checkpoint.state.position_seconds = 12.0;
        checkpoint.pending_events.push(PlayEvent {
            id: "event-1".to_owned(),
            track_id: "track-a".to_owned(),
            played_at: "2026-10-30T00:00:00Z".to_owned(),
            listened_seconds: 15.0,
        });
        persist_checkpoint(&path, &checkpoint).unwrap();
        let loaded = load_checkpoint(&path).unwrap();
        assert_eq!(loaded.state.position_seconds, 12.0);
        assert_eq!(loaded.state.current().unwrap().track_id, "track-a");
        assert_eq!(loaded.pending_events[0].id, "event-1");
    }

    #[test]
    fn history_replay_is_idempotent_and_track_identity_is_checked() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("music.sqlite");
        let connection = Connection::open(&database_path).unwrap();
        connection.execute_batch("CREATE TABLE music_tracks(id TEXT PRIMARY KEY,storage_pool_id TEXT,relative_path TEXT,missing INTEGER); CREATE TABLE music_play_events(id TEXT PRIMARY KEY,track_id TEXT REFERENCES music_tracks(id),played_at TEXT,listened_seconds REAL); INSERT INTO music_tracks VALUES('track-a','pool-1','music/a.flac',0);").unwrap();
        let track = entry("a");
        verify_track(&database_path, &track).unwrap();
        let mut changed = track.clone();
        changed.relative_path = "music/other.flac".to_owned();
        assert!(verify_track(&database_path, &changed).is_err());
        let event = PlayEvent {
            id: "played-once".to_owned(),
            track_id: track.track_id,
            played_at: "2026-10-30T00:00:00Z".to_owned(),
            listened_seconds: 15.0,
        };
        save_play_event(&database_path, &event).unwrap();
        save_play_event(&database_path, &event).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM music_play_events", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            1
        );
        connection
            .execute("UPDATE music_tracks SET missing=1", [])
            .unwrap();
        assert!(verify_track(&database_path, &entry("a")).is_err());
    }
}
