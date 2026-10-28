import type Database from "better-sqlite3";

export interface Migration {
  id: string;
  sql: string;
  prepare?: (db: Database.Database) => void;
}
