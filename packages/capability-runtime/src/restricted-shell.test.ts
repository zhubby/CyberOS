import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCyberOsDb, type CyberOsDatabase } from "@cyberos/db";
import { loadConfig, type CyberOsConfig } from "@cyberos/shared";
import { createRestrictedShellAdapter } from "./restricted-shell.js";

let tempDir: string;
let rootDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-restricted-shell-"));
  rootDir = path.join(tempDir, "pool-1");
  await mkdir(rootDir);
  await writeFile(path.join(rootDir, "visible.txt"), "visible", "utf8");
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
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
      storagePoolId: "pool-1",
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
      storagePoolId: "pool-1",
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
      storagePoolId: "pool-1",
      command: "ls"
    }, context)).rejects.toMatchObject({ code: "NOT_READY" });
  });
});

function adapterContext(shellEnabled = true) {
  return {
    db,
    config: testConfig(shellEnabled),
    capabilityId: "cyberos.shell.run",
    subject: {
      id: "pi",
      clientId: "pi",
      kind: "pi" as const,
      scopes: new Set(["cyberos:admin:shell"])
    }
  };
}

function testConfig(shellEnabled: boolean): CyberOsConfig {
  const base = loadConfig({ CYBEROS_CONFIG: path.join(tempDir, "missing.toml"), CYBEROS_ROOT: tempDir }, tempDir);
  return {
    ...base,
    paths: { ...base.paths, dataRoot: tempDir, databasePath: path.join(tempDir, "cyberos.sqlite") },
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 100, concurrency: 1 },
    admin: { displayName: "Admin", authMode: "local-only" },
    mcp: {
      enabled: true,
      piEnabled: true,
      piTokenFile: path.join(tempDir, "pi.token"),
      externalEnabled: false,
      shellEnabled,
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      allowedOrigins: ["localhost", "127.0.0.1", "[::1]"],
      maxConcurrentPerClient: 4
    },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1_000, consoleShells: ["/bin/sh"] },
    hostd: { socketPath: path.join(tempDir, "hostd.sock"), mutationPolicy: "mutable" },
    shares: { enabled: false, account: { username: "cyberos", password: null }, shares: [] },
    terminal: { user: "cyberos", socketPath: path.join(tempDir, "terminald.sock"), sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: path.join(tempDir, "vod.sock"), statePath: path.join(tempDir, "vod.json"), commandTimeoutMs: 1_000, startupTimeoutMs: 1_000, checkpointIntervalMs: 1_000, retryBaseDelayMs: 100, retryMaxDelayMs: 1_000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: "default", hwdec: "auto-safe", user: "cyberos" },
  };
}
