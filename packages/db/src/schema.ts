import type Database from "better-sqlite3";
import { currentMigrations } from "./migrations/current.js";
import { agentResourceMigrations } from "./migrations/agent-resources.js";
import { p2pDownloadMigrations } from "./migrations/p2p-downloads.js";
import { musicMigrations } from "./migrations/music.js";
import { videoMigrations } from "./migrations/video.js";
import { photosScanContentionMigrations } from "./migrations/photos-scan-contention.js";
import type { Migration } from "./migrations/types.js";

export type { Migration } from "./migrations/types.js";

export const migrations: Migration[] = [
  ...currentMigrations,
  ...agentResourceMigrations,
  ...p2pDownloadMigrations,
  ...musicMigrations,
  ...videoMigrations,
  ...photosScanContentionMigrations
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const hasMigration = db
    .prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
    .pluck() as Database.Statement<[string], 1 | undefined>;
  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
  );

  const apply = db.transaction((migration: Migration) => {
    // Another process may have applied this migration while this connection
    // was waiting for the write lock. Re-check under the transaction lock so
    // concurrent startups never replay ALTER TABLE statements.
    if (hasMigration.get(migration.id)) return;
    migration.prepare?.(db);
    db.exec(migration.sql);
    insertMigration.run(migration.id, new Date().toISOString());
  });

  for (const migration of migrations) {
    if (!hasMigration.get(migration.id)) {
      apply.immediate(migration);
    }
  }
}
