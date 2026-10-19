import type Database from "better-sqlite3";

export interface Migration {
  id: string;
  sql: string;
  disableForeignKeys?: boolean;
  prepare?: (db: Database.Database) => void;
}
