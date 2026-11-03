import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCyberOsRuntime } from "@cyberos/shared";
import { listBackupDirectories } from "./backup-directories.js";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberos-backup-picker-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config() {
  return loadCyberOsRuntime({ CYBEROS_ROOT: root, CYBEROS_ENVIRONMENT: "development" });
}

describe("backup repository directory browsing", () => {
  it("lists configured backup directories and mounted backup filesystems, excluding system and NAS roots", async () => {
    const runtime = config();
    const repository = path.join(root, "external-repository");
    const mounted = path.join(root, "backup disk");
    const alias = path.join(root, "nas-alias");
    await Promise.all([runtime.paths.backupRoot, repository, mounted, alias, runtime.paths.dataRoot, runtime.paths.stateDir].map((directory) => mkdir(directory, { recursive: true })));
    const mountInfo = [
      `1 0 8:1 / / rw - ext4 /dev/root rw`,
      `2 1 8:2 / ${mounted.replaceAll(" ", "\\040")} rw - ext4 /dev/sda1 rw`,
      `3 1 8:3 / ${runtime.paths.dataRoot} rw - ext4 /dev/sda2 rw`,
      `4 1 8:4 / ${runtime.paths.stateDir} rw - ext4 /dev/sda3 rw`,
      `5 1 0:1 / /proc rw - proc proc rw`,
      `6 1 8:3 / ${alias} rw - ext4 /dev/sda2 rw`
    ].join("\n");
    const listing = await listBackupDirectories(runtime, repository, {}, mountInfo);
    expect(listing.roots.map((entry) => entry.path)).toEqual([runtime.paths.backupRoot, repository, mounted]);
    expect(listing.entries).toEqual([]);
    await expect(listBackupDirectories(runtime, repository, { root: alias, path: alias }, mountInfo)).rejects.toThrow(/available backup location/u);
  });

  it("browses directories without exposing files, symlinks, or protected descendants", async () => {
    const runtime = config();
    const backupRoot = runtime.paths.backupRoot;
    const child = path.join(backupRoot, "snapshots");
    await mkdir(child, { recursive: true });
    await mkdir(runtime.paths.stateDir, { recursive: true });
    await writeFile(path.join(backupRoot, "credential.txt"), "not returned");
    await symlink(runtime.paths.stateDir, path.join(backupRoot, "outside"));
    await symlink(child, path.join(backupRoot, "alias"));
    const listing = await listBackupDirectories(runtime, backupRoot, { root: backupRoot, path: backupRoot }, "");
    expect(listing.entries).toEqual([expect.objectContaining({ name: "snapshots", path: child, kind: "directory", isSafe: true })]);
    expect((await listBackupDirectories(runtime, backupRoot, { root: backupRoot, path: child }, "")).entries).toEqual([]);

    for (const directory of [runtime.paths.stateDir, path.join(backupRoot, "..", "state"), path.join(backupRoot, "outside"), path.join(backupRoot, "alias")]) {
      await expect(listBackupDirectories(runtime, backupRoot, { root: backupRoot, path: directory }, "")).rejects.toThrow(/outside|symbolic|escapes/u);
    }
    await expect(listBackupDirectories(runtime, backupRoot, { root, path: root }, "")).rejects.toThrow(/available backup location/u);
  });

  it("rejects a symlink as a configured root and never browses a repository inside NAS data", async () => {
    const runtime = config();
    const data = path.join(runtime.paths.dataRoot, "pool-1");
    await mkdir(data, { recursive: true });
    await symlink(data, runtime.paths.backupRoot);
    expect((await listBackupDirectories(runtime, data, {}, "")).roots).toEqual([]);
    await expect(listBackupDirectories(runtime, data, { root: data, path: data }, "")).rejects.toThrow(/available backup location/u);
  });
});
