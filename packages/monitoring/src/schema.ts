import type Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

export function runMonitoringMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitoring_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const version = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM monitoring_schema_migrations")
    .get() as { version: number };
  if (version.version >= SCHEMA_VERSION) return;

  db.transaction(() => {
    db.exec(`
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
    `);
    db.prepare("INSERT INTO monitoring_schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(SCHEMA_VERSION, new Date().toISOString());
  })();
}
