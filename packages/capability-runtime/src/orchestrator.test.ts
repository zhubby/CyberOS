import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityError } from "@zos/capabilities";
import {
  createCapabilityRun,
  createMcpClient,
  createSession,
  createUserMessageAndJob,
  defaultAgentCapabilityPolicySettings,
  decideCapabilityApproval,
  ensureNasRoots,
  getCapabilityApprovalByRun,
  getCapabilityRun,
  getCapabilityRunPayload,
  linkAgentJobToCapabilityRun,
  openZosDb,
  saveAgentCapabilityPolicySettings,
  type ZosDatabase
} from "@zos/db";
import type { ZosConfig } from "@zos/shared";
import {
  executeApprovedCapabilityRun,
  proposeFileMutation,
  proposePiMcpFileCapability,
  recoverCapabilityRuns
} from "./orchestrator.js";

let tempDir: string;
let rootDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-capability-runtime-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir);
  await writeFile(path.join(rootDir, "source.txt"), "version one", "utf8");
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "primary", name: "Primary", path: rootDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("capability mutation runtime", () => {
  it("executes an approved Pi MCP read and stores its result for continuation", async () => {
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:read"] });
    const proposed = await proposePiMcpFileCapability({
      dependencies: dependencies(),
      subject: { id: client.id, clientId: client.id, kind: "pi", scopes: new Set(client.scopes) },
      capabilityId: "zos.files.read",
      request: { rootId: "primary", path: "source.txt" },
      requiresConfirmation: false
    });
    linkProposalToAgentJob(proposed.runId!);
    const approval = getCapabilityApprovalByRun(db, proposed.runId!)!;
    expect(decideCapabilityApproval(db, {
      approvalId: approval.id,
      expectedRevision: approval.revision,
      decision: "approved",
      decidedBy: "local-admin"
    })).not.toBeNull();

    const run = await executeApprovedCapabilityRun(dependencies(), proposed.runId!);

    expect(run).toMatchObject({
      state: "succeeded",
      result: { data: { rootId: "primary", preview: { content: "version one", truncated: false } } }
    });
  });

  it("rechecks Agent policy immediately before an approved capability executes", async () => {
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:read"] });
    const proposed = await proposePiMcpFileCapability({
      dependencies: dependencies(),
      subject: { id: client.id, clientId: client.id, kind: "pi", scopes: new Set(client.scopes) },
      capabilityId: "zos.files.read",
      request: { rootId: "primary", path: "source.txt" },
      requiresConfirmation: false
    });
    linkProposalToAgentJob(proposed.runId!);
    const approval = getCapabilityApprovalByRun(db, proposed.runId!)!;
    expect(decideCapabilityApproval(db, {
      approvalId: approval.id,
      expectedRevision: approval.revision,
      decision: "approved",
      decidedBy: "local-admin"
    })).not.toBeNull();
    const defaults = defaultAgentCapabilityPolicySettings();
    saveAgentCapabilityPolicySettings(db, {
      policies: { ...defaults.policies, "zos.files.read": "disabled" }
    });

    const run = await executeApprovedCapabilityRun(dependencies(), proposed.runId!);

    expect(run).toMatchObject({ state: "failed", errorCode: "FORBIDDEN" });
    expect(getCapabilityRunPayload(db, proposed.runId!)).toBeNull();
  });

  it("rejects an approved proposal when the source revision changed", async () => {
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:propose"] });
    const proposed = await proposeFileMutation({
      dependencies: dependencies(),
      subject: subject(client.id),
      request: { operation: "move", rootId: "primary", sourcePath: "source.txt", targetPath: "target.txt" }
    });
    linkProposalToAgentJob(proposed.runId!);
    const approval = getCapabilityApprovalByRun(db, proposed.runId!)!;
    expect(decideCapabilityApproval(db, {
      approvalId: approval.id,
      expectedRevision: approval.revision,
      decision: "approved",
      decidedBy: "local-admin"
    })).not.toBeNull();
    await writeFile(path.join(rootDir, "source.txt"), "version two is different", "utf8");

    const run = await executeApprovedCapabilityRun(dependencies(), proposed.runId!);

    expect(run).toMatchObject({ state: "failed", errorCode: "CONFLICT", cancellable: false });
    await expect(access(path.join(rootDir, "source.txt"))).resolves.toBeUndefined();
    await expect(access(path.join(rootDir, "target.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks client scopes immediately before execution", async () => {
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:propose"] });
    const proposed = await proposeFileMutation({
      dependencies: dependencies(),
      subject: subject(client.id),
      request: { operation: "mkdir", rootId: "primary", targetPath: "Archive" }
    });
    linkProposalToAgentJob(proposed.runId!);
    const approval = getCapabilityApprovalByRun(db, proposed.runId!)!;
    expect(decideCapabilityApproval(db, {
      approvalId: approval.id,
      expectedRevision: approval.revision,
      decision: "approved",
      decidedBy: "local-admin"
    })).not.toBeNull();
    db.prepare("UPDATE mcp_clients SET scopes_json = '[]' WHERE id = ?").run(client.id);

    const run = await executeApprovedCapabilityRun(dependencies(), proposed.runId!);

    expect(run).toMatchObject({ state: "failed", errorCode: "FORBIDDEN" });
    await expect(access(path.join(rootDir, "Archive"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects proposals while a required NAS root is not ready", async () => {
    ensureNasRoots(db, [{ id: "primary", name: "Primary", path: rootDir, mountPolicy: "required" }]);
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:propose"] });

    await expect(proposeFileMutation({
      dependencies: dependencies(),
      subject: subject(client.id),
      request: { operation: "mkdir", rootId: "primary", targetPath: "Archive" }
    })).rejects.toMatchObject({ code: "NOT_READY", retryable: true } satisfies Partial<CapabilityError>);
  });

  it("rejects mutations through a symlink", async () => {
    const outside = path.join(tempDir, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path.join(rootDir, "linked.txt"));
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:propose"] });

    await expect(proposeFileMutation({
      dependencies: dependencies(),
      subject: subject(client.id),
      request: { operation: "trash", rootId: "primary", sourcePath: "linked.txt" }
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" } satisfies Partial<CapabilityError>);
  });

  it("marks interrupted destructive work failed without replaying it", async () => {
    const client = createMcpClient(db, { name: "Agent", kind: "local", scopes: ["zos:files:propose"] });
    const run = createCapabilityRun(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "local",
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: { operation: "mkdir", rootId: "primary", targetPath: "NeverCreate" },
      state: "running",
      cancellable: false
    });

    await expect(recoverCapabilityRuns(dependencies())).resolves.toEqual({ expired: 0, interrupted: 1, resumed: 0 });
    expect(getCapabilityRun(db, run.id)).toMatchObject({ state: "failed", errorCode: "INTERNAL" });
    await expect(access(path.join(rootDir, "NeverCreate"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function subject(clientId: string) {
  return { id: clientId, clientId, kind: "pi" as const, scopes: new Set(["zos:files:propose"]) };
}

function linkProposalToAgentJob(runId: string): void {
  const session = createSession(db, { rootId: "primary" });
  const { job } = createUserMessageAndJob(db, {
    sessionId: session.id,
    content: "Run a file mutation",
    status: "waiting_approval"
  });
  linkAgentJobToCapabilityRun(db, { jobId: job.id, runId });
}

function dependencies() {
  return { db, config: testConfig() };
}

function testConfig(): ZosConfig {
  return {
    environment: "development",
    dataDir: tempDir,
    databasePath: path.join(tempDir, "zos.sqlite"),
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 100 },
    admin: { displayName: "Admin", authMode: "local-only" },
    model: { provider: "pi", piCommand: "pi", localEndpoint: null },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1_000, consoleShells: ["/bin/sh"] },
    hostd: { socketPath: path.join(tempDir, "hostd.sock") },
    shares: { enabled: false, account: { username: "zos", password: null }, shares: [] },
    terminal: { user: "zos", termuxSocketPath: path.join(tempDir, "termux.sock"), sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: path.join(tempDir, "vod.sock"), statePath: path.join(tempDir, "vod.json"), commandTimeoutMs: 1_000, startupTimeoutMs: 1_000, checkpointIntervalMs: 1_000, retryBaseDelayMs: 100, retryMaxDelayMs: 1_000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: "default", hwdec: "auto-safe", user: "zos" },
    nasRoots: [{ id: "primary", name: "Primary", path: rootDir }]
  };
}
