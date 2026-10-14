import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyDatabase, parsePathMappings } from "./scripts/zos-migrate-database.mjs";

const tempDirectories = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("legacy database migration", () => {
  it("rewrites operational absolute paths without changing embedded audit text", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zos-database-migration-"));
    tempDirectories.push(directory);
    const databasePath = path.join(directory, "zos.sqlite");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE nas_roots (id TEXT PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE agent_provider_sessions (session_file TEXT);
      CREATE TABLE trash_entries (trash_path TEXT NOT NULL, metadata_json TEXT NOT NULL);
      CREATE TABLE file_operations (source_path TEXT, target_path TEXT, metadata_json TEXT NOT NULL);
      CREATE TABLE pending_approvals (proposal_json TEXT NOT NULL);
      CREATE TABLE storage_operations (target_id TEXT NOT NULL, metadata_json TEXT NOT NULL);
      CREATE TABLE vm_operations (metadata_json TEXT NOT NULL);
      CREATE TABLE photostaff_publish_journal (
        thumbnail_temp_path TEXT,
        thumbnail_path TEXT,
        preview_temp_path TEXT,
        preview_path TEXT
      );
    `);
    database.prepare("INSERT INTO nas_roots VALUES (?, ?)").run("primary", "/srv/nas");
    database.prepare("INSERT INTO agent_provider_sessions VALUES (?)")
      .run("/var/lib/sigmaos/pi-sessions/session.jsonl");
    database.prepare("INSERT INTO trash_entries VALUES (?, ?)").run(
      "/var/lib/sigmaos/trash/primary/item",
      JSON.stringify({ absoluteTrashPath: "/var/lib/sigmaos/trash/primary/item" })
    );
    database.prepare("INSERT INTO file_operations VALUES (?, ?, ?)").run(
      "relative.txt",
      "/srv/nas/pool1/target.txt",
      JSON.stringify({ absoluteSourcePath: "/srv/nas/pool1/source.txt" })
    );
    database.prepare("INSERT INTO pending_approvals VALUES (?)").run(JSON.stringify([{
      cwd: "/srv/nas/pool1",
      diskPath: "/var/lib/sigmaos/vmstore/guest.qcow2",
      isoPath: "/srv/iso/debian.iso",
      summary: "Use /srv/nas/pool1"
    }]));
    database.prepare("INSERT INTO storage_operations VALUES (?, ?)").run(
      "/srv/apps/project",
      JSON.stringify({ proposal: { mountpoint: "/srv/apps/project" } })
    );
    database.prepare("INSERT INTO vm_operations VALUES (?)").run(
      JSON.stringify({ proposal: { diskPath: "/var/lib/sigmaos/vmstore/guest.qcow2" } })
    );
    database.prepare("INSERT INTO photostaff_publish_journal VALUES (?, ?, ?, ?)").run(
      "/var/lib/sigmaos/photostaff/thumbnail/.thumb.tmp",
      "/var/lib/sigmaos/photostaff/thumbnail/thumb.webp",
      "/var/lib/sigmaos/photostaff/preview/.preview.tmp",
      "/var/lib/sigmaos/photostaff/preview/preview.webp"
    );
    database.close();

    const mappings = [
      "/srv/nas\t/zos/data/primary",
      "/srv/apps\t/zos/apps",
      "/srv/iso\t/zos/iso",
      "/var/lib/sigmaos/vmstore\t/zos/vm"
    ].join("\n");
    expect(migrateLegacyDatabase(databasePath, mappings)).toEqual({
      scalarValues: 9,
      jsonDocuments: 5,
      pathValues: 16
    });

    const migrated = new Database(databasePath, { readonly: true });
    expect(migrated.prepare("SELECT path FROM nas_roots").pluck().get()).toBe("/zos/data/primary");
    expect(migrated.prepare("SELECT session_file FROM agent_provider_sessions").pluck().get())
      .toBe("/zos/state/pi-sessions/session.jsonl");
    expect(migrated.prepare("SELECT trash_path FROM trash_entries").pluck().get())
      .toBe("/zos/state/trash/primary/item");
    expect(migrated.prepare("SELECT source_path, target_path FROM file_operations").get())
      .toEqual({ source_path: "relative.txt", target_path: "/zos/data/primary/pool1/target.txt" });
    expect(JSON.parse(migrated.prepare("SELECT proposal_json FROM pending_approvals").pluck().get())[0]).toEqual({
      cwd: "/zos/data/primary/pool1",
      diskPath: "/zos/vm/guest.qcow2",
      isoPath: "/zos/iso/debian.iso",
      summary: "Use /srv/nas/pool1"
    });
    expect(migrated.prepare("SELECT target_id FROM storage_operations").pluck().get()).toBe("/zos/apps/project");
    expect(migrated.prepare(`
      SELECT thumbnail_temp_path, thumbnail_path, preview_temp_path, preview_path
      FROM photostaff_publish_journal
    `).get()).toEqual({
      thumbnail_temp_path: "/zos/state/photostaff/thumbnail/.thumb.tmp",
      thumbnail_path: "/zos/state/photostaff/thumbnail/thumb.webp",
      preview_temp_path: "/zos/state/photostaff/preview/.preview.tmp",
      preview_path: "/zos/state/photostaff/preview/preview.webp"
    });
    migrated.close();

    expect(migrateLegacyDatabase(databasePath, mappings)).toEqual({
      scalarValues: 0,
      jsonDocuments: 0,
      pathValues: 0
    });
  });

  it("rejects conflicting mappings", () => {
    expect(() => parsePathMappings("/srv/nas\t/zos/data/one\n/srv/nas\t/zos/data/two\n"))
      .toThrow("conflicting migration mapping");
  });

  it("rolls back every path update when persisted JSON is invalid", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zos-database-migration-"));
    tempDirectories.push(directory);
    const databasePath = path.join(directory, "zos.sqlite");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE nas_roots (id TEXT PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE pending_approvals (proposal_json TEXT NOT NULL);
      INSERT INTO nas_roots VALUES ('primary', '/srv/nas');
      INSERT INTO pending_approvals VALUES ('not-json');
    `);
    database.close();

    expect(() => migrateLegacyDatabase(databasePath, "/srv/nas\t/zos/data/primary\n"))
      .toThrow(SyntaxError);
    const unchanged = new Database(databasePath, { readonly: true });
    expect(unchanged.prepare("SELECT path FROM nas_roots").pluck().get()).toBe("/srv/nas");
    unchanged.close();
  });
});
