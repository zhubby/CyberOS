import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCatalogDescriptors } from "@zos/capabilities";
import type { CapabilityDomainAdapter } from "@zos/capability-runtime";
import {
  createMcpClient,
  defaultAgentCapabilityPolicySettings,
  openZosDb,
  saveAgentCapabilityPolicySettings,
  type ZosDatabase
} from "@zos/db";
import type { ZosConfig } from "@zos/shared";
import { catalogForClient, createClientRuntime } from "./runtime.js";

const PLANNED_CAPABILITIES = [
  "zos.files.grep",
  "zos.files.find",
  "zos.files.git",
  "zos.files.archive-inspect",
  "zos.photos.media",
  "zos.files.export-propose",
  "zos.files.edit",
  "zos.files.write",
  "zos.files.rollback-propose",
  "zos.system.power-propose",
  "zos.operations.run-propose",
  "zos.index.reindex-propose",
  "zos.photos.manage-propose",
  "zos.downloads.manage-propose",
  "zos.backup.run-propose",
  "zos.alerts.manage-propose",
  "zos.notifications.read-state-propose",
  "zos.docker.manage-propose",
  "zos.docker.console-propose",
  "zos.vm.manage-propose",
  "zos.vm.console-propose",
  "zos.network.manage-propose",
  "zos.storage.manage-propose",
  "zos.settings.update-propose",
  "zos.terminal.manage-propose",
  "zos.vod.control-propose",
  "zos.shell.run"
] as const;

let tempDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-mcp-runtime-"));
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
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
    expect(runtime.context.subject.scopes.has("zos:admin:shell")).toBe(true);
    expect(runtime.registry.get("zos.shell.run")).toBeNull();
  });

  it("applies the Agent capability policy to newly implemented tools", () => {
    const defaults = defaultAgentCapabilityPolicySettings();
    saveAgentCapabilityPolicySettings(db, {
      policies: {
        ...defaults.policies,
        "zos.files.grep": "disabled",
        "zos.files.edit": "disabled",
        "zos.shell.run": "disabled"
      }
    });
    const runtime = createRuntime(true);
    expect(runtime.registry.get("zos.files.grep")).toBeNull();
    expect(runtime.registry.get("zos.files.edit")).toBeNull();
    expect(runtime.registry.get("zos.shell.run")).toBeNull();
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
    readAdapters: { "zos.photos.media": async () => ({ ok: true }) }
  }, client);
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
    docker: { enabled: true, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1_000, consoleShells: ["/bin/sh"] },
    vm: { enabled: true, libvirtUri: "qemu:///system", storagePath: path.join(tempDir, "vm"), networkName: "default", isoRoots: [tempDir], operationTimeoutMs: 1_000, consoleMode: "serial" },
    backup: { enabled: true, repositoryPath: path.join(tempDir, "backup"), passwordFile: path.join(tempDir, "backup-password"), stagingPath: path.join(tempDir, "staging"), requireMount: false, retryCount: 1, timeoutMs: 1_000, keepDaily: 7, keepWeekly: 4 },
    hostd: { socketPath: path.join(tempDir, "hostd.sock") },
    shares: { enabled: false, account: { username: "zos", password: null }, shares: [] },
    terminal: { user: "zos", termuxSocketPath: path.join(tempDir, "termux.sock"), sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: true, socketPath: path.join(tempDir, "vod.sock"), statePath: path.join(tempDir, "vod.json"), commandTimeoutMs: 1_000, startupTimeoutMs: 1_000, checkpointIntervalMs: 1_000, retryBaseDelayMs: 100, retryMaxDelayMs: 1_000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: "default", hwdec: "auto-safe", user: "zos" },
    nasRoots: []
  };
}
