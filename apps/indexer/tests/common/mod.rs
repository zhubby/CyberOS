use std::path::Path;

use rusqlite::Connection;

pub fn create_schema(path: &Path, root_path: &Path) {
    let connection = Connection::open(path).unwrap();
    connection.execute_batch(r#"
      PRAGMA journal_mode = WAL;
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('024_rust_indexer', '2026-01-01T00:00:00Z');
      CREATE TABLE nas_roots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        mount_policy TEXT NOT NULL DEFAULT 'optional', expected_source TEXT, expected_uuid TEXT, expected_fstype TEXT
      );
      CREATE TABLE indexed_files (
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE CASCADE,
        path TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0, hash TEXT, indexed_at TEXT NOT NULL,
        storage_pool_id TEXT, source_device INTEGER, source_inode INTEGER, source_size_bytes INTEGER,
        source_mtime_ns INTEGER, source_ctime_ns INTEGER, scan_generation TEXT,
        extraction_source TEXT, extraction_status TEXT NOT NULL DEFAULT 'pending', extraction_error TEXT,
        UNIQUE(root_id, path)
      );
      CREATE VIRTUAL TABLE indexed_text USING fts5(file_id UNINDEXED, root_id UNINDEXED, path, name, body);
      CREATE VIRTUAL TABLE indexed_content_fts USING fts5(
        file_id UNINDEXED, root_id UNINDEXED, path, name, body, terms,
        tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
      );
      CREATE TABLE index_queue (
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE CASCADE,
        storage_pool_id TEXT, path TEXT NOT NULL, recursive INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued', retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT, worker_id TEXT, lease_expires_at TEXT, error TEXT, error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        UNIQUE(root_id, path)
      );
      CREATE TABLE index_content_state (
        root_id TEXT PRIMARY KEY REFERENCES nas_roots(id), status TEXT NOT NULL DEFAULT 'legacy',
        legacy_cursor INTEGER NOT NULL DEFAULT 0, copied_count INTEGER NOT NULL DEFAULT 0,
        legacy_total INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE indexer_workers (
        worker_id TEXT PRIMARY KEY, version TEXT NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL
      );
      CREATE TABLE index_root_state (
        root_id TEXT PRIMARY KEY REFERENCES nas_roots(id), watcher_status TEXT NOT NULL DEFAULT 'starting',
        watcher_error TEXT, reconcile_requested INTEGER NOT NULL DEFAULT 1,
        active_scan_generation TEXT, completed_scan_generation TEXT,
        mount_source TEXT, mount_uuid TEXT, mount_fstype TEXT,
        last_event_at TEXT, last_reconcile_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE index_runs (
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES nas_roots(id), status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, scanned INTEGER NOT NULL DEFAULT 0,
        indexed INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0, error TEXT, duration_ms INTEGER,
        bytes INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0,
        text_file_count INTEGER NOT NULL DEFAULT 0, phase TEXT, current_path TEXT,
        last_progress_at TEXT, kind TEXT NOT NULL DEFAULT 'full'
      );
      CREATE TABLE index_failures (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES index_runs(id) ON DELETE CASCADE,
        root_id TEXT NOT NULL REFERENCES nas_roots(id), path TEXT NOT NULL,
        reason TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE index_run_history (
        id TEXT PRIMARY KEY, root_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, scanned INTEGER NOT NULL DEFAULT 0, indexed INTEGER NOT NULL DEFAULT 0,
        unchanged INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, error TEXT,
        duration_ms INTEGER, bytes INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0,
        text_file_count INTEGER NOT NULL DEFAULT 0, phase TEXT, current_path TEXT,
        last_progress_at TEXT, failures_json TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'full'
      );
      CREATE TABLE system_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    "#).unwrap();
    connection.execute(
        "INSERT INTO nas_roots (id, name, path, created_at, updated_at) VALUES ('local', 'Local', ?, 'now', 'now')",
        [root_path.to_string_lossy().as_ref()],
    ).unwrap();
    connection.execute(
        "INSERT INTO index_content_state (root_id, status, updated_at) VALUES ('local', 'legacy', 'now')",
        [],
    ).unwrap();
    connection
        .execute(
            "INSERT INTO index_root_state (root_id, updated_at) VALUES ('local', 'now')",
            [],
        )
        .unwrap();
}
