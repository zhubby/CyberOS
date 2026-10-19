import type Database from "better-sqlite3";

export const MONITORING_SCHEMA_VERSION = 3;

export class UnsupportedMonitoringSchemaVersionError extends Error {
  constructor(version: number) {
    super(`Monitoring schema version ${version} is newer than supported version ${MONITORING_SCHEMA_VERSION}`);
  }
}

export function assertSupportedMonitoringSchemaVersion(db: Database.Database): number {
  const exists = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'monitoring_schema_migrations'
  `).pluck().get();
  if (!exists) return 0;
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM monitoring_schema_migrations")
    .get() as { version: number };
  if (row.version > MONITORING_SCHEMA_VERSION) {
    throw new UnsupportedMonitoringSchemaVersionError(row.version);
  }
  return row.version;
}

export function runMonitoringMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitoring_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  let version = assertSupportedMonitoringSchemaVersion(db);

  if (version < 1) {
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
      recordMigration(db, 1);
    })();
    version = 1;
  }

  if (version < 2) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE metric_rollups_1m ADD COLUMN increase_value REAL;
        ALTER TABLE metric_rollups_1h ADD COLUMN increase_value REAL;
      `);
      recordMigration(db, 2);
    })();
    version = 2;
  }

  if (version < 3) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE metric_rollups_1m ADD COLUMN boundary_increase_value REAL;
        ALTER TABLE metric_rollups_1h ADD COLUMN boundary_increase_value REAL;
      `);
      recordMigration(db, 3);
    })();
  }
}

function recordMigration(db: Database.Database, version: number): void {
  db.prepare("INSERT INTO monitoring_schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(version, new Date().toISOString());
}
