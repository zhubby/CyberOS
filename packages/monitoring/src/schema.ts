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
