import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  createUserMessageAndJob,
  createCapabilityProposal,
  createMcpClient,
  decideCapabilityApproval,
  deleteSession,
  ensureNasRoots,
  getAgentProviderSession,
  getJob,
  listEvents,
  listPendingAgentCapabilityApprovals,
  listPendingApprovals,
  openZosDb,
  savePhotostaffLibrarySettings,
  upsertIndexedFile,
  type ZosDatabase
} from "@zos/db";
import type { PiAgentRunner } from "@zos/agent";
import type { ZosConfig } from "@zos/shared";
import { photostaffAgentTools, processNextJob } from "./processor.js";

let tempDir: string;
let rootDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-worker-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir);
  await writeFile(path.join(rootDir, "alpha.txt"), "alpha");
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: rootDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("worker processor", () => {
  it("claims a queued job and writes ordered agent events", async () => {
    const session = createSession(db, { rootId: "local" });
    createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List files"
    });
    const runner: PiAgentRunner = async (input) => {
      await input.emit({
        type: "agent.started",
        payload: { provider: "pi" }
      });
      await input.emit({
        type: "agent.message",
        payload: { role: "assistant", content: "Pi response" }
      });
      await input.emit({
        type: "agent.completed",
        payload: { provider: "pi" }
      });
      await input.saveProviderSession({
        providerSessionId: "pi-session-1",
        sessionFile: path.join(tempDir, "pi-sessions", "pi-session-1.jsonl"),
        providerName: "openai",
        model: "",
        settingsSnapshot: { providerName: "openai" }
      });
      return { status: "completed", summary: "Pi response" };
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);

    expect(listEvents(db, { sessionId: session.id }).map((event) => event.type)).toEqual([
      "job.running",
      "agent.started",
      "agent.message",
      "agent.completed",
      "job.completed"
    ]);
    expect(getAgentProviderSession(db, session.id)).toMatchObject({
      providerSessionId: "pi-session-1",
      providerName: "openai"
    });
  });

  it("marks Pi failures as failed jobs", async () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List files"
    });
    const runner: PiAgentRunner = async (input) => {
      await input.emit({
        type: "agent.started",
        payload: { provider: "pi" }
      });
      await input.emit({
        type: "agent.failed",
        payload: { provider: "pi", error: "Pi unavailable" }
      });
      return { status: "failed", error: "Pi unavailable" };
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);

    expect(getJob(db, job.id)?.status).toBe("failed");
    expect(listEvents(db, { sessionId: session.id }).map((event) => event.type)).toEqual([
      "job.running",
      "agent.started",
      "agent.failed",
      "job.failed"
    ]);
  });

  it("treats a cascaded job record as cancellation", async () => {
    const session = createSession(db, { rootId: "local" });
    createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List files"
    });
    const runner: PiAgentRunner = async (input) => {
      expect(deleteSession(db, session.id)).toBe(true);
      expect(input.isCancelled()).toBe(true);
      return { status: "cancelled" };
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);
  });

  it("keeps local fallback read-only without creating an approval", async () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "move alpha.txt to beta.txt"
    });

    await expect(processNextJob({ db, config: testConfig(), allowLocalFallback: true })).resolves.toBe(true);

    expect(getJob(db, job.id)?.status).toBe("completed");
    expect(listPendingApprovals(db)).toHaveLength(0);
    expect(listEvents(db, { sessionId: session.id }).map((event) => event.type)).toEqual([
      "job.running",
      "agent.started",
      "agent.message",
      "agent.completed",
      "job.completed"
    ]);
    await expect(readFile(path.join(rootDir, "alpha.txt"), "utf8")).resolves.toBe("alpha");
  });

  it("scopes local agent index searches to the session directory", async () => {
    await mkdir(path.join(rootDir, "docs"));
    const session = createSession(db, { rootId: "local", currentPath: "docs" });
    createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "search alpha"
    });
    upsertIndexedFile(db, {
      rootId: "local",
      path: "alpha.txt",
      name: "alpha.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      mtimeMs: 1,
      body: "alpha outside"
    });
    upsertIndexedFile(db, {
      rootId: "local",
      path: "docs/inside.txt",
      name: "inside.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      mtimeMs: 1,
      body: "alpha inside"
    });

    await expect(processNextJob({ db, config: testConfig(), allowLocalFallback: true })).resolves.toBe(true);

    const queryEvent = listEvents(db, { sessionId: session.id }).find(
      (event) => event.type === "tool_call.completed"
    );
    expect(queryEvent?.payload).toMatchObject({
      name: "query_index",
      output: {
        count: 1,
        matches: [{ path: "docs/inside.txt" }]
      }
    });
  });

  it("passes the saved Pi provider session back into the next job for the same ZOS session", async () => {
    const session = createSession(db, { rootId: "local" });
    createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "First"
    });
    createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "Second"
    });
    const seenProviderSessions: Array<string | null> = [];
    const runner: PiAgentRunner = async (input) => {
      seenProviderSessions.push(input.providerSession?.providerSessionId ?? null);
      await input.saveProviderSession({
        providerSessionId: "pi-session-reused",
        sessionFile: path.join(tempDir, "pi-sessions", "pi-session-reused.jsonl"),
        providerName: "openai",
        model: "",
        settingsSnapshot: { providerName: "openai" }
      });
      await input.emit({
        type: "agent.started",
        payload: { provider: "pi" }
      });
      return { status: "completed" };
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);
    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);

    expect(seenProviderSessions).toEqual([null, "pi-session-reused"]);
  });

  it("resumes the same Pi job with a terminal capability run continuation", async () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "Move alpha.txt"
    });
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["zos:files:propose"] });
    const pending = createCapabilityProposal(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "pi",
      capabilityId: "zos.files.mutate-propose",
      risk: "high",
      redactedInput: { operation: "move", rootId: "local" },
      proposal: { target: "beta.txt", revision: "r1" },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const messages: string[] = [];
    const providerSessions: Array<string | null> = [];
    let invocation = 0;
    const runner: PiAgentRunner = async (input) => {
      invocation += 1;
      messages.push(input.message);
      providerSessions.push(input.providerSession?.providerSessionId ?? null);
      if (invocation === 1) {
        await input.saveProviderSession({
          providerSessionId: "pi-session-continuation",
          sessionFile: path.join(tempDir, "pi-sessions", "continuation.jsonl"),
          providerName: "openai",
          model: "",
          settingsSnapshot: { providerName: "openai" }
        });
        await input.onCapabilityRunPending?.(pending.run.id, "pi-session-continuation");
        return { status: "waiting_approval", runId: pending.run.id };
      }
      return { status: "completed", summary: "The change was rejected." };
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);
    expect(getJob(db, job.id)?.status).toBe("waiting_approval");
    expect(decideCapabilityApproval(db, {
      approvalId: pending.approval.id,
      expectedRevision: pending.approval.revision,
      decision: "rejected",
      decidedBy: "local-admin"
    })?.run.state).toBe("failed");

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);

    expect(getJob(db, job.id)?.status).toBe("completed");
    expect(messages[0]).toBe("Move alpha.txt");
    expect(messages[1]).toContain("Internal ZOS continuation");
    expect(messages[1]).toContain(pending.run.id);
    expect(messages[1]).toContain("APPROVAL_REJECTED");
    expect(messages[1]).not.toContain("Move alpha.txt");
    expect(providerSessions).toEqual([null, "pi-session-continuation"]);
  });

  it("links every pending capability and waits for all decisions before continuing", async () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createUserMessageAndJob(db, { sessionId: session.id, content: "Inspect both files" });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposals = ["alpha.txt", "beta.txt"].map((pathValue) => createCapabilityProposal(db, {
      subjectId: session.id,
      subjectKind: "pi",
      capabilityId: "zos.files.read",
      risk: "low",
      redactedInput: { path: pathValue },
      proposal: { summary: `Read ${pathValue}` },
      expiresAt
    }));
    let invocation = 0;
    const messages: string[] = [];
    const runner: PiAgentRunner = async (input) => {
      invocation += 1;
      messages.push(input.message);
      if (invocation === 1) {
        for (const proposal of proposals) {
          await input.onCapabilityRunPending?.(proposal.run.id, "pi-multi-approval");
        }
        return { status: "waiting_approval", runId: proposals[0]!.run.id };
      }
      return { status: "completed", summary: "Both decisions received." };
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);
    expect(listPendingAgentCapabilityApprovals(db, { sessionId: session.id })).toHaveLength(2);

    expect(decideCapabilityApproval(db, {
      approvalId: proposals[1]!.approval.id,
      expectedRevision: proposals[1]!.approval.revision,
      decision: "rejected",
      decidedBy: "local-admin"
    })).not.toBeNull();
    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(false);
    expect(getJob(db, job.id)?.status).toBe("waiting_approval");

    expect(decideCapabilityApproval(db, {
      approvalId: proposals[0]!.approval.id,
      expectedRevision: proposals[0]!.approval.revision,
      decision: "rejected",
      decidedBy: "local-admin"
    })).not.toBeNull();
    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);
    expect(getJob(db, job.id)?.status).toBe("completed");
    expect(invocation).toBe(2);
    expect(messages[1]).toContain(proposals[0]!.run.id);
    expect(messages[1]).toContain(proposals[1]!.run.id);
    expect(messages[1]?.match(/APPROVAL_REJECTED/gu)).toHaveLength(2);
  });

  it("only injects photostaff tools for sessions on the configured photostaff root", async () => {
    savePhotostaffLibrarySettings(db, {
      rootId: "local",
      storagePoolId: "pool-a",
      path: "Photostaff"
    });

    expect(photostaffAgentTools(db, "other")).toEqual({});
    expect(photostaffAgentTools(db, "local").photostaffTools).toMatchObject({
      searchPhotostaff: expect.any(Function),
      getPhotostaffMetadata: expect.any(Function)
    });
  });
});

function testConfig(): ZosConfig {
  return {
    dataDir: tempDir,
    databasePath: path.join(tempDir, "zos.sqlite"),
    api: {
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: []
    },
    worker: {
      pollMs: 10
    },
    admin: {
      displayName: "Test Admin",
      authMode: "local-only"
    },
    model: {
      provider: "pi",
      piCommand: "pi",
      localEndpoint: null
    },
    docker: {
      enabled: false,
      socketPath: "/var/run/docker.sock",
      composeCommand: "docker",
      operationTimeoutMs: 120_000,
      consoleShells: ["/bin/sh", "/bin/bash"],
    },
    shares: {
      enabled: false,
      account: {
        username: "zos-share",
        password: null
      },
      shares: []
    },
    hostd: { socketPath: "/tmp/hostd.sock" },
    terminal: { user: "test-user", termuxSocketPath: "/tmp/termux.sock" },
    vodPlayer: { enabled: false, socketPath: "/tmp/vod-player.sock", statePath: "/tmp/vod-player-session.json", commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "zos" },
    nasRoots: [{ id: "local", name: "Local", path: rootDir }]
  };
}
