import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageWorkspace } from "@cyberos/shared";
import { applyFileMutation, resolveSafeTargetPath } from "./mutation-tools.js";
import { listDir, searchFiles } from "./read-tools.js";

let temporaryDirectory: string | undefined;
afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

async function fixture(): Promise<StorageWorkspace> {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cyberos-iscsi-protect-"));
  const pool = path.join(temporaryDirectory, "pool");
  await mkdir(path.join(pool, ".cyberos", "iscsi"), { recursive: true });
  await writeFile(path.join(pool, ".cyberos", "iscsi", "disk.img"), "disk-data");
  await writeFile(path.join(pool, ".cyberos", "ordinary.json"), "{}");
  return { path: pool };
}

describe("managed iSCSI image protection", () => {
  it("rejects upload and restore targets inside the managed directory", async () => {
    const root = await fixture();
    await expect(resolveSafeTargetPath(root.path, ".cyberos/iscsi/new.img")).rejects.toThrow("iSCSI");
  });

  it("omits managed images from listings and recursive search", async () => {
    const root = await fixture();
    expect((await listDir(root, ".cyberos")).map((entry) => entry.name)).toEqual(["ordinary.json"]);
    expect((await searchFiles(root, { query: "disk" })).length).toBe(0);
  });

  it.each(["move", "copy", "trash"] as const)("prevents %s of an ancestor containing LUN data", async (operation) => {
    const root = await fixture();
    await expect(applyFileMutation(root, {
      operation, storagePoolId: "pool", sourcePath: ".cyberos", targetPath: "moved",
      risk: "medium", reversible: true, summary: "Move internal directory"
    }, path.join(temporaryDirectory!, "trash"))).rejects.toThrow("iSCSI");
    expect(await readFile(path.join(root.path, ".cyberos", "iscsi", "disk.img"), "utf8")).toBe("disk-data");
  });

  it("guards a pool ancestor when the workspace spans the data root", async () => {
    const pool = await fixture();
    await symlink(path.join(pool.path, ".cyberos"), path.join(pool.path, "internal-alias"));
    const dataRoot = path.dirname(pool.path);
    for (const sourcePath of ["pool", ".", "pool/internal-alias"]) {
      await expect(applyFileMutation({ path: dataRoot }, {
        operation: "trash", storagePoolId: "pool", sourcePath,
        risk: "high", reversible: true, summary: "Trash a pool ancestor"
      }, path.join(temporaryDirectory!, "trash"))).rejects.toThrow("iSCSI");
    }
  });
});
