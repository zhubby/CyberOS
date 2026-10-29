import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CYBEROS_DATABASE_FORMAT_VERSION,
  migrations,
  openCyberOsDb,
  openCyberOsDbReadOnly
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
        "001_cyberos_2_0"
      ]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }

    const reopened = openCyberOsDbReadOnly(databasePath);
    reopened.close();
  });

  it("exposes a single clean-install migration", () => {
    expect(migrations.map((migration) => migration.id)).toEqual(["001_cyberos_2_0"]);
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
        "001_cyberos_2_0"
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
