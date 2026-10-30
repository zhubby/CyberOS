import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CYBEROS_DATABASE_FORMAT_VERSION,
  createMediaSource,
  getMediaFile,
  migrations,
  openCyberOsDb,
  openCyberOsDbReadOnly,
  saveMediaProgress,
  upsertMediaCatalogEntry
} from "./index.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-db-schema-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("CyberOS 2.0 SQLite schema", () => {
  it("initializes a blank database with the current identity and baseline", () => {
    const databasePath = path.join(tempDir, "cyberos.sqlite");
    const database = openCyberOsDb(databasePath);
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(CYBEROS_DATABASE_FORMAT_VERSION);
      expect(database.prepare("SELECT id FROM schema_migrations").pluck().all()).toEqual([
        "001_cyberos_2_0",
        "002_agent_resources",
        "003_p2p_downloads",
        "004_music_library",
        "005_video_library",
        "006_photos_scan_contention"
      ]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }

    const reopened = openCyberOsDbReadOnly(databasePath);
    reopened.close();
  });

  it("keeps the clean-install baseline and applies additive 2.x migrations", () => {
    expect(migrations.map((migration) => migration.id)).toEqual([
      "001_cyberos_2_0",
      "002_agent_resources",
      "003_p2p_downloads",
        "004_music_library",
        "005_video_library",
        "006_photos_scan_contention"
    ]);
  });

  it("adds P2P task metadata, previews, and selected files without breaking foreign keys", () => {
    const database = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
    try {
      const taskColumns = database.pragma("table_info(download_tasks)") as Array<{ name: string }>;
      expect(taskColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "source_kind",
        "torrent_info_hash",
        "uploaded_bytes",
        "upload_speed_bytes_per_second",
        "peer_count",
        "seed_ratio_limit",
        "seed_time_limit_seconds"
      ]));
      expect(database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name IN (
          'download_task_files', 'torrent_previews', 'torrent_preview_files'
        ) ORDER BY name
      `).pluck().all()).toEqual([
        "download_task_files",
        "torrent_preview_files",
        "torrent_previews"
      ]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("upgrades a populated pre-video 2.x database without changing media or settings", () => {
    const databasePath = path.join(tempDir, "upgrade.sqlite");
    const previous = new Database(databasePath);
    let fileId: string;
    try {
      previous.pragma(`user_version = ${CYBEROS_DATABASE_FORMAT_VERSION}`);
      previous.pragma("foreign_keys = ON");
      previous.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      for (const migration of migrations.filter((entry) => entry.id < "005_video_library")) {
        migration.prepare?.(previous);
        previous.exec(migration.sql);
        previous.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(migration.id, "2026-10-29T00:00:00Z");
      }
      const source = createMediaSource(previous, { name: "Movies", kind: "movie", storagePoolId: "pool-1", path: "Movies" });
      const { file } = upsertMediaCatalogEntry(previous, {
        sourceId: source.id,
        generation: "existing",
        title: { kind: "movie", sourcePath: "Movies/Arrival", title: "Arrival", metadataSource: "filename", matchStatus: "unmatched" },
        file: { relativePath: "Movies/Arrival.mp4", name: "Arrival.mp4", mimeType: "video/mp4", sizeBytes: 100, mtimeMs: 1 }
      });
      fileId = file.id;
      saveMediaProgress(previous, { fileId, positionSeconds: 30, durationSeconds: 120 });
      previous.prepare("INSERT INTO system_settings VALUES (?, ?, ?)").run("test.setting", '{"enabled":true}', "2026-10-29T00:00:00Z");
    } finally {
      previous.close();
    }

    const upgraded = openCyberOsDb(databasePath);
    try {
      expect(getMediaFile(upgraded, fileId!)?.relativePath).toBe("Movies/Arrival.mp4");
      expect(upgraded.prepare("SELECT position_seconds FROM media_progress WHERE file_id = ?").pluck().get(fileId!)).toBe(30);
      expect(upgraded.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = 'test.setting'").get()).toEqual({
        value_json: '{"enabled":true}', updated_at: "2026-10-29T00:00:00Z"
      });
      expect(upgraded.prepare("SELECT COUNT(*) FROM media_personal_state").pluck().get()).toBe(0);
      expect(upgraded.prepare("SELECT COUNT(*) FROM schema_migrations WHERE id = '005_video_library'").pluck().get()).toBe(1);
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
    }
    const reopened = openCyberOsDb(databasePath);
    reopened.close();
  });

  it("adds Photos claim indexes without resetting existing scan progress or leases", () => {
    const databasePath = path.join(tempDir, "photos-upgrade.sqlite");
    const previous = new Database(databasePath);
    try {
      previous.pragma(`user_version = ${CYBEROS_DATABASE_FORMAT_VERSION}`);
      previous.pragma("foreign_keys = ON");
      previous.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      for (const migration of migrations.filter((entry) => entry.id < "006_photos_scan_contention")) {
        migration.prepare?.(previous);
        previous.exec(migration.sql);
        previous.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(migration.id, "2026-10-30T00:00:00Z");
      }
      previous.exec(`
        INSERT INTO photos_jobs (id, kind, status, storage_pool_id, path, library_updated_at,
          scanned, processed, scan_generation, worker_id, lease_expires_at, created_at, updated_at)
        VALUES ('job-1', 'full_scan', 'running', 'pool-1', 'Photos', 'library-1',
          4354, 12, 'generation-1', 'worker-1', '2099-01-01T00:00:00Z', 'created', 'updated');
        INSERT INTO photos_scan_entries (job_id, path, entry_type, status, error_retryable,
          retry_count, next_retry_at, updated_at) VALUES
          ('job-1', 'Photos/completed.jpg', 'media', 'completed', 0, 0, NULL, 'completed'),
          ('job-1', 'Photos/pending', 'directory', 'pending', 0, 0, NULL, 'pending'),
          ('job-1', 'Photos/retry', 'directory', 'failed', 1, 2, '2026-10-30T00:00:00Z', 'retry');
      `);
    } finally {
      previous.close();
    }

    const upgraded = openCyberOsDb(databasePath);
    try {
      expect(upgraded.prepare("SELECT status, scanned, processed, scan_generation, worker_id, lease_expires_at FROM photos_jobs WHERE id = 'job-1'").get()).toEqual({
        status: "running", scanned: 4354, processed: 12, scan_generation: "generation-1",
        worker_id: "worker-1", lease_expires_at: "2099-01-01T00:00:00Z"
      });
      expect(upgraded.prepare("SELECT path, status, retry_count FROM photos_scan_entries ORDER BY path").all()).toEqual([
        { path: "Photos/completed.jpg", status: "completed", retry_count: 0 },
        { path: "Photos/pending", status: "pending", retry_count: 0 },
        { path: "Photos/retry", status: "failed", retry_count: 2 }
      ]);
      const plans = [
        "SELECT path FROM photos_scan_entries INDEXED BY idx_photos_scan_entries_pending WHERE job_id = 'job-1' AND entry_type = 'directory' AND status = 'pending' ORDER BY path LIMIT 1",
        "SELECT path FROM photos_scan_entries INDEXED BY idx_photos_scan_entries_retry WHERE job_id = 'job-1' AND entry_type = 'directory' AND status = 'failed' AND error_retryable = 1 AND next_retry_at <= '2026-10-30T00:00:00Z' ORDER BY path LIMIT 1"
      ].map((sql) => upgraded.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>);
      expect(plans[0]?.some((row) => row.detail.includes("idx_photos_scan_entries_pending"))).toBe(true);
      expect(plans[1]?.some((row) => row.detail.includes("idx_photos_scan_entries_retry"))).toBe(true);
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
      expect(upgraded.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
    } finally {
      upgraded.close();
    }
    openCyberOsDb(databasePath).close();
  });

  it("rejects an unmarked non-empty database without changing it", () => {
    const databasePath = path.join(tempDir, "old.sqlite");
    const oldDatabase = new Database(databasePath);
    oldDatabase.exec("CREATE TABLE old_product_data (id TEXT PRIMARY KEY)");
    oldDatabase.close();

    expect(() => openCyberOsDb(databasePath)).toThrow("does not migrate older databases");
    expect(() => openCyberOsDbReadOnly(databasePath)).toThrow("expected CyberOS format 3");

    const unchanged = new Database(databasePath, { readonly: true });
    try {
      expect(unchanged.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"
      ).pluck().all()).toEqual(["old_product_data"]);
    } finally {
      unchanged.close();
    }
  });

  it("rejects a database marked with an earlier CyberOS format", () => {
    const databasePath = path.join(tempDir, "format-2.sqlite");
    const oldDatabase = new Database(databasePath);
    oldDatabase.pragma("user_version = 2");
    oldDatabase.exec("CREATE TABLE previous_state (id TEXT PRIMARY KEY)");
    oldDatabase.close();

    expect(() => openCyberOsDb(databasePath)).toThrow("does not migrate older databases");
    expect(() => openCyberOsDbReadOnly(databasePath)).toThrow("expected CyberOS format 3, received 2");
  });

  it("creates only storage-pool-scoped filesystem tables", () => {
    const database = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
    try {
      const tables = database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).pluck().all() as string[];
      expect(tables).toEqual(expect.arrayContaining([
        "agent_sessions",
        "bluetooth_transfers",
        "download_tasks",
        "index_storage_pool_state",
        "indexed_files",
        "media_sources",
        "photos_assets",
        "terminal_tab_state",
        "terminal_tabs"
      ]));

      expect(database.prepare("SELECT COUNT(*) FROM system_settings").pluck().get()).toBe(0);
      expect(database.prepare("SELECT status FROM monitoring_alerter_state WHERE id = 1")
        .pluck().get()).toBe("starting");
    } finally {
      database.close();
    }
  });

  it("contains no pre-2.0 approval, FTS, or branded internal schema", () => {
    const database = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
    try {
      const schemaNames = database.prepare(`
        SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name
      `).pluck().all() as string[];
      expect(schemaNames).not.toEqual(expect.arrayContaining([
        "pending_approvals",
        "tool_calls",
        "docker_create_drafts",
        "indexed_text",
        "photostaff_assets",
        "photostaff_jobs"
      ]));

      for (const table of [
        "file_operations",
        "docker_operations",
        "vm_operations",
        "storage_operations",
        "share_operations",
        "docker_console_authorizations",
        "vm_console_authorizations"
      ]) {
        const columns = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).not.toContain("approval_id");
      }

      const eventColumns = database.pragma("table_info(agent_events)") as Array<{
        name: string;
        notnull: number;
      }>;
      expect(eventColumns.find((column) => column.name === "run_id")?.notnull).toBe(1);
      expect(eventColumns.find((column) => column.name === "sequence")?.notnull).toBe(1);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("serializes concurrent first-start baseline creation", async () => {
    const databasePath = path.join(tempDir, "concurrent.sqlite");
    const moduleUrl = pathToFileURL(path.resolve("packages/db/src/index.ts")).href;

    await Promise.all([
      startDatabaseProcess(databasePath, moduleUrl),
      startDatabaseProcess(databasePath, moduleUrl)
    ]);

    const database = openCyberOsDbReadOnly(databasePath);
    try {
      expect(database.prepare("SELECT id FROM schema_migrations").pluck().all()).toEqual([
        "001_cyberos_2_0",
        "002_agent_resources",
        "003_p2p_downloads",
        "004_music_library",
        "005_video_library",
        "006_photos_scan_contention"
      ]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });
});

function startDatabaseProcess(databasePath: string, moduleUrl: string): Promise<void> {
  const childCode = [
    `import { openCyberOsDb } from ${JSON.stringify(moduleUrl)};`,
    "const db = openCyberOsDb(process.argv[1]);",
    "db.close();"
  ].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", childCode, databasePath],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (status === 0) {
        resolve();
      } else {
        reject(new Error(`database process exited ${status ?? signal}: ${stderr}`));
      }
    });
  });
}
