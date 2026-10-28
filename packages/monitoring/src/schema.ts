import type Database from "better-sqlite3";

export const MONITORING_SCHEMA_VERSION = 1;
export const MONITORING_SCHEMA_IDENTITY = "cyberos-2.0";

export class UnsupportedMonitoringSchemaVersionError extends Error {
  constructor(version: number) {
    super(`Monitoring schema version ${version} is newer than supported version ${MONITORING_SCHEMA_VERSION}`);
  }
}

export class UnsupportedMonitoringSchemaIdentityError extends Error {
  constructor() {
    super("Metrics database does not use the CyberOS 2.0 schema");
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
  if (row.version === MONITORING_SCHEMA_VERSION) {
    const hasMetadata = db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'monitoring_metadata'
    `).pluck().get();
    const identity = hasMetadata
      ? db.prepare("SELECT value FROM monitoring_metadata WHERE key = 'schema_identity'").pluck().get()
      : undefined;
    if (identity !== MONITORING_SCHEMA_IDENTITY) {
      throw new UnsupportedMonitoringSchemaIdentityError();
    }
  }
  return row.version;
}
