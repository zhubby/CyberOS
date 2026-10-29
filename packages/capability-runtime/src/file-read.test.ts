import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCyberOsDb, type CyberOsDatabase } from "@cyberos/db";
import { loadCyberOsRuntime, type CyberOsRuntime } from "@cyberos/shared";
import { executeExtendedFileReadCapability } from "./file-read.js";

const execFileAsync = promisify(execFile);

let tempDir: string;
let rootDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-file-read-"));
  rootDir = path.join(tempDir, "data", "local");
  await mkdir(path.join(rootDir, "nested"), { recursive: true });
  await writeFile(path.join(rootDir, "alpha.txt"), "Needle one\nneedle two\n", "utf8");
  await writeFile(path.join(rootDir, "nested", "beta.md"), "prefix NEEDLE suffix\n", "utf8");
  await writeFile(path.join(rootDir, "nested", "binary.bin"), Buffer.from([0, 1, 2, 3]));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("extended file read capabilities", () => {
  it("supports literal and regular-expression grep with case and path filters", async () => {
    const literal = await run("cyberos.files.grep", {
      storagePoolId: "local",
      pattern: "needle",
      mode: "literal",
      caseSensitive: false,
      include: ["*.txt"]
    });
    expect(literal.data).toMatchObject({ scannedFiles: 1, truncated: false });
    expect((literal.data as { matches: unknown[] }).matches).toHaveLength(2);

    const regex = await run("cyberos.files.grep", {
      storagePoolId: "local",
      path: "nested",
      pattern: "^prefix\\s+NEEDLE",
      mode: "regex",
      caseSensitive: true
    });
    expect((regex.data as { matches: Array<{ path: string }> }).matches).toEqual([
      expect.objectContaining({ path: "nested/beta.md" })
    ]);
  });

  it("paginates grep results with request-bound cursors", async () => {
    const first = await run("cyberos.files.grep", { storagePoolId: "local", pattern: "needle", limit: 1 });
    const cursor = first.page?.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    if (!cursor) throw new Error("Expected a grep cursor");
    expect((first.data as { matches: unknown[] }).matches).toHaveLength(1);

    const second = await run("cyberos.files.grep", {
      storagePoolId: "local",
      pattern: "needle",
      limit: 1,
      cursor
    });
    expect((second.data as { matches: Array<{ line: number }> }).matches[0]?.line).toBe(2);
    await expect(run("cyberos.files.grep", {
      storagePoolId: "local",
      pattern: "different",
      cursor
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("filters and paginates find results", async () => {
    const first = await run("cyberos.files.find", {
      storagePoolId: "local",
      glob: "*.*",
      kind: "file",
      limit: 2
    });
    expect((first.data as { entries: Array<{ kind: string }> }).entries).toHaveLength(2);
    expect((first.data as { entries: Array<{ kind: string }> }).entries.every((entry) => entry.kind === "file")).toBe(true);
    const cursor = first.page?.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    if (!cursor) throw new Error("Expected a find cursor");

    const second = await run("cyberos.files.find", {
      storagePoolId: "local",
      glob: "*.*",
      kind: "file",
      limit: 2,
      cursor
    });
    expect((second.data as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path)).toContain("nested/binary.bin");
  });

  it("skips discovered symbolic links and rejects symlink or traversal start paths", async () => {
    await symlink(path.join(rootDir, "nested"), path.join(rootDir, "linked"));
    const result = await run("cyberos.files.find", { storagePoolId: "local" });
    expect(result.warnings).toContain("Skipped 1 symbolic link(s)");
    expect(JSON.stringify(result.data)).not.toContain("linked");

    await expect(run("cyberos.files.find", { storagePoolId: "local", path: "linked" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(run("cyberos.files.find", { storagePoolId: "local", path: "../outside" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects a storage pool alias implemented as a symbolic link", async () => {
    await symlink(rootDir, path.join(tempDir, "data", "alias"));
    await expect(run("cyberos.files.find", { storagePoolId: "alias" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects archives containing traversal entries", async () => {
    await writeFile(path.join(rootDir, "unsafe.tar"), tarWithEmptyEntry("../escape.txt"));
    await expect(run("cyberos.files.archive-inspect", { storagePoolId: "local", path: "unsafe.tar" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects a Git repository whose top level escapes the storage pool", async () => {
    await execFileAsync("git", ["init", "--quiet", tempDir]);
    await expect(run("cyberos.files.git", { storagePoolId: "local" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

function run(
  capabilityId: Parameters<typeof executeExtendedFileReadCapability>[1],
  input: Parameters<typeof executeExtendedFileReadCapability>[2]
) {
  return executeExtendedFileReadCapability({ db, config: testConfig() }, capabilityId, input);
}

function testConfig(): CyberOsRuntime {
  const base = loadCyberOsRuntime({ CYBEROS_ROOT: tempDir }, tempDir);
  return {
    ...base,
    paths: { ...base.paths, databasePath: path.join(tempDir, "cyberos.sqlite") },
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 100, concurrency: 1 },
    admin: { displayName: "Admin", authMode: "local-only" },
    docker: {
      enabled: false,
      socketPath: "/var/run/docker.sock",
      composeCommand: "docker",
      operationTimeoutMs: 1_000,
      consoleShells: ["/bin/sh"]
    },
    hostd: { socketPath: path.join(tempDir, "hostd.sock") },
    shares: { enabled: false, account: { username: "cyberos", password: null }, shares: [] },
    terminal: {
      user: "cyberos",
      socketPath: path.join(tempDir, "terminald.sock"),
      sessionIdleTimeoutMs: 60_000,
      connectTimeoutMs: 1_000,
      maxSessions: 4
    },
    vodPlayer: {
      enabled: false,
      socketPath: path.join(tempDir, "vod.sock"),
      statePath: path.join(tempDir, "vod.json"),
      commandTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      checkpointIntervalMs: 1_000,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1_000,
      videoOutput: "drm",
      drmConnector: null,
      audioOutput: "alsa",
      audioDevice: "default",
      hwdec: "auto-safe",
      user: "cyberos"
    }
  };
}

function tarWithEmptyEntry(name: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, 0);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeTarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
  return Buffer.concat([header, Buffer.alloc(1024)]);
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 2, "0")}\0 `;
  buffer.write(encoded, offset, length, "ascii");
}
