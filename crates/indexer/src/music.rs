use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::db::{Db, StoragePool};
use crate::error::{ErrorCode, IndexerError};
use crate::music_metadata::metadata_signature;
use crate::music_metadata::{MusicMetadata, is_audio, read_metadata};
use crate::storage::{EntryKind, StoragePoolStorage, probe_mount_identity};

#[derive(Debug, Clone)]
pub struct MusicScanTask {
    pub id: String,
    pub generation: String,
    pub source_id: String,
    pub source_path: String,
    pub pool: StoragePool,
    pub full_scan: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MusicScanEntry {
    pub relative_path: String,
    pub size_bytes: u64,
    pub mtime_ms: i64,
    pub metadata: MusicMetadata,
    pub metadata_signature: String,
}

pub async fn run_music_scan(
    db: &Db,
    task: &MusicScanTask,
    worker: &str,
    artwork_root: &Path,
    shutdown: &CancellationToken,
) -> Result<(), IndexerError> {
    let stop = CancellationToken::new();
    let lease_lost = CancellationToken::new();
    let lease = {
        let db = db.clone();
        let task = task.clone();
        let worker = worker.to_owned();
        let stop = stop.clone();
        let lost = lease_lost.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.tick().await;
            loop {
                tokio::select! {
                    _=stop.cancelled()=>break,
                    _=interval.tick()=>if db.renew_music_scan(&task,&worker).await.is_err() {lost.cancel();break;}
                }
            }
        })
    };
    let result = tokio::select! {
        _=shutdown.cancelled()=>Err(IndexerError::internal("Indexer is stopping")),
        _=lease_lost.cancelled()=>Err(IndexerError::database("Music scan lease was lost")),
        result=scan(db,task,worker,artwork_root)=>result,
    };
    stop.cancel();
    let _ = lease.await;
    result
}

async fn scan(
    db: &Db,
    task: &MusicScanTask,
    worker: &str,
    artwork_root: &Path,
) -> Result<(), IndexerError> {
    let storage = StoragePoolStorage::open(Path::new(&task.pool.path))?;
    let initial_mount = probe_mount_identity(
        storage.path(),
        &task.pool.mount_policy,
        task.pool.expected_source.as_deref(),
        task.pool.expected_uuid.as_deref(),
        task.pool.expected_fstype.as_deref(),
    )
    .await?;
    storage.open_directory(Path::new(&task.source_path))?;
    let mut directories = VecDeque::from([PathBuf::from(&task.source_path)]);
    let mut batch = Vec::with_capacity(100);
    let mut scanned = 0;
    while let Some(directory) = directories.pop_front() {
        for entry in storage.list_directory(&directory)? {
            let path = directory.join(entry.name);
            match entry.kind {
                EntryKind::Directory => directories.push_back(path),
                EntryKind::File if is_audio(&path) => {
                    let identity = storage.identity_for(&path)?;
                    let signature = metadata_signature(&storage, &path)?;
                    let text = path.to_string_lossy();
                    let relative_path = text.strip_prefix("./").unwrap_or(&text).to_owned();
                    let cached = if task.full_scan {
                        None
                    } else {
                        db.cached_music_metadata(&task.pool.id, &relative_path, &signature)
                            .await?
                    };
                    let metadata = match cached {
                        Some(value) => value,
                        None => read_metadata(&storage, &path, artwork_root).await?,
                    };
                    let path_text = path.to_string_lossy();
                    batch.push(MusicScanEntry {
                        relative_path: path_text
                            .strip_prefix("./")
                            .unwrap_or(&path_text)
                            .to_owned(),
                        size_bytes: identity.size,
                        mtime_ms: identity.mtime_ns / 1_000_000,
                        metadata,
                        metadata_signature: signature,
                    });
                    scanned += 1;
                    if batch.len() >= 25 {
                        db.stage_music_entries(task, worker, std::mem::take(&mut batch), scanned)
                            .await?;
                    }
                }
                _ => {}
            }
        }
    }
    db.stage_music_entries(task, worker, batch, scanned).await?;
    storage.verify_unchanged()?;
    let final_mount = probe_mount_identity(
        storage.path(),
        &task.pool.mount_policy,
        task.pool.expected_source.as_deref(),
        task.pool.expected_uuid.as_deref(),
        task.pool.expected_fstype.as_deref(),
    )
    .await?;
    if final_mount != initial_mount {
        return Err(IndexerError::new(
            ErrorCode::SourceChanged,
            "Mount identity changed during music scan",
            true,
        ));
    }
    let mut after = String::new();
    loop {
        storage.verify_unchanged()?;
        match db.publish_music_batch(task, worker, &after).await? {
            Some(path) => after = path,
            None => break,
        }
    }
    storage.verify_unchanged()?;
    db.complete_music_scan(task, worker).await
}

#[cfg(test)]
mod tests {
    use super::super::music_metadata::{album_key, is_audio, read_metadata};
    use crate::storage::StoragePoolStorage;
    use std::path::Path;

    fn wav() -> Vec<u8> {
        let mut data = b"RIFF".to_vec();
        data.extend(38_u32.to_le_bytes());
        data.extend(b"WAVEfmt ");
        data.extend(16_u32.to_le_bytes());
        data.extend(1_u16.to_le_bytes());
        data.extend(1_u16.to_le_bytes());
        data.extend(8000_u32.to_le_bytes());
        data.extend(16000_u32.to_le_bytes());
        data.extend(2_u16.to_le_bytes());
        data.extend(16_u16.to_le_bytes());
        data.extend(b"data");
        data.extend(2_u32.to_le_bytes());
        data.extend([0, 0]);
        data
    }

    #[tokio::test]
    async fn reads_audio_properties_and_local_lyrics_without_tags() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("Artist/Album/CD1")).unwrap();
        std::fs::write(temp.path().join("Artist/Album/CD1/01 Song.wav"), wav()).unwrap();
        std::fs::write(
            temp.path().join("Artist/Album/CD1/01 Song.lrc"),
            "[00:01.00]歌词",
        )
        .unwrap();
        let storage = StoragePoolStorage::open(temp.path()).unwrap();
        let value = read_metadata(
            &storage,
            Path::new("Artist/Album/CD1/01 Song.wav"),
            &temp.path().join("cache"),
        )
        .await
        .unwrap();
        assert_eq!(value.title, "01 Song");
        assert_eq!(value.album, "Album");
        assert_eq!(value.sample_rate, Some(8000));
        assert_eq!(value.bit_depth, Some(16));
        assert_eq!(value.lyrics_format.as_deref(), Some("lrc"));
        assert!(value.lyrics_text.unwrap().contains("歌词"));
    }

    #[test]
    fn groups_discs_but_keeps_same_named_editions_apart() {
        assert_eq!(
            album_key(
                "pool",
                Path::new("A/Album/CD1/a.flac"),
                "Album",
                &["A".into()],
                None
            ),
            album_key(
                "pool",
                Path::new("A/Album/CD2/b.flac"),
                "Album",
                &["A".into()],
                None
            )
        );
        assert_ne!(
            album_key(
                "pool",
                Path::new("A/Edition1/a.flac"),
                "Album",
                &["A".into()],
                None
            ),
            album_key(
                "pool",
                Path::new("A/Edition2/a.flac"),
                "Album",
                &["A".into()],
                None
            )
        );
        assert!(is_audio(Path::new("SONG.FLAC")));
        assert!(!is_audio(Path::new("movie.mp4")));
    }

    #[tokio::test]
    async fn does_not_read_symlinked_sidecar_lyrics() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("pool")).unwrap();
        std::fs::write(temp.path().join("pool/song.wav"), wav()).unwrap();
        std::fs::write(temp.path().join("secret"), "secret").unwrap();
        symlink(
            temp.path().join("secret"),
            temp.path().join("pool/song.lrc"),
        )
        .unwrap();
        let storage = StoragePoolStorage::open(&temp.path().join("pool")).unwrap();
        let value = read_metadata(&storage, Path::new("song.wav"), &temp.path().join("cache"))
            .await
            .unwrap();
        assert!(value.lyrics_text.is_none());
    }
}
