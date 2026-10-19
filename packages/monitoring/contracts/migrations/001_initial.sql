CREATE TABLE metric_series (
  id INTEGER PRIMARY KEY,
  metric_name TEXT NOT NULL,
  labels_key TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(metric_name, labels_key)
) STRICT;

CREATE TABLE metric_samples_raw (
  series_id INTEGER NOT NULL REFERENCES metric_series(id) ON DELETE CASCADE,
  timestamp_ms INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY(series_id, timestamp_ms)
) WITHOUT ROWID, STRICT;

CREATE TABLE metric_rollups_1m (
  series_id INTEGER NOT NULL REFERENCES metric_series(id) ON DELETE CASCADE,
  bucket_ms INTEGER NOT NULL,
  first_timestamp_ms INTEGER NOT NULL,
  last_timestamp_ms INTEGER NOT NULL,
  first_value REAL NOT NULL,
  last_value REAL NOT NULL,
  min_value REAL NOT NULL,
  max_value REAL NOT NULL,
  sum_value REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY(series_id, bucket_ms)
) WITHOUT ROWID, STRICT;

CREATE TABLE metric_rollups_1h (
  series_id INTEGER NOT NULL REFERENCES metric_series(id) ON DELETE CASCADE,
  bucket_ms INTEGER NOT NULL,
  first_timestamp_ms INTEGER NOT NULL,
  last_timestamp_ms INTEGER NOT NULL,
  first_value REAL NOT NULL,
  last_value REAL NOT NULL,
  min_value REAL NOT NULL,
  max_value REAL NOT NULL,
  sum_value REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY(series_id, bucket_ms)
) WITHOUT ROWID, STRICT;

CREATE TABLE collector_status (
  collector_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('ready', 'error', 'unsupported', 'disabled')),
  last_attempt_ms INTEGER,
  last_success_ms INTEGER,
  duration_ms REAL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  error TEXT
) WITHOUT ROWID, STRICT;

CREATE TABLE monitoring_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID, STRICT;

CREATE INDEX metric_samples_raw_timestamp_idx ON metric_samples_raw(timestamp_ms);
CREATE INDEX metric_rollups_1m_bucket_idx ON metric_rollups_1m(bucket_ms);
CREATE INDEX metric_rollups_1h_bucket_idx ON metric_rollups_1h(bucket_ms);
