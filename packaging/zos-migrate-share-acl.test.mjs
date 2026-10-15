import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyShareAclState } from "./scripts/zos-migrate-share-acl.mjs";

const script = fileURLToPath(new URL("scripts/zos-migrate-share-acl.mjs", import.meta.url));
const tempDirectories = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("legacy share ACL state migration", () => {
  it("moves managed paths while preserving legacy principals for explicit ACL replacement", () => {
    const state = JSON.stringify([
      { path: "/srv/nas/pool1/Shares", principal: "sigma-share", access: "write", scope: "tree" },
      { path: "/srv/nas/pool1/Shares", principal: "sigmaos-nfs", access: "write", scope: "tree" },
      { path: "/srv/nas/pool1", principal: "www-data", access: "traverse", scope: "parent" }
    ]);
    const mappings = "/srv/nas\t/zos/data/primary\n";

    expect(migrateLegacyShareAclState(state, mappings)).toEqual({
      grants: [
        { path: "/zos/data/primary/pool1/Shares", principal: "sigma-share", access: "write", scope: "tree" },
        { path: "/zos/data/primary/pool1/Shares", principal: "sigmaos-nfs", access: "write", scope: "tree" },
        { path: "/zos/data/primary/pool1", principal: "www-data", access: "traverse", scope: "parent" }
      ],
      report: { grants: 3, pathValues: 3 }
    });
  });

  it("is idempotent after managed paths are migrated", () => {
    const state = JSON.stringify([
      { path: "/zos/data/primary/pool1/Shares", principal: "sigma-share", access: "read", scope: "tree" }
    ]);
    expect(migrateLegacyShareAclState(state, "/srv/nas\t/zos/data/primary\n").report)
      .toEqual({ grants: 1, pathValues: 0 });
  });

  it("rejects malformed grants before changing state", () => {
    expect(() => migrateLegacyShareAclState(JSON.stringify([
      { path: "../Shares", principal: "root", access: "write", scope: "tree" }
    ]), "/srv/nas\t/zos/data/primary\n")).toThrow("invalid share ACL grant");
  });

  it("atomically replaces the copied state and writes a count-only report", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "zos-share-acl-migration-"));
    tempDirectories.push(directory);
    const statePath = path.join(directory, "share-acl.json");
    const mappingsPath = path.join(directory, "mappings.tsv");
    const reportPath = path.join(directory, "report.json");
    await writeFile(statePath, JSON.stringify([
      { path: "/srv/nas/pool1/Shares", principal: "sigmaos-nfs", access: "write", scope: "tree" }
    ]), { mode: 0o644 });
    await writeFile(mappingsPath, "/srv/nas\t/zos/data/primary\n");

    const result = spawnSync(process.execPath, [script, statePath, mappingsPath, reportPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('{"grants":1,"pathValues":1}');
    await expect(readFile(statePath, "utf8")).resolves.toBe(JSON.stringify([
      { path: "/zos/data/primary/pool1/Shares", principal: "sigmaos-nfs", access: "write", scope: "tree" }
    ]));
    await expect(readFile(reportPath, "utf8")).resolves.toContain('"pathValues": 1');
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });
});
