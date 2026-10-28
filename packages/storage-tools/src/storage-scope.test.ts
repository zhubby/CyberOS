import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSafeStorageScope } from "./storage-scope.js";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("storage pool scope", () => {
  it("rejects a pool identity implemented as a symbolic-link alias", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cyberos-storage-scope-"));
    const dataRoot = path.join(temporaryDirectory, "data");
    const pool = path.join(dataRoot, "pool-1");
    const alias = path.join(dataRoot, "alias");
    await mkdir(pool, { recursive: true });
    await symlink(pool, alias);

    await expect(createSafeStorageScope({ rootPath: dataRoot, mountpointPath: alias }))
      .rejects.toMatchObject({ message: "Storage pool is not mounted", statusCode: 404 });
  });
});
