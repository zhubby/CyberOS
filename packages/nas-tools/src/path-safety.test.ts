import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathSafetyError, resolveSafeExistingPath } from "./path-safety.js";

let tempDir: string;
let rootDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-path-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("resolveSafeExistingPath", () => {
  it("resolves unicode paths inside the configured root", async () => {
    await writeFile(path.join(rootDir, "文档.txt"), "hello");

    const safe = await resolveSafeExistingPath(rootDir, "文档.txt");

    expect(safe.relativePath).toBe("文档.txt");
  });

  it("rejects absolute paths", async () => {
    await expect(resolveSafeExistingPath(rootDir, "/etc/passwd")).rejects.toBeInstanceOf(
      PathSafetyError
    );
  });

  it("rejects parent traversal outside the root", async () => {
    await writeFile(path.join(tempDir, "outside.txt"), "outside");

    await expect(resolveSafeExistingPath(rootDir, "../outside.txt")).rejects.toThrow(
      "Path escapes"
    );
  });

  it("rejects symlinks that resolve outside the root", async () => {
    await writeFile(path.join(tempDir, "outside.txt"), "outside");
    await symlink(path.join(tempDir, "outside.txt"), path.join(rootDir, "escape.txt"));

    await expect(resolveSafeExistingPath(rootDir, "escape.txt")).rejects.toThrow("Path escapes");
  });
});

