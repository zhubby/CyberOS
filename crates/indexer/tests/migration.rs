mod common;

use std::time::Duration;

use cyberos_indexer::db::{Db, IndexedFileRecord};
use cyberos_indexer::error::{ErrorCode, IndexerError};
use cyberos_indexer::storage::FileIdentity;

#[tokio::test]
async fn waits_for_cyberos_2_0_schema() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let database = directory.path().join("cyberos.sqlite");
    common::create_schema(&database, &root);
    let db = Db::open(&database).unwrap();
    db.wait_for_schema(Duration::from_millis(50)).await.unwrap();
}

#[tokio::test]
async fn first_extraction_failure_is_persisted_for_diagnostics() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let database = directory.path().join("cyberos.sqlite");
    common::create_schema(&database, &root);
    let db = Db::open(&database).unwrap();
    db.record_extraction_error(
        IndexedFileRecord {
            storage_pool_id: "local",
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
        "SELECT storage_pool_id, extraction_status, extraction_error, scan_generation FROM indexed_files WHERE storage_pool_id = 'local' AND path = 'broken.pdf'",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
    ).unwrap();
    assert_eq!(
        stored,
        (
            "local".to_owned(),
            "error".to_owned(),
            "encrypted PDF".to_owned(),
            "generation-1".to_owned()
        )
    );
}
