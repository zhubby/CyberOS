import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runMigrations } from "./schema.js";

export type CyberOsDatabase = Database.Database;

export const CYBEROS_DATABASE_FORMAT_VERSION = 3;

const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const WAL_RETRY_INITIAL_DELAY_MS = 10;
const WAL_RETRY_MAX_DELAY_MS = 250;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isSqliteLockError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function enableWal(db: CyberOsDatabase): void {
  const deadline = performance.now() + SQLITE_BUSY_TIMEOUT_MS;
  let delayMs = WAL_RETRY_INITIAL_DELAY_MS;

  while (true) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (error) {
      const remainingMs = deadline - performance.now();
      if (!isSqliteLockError(error) || remainingMs <= 0) throw error;

      Atomics.wait(sleepBuffer, 0, 0, Math.min(delayMs, remainingMs));
      delayMs = Math.min(delayMs * 2, WAL_RETRY_MAX_DELAY_MS);
    }
  }
}

function userSchemaObjectCount(db: CyberOsDatabase): number {
  return Number(db.prepare(`
    SELECT COUNT(*)
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
  `).pluck().get());
}

function initializeOrValidateDatabaseIdentity(db: CyberOsDatabase): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version === CYBEROS_DATABASE_FORMAT_VERSION) return;

  if (version !== 0 || userSchemaObjectCount(db) !== 0) {
    throw new Error(
      `Unsupported database format: CyberOS requires format ${CYBEROS_DATABASE_FORMAT_VERSION} and does not migrate older databases`
    );
  }

  db.pragma(`user_version = ${CYBEROS_DATABASE_FORMAT_VERSION}`);
}

function validateDatabaseIdentity(db: CyberOsDatabase): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version !== CYBEROS_DATABASE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported database format: expected CyberOS format ${CYBEROS_DATABASE_FORMAT_VERSION}, received ${version}`
    );
  }
}

export function openCyberOsDb(databasePath: string): CyberOsDatabase {
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new Database(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    initializeOrValidateDatabaseIdentity(db);
    // WAL negotiation can return SQLITE_BUSY without invoking SQLite's busy
    // handler when several processes initialize a new database concurrently.
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    enableWal(db);
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openCyberOsDbReadOnly(databasePath: string): CyberOsDatabase {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    validateDatabaseIdentity(db);
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.pragma("foreign_keys = ON");
    db.pragma("query_only = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
