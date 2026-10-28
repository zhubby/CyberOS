import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NasRootRecord } from "@cyberos/shared";
import {
  applyFileMutation,
  archiveKindForPath,
  defaultExtractionTarget,
  restoreTrashPath,
  resolveSafeTargetPath,
  rollbackFileMutation,
  validateArchiveEntries
} from "./mutation-tools.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: vi.fn((...args: Parameters<typeof fs.rename>) => fs.rename(...args))
  };
});

const execFileAsync = promisify(execFile);

let tempDir: string;
let rootDir: string;
let trashDir: string;
let root: NasRootRecord;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-mutate-"));
  rootDir = path.join(tempDir, "root");
  trashDir = path.join(tempDir, "trash");
  await mkdir(rootDir);
  await writeFile(path.join(rootDir, "source.txt"), "hello");
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

describe("approval-gated mutation tools", () => {
  it("identifies archive formats and safe default targets", () => {
    expect(archiveKindForPath("backup.zip")).toBe("zip");
    expect(archiveKindForPath("logs.tar.gz")).toBe("tar");
    expect(archiveKindForPath("photos.tgz")).toBe("tar");
    expect(archiveKindForPath("document.gz")).toBe("gzip");
    expect(archiveKindForPath("bundle.rar")).toBe("rar");
    expect(defaultExtractionTarget("nested/logs.tar.gz")).toBe(path.join("nested", "logs"));
    expect(defaultExtractionTarget("document.gz")).toBe("document");
  });

  it("extracts zip archives into a new sibling folder", async () => {
    const archiveDir = path.join(rootDir, "zip-source");
    await mkdir(path.join(archiveDir, "nested"), { recursive: true });
    await writeFile(path.join(archiveDir, "nested", "hello.txt"), "hello from zip");
    await execFileAsync("zip", ["-qr", path.join(rootDir, "archive.zip"), "."], { cwd: archiveDir });

    await applyFileMutation(
      root,
      {
        operation: "extract",
        rootId: root.id,
        sourcePath: "archive.zip",
        targetPath: "archive",
        risk: "medium",
        reversible: true,
        summary: "Extract archive"
      },
      trashDir
    );

    await expect(readFile(path.join(rootDir, "archive", "nested", "hello.txt"), "utf8")).resolves.toBe("hello from zip");
  });

  it("extracts gzip files without overwriting the target", async () => {
    await writeFile(path.join(rootDir, "payload.txt"), "hello from gzip");
    const compressed = await execFileAsync("gzip", ["-c", path.join(rootDir, "payload.txt")], { encoding: "buffer" });
    await writeFile(path.join(rootDir, "payload.txt.gz"), compressed.stdout);

    await applyFileMutation(
      root,
      {
        operation: "extract",
        rootId: root.id,
        sourcePath: "payload.txt.gz",
        targetPath: "payload-extracted.txt",
        risk: "medium",
        reversible: true,
        summary: "Extract payload"
      },
      trashDir
    );

    await expect(readFile(path.join(rootDir, "payload-extracted.txt"), "utf8")).resolves.toBe("hello from gzip");
  });

  it("extracts tar.gz archives into a sibling folder", async () => {
    const archiveDir = path.join(rootDir, "tar-source");
    await mkdir(archiveDir);
    await writeFile(path.join(archiveDir, "hello.txt"), "hello from tar");
    await execFileAsync("tar", ["-czf", path.join(rootDir, "bundle.tar.gz"), "hello.txt"], { cwd: archiveDir });

    await applyFileMutation(
      root,
      {
        operation: "extract",
        rootId: root.id,
        sourcePath: "bundle.tar.gz",
        targetPath: "bundle",
        risk: "medium",
        reversible: true,
        summary: "Extract bundle"
      },
      trashDir
    );

    await expect(readFile(path.join(rootDir, "bundle", "hello.txt"), "utf8")).resolves.toBe("hello from tar");
  });

  it("rejects archive path traversal entries before extraction", async () => {
    expect(() => validateArchiveEntries(["safe/file.txt", "../escape.txt"])).toThrow("path traversal");
    expect(() => validateArchiveEntries(["/absolute.txt"])).toThrow("absolute path");
  });

  it("rejects escaped mutation targets", async () => {
    await expect(resolveSafeTargetPath(root.path, "../escape.txt")).rejects.toThrow("escapes");
  });

  it("rejects mkdir through a parent symlink", async () => {
    const outsideDir = path.join(tempDir, "outside");
    await mkdir(outsideDir);
    await symlink(outsideDir, path.join(rootDir, "link"));

    await expect(
      applyFileMutation(
        root,
        {
          operation: "mkdir",
          rootId: root.id,
          targetPath: "link/created",
          risk: "medium",
          reversible: true,
          summary: "Create directory"
        },
        trashDir
      )
    ).rejects.toThrow("symlink");
    await expect(stat(path.join(outsideDir, "created"))).rejects.toThrow();
  });

  it("rejects trash restore through a parent symlink", async () => {
    const outsideDir = path.join(tempDir, "outside");
    const trashSource = path.join(trashDir, "deleted.txt");
    await mkdir(outsideDir);
    await mkdir(trashDir);
    await writeFile(trashSource, "deleted");
    await symlink(outsideDir, path.join(rootDir, "link"));

    await expect(
      restoreTrashPath(root, {
        trashPath: trashSource,
        originalPath: "link/restored.txt"
      })
    ).rejects.toThrow("symlink");
    await expect(stat(path.join(outsideDir, "restored.txt"))).rejects.toThrow();
    await expect(stat(trashSource)).resolves.toBeTruthy();
  });

  it("moves files only when apply is called", async () => {
    await applyFileMutation(
      root,
      {
        operation: "move",
        rootId: root.id,
        sourcePath: "source.txt",
        targetPath: "target.txt",
        risk: "medium",
        reversible: true,
        summary: "Move source"
      },
      trashDir
    );

    await expect(readFile(path.join(rootDir, "target.txt"), "utf8")).resolves.toBe("hello");
    await expect(stat(path.join(rootDir, "source.txt"))).rejects.toThrow();
  });

  it("copies files without removing the source", async () => {
    await applyFileMutation(
      root,
      {
        operation: "copy",
        rootId: root.id,
        sourcePath: "source.txt",
        targetPath: "copy.txt",
        risk: "medium",
        reversible: true,
        summary: "Copy source"
      },
      trashDir
    );

    await expect(readFile(path.join(rootDir, "source.txt"), "utf8")).resolves.toBe("hello");
    await expect(readFile(path.join(rootDir, "copy.txt"), "utf8")).resolves.toBe("hello");
  });

  it("rejects transferring a folder into itself", async () => {
    await mkdir(path.join(rootDir, "folder", "child"), { recursive: true });

    await expect(
      applyFileMutation(
        root,
        {
          operation: "copy",
          rootId: root.id,
          sourcePath: "folder",
          targetPath: "folder/child/folder",
          risk: "medium",
          reversible: true,
          summary: "Copy folder"
        },
        trashDir
      )
    ).rejects.toThrow("Cannot transfer a folder into itself");
  });

  it("moves trash requests into CyberOS trash", async () => {
    const result = await applyFileMutation(
      root,
      {
        operation: "trash",
        rootId: root.id,
        sourcePath: "source.txt",
        risk: "medium",
        reversible: true,
        summary: "Trash source"
      },
      trashDir
    );

    expect(result.metadata.trashEntryId).toEqual(expect.any(String));
    await expect(stat(String(result.metadata.absoluteTrashPath))).resolves.toBeTruthy();
  });

  it("moves directories to trash and restores them across filesystems", async () => {
    await mkdir(path.join(rootDir, "folder"));
    await writeFile(path.join(rootDir, "folder", "nested.txt"), "cross-device");
    const crossDeviceError = Object.assign(new Error("cross-device link not permitted"), {
      code: "EXDEV"
    });
    vi.mocked(rename).mockRejectedValueOnce(crossDeviceError);

    const trashed = await applyFileMutation(
      root,
      {
        operation: "trash",
        rootId: root.id,
        sourcePath: "folder",
        risk: "medium",
        reversible: true,
        summary: "Trash folder"
      },
      trashDir
    );
    const trashPath = String(trashed.metadata.absoluteTrashPath);

    await expect(stat(path.join(rootDir, "folder"))).rejects.toThrow();
    await expect(readFile(path.join(trashPath, "nested.txt"), "utf8")).resolves.toBe("cross-device");

    vi.mocked(rename).mockRejectedValueOnce(crossDeviceError);
    await restoreTrashPath(root, {
      trashPath,
      originalPath: "folder"
    });

    await expect(readFile(path.join(rootDir, "folder", "nested.txt"), "utf8")).resolves.toBe("cross-device");
    await expect(stat(trashPath)).rejects.toThrow();
  });

  it("rolls move operations back to the original path", async () => {
    await applyFileMutation(
      root,
      {
        operation: "move",
        rootId: root.id,
        sourcePath: "source.txt",
        targetPath: "target.txt",
        risk: "medium",
        reversible: true,
        summary: "Move source"
      },
      trashDir
    );

    await rollbackFileMutation(
      root,
      {
        id: "operation-1",
        approvalId: "approval-1",
        operation: "move",
        sourcePath: "source.txt",
        targetPath: "target.txt",
        status: "applied",
        metadata: { rootId: root.id },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      trashDir
    );

    await expect(readFile(path.join(rootDir, "source.txt"), "utf8")).resolves.toBe("hello");
    await expect(stat(path.join(rootDir, "target.txt"))).rejects.toThrow();
  });

  it("rejects move rollback through a parent symlink", async () => {
    const outsideDir = path.join(tempDir, "outside");
    await mkdir(outsideDir);
    await writeFile(path.join(rootDir, "moved.txt"), "moved");
    await symlink(outsideDir, path.join(rootDir, "link"));

    await expect(
      rollbackFileMutation(
        root,
        {
          id: "operation-1",
          approvalId: "approval-1",
          operation: "move",
          sourcePath: "link/original.txt",
          targetPath: "moved.txt",
          status: "applied",
          metadata: { rootId: root.id },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        trashDir
      )
    ).rejects.toThrow("symlink");
    await expect(readFile(path.join(rootDir, "moved.txt"), "utf8")).resolves.toBe("moved");
    await expect(stat(path.join(outsideDir, "original.txt"))).rejects.toThrow();
  });

  it("rolls uploaded files back into trash", async () => {
    await writeFile(path.join(rootDir, "uploaded.txt"), "new");

    const rollback = await rollbackFileMutation(
      root,
      {
        id: "operation-1",
        approvalId: null,
        operation: "upload",
        sourcePath: null,
        targetPath: "uploaded.txt",
        status: "applied",
        metadata: { rootId: root.id },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      trashDir
    );

    expect(rollback.operation).toBe("trash");
    await expect(stat(path.join(rootDir, "uploaded.txt"))).rejects.toThrow();
    await expect(stat(String(rollback.metadata.absoluteTrashPath))).resolves.toBeTruthy();
  });
});
