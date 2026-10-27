import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureNasRoots, openZosDb, type ZosDatabase } from "@zos/db";
import type { ZosConfig } from "@zos/shared";
import { createRestrictedShellAdapter } from "./restricted-shell.js";

let tempDir: string;
let rootDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-restricted-shell-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir);
  await writeFile(path.join(rootDir, "visible.txt"), "visible", "utf8");
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "primary", name: "Primary", path: rootDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("restricted shell adapter", () => {
  it("executes a fixed read-only argv command inside the selected root", async () => {
    const adapter = createRestrictedShellAdapter();
    const context = adapterContext();
    const prepared = await adapter.prepare({
      rootId: "primary",
      command: "ls",
      args: ["-1"],
      cwd: ".",
      timeoutMs: 1_000
    }, context);

    await expect(adapter.revalidate(prepared, context)).resolves.toBeUndefined();
    await expect(adapter.execute(prepared, context, {})).resolves.toMatchObject({
      data: { command: "ls", cwd: ".", exitCode: 0, truncated: false }
    });
    const result = await adapter.execute(prepared, context, {});
    expect(JSON.stringify(result.data)).toContain("visible.txt");
  });

  it.each([
    ["sha256sum", ["--check", "checksums.txt"]],
    ["du", ["--files0-from=paths.txt"]],
    ["git", ["grep", "--open-files-in-pager=/bin/sh", "needle"]],
    ["git", ["diff", "--textconv"]],
    ["ls", ["--hyperlink=always"]]
  ] as const)("rejects indirect reads or external execution through %s", async (command, args) => {
    await expect(createRestrictedShellAdapter().prepare({
      rootId: "primary",
      command,
      args: [...args]
    }, adapterContext())).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("stays unavailable when the shell feature flag is disabled", async () => {
    const context = adapterContext(false);
    expect(await createRestrictedShellAdapter().availability(context)).toEqual({
      available: false,
      reason: "Restricted shell is disabled by host configuration"
    });
    await expect(createRestrictedShellAdapter().prepare({
      rootId: "primary",
      command: "ls"
    }, context)).rejects.toMatchObject({ code: "NOT_READY" });
  });
});

function adapterContext(shellEnabled = true) {
  return {
    db,
    config: testConfig(shellEnabled),
    capabilityId: "zos.shell.run",
    subject: {
      id: "pi",
      clientId: "pi",
      kind: "pi" as const,
      scopes: new Set(["zos:admin:shell"])
    }
  };
}

function testConfig(shellEnabled: boolean): ZosConfig {
  return {
    environment: "development",
    dataDir: tempDir,
    databasePath: path.join(tempDir, "zos.sqlite"),
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 100 },
    admin: { displayName: "Admin", authMode: "local-only" },
    model: { provider: "pi", piCommand: "pi", localEndpoint: null },
    mcp: {
      enabled: true,
      piEnabled: true,
      piTokenFile: path.join(tempDir, "pi.token"),
      legacyPiToolsEnabled: false,
      externalEnabled: false,
      shellEnabled,
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      allowedOrigins: ["localhost", "127.0.0.1", "[::1]"],
      maxConcurrentPerClient: 4
    },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1_000, consoleShells: ["/bin/sh"] },
    hostd: { socketPath: path.join(tempDir, "hostd.sock") },
    shares: { enabled: false, account: { username: "zos", password: null }, shares: [] },
    terminal: { user: "zos", termuxSocketPath: path.join(tempDir, "termux.sock"), sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: path.join(tempDir, "vod.sock"), statePath: path.join(tempDir, "vod.json"), commandTimeoutMs: 1_000, startupTimeoutMs: 1_000, checkpointIntervalMs: 1_000, retryBaseDelayMs: 100, retryMaxDelayMs: 1_000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: "default", hwdec: "auto-safe", user: "zos" },
    nasRoots: [{ id: "primary", name: "Primary", path: rootDir }]
  };
}
