use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::VodError;
use crate::protocol::validate_bluetooth_audio_device_id;
use crate::storage::FileIdentity;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistedSession {
    pub version: u8,
    pub session_id: String,
    pub storage_pool_id: String,
    pub relative_path: String,
    pub position_seconds: f64,
    pub volume: f64,
    pub desired_paused: bool,
    #[serde(default)]
    pub audio_device_id: Option<String>,
    #[serde(default)]
    pub media_file_id: Option<String>,
    pub identity: FileIdentity,
    pub updated_at: String,
}

pub enum LoadOutcome {
    Empty,
    Session(Box<PersistedSession>),
    Corrupt(PathBuf),
}

pub fn load(path: &Path) -> Result<LoadOutcome, VodError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LoadOutcome::Empty);
        }
        Err(error) => return Err(error.into()),
    };
    match serde_json::from_slice::<PersistedSession>(&bytes) {
        Ok(session) if session.version == 2 && valid_session(&session) => {
            Ok(LoadOutcome::Session(Box::new(session)))
        }
        _ => {
            let quarantined = path.with_file_name(format!(
                "session.corrupt.{}.{}.json",
                OffsetDateTime::now_utc().unix_timestamp(),
                Uuid::new_v4().simple()
            ));
            match fs::rename(path, &quarantined) {
                Ok(()) => {
                    if let Err(error) = sync_parent(path) {
                        tracing::warn!(
                            code = ?error.code,
                            "failed to fsync quarantined VOD player session"
                        );
                    }
                    Ok(LoadOutcome::Corrupt(quarantined))
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        path = %path.display(),
                        "failed to quarantine corrupt VOD player session"
                    );
                    Ok(LoadOutcome::Corrupt(path.to_owned()))
                }
            }
        }
    }
}

pub fn persist(path: &Path, session: &PersistedSession) -> Result<(), VodError> {
    let parent = path
        .parent()
        .ok_or_else(|| VodError::internal("Session path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_file_name(format!(".session.json.{}", Uuid::new_v4().simple()));
    let result = (|| {
        let body = serde_json::to_vec(session).map_err(|error| {
            VodError::internal(format!("Unable to serialize playback session: {error}"))
        })?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&body)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn clear(path: &Path) -> Result<(), VodError> {
    match fs::remove_file(path) {
        Ok(()) => sync_parent(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn sync_parent(path: &Path) -> Result<(), VodError> {
    let parent = path
        .parent()
        .ok_or_else(|| VodError::internal("Session path has no parent"))?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn valid_session(session: &PersistedSession) -> bool {
    !session.session_id.is_empty()
        && !session.storage_pool_id.is_empty()
        && !session.relative_path.is_empty()
        && session.position_seconds.is_finite()
        && session.position_seconds >= 0.0
        && session.volume.is_finite()
        && (0.0..=100.0).contains(&session.volume)
        && session
            .audio_device_id
            .as_deref()
            .is_none_or(|value| validate_bluetooth_audio_device_id(value).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PersistedSession {
        PersistedSession {
            version: 2,
            session_id: "session-1".to_owned(),
            storage_pool_id: "pool".to_owned(),
            relative_path: "movies/a.mp4".to_owned(),
            position_seconds: 12.0,
            volume: 80.0,
            desired_paused: true,
            audio_device_id: None,
            media_file_id: None,
            identity: FileIdentity {
                device: 1,
                inode: 2,
                size: 3,
                modified_seconds: 4,
                modified_nanoseconds: 5,
                changed_seconds: 6,
                changed_nanoseconds: 7,
            },
            updated_at: "2026-01-01T00:00:00Z".to_owned(),
        }
    }

    #[test]
    fn atomically_round_trips_a_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.json");
        persist(&path, &fixture()).unwrap();
        match load(&path).unwrap() {
            LoadOutcome::Session(session) => assert_eq!(session.session_id, "session-1"),
            _ => panic!("session did not load"),
        }
    }

    #[test]
    fn quarantines_corrupt_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.json");
        fs::write(&path, b"not json").unwrap();
        match load(&path).unwrap() {
            LoadOutcome::Corrupt(path) => assert!(path.exists()),
            _ => panic!("state was not quarantined"),
        }
        assert!(!path.exists());
    }
}
