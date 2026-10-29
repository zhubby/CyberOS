import type { Migration } from "./types.js";

export const p2pDownloadMigrations: Migration[] = [
  {
    id: "003_p2p_downloads",
    sql: `
CREATE TABLE download_tasks_p2p (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  storage_pool_id TEXT NOT NULL,
  target_directory TEXT NOT NULL,
  target_file_name TEXT NOT NULL,
  target_path TEXT NOT NULL,
  partial_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'seeding', 'completed', 'failed', 'cancelled')),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
  speed_bytes_per_second INTEGER NOT NULL DEFAULT 0 CHECK (speed_bytes_per_second >= 0),
  etag TEXT,
  last_modified TEXT,
  error TEXT,
  worker_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  last_progress_at TEXT,
  file_operation_id TEXT REFERENCES file_operations(id) ON DELETE SET NULL,
  phase TEXT CHECK (phase IS NULL OR phase IN ('resolving_metadata', 'probing', 'downloading', 'verifying', 'publishing', 'seeding', 'retry_wait')),
  download_mode TEXT CHECK (download_mode IS NULL OR download_mode IN ('single', 'segmented', 'torrent')),
  expected_sha256 TEXT CHECK (expected_sha256 IS NULL OR (length(expected_sha256) = 64 AND expected_sha256 = lower(expected_sha256))),
  actual_sha256 TEXT CHECK (actual_sha256 IS NULL OR (length(actual_sha256) = 64 AND actual_sha256 = lower(actual_sha256))),
  error_code TEXT,
  error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0, 1)),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at TEXT,
  control_requested TEXT CHECK (control_requested IS NULL OR control_requested IN ('pause', 'cancel', 'stop_seeding')),
  segment_count INTEGER NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
  source_kind TEXT NOT NULL DEFAULT 'http' CHECK (source_kind IN ('http', 'magnet', 'torrent')),
  torrent_info_hash TEXT,
  torrent_name TEXT,
  torrent_metainfo BLOB,
  selected_file_count INTEGER NOT NULL DEFAULT 0 CHECK (selected_file_count >= 0),
  uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_bytes >= 0),
  upload_speed_bytes_per_second INTEGER NOT NULL DEFAULT 0 CHECK (upload_speed_bytes_per_second >= 0),
  peer_count INTEGER NOT NULL DEFAULT 0 CHECK (peer_count >= 0),
  seed_ratio_limit REAL NOT NULL DEFAULT 1.0 CHECK (seed_ratio_limit >= 0),
  seed_time_limit_seconds INTEGER NOT NULL DEFAULT 7200 CHECK (seed_time_limit_seconds >= 0),
  content_completed_at TEXT,
  seed_started_at TEXT,
  engine_torrent_id TEXT,
  UNIQUE(storage_pool_id, target_path)
);

INSERT INTO download_tasks_p2p (
  id, url, storage_pool_id, target_directory, target_file_name, target_path,
  partial_path, status, received_bytes, total_bytes, speed_bytes_per_second,
  etag, last_modified, error, worker_id, lease_expires_at, created_at,
  updated_at, started_at, finished_at, last_progress_at, file_operation_id,
  phase, download_mode, expected_sha256, actual_sha256, error_code,
  error_retryable, retry_count, next_retry_at, control_requested, segment_count
)
SELECT
  id, url, storage_pool_id, target_directory, target_file_name, target_path,
  partial_path, status, received_bytes, total_bytes, speed_bytes_per_second,
  etag, last_modified, error, worker_id, lease_expires_at, created_at,
  updated_at, started_at, finished_at, last_progress_at, file_operation_id,
  phase, download_mode, expected_sha256, actual_sha256, error_code,
  error_retryable, retry_count, next_retry_at, control_requested, segment_count
FROM download_tasks;

CREATE TABLE download_segments_p2p (
  task_id TEXT NOT NULL REFERENCES download_tasks_p2p(id) ON DELETE CASCADE,
  start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
  end_byte INTEGER NOT NULL CHECK (end_byte > start_byte),
  next_byte INTEGER NOT NULL CHECK (next_byte >= start_byte AND next_byte <= end_byte),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, start_byte)
);
INSERT INTO download_segments_p2p SELECT * FROM download_segments;

CREATE TABLE download_publish_journal_p2p (
  task_id TEXT PRIMARY KEY REFERENCES download_tasks_p2p(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  device INTEGER NOT NULL,
  inode INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO download_publish_journal_p2p SELECT * FROM download_publish_journal;

CREATE TABLE download_space_reservations_p2p (
  task_id TEXT PRIMARY KEY REFERENCES download_tasks_p2p(id) ON DELETE CASCADE,
  storage_pool_id TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  updated_at TEXT NOT NULL
);
INSERT INTO download_space_reservations_p2p SELECT * FROM download_space_reservations;

DROP TABLE download_segments;
DROP TABLE download_publish_journal;
DROP TABLE download_space_reservations;
DROP TABLE download_tasks;

ALTER TABLE download_tasks_p2p RENAME TO download_tasks;
ALTER TABLE download_segments_p2p RENAME TO download_segments;
ALTER TABLE download_publish_journal_p2p RENAME TO download_publish_journal;
ALTER TABLE download_space_reservations_p2p RENAME TO download_space_reservations;

CREATE TABLE torrent_previews (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('magnet', 'torrent')),
  source_uri TEXT,
  metainfo BLOB,
  status TEXT NOT NULL CHECK (status IN ('queued', 'resolving', 'ready', 'failed', 'expired')),
  info_hash TEXT,
  name TEXT,
  total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  is_private INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
  error TEXT,
  worker_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE torrent_preview_files (
  preview_id TEXT NOT NULL REFERENCES torrent_previews(id) ON DELETE CASCADE,
  file_index INTEGER NOT NULL CHECK (file_index >= 0),
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  PRIMARY KEY (preview_id, file_index)
);

CREATE TABLE download_task_files (
  task_id TEXT NOT NULL REFERENCES download_tasks(id) ON DELETE CASCADE,
  file_index INTEGER NOT NULL CHECK (file_index >= 0),
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  selected INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  PRIMARY KEY (task_id, file_index)
);

CREATE INDEX idx_download_tasks_claim ON download_tasks(status, next_retry_at, created_at);
CREATE INDEX idx_download_tasks_status_created_at ON download_tasks(status, created_at);
CREATE INDEX idx_download_tasks_updated_at ON download_tasks(updated_at DESC);
CREATE UNIQUE INDEX idx_download_tasks_active_info_hash
  ON download_tasks(torrent_info_hash)
  WHERE torrent_info_hash IS NOT NULL
    AND status IN ('queued', 'running', 'paused', 'seeding');
CREATE INDEX idx_torrent_previews_claim ON torrent_previews(status, expires_at, created_at);
CREATE INDEX idx_torrent_previews_expiry ON torrent_previews(expires_at);
    `
  }
];
