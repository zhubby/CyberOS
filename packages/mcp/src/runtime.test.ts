import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCatalogDescriptors } from "@cyberos/capabilities";
import type { CapabilityDomainAdapter } from "@cyberos/capability-runtime";
import {
  createMcpClient,
  defaultAgentCapabilityPolicySettings,
  openCyberOsDb,
  saveAgentCapabilityPolicySettings,
  saveBackupSettings,
  saveDockerSettings,
  saveMonitoringSettings,
  saveTvSettings,
  saveVmSettings,
  type CyberOsDatabase
} from "@cyberos/db";
import { loadCyberOsRuntime, type CyberOsRuntime } from "@cyberos/shared";
import { catalogForClient, createClientRuntime } from "./runtime.js";

const PLANNED_CAPABILITIES = [
  "cyberos.files.grep",
  "cyberos.files.find",
  "cyberos.files.git",
  "cyberos.files.archive-inspect",
  "cyberos.photos.media",
  "cyberos.files.export-propose",
  "cyberos.files.edit",
  "cyberos.files.write",
  "cyberos.files.rollback-propose",
  "cyberos.system.power-propose",
  "cyberos.operations.run-propose",
  "cyberos.index.reindex-propose",
  "cyberos.photos.manage-propose",
  "cyberos.downloads.manage-propose",
  "cyberos.backup.run-propose",
  "cyberos.alerts.manage-propose",
  "cyberos.notifications.read-state-propose",
  "cyberos.docker.manage-propose",
  "cyberos.docker.console-propose",
  "cyberos.vm.manage-propose",
  "cyberos.vm.console-propose",
  "cyberos.network.manage-propose",
  "cyberos.storage.manage-propose",
  "cyberos.settings.update-propose",
  "cyberos.terminal.manage-propose",
  "cyberos.vod.control-propose",
  "cyberos.shell.run"
] as const;

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-mcp-runtime-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("Pi MCP capability discovery", () => {
  it("discovers all 27 planned capabilities when adapters and Shell are enabled", async () => {
    const runtime = createRuntime(true);
    const discovered = runtime.registry.listForScopes(runtime.context.subject.scopes)
      .map((descriptor) => descriptor.id);
    expect(PLANNED_CAPABILITIES.every((id) => discovered.includes(id))).toBe(true);

    const catalog = await catalogForClient(runtime) as Array<{
      id: string;
      available: boolean;
      reason: string | null;
    }>;
    const planned = catalog.filter((entry) => (PLANNED_CAPABILITIES as readonly string[]).includes(entry.id));
    expect(planned).toHaveLength(27);
    expect(planned.every((entry) => entry.available && entry.reason === null)).toBe(true);
    expect(JSON.stringify(planned)).not.toContain("Domain adapter is not installed");
  });

  it("does not register Shell when the host flag is disabled even with a stale scope", () => {
    const runtime = createRuntime(false);
    expect(runtime.context.subject.scopes.has("cyberos:admin:shell")).toBe(true);
    expect(runtime.registry.get("cyberos.shell.run")).toBeNull();
  });

  it("applies the Agent capability policy to newly implemented tools", () => {
    const defaults = defaultAgentCapabilityPolicySettings();
    saveAgentCapabilityPolicySettings(db, {
      policies: {
        ...defaults.policies,
        "cyberos.files.grep": "disabled",
        "cyberos.files.edit": "disabled",
        "cyberos.shell.run": "disabled"
      }
    });
    const runtime = createRuntime(true);
    expect(runtime.registry.get("cyberos.files.grep")).toBeNull();
    expect(runtime.registry.get("cyberos.files.edit")).toBeNull();
    expect(runtime.registry.get("cyberos.shell.run")).toBeNull();
  });

  it("rejects every planned capability before execution when its scope is missing", async () => {
    const runtime = createRuntime(true);
    const unscopedContext = {
      ...runtime.context,
      subject: { ...runtime.context.subject, scopes: new Set<string>() }
    };

    for (const capabilityId of PLANNED_CAPABILITIES) {
      await expect(runtime.registry.invoke(capabilityId, {}, unscopedContext), capabilityId)
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("reads product capability state from SQLite for every system status request", async () => {
    saveDockerSettings(db, { enabled: false });
    saveVmSettings(db, { enabled: false });
    saveBackupSettings(db, {
      enabled: false,
      repositoryPath: path.join(tempDir, "backup"),
      requireMount: false,
      keepDaily: 7,
      keepWeekly: 4,
      validatedAt: null
    });
    saveMonitoringSettings(db, {
      enabled: false,
      rawRetentionDays: 2,
      minuteRetentionDays: 30,
      hourRetentionDays: 365,
      maxDatabaseBytes: 512 * 1024 * 1024
    });
    saveTvSettings(db, {
      enabled: false,
      videoOutput: "drm",
      drmConnector: null,
      audioDevice: null,
      hardwareDecoding: "auto-safe"
    });
    const runtime = createRuntime(true);

    const execution = await runtime.registry.invoke("cyberos.system.status", {}, runtime.context);

    expect(execution.data).toMatchObject({
      services: {
        dockerConfigured: false,
        vmConfigured: false,
        backupConfigured: false,
        monitoringConfigured: false,
        vodConfigured: false
      }
    });
  });
});

function createRuntime(shellEnabled: boolean) {
  const descriptors = createCatalogDescriptors();
  const scopes = [...new Set(descriptors.flatMap((descriptor) => descriptor.requiredScopes))];
  const client = createMcpClient(db, { name: "Built-in Pi", kind: "pi", scopes });
  const fakeAdapter: CapabilityDomainAdapter = {
    availability: () => ({ available: true }),
    prepare: (request) => ({ summary: "prepared", privatePayload: request }),
    revalidate: () => undefined,
    execute: () => ({ data: { ok: true } })
  };
  const adapters = Object.fromEntries(descriptors
    .filter((descriptor) => descriptor.risk !== "read" && descriptor.approval !== "owner_control")
    .map((descriptor) => [descriptor.id, fakeAdapter]));
  return createClientRuntime({
    db,
    config: testConfig(shellEnabled),
    adapters,
    readAdapters: { "cyberos.photos.media": async () => ({ ok: true }) }
  }, client);
}

function testConfig(shellEnabled: boolean): CyberOsRuntime {
  const base = loadCyberOsRuntime({ CYBEROS_ROOT: tempDir }, tempDir);
  return {
    ...base,
    paths: { ...base.paths, databasePath: path.join(tempDir, "cyberos.sqlite") },
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
    docker: { enabled: true, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1_000, consoleShells: ["/bin/sh"] },
    vm: { enabled: true, libvirtUri: "qemu:///system", storagePath: path.join(tempDir, "vm"), networkName: "default", isoRoots: [tempDir], operationTimeoutMs: 1_000, consoleMode: "serial" },
    backup: { enabled: true, repositoryPath: path.join(tempDir, "backup"), passwordFile: path.join(tempDir, "backup-password"), stagingPath: path.join(tempDir, "staging"), requireMount: false, retryCount: 1, timeoutMs: 1_000, keepDaily: 7, keepWeekly: 4 },
    hostd: { socketPath: path.join(tempDir, "hostd.sock") },
    shares: { enabled: false, account: { username: "cyberos", password: null }, shares: [] },
    terminal: { user: "cyberos", socketPath: path.join(tempDir, "terminald.sock"), sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: true, socketPath: path.join(tempDir, "vod.sock"), statePath: path.join(tempDir, "vod.json"), commandTimeoutMs: 1_000, startupTimeoutMs: 1_000, checkpointIntervalMs: 1_000, retryBaseDelayMs: 100, retryMaxDelayMs: 1_000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: "default", hwdec: "auto-safe", user: "cyberos" },
  };
}
