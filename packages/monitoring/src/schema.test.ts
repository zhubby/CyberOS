import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  MONITORING_SCHEMA_IDENTITY,
  MONITORING_SCHEMA_VERSION,
  UnsupportedMonitoringSchemaIdentityError,
  UnsupportedMonitoringSchemaVersionError,
  assertSupportedMonitoringSchemaVersion
} from "./schema.js";

describe("CyberOS 2.0 monitoring schema identity", () => {
  it("allows an empty database to be initialized", () => {
    const db = new Database(":memory:");
    try {
      expect(assertSupportedMonitoringSchemaVersion(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("accepts only the current version with the CyberOS 2.0 identity", () => {
    const db = schemaDatabase(MONITORING_SCHEMA_VERSION, MONITORING_SCHEMA_IDENTITY);
    try {
      expect(assertSupportedMonitoringSchemaVersion(db)).toBe(MONITORING_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("rejects a pre-2.0 schema that reused the current numeric version", () => {
    const db = schemaDatabase(MONITORING_SCHEMA_VERSION, null);
    try {
      expect(() => assertSupportedMonitoringSchemaVersion(db))
        .toThrow(UnsupportedMonitoringSchemaIdentityError);
    } finally {
      db.close();
    }
  });

  it("rejects a future schema before inspecting its identity", () => {
    const db = schemaDatabase(MONITORING_SCHEMA_VERSION + 1, null);
    try {
      expect(() => assertSupportedMonitoringSchemaVersion(db))
        .toThrow(UnsupportedMonitoringSchemaVersionError);
    } finally {
      db.close();
    }
  });
});

function schemaDatabase(version: number, identity: string | null): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE monitoring_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE monitoring_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID, STRICT;
  `);
  db.prepare("INSERT INTO monitoring_schema_migrations(version, applied_at) VALUES (?, 'test')")
    .run(version);
  if (identity) {
    db.prepare("INSERT INTO monitoring_metadata(key, value) VALUES ('schema_identity', ?)")
      .run(identity);
  }
  return db;
}
