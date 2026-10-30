mod common;

use std::future::Future;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use cyberos_indexer::db::{Db, IndexedFileRecord, RunStats};
use cyberos_indexer::error::IndexerError;
use cyberos_indexer::extractor::ExtractedFile;
use cyberos_indexer::media::MediaScanTask;
use cyberos_indexer::storage::FileIdentity;
use rusqlite::{Connection, params};

fn setup() -> (tempfile::TempDir, Db, Connection) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db.sqlite");
    common::create_schema(&path, directory.path());
    let db = Db::open(&path).unwrap();
    let reader = Connection::open(path).unwrap();
    (directory, db, reader)
}

fn hold_writer(directory: &Path) -> Connection {
    let writer = Connection::open(directory.join("db.sqlite")).unwrap();
    writer
        .execute_batch(
            "BEGIN IMMEDIATE;
         INSERT INTO system_settings VALUES ('concurrent-writer', '{}', 'now');",
        )
        .unwrap();
    writer
}

async fn during_write<T>(
    writer: Connection,
    operation: impl Future<Output = Result<T, IndexerError>>,
) -> Result<T, IndexerError> {
    let (release, requested) = mpsc::channel();
    let writer_thread = std::thread::spawn(move || {
        // The writer owns the lock before the real Db operation starts. Its
        // bounded hold schedules a commit, rather than imposing a latency
        // assertion. A DEFERRED read-to-write upgrade fails before this commit;
        // an IMMEDIATE transaction waits and then observes the committed state.
        let _ = requested.recv_timeout(Duration::from_millis(250));
        writer.execute_batch("COMMIT").unwrap();
    });
    let result = operation.await;
    let _ = release.send(());
    writer_thread.join().unwrap();
    result
}

fn seed_file(reader: &Connection, id: &str, pool: &str, path: &str, generation: &str) {
    reader.execute(
        "INSERT INTO indexed_files (id, storage_pool_id, path, name, indexed_at, scan_generation)
         VALUES (?, ?, ?, ?, 'now', ?)",
        params![id, pool, path, path, generation],
    ).unwrap();
    reader
        .execute(
            "INSERT INTO indexed_content_fts(file_id, storage_pool_id, path, name, body, terms)
         VALUES (?, ?, ?, ?, 'oldword', 'oldword')",
            params![id, pool, path, path],
        )
        .unwrap();
}

fn count(reader: &Connection, sql: &str) -> i64 {
    reader.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[tokio::test]
async fn publishing_file_waits_for_a_writer_and_replaces_content_with_the_same_id() {
    let (directory, db, reader) = setup();
    seed_file(&reader, "stable-id", "local", "doc.txt", "old");
    let file = IndexedFileRecord {
        storage_pool_id: "local",
        path: "doc.txt",
        name: "doc.txt",
        identity: FileIdentity {
            device: 1,
            inode: 2,
            size: 3,
            mtime_ns: 4,
            ctime_ns: 5,
        },
        scan_generation: Some("new"),
    };
    during_write(
        hold_writer(directory.path()),
        db.publish_file(
            file,
            ExtractedFile {
                hash: "new-hash".into(),
                mime_type: "text/plain".into(),
                body: "newword".into(),
                terms: "newword".into(),
                source: None,
                status: "ready",
            },
        ),
    )
    .await
    .unwrap();
    let file: (String, String) = reader
        .query_row(
            "SELECT id, scan_generation FROM indexed_files WHERE path='doc.txt'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(file, ("stable-id".into(), "new".into()));
    assert_eq!(
        count(
            &reader,
            "SELECT COUNT(*) FROM indexed_content_fts WHERE indexed_content_fts MATCH 'oldword'"
        ),
        0
    );
    assert_eq!(
        count(
            &reader,
            "SELECT COUNT(*) FROM indexed_content_fts WHERE indexed_content_fts MATCH 'newword' AND file_id='stable-id'"
        ),
        1
    );
}

#[tokio::test]
async fn removing_path_waits_for_a_writer_without_deleting_siblings_or_other_pools() {
    let (directory, db, reader) = setup();
    for (id, pool, path) in [
        ("child", "local", "docs/a.txt"),
        ("nested", "local", "docs/nested/b.txt"),
        ("sibling", "local", "docs-other/c.txt"),
        ("other-pool", "other", "docs/a.txt"),
    ] {
        seed_file(&reader, id, pool, path, "old");
    }
    let removed = during_write(
        hold_writer(directory.path()),
        db.remove_path("local", "docs", true),
    )
    .await
    .unwrap();
    assert_eq!(removed, 2);
    assert_eq!(
        count(
            &reader,
            "SELECT COUNT(*) FROM indexed_files WHERE id IN ('sibling','other-pool')"
        ),
        2
    );
    assert_eq!(
        count(&reader, "SELECT COUNT(*) FROM indexed_content_fts"),
        2
    );
}

#[tokio::test]
async fn cleaning_generation_waits_for_a_writer_and_preserves_current_or_outside_entries() {
    let (directory, db, reader) = setup();
    for (id, pool, path, generation) in [
        ("stale", "local", "docs/stale.txt", "old"),
        ("current", "local", "docs/current.txt", "new"),
        ("sibling", "local", "docs-other/stale.txt", "old"),
        ("other-pool", "other", "docs/stale.txt", "old"),
    ] {
        seed_file(&reader, id, pool, path, generation);
    }
    reader.execute_batch(
        "UPDATE index_storage_pool_state SET active_scan_generation='new', completed_scan_generation='old';
         UPDATE index_content_state SET status='rebuilding';
         INSERT INTO index_queue(id,storage_pool_id,path,kind,status,created_at,updated_at) VALUES
           ('failed-child','local','docs/stale.txt','incremental','failed','now','now'),
           ('failed-sibling','local','docs-other/stale.txt','incremental','failed','now','now'),
           ('queued-child','local','docs/current.txt','incremental','queued','now','now');",
    ).unwrap();
    let removed = during_write(
        hold_writer(directory.path()),
        db.cleanup_generation("local", "docs", "new", false),
    )
    .await
    .unwrap();
    assert_eq!(removed, 1);
    assert_eq!(
        count(
            &reader,
            "SELECT COUNT(*) FROM indexed_files WHERE id IN ('current','sibling','other-pool')"
        ),
        3
    );
    assert_eq!(
        count(&reader, "SELECT COUNT(*) FROM indexed_content_fts"),
        3
    );
    assert_eq!(
        count(
            &reader,
            "SELECT COUNT(*) FROM index_queue WHERE id IN ('failed-sibling','queued-child')"
        ),
        2
    );
    assert_eq!(
        count(
            &reader,
            "SELECT COUNT(*) FROM index_queue WHERE id='failed-child'"
        ),
        0
    );
    let generations: (Option<String>, String) = reader.query_row(
        "SELECT active_scan_generation, completed_scan_generation FROM index_storage_pool_state WHERE storage_pool_id='local'",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(generations, (None, "old".into()));
    assert_eq!(
        reader
            .query_row(
                "SELECT status FROM index_content_state WHERE storage_pool_id='local'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "rebuilding"
    );
}

#[tokio::test]
async fn finishing_run_waits_for_a_writer_and_persists_final_stats_and_failures() {
    let (directory, db, reader) = setup();
    let run_id = db.start_run("local", "full").await.unwrap();
    let stats = RunStats {
        scanned: 3,
        indexed: 1,
        unchanged: 1,
        failed: 1,
        failures: vec![("bad.txt".into(), "unreadable".into())],
        ..RunStats::default()
    };
    during_write(
        hold_writer(directory.path()),
        db.finish_run(&run_id, &stats, false),
    )
    .await
    .unwrap();
    let run: (String, i64, i64, i64, i64) = reader
        .query_row(
            "SELECT status,scanned,indexed,unchanged,failed FROM index_runs WHERE id=?",
            [&run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(run, ("failed".into(), 3, 1, 1, 1));
    let failure: (String, String, String) = reader
        .query_row(
            "SELECT storage_pool_id,path,reason FROM index_failures WHERE run_id=?",
            [&run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        failure,
        ("local".into(), "bad.txt".into(), "unreadable".into())
    );
}

async fn media_task(db: &Db, reader: &Connection, root: &Path) -> MediaScanTask {
    reader.execute_batch(
        "INSERT INTO media_sources(id,name,kind,storage_pool_id,path,created_at,updated_at) VALUES
           ('movies','Movies','movie','local','Movies','now','now'),
           ('other','Other','movie','local','Other','now','now');
         INSERT INTO media_scan_runs(id,source_id,status,generation,created_at,updated_at)
           VALUES ('scan','movies','queued','new','now','now');
         INSERT INTO media_titles(id,source_id,kind,source_path,title,sort_title,metadata_source,match_status,scan_generation,added_at,updated_at) VALUES
           ('stale-title','movies','movie','Movies/stale.mkv','Stale','Stale','filename','unmatched','old','now','now'),
           ('other-title','other','movie','Other/keep.mkv','Keep','Keep','filename','unmatched','old','now','now');
         INSERT INTO media_files(id,source_id,title_id,storage_pool_id,relative_path,name,mime_type,size_bytes,mtime_ms,scan_generation,created_at,updated_at) VALUES
           ('stale-file','movies','stale-title','local','Movies/stale.mkv','stale.mkv','video/x-matroska',1,1,'old','now','now'),
           ('other-file','other','other-title','local','Other/keep.mkv','keep.mkv','video/x-matroska',1,1,'old','now','now');",
    ).unwrap();
    db.claim_media_scan("worker", &[common::storage_pool(root)])
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn publishing_media_waits_for_a_writer_and_cleans_only_its_source() {
    let (directory, db, reader) = setup();
    let task = media_task(&db, &reader, directory.path()).await;
    during_write(
        hold_writer(directory.path()),
        db.publish_media_scan(&task, "worker", &[]),
    )
    .await
    .unwrap();
    let scan: (String, i64, i64) = reader
        .query_row(
            "SELECT status,scanned,removed FROM media_scan_runs WHERE id='scan'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(scan, ("completed".into(), 0, 1));
    assert_eq!(
        count(
            &reader,
            "SELECT COUNT(*) FROM media_files WHERE id='other-file'"
        ),
        1
    );
    assert_eq!(
        count(
            &reader,
            "SELECT COUNT(*) FROM media_titles WHERE id='other-title'"
        ),
        1
    );
    assert_eq!(
        count(
            &reader,
            "SELECT COUNT(*) FROM media_files WHERE source_id='movies'"
        ),
        0
    );
}

#[tokio::test]
async fn publishing_media_rechecks_ownership_after_the_concurrent_writer_commits() {
    let (directory, db, reader) = setup();
    let task = media_task(&db, &reader, directory.path()).await;
    let writer = hold_writer(directory.path());
    writer
        .execute(
            "UPDATE media_scan_runs SET worker_id='replacement-worker' WHERE id='scan'",
            [],
        )
        .unwrap();
    let error = during_write(writer, db.publish_media_scan(&task, "worker", &[]))
        .await
        .unwrap_err();
    assert_eq!(error.message, "Media scan lease was lost");
    assert_eq!(count(&reader, "SELECT COUNT(*) FROM media_files"), 2);
    assert_eq!(
        reader
            .query_row(
                "SELECT worker_id FROM media_scan_runs WHERE id='scan'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "replacement-worker"
    );
}
