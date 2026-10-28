mod common;

use std::path::Path;

use cyberos_indexer::db::{Db, IndexerSettings, QueueTask};
use cyberos_indexer::scanner::run_task;
use rusqlite::Connection;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn indexes_text_skips_symlinks_and_cleans_stale_rows() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("docs/alpha.txt"), "alpha project plan").unwrap();
    std::fs::write(root.join("duplicate-a.txt"), "same bytes").unwrap();
    std::fs::write(root.join("duplicate-b.txt"), "same bytes").unwrap();
    std::fs::write(directory.path().join("outside.txt"), "outside secret").unwrap();
    symlink(
        directory.path().join("outside.txt"),
        root.join("outside.txt"),
    )
    .unwrap();
    let database_path = directory.path().join("cyberos.sqlite");
    common::create_schema(&database_path, &root);
    let db = Db::open(&database_path).unwrap();
    let task = QueueTask {
        id: "task-1".to_owned(),
        root_id: "local".to_owned(),
        root_path: root.to_string_lossy().into_owned(),
        storage_pool_id: None,
        path: ".".to_owned(),
        recursive: true,
        kind: "full".to_owned(),
        generation: 1,
        retry_count: 0,
        mount_policy: "optional".to_owned(),
        expected_source: None,
        expected_uuid: None,
        expected_fstype: None,
    };

    let first = match run_task(
        &db,
        &task,
        &IndexerSettings::default(),
        &CancellationToken::new(),
    )
    .await
    {
        Ok(stats) => stats,
        Err(error) => {
            let reader = Connection::open(&database_path).unwrap();
            let failures: Vec<(String, String)> = reader
                .prepare("SELECT path, reason FROM index_failures")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            panic!("{error:?}: {failures:?}");
        }
    };
    assert_eq!(first.indexed, 3);
    assert_eq!(first.skipped, 1);
    let reader = Connection::open(&database_path).unwrap();
    let matches: i64 = reader
        .query_row(
            "SELECT COUNT(*) FROM indexed_content_fts WHERE indexed_content_fts MATCH 'alpha'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(matches, 1);

    reader.execute(
        "INSERT INTO index_queue (id, root_id, path, recursive, kind, generation, priority, status, created_at, updated_at)
         VALUES ('failed-child', 'local', 'docs/failed.txt', 0, 'incremental', 1, 50, 'failed', 'now', 'now')",
        [],
    ).unwrap();

    std::fs::remove_file(root.join("docs/alpha.txt")).unwrap();
    let second = run_task(
        &db,
        &QueueTask {
            id: "task-2".to_owned(),
            ..task
        },
        &IndexerSettings::default(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(second.removed, 1);
    let stale: i64 = reader.query_row(
        "SELECT COUNT(*) FROM indexed_files WHERE root_id = 'local' AND path = 'docs/alpha.txt'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(stale, 0);
    let failed_tasks: i64 = reader
        .query_row(
            "SELECT COUNT(*) FROM index_queue WHERE root_id = 'local' AND status = 'failed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(failed_tasks, 0);
    assert!(Path::new(&root).exists());
}

#[tokio::test]
async fn non_recursive_and_ignored_incremental_tasks_preserve_rebuild_state() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir_all(root.join("docs/nested")).unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join("docs/direct.txt"), "direct alpha").unwrap();
    std::fs::write(root.join("docs/nested/deep.txt"), "deep alpha").unwrap();
    std::fs::write(root.join(".git/config"), "secret alpha").unwrap();
    let database_path = directory.path().join("cyberos.sqlite");
    common::create_schema(&database_path, &root);
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute(
            "UPDATE index_content_state SET status = 'copying' WHERE root_id = 'local'",
            [],
        )
        .unwrap();
    connection.execute(
        "INSERT INTO indexed_files (id, root_id, path, name, indexed_at) VALUES ('ignored', 'local', '.git/config', 'config', 'now')",
        [],
    ).unwrap();
    connection.execute(
        "INSERT INTO indexed_content_fts (file_id, root_id, path, name, body, terms) VALUES ('ignored', 'local', '.git/config', 'config', 'secret', 'secret')",
        [],
    ).unwrap();
    drop(connection);
    let db = Db::open(&database_path).unwrap();
    let base_task = QueueTask {
        id: "task-incremental".to_owned(),
        root_id: "local".to_owned(),
        root_path: root.to_string_lossy().into_owned(),
        storage_pool_id: None,
        path: "docs".to_owned(),
        recursive: false,
        kind: "incremental".to_owned(),
        generation: 1,
        retry_count: 0,
        mount_policy: "optional".to_owned(),
        expected_source: None,
        expected_uuid: None,
        expected_fstype: None,
    };

    run_task(
        &db,
        &base_task,
        &IndexerSettings::default(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let connection = Connection::open(&database_path).unwrap();
    let paths_after_non_recursive: Vec<String> = connection
        .prepare("SELECT path FROM indexed_files ORDER BY path")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        paths_after_non_recursive,
        vec![".git/config", "docs/direct.txt"]
    );
    drop(connection);
    run_task(
        &db,
        &QueueTask {
            id: "task-subtree".to_owned(),
            recursive: true,
            ..base_task.clone()
        },
        &IndexerSettings::default(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    run_task(
        &db,
        &QueueTask {
            id: "task-ignored".to_owned(),
            path: ".git/config".to_owned(),
            recursive: true,
            ..base_task
        },
        &IndexerSettings::default(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();

    let connection = Connection::open(&database_path).unwrap();
    let paths: Vec<String> = connection
        .prepare("SELECT path FROM indexed_files ORDER BY path")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(paths, vec!["docs/direct.txt", "docs/nested/deep.txt"]);
    let state: (String, Option<String>, i64) = connection.query_row(
        "SELECT c.status, r.active_scan_generation, r.reconcile_requested FROM index_content_state c JOIN index_root_state r USING (root_id) WHERE c.root_id = 'local'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(state, ("copying".to_owned(), None, 1));
}

#[tokio::test]
async fn file_failures_skip_stale_cleanup_and_preserve_old_rows() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("broken.docx"), "not a zip").unwrap();
    let database_path = directory.path().join("cyberos.sqlite");
    common::create_schema(&database_path, &root);
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute(
            "INSERT INTO indexed_files (id, root_id, path, name, indexed_at, scan_generation)
         VALUES ('old', 'local', 'gone.txt', 'gone.txt', 'now', 'old-generation')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO indexed_content_fts (file_id, root_id, path, name, body, terms)
         VALUES ('old', 'local', 'gone.txt', 'gone.txt', 'old body', 'old body')",
            [],
        )
        .unwrap();
    drop(connection);
    let db = Db::open(&database_path).unwrap();
    let task = QueueTask {
        id: "task-failure".to_owned(),
        root_id: "local".to_owned(),
        root_path: root.to_string_lossy().into_owned(),
        storage_pool_id: None,
        path: ".".to_owned(),
        recursive: true,
        kind: "full".to_owned(),
        generation: 1,
        retry_count: 0,
        mount_policy: "optional".to_owned(),
        expected_source: None,
        expected_uuid: None,
        expected_fstype: None,
    };

    assert!(
        run_task(
            &db,
            &task,
            &IndexerSettings::default(),
            &CancellationToken::new(),
        )
        .await
        .is_err()
    );

    let connection = Connection::open(&database_path).unwrap();
    let old_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM indexed_files WHERE id = 'old'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(old_rows, 1);
    let state: (String, Option<String>) = connection.query_row(
        "SELECT c.status, r.last_reconcile_at FROM index_content_state c JOIN index_root_state r USING (root_id) WHERE c.root_id = 'local'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(state, ("rebuilding".to_owned(), None));
}
