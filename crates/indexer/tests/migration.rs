mod common;

use std::time::Duration;

use zos_indexer::db::{Db, IndexedFileRecord};
use zos_indexer::error::{ErrorCode, IndexerError};
use zos_indexer::storage::FileIdentity;

#[tokio::test]
async fn waits_for_migration_039() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let database = directory.path().join("zos.sqlite");
    common::create_schema(&database, &root);
    let db = Db::open(&database).unwrap();
    db.wait_for_schema(Duration::from_millis(50)).await.unwrap();
}

#[tokio::test]
async fn first_extraction_failure_is_persisted_for_diagnostics() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let database = directory.path().join("zos.sqlite");
    common::create_schema(&database, &root);
    let db = Db::open(&database).unwrap();
    db.record_extraction_error(
        IndexedFileRecord {
            root_id: "local",
            storage_pool_id: Some("pool-1"),
            path: "broken.pdf",
            name: "broken.pdf",
            identity: FileIdentity {
                device: 1,
                inode: 2,
                size: 3,
                mtime_ns: 4_000_000,
                ctime_ns: 5,
            },
            scan_generation: Some("generation-1"),
        },
        &IndexerError::new(ErrorCode::CorruptDocument, "encrypted PDF", false),
    )
    .await
    .unwrap();

    let connection = rusqlite::Connection::open(&database).unwrap();
    let stored = connection.query_row(
        "SELECT storage_pool_id, extraction_status, extraction_error, scan_generation FROM indexed_files WHERE root_id = 'local' AND path = 'broken.pdf'",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
    ).unwrap();
    assert_eq!(
        stored,
        (
            "pool-1".to_owned(),
            "error".to_owned(),
            "encrypted PDF".to_owned(),
            "generation-1".to_owned()
        )
    );
}

#[tokio::test]
async fn legacy_copy_skips_content_without_a_live_file_row() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let database = directory.path().join("zos.sqlite");
    common::create_schema(&database, &root);
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection.execute(
        "INSERT INTO indexed_files (id, root_id, path, name, indexed_at) VALUES ('live', 'local', 'live.txt', 'live.txt', 'now')",
        [],
    ).unwrap();
    connection.execute(
        "INSERT INTO indexed_text (file_id, root_id, path, name, body) VALUES ('live', 'local', 'live.txt', 'live.txt', 'live body')",
        [],
    ).unwrap();
    connection.execute(
        "INSERT INTO indexed_text (file_id, root_id, path, name, body) VALUES ('orphan', 'local', 'gone.txt', 'gone.txt', 'orphan body')",
        [],
    ).unwrap();
    drop(connection);
    let db = Db::open(&database).unwrap();

    assert!(db.copy_legacy_batch("local", 100, 1024).await.unwrap());

    let connection = rusqlite::Connection::open(&database).unwrap();
    let copied: Vec<String> = connection
        .prepare("SELECT file_id FROM indexed_content_fts ORDER BY file_id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(copied, vec!["live"]);
}
