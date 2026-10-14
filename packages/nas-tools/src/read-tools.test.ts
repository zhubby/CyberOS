import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NasRootRecord } from "@zos/shared";
import { listDir, readText, searchFiles } from "./read-tools.js";

let tempDir: string;
let rootDir: string;
let root: NasRootRecord;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-read-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir);
  await mkdir(path.join(rootDir, "photos"));
  await writeFile(path.join(rootDir, "notes.txt"), "alpha beta");
  await writeFile(path.join(rootDir, "photos", "summer.txt"), "sun");
  await writeFile(path.join(tempDir, "outside.txt"), "outside");
  await symlink(path.join(tempDir, "outside.txt"), path.join(rootDir, "escape.txt"));
  root = {
    id: "local",
    name: "Local",
    path: rootDir,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("read-only NAS tools", () => {
  it("lists directories first and marks unsafe symlinks", async () => {
    const entries = await listDir(root, ".");

    expect(entries[0]?.name).toBe("photos");
    expect(entries.find((entry) => entry.name === "escape.txt")?.isSafe).toBe(false);
  });

  it("reads bounded UTF-8 text", async () => {
    const preview = await readText(root, "notes.txt", 5);

    expect(preview.content).toBe("alpha");
    expect(preview.truncated).toBe(true);
  });

  it("searches filenames recursively inside the root", async () => {
    const matches = await searchFiles(root, { query: "summer" });

    expect(matches.map((entry) => entry.path)).toContain("photos/summer.txt");
  });
});
