import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeMountedBackupPath,
  findRolledBackMigration
} from "./scripts/zos-migration-recovery.mjs";

let directory;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("migration recovery state", () => {
  it("selects the newest complete rolled-back migration", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "zos-migration-recovery-"));
    const older = await createMigration("legacy-sigmaos-20261015T010000Z.older", {
      status: "rolled_back",
      updatedAt: "2026-10-15T01:00:00.000Z"
    });
    const newer = await createMigration("legacy-sigmaos-20261015T020000Z.newer", {
      status: "rolled_back",
      updatedAt: "2026-10-15T02:00:00.000Z"
    });
    await createMigration("legacy-sigmaos-20261015T030000Z.preparing", {
      status: "preparing",
      updatedAt: "2026-10-15T03:00:00.000Z"
    });

    expect(findRolledBackMigration(directory, process.getuid())).toBe(newer);
    expect(findRolledBackMigration(directory, process.getuid())).not.toBe(older);
  });

  it("ignores rollback metadata when the cold backup no longer matches", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "zos-migration-recovery-"));
    const candidate = await createMigration("legacy-sigmaos-20261015T010000Z.invalid", {
      status: "rolled_back",
      updatedAt: "2026-10-15T01:00:00.000Z"
    });
    const statusPath = path.join(candidate, "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    status.coldBackup.sizeBytes += 1;
    await writeFile(statusPath, `${JSON.stringify(status)}\n`);

    expect(findRolledBackMigration(directory, process.getuid())).toBeUndefined();
  });

  it("chooses the active side of a mounted cold backup", () => {
    const backup = {
      storage: "mounted",
      legacyPath: "/srv/nas/pool1/.zos/system-backups/legacy-sigmaos-test/state.tar",
      migratedPath: "/zos/data/primary/pool1/.zos/system-backups/legacy-sigmaos-test/state.tar"
    };

    expect(activeMountedBackupPath(JSON.stringify({ status: "rolled_back", coldBackup: backup })))
      .toBe(backup.legacyPath);
    expect(activeMountedBackupPath(JSON.stringify({ status: "committed", coldBackup: backup })))
      .toBe(backup.migratedPath);
    expect(activeMountedBackupPath(JSON.stringify({ status: "none" }))).toBeUndefined();
  });
});

async function createMigration(name, { status, updatedAt }) {
  const candidate = path.join(directory, name);
  await mkdir(candidate, { mode: 0o700 });
  await chmod(candidate, 0o700);
  await writeFile(path.join(candidate, "state.env"), "LEGACY_VERSION='0.10.8'\n", { mode: 0o600 });
  const backupPath = path.join(candidate, "state.tar");
  await writeFile(backupPath, "backup", { mode: 0o600 });
  await writeFile(path.join(candidate, "status.json"), `${JSON.stringify({
    status,
    backupPath: candidate,
    updatedAt,
    coldBackup: {
      storage: "root",
      legacyPath: backupPath,
      migratedPath: backupPath,
      relativePath: "state.tar",
      sizeBytes: 6,
      sha256: "a".repeat(64)
    }
  })}\n`, { mode: 0o600 });
  return candidate;
}
