import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { runMigrations } from "./schema.js";

export type ZosDatabase = Database.Database;

const SQLITE_BUSY_TIMEOUT_MS = 30_000;

export function openZosDb(databasePath: string): ZosDatabase {
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  // Set the busy handler before WAL negotiation so simultaneous service
  // startup waits for the other connection instead of failing immediately.
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
