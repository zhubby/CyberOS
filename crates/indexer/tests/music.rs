#[allow(dead_code)]
mod common;

use std::path::Path;

use cyberos_indexer::{db::Db, music::run_music_scan};
use rusqlite::{Connection, params};
use tokio_util::sync::CancellationToken;

fn schema(path: &Path) {
    let connection = Connection::open(path).unwrap();
    let source = include_str!("../../../packages/db/src/migrations/music.ts");
    connection
        .execute_batch(source.split('`').nth(1).unwrap())
        .unwrap();
    connection.execute("INSERT INTO music_sources(id,name,storage_pool_id,path,created_at,updated_at) VALUES ('music','Music','local','Music','now','now')",[]).unwrap();
}

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

fn queue(path: &Path, id: &str) {
    Connection::open(path).unwrap().execute("INSERT INTO music_scan_runs(id,source_id,status,generation,created_at,updated_at) VALUES (?,'music','queued',?,'now','now')",params![id,id]).unwrap();
}

#[tokio::test]
async fn stable_tracks_keep_user_references_and_missing_files_on_rescan() {
    let temp = tempfile::tempdir().unwrap();
    let pool = temp.path().join("pool");
    std::fs::create_dir_all(pool.join("Music/Album")).unwrap();
    std::fs::write(pool.join("Music/Album/song.wav"), wav()).unwrap();
    std::fs::write(pool.join("Music/Album/other.wav"), wav()).unwrap();
    let path = temp.path().join("db.sqlite");
    schema(&path);
    queue(&path, "scan-1");
    let db = Db::open(&path).unwrap();
    let pools = [common::storage_pool(&pool)];
    let task = db
        .claim_music_scan("worker", &pools)
        .await
        .unwrap()
        .unwrap();
    run_music_scan(
        &db,
        &task,
        "worker",
        &temp.path().join("art"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let connection = Connection::open(&path).unwrap();
    let id: String = connection
        .query_row(
            "SELECT id FROM music_tracks WHERE relative_path='Music/Album/song.wav'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO music_favorites VALUES ('track',?,'now')",
            [&id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO music_playlists VALUES ('playlist','Playlist','now','now')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO music_playlist_items VALUES ('item','playlist',?,0)",
            [&id],
        )
        .unwrap();
    let old_album: String = connection
        .query_row(
            "SELECT album_id FROM music_tracks WHERE id=?",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO music_favorites VALUES ('album',?,'now')",
            [&old_album],
        )
        .unwrap();
    std::fs::write(pool.join("Music/Album/song.lrc"), "[00:00.01]Updated lyric").unwrap();
    std::fs::remove_file(pool.join("Music/Album/other.wav")).unwrap();
    {
        use lofty::prelude::{Accessor, TagExt};
        let mut tag = lofty::tag::Tag::new(lofty::tag::TagType::RiffInfo);
        tag.set_album("Retitled album".into());
        tag.save_to_path(
            pool.join("Music/Album/song.wav"),
            lofty::config::WriteOptions::default(),
        )
        .unwrap();
    }
    queue(&path, "scan-2");
    connection
        .execute(
            "UPDATE music_scan_runs SET full_scan=0 WHERE id='scan-2'",
            [],
        )
        .unwrap();
    let task = db
        .claim_music_scan("worker", &pools)
        .await
        .unwrap()
        .unwrap();
    run_music_scan(
        &db,
        &task,
        "worker",
        &temp.path().join("art"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let saved: (String, String) = connection
        .query_row(
            "SELECT id,lyrics_text FROM music_tracks WHERE relative_path='Music/Album/song.wav'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(saved.0, id);
    assert!(saved.1.contains("Updated lyric"));
    let new_album: String = connection
        .query_row(
            "SELECT album_id FROM music_tracks WHERE id=?",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    assert_ne!(old_album, new_album);
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM music_favorites WHERE kind='album' AND entity_id=?",
                [new_album],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM music_favorites WHERE entity_id=?",
                [&id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM music_playlist_items WHERE track_id=?",
                [&id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT missing FROM music_tracks WHERE relative_path='Music/Album/other.wav'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM music_scan_entries", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn cancelled_source_and_failed_scan_cannot_publish_or_clear_previous_tracks() {
    let temp = tempfile::tempdir().unwrap();
    let pool = temp.path().join("pool");
    std::fs::create_dir_all(pool.join("Music")).unwrap();
    std::fs::write(pool.join("Music/song.wav"), wav()).unwrap();
    let path = temp.path().join("db.sqlite");
    schema(&path);
    queue(&path, "scan-1");
    let db = Db::open(&path).unwrap();
    let pools = [common::storage_pool(&pool)];
    let task = db
        .claim_music_scan("worker", &pools)
        .await
        .unwrap()
        .unwrap();
    run_music_scan(
        &db,
        &task,
        "worker",
        &temp.path().join("art"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    std::fs::rename(pool.join("Music"), pool.join("Away")).unwrap();
    queue(&path, "scan-2");
    let task = db
        .claim_music_scan("worker", &pools)
        .await
        .unwrap()
        .unwrap();
    assert!(
        run_music_scan(
            &db,
            &task,
            "worker",
            &temp.path().join("art"),
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM music_tracks WHERE missing=0",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    connection
        .execute("UPDATE music_sources SET removed=1", [])
        .unwrap();
    assert!(db.complete_music_scan(&task, "worker").await.is_err());
}

#[tokio::test]
async fn watcher_changes_match_source_boundaries_and_coalesce_active_scans() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.sqlite");
    schema(&path);
    let db = Db::open(&path).unwrap();
    db.enqueue_music_changes("local", "MusicOther/song.wav")
        .await
        .unwrap();
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM music_scan_runs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    db.enqueue_music_changes("local", "Music/song.wav")
        .await
        .unwrap();
    db.enqueue_music_changes("local", "Music/song.lrc")
        .await
        .unwrap();
    let task = db
        .claim_music_scan("worker", &[common::storage_pool(temp.path())])
        .await
        .unwrap()
        .unwrap();
    assert!(!task.full_scan);
    db.enqueue_music_changes("local", "Music/song.wav")
        .await
        .unwrap();
    db.complete_music_scan(&task, "worker").await.unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM music_scan_runs WHERE status='queued'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM music_scan_runs WHERE status='queued'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn expired_scan_gets_a_new_generation_and_rechecks_partially_published_files() {
    let temp = tempfile::tempdir().unwrap();
    let pool = temp.path().join("pool");
    std::fs::create_dir_all(pool.join("Music")).unwrap();
    std::fs::write(pool.join("Music/song.wav"), wav()).unwrap();
    let path = temp.path().join("db.sqlite");
    schema(&path);
    queue(&path, "first");
    let db = Db::open(&path).unwrap();
    let pools = [common::storage_pool(&pool)];
    let first = db
        .claim_music_scan("worker", &pools)
        .await
        .unwrap()
        .unwrap();
    run_music_scan(
        &db,
        &first,
        "worker",
        &temp.path().join("art"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    queue(&path, "retry");
    let old = db
        .claim_music_scan("worker", &pools)
        .await
        .unwrap()
        .unwrap();
    let connection = Connection::open(&path).unwrap();
    // A process dies after publishing one batch but before confirming missing files.
    connection
        .execute(
            "UPDATE music_tracks SET scan_generation=?",
            [&old.generation],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO music_scan_entries VALUES (?,'Music/song.wav','{}')",
            [&old.id],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE music_scan_runs SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?",
            [&old.id],
        )
        .unwrap();
    std::fs::remove_file(pool.join("Music/song.wav")).unwrap();
    let retry = db
        .claim_music_scan("worker", &pools)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retry.id, old.id);
    assert_ne!(retry.generation, old.generation);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM music_scan_entries", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    // A late failure from the old attempt must not cancel the new lease, even for the same worker.
    db.fail_music_scan(
        &old,
        "worker",
        &cyberos_indexer::error::IndexerError::internal("stale failure"),
    )
    .await
    .unwrap();
    run_music_scan(
        &db,
        &retry,
        "worker",
        &temp.path().join("art"),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT missing FROM music_tracks", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn failed_scan_discards_staged_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.sqlite");
    schema(&path);
    queue(&path, "failure");
    let db = Db::open(&path).unwrap();
    let task = db
        .claim_music_scan("worker", &[common::storage_pool(temp.path())])
        .await
        .unwrap()
        .unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO music_scan_entries VALUES (?,'Music/song.wav','{}')",
            [&task.id],
        )
        .unwrap();
    db.fail_music_scan(
        &task,
        "worker",
        &cyberos_indexer::error::IndexerError::internal("read failed"),
    )
    .await
    .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM music_scan_entries", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT status FROM music_scan_runs", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "failed"
    );
}
