import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openZosDb, type ZosDatabase } from "@zos/db";
import type { OpsTask, ZosConfig } from "@zos/shared";
import { buildServer } from "../server.js";
import {
  SystemOperationsRequestError,
  type SystemOperationsRunResult,
  type SystemOperationsRuntime
} from "../lib/operations-management.js";

let tempDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-api-operations-"));
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("system operations routes", () => {
  it("returns task overviews and validates history filters", async () => {
    const runtime = new FakeOperationsRuntime();
    const server = await buildServer({ config: createConfig(tempDir), db, system: { operations: runtime } });
    const response = await server.inject({ method: "GET", url: "/api/system/operations?task=health&limit=60" });
    const invalidTask = await server.inject({ method: "GET", url: "/api/system/operations?task=backup" });
    const invalidLimit = await server.inject({ method: "GET", url: "/api/system/operations?limit=101" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tasks: {
        health: { status: "never_run" },
        maintenance: { status: "never_run" }
      },
      runs: []
    });
    expect(invalidTask.statusCode).toBe(400);
    expect(invalidLimit.statusCode).toBe(400);
    await server.close();
  });

  it("uses the same operation overview in health and operations responses", async () => {
    const server = await buildServer({
      config: createConfig(tempDir),
      db,
      system: { operations: new FakeOperationsRuntime() }
    });

    const operations = await server.inject({ method: "GET", url: "/api/system/operations" });
    const health = await server.inject({ method: "GET", url: "/api/system/health" });

    expect(health.statusCode).toBe(200);
    expect(health.json().operations).toEqual(operations.json().tasks);
    await server.close();
  });

  it("requires maintenance confirmation and accepts health without it", async () => {
    const runtime = new FakeOperationsRuntime();
    const server = await buildServer({ config: createConfig(tempDir), db, system: { operations: runtime } });
    const missingConfirmation = await server.inject({
      method: "POST",
      url: "/api/system/operations/maintenance/run",
      payload: {}
    });
    const injected = await server.inject({
      method: "POST",
      url: "/api/system/operations/health/run",
      payload: { unit: "attacker.service" }
    });
    const health = await server.inject({
      method: "POST",
      url: "/api/system/operations/health/run",
      payload: {}
    });
    const maintenance = await server.inject({
      method: "POST",
      url: "/api/system/operations/maintenance/run",
      payload: { confirmed: true }
    });

    expect(missingConfirmation.statusCode).toBe(400);
    expect(injected.statusCode).toBe(400);
    expect(health.statusCode).toBe(202);
    expect(maintenance.statusCode).toBe(202);
    expect(runtime.calls).toEqual([
      { task: "health", confirmed: false },
      { task: "maintenance", confirmed: true }
    ]);
    await server.close();
  });

  it("maps unavailable and timed out hostd requests without leaking unsafe errors", async () => {
    const runtime = new FakeOperationsRuntime();
    const server = await buildServer({ config: createConfig(tempDir), db, system: { operations: runtime } });
    runtime.error = new SystemOperationsRequestError("hostd is unavailable password=secret", 503);
    const unavailable = await server.inject({ method: "POST", url: "/api/system/operations/health/run", payload: {} });
    runtime.error = new SystemOperationsRequestError("hostd request timed out", 504);
    const timeout = await server.inject({ method: "POST", url: "/api/system/operations/health/run", payload: {} });

    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.payload).not.toContain("secret");
    expect(timeout.statusCode).toBe(504);
    await server.close();
  });
});

class FakeOperationsRuntime implements SystemOperationsRuntime {
  calls: Array<{ task: OpsTask; confirmed: boolean }> = [];
  error: Error | null = null;

  async run(task: OpsTask, confirmed: boolean): Promise<SystemOperationsRunResult> {
    this.calls.push({ task, confirmed });
    if (this.error) throw this.error;
    return { task, accepted: true };
  }
}

function createConfig(dataDir: string): ZosConfig {
  return {
    dataDir,
    databasePath: path.join(dataDir, "zos.sqlite"),
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50 },
    admin: { displayName: "Test Admin", authMode: "local-only" },
    model: { provider: "local", piCommand: "pi", localEndpoint: null },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 120_000, consoleShells: ["/bin/sh"] },
    shares: { enabled: false, account: { username: "zos-share", password: null }, shares: [] },
    hostd: { socketPath: path.join(dataDir, "hostd.sock") },
    terminal: { user: "test-user", termuxSocketPath: path.join(dataDir, "termux.sock") },
    vodPlayer: { enabled: false, socketPath: path.join(dataDir, "vod.sock"), statePath: path.join(dataDir, "vod.json"), commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "zos" },
    nasRoots: []
  };
}
