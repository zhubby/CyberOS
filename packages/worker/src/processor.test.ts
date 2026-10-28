import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimNextCapabilityContinuation,
  claimNextJob,
  createAgentSessionCommand,
  createSession,
  createUserMessageAndJob,
  createCapabilityProposal,
  createMcpClient,
  decideCapabilityApproval,
  deleteSession,
  getAgentProviderSession,
  getAgentSessionCommand,
  getJob,
  listEvents,
  listPendingAgentCapabilityApprovals,
  openCyberOsDb,
  recoverInterruptedAgentSessionCommands,
  saveAgentProviderSession,
  saveAgentMcpSettings,
  type CyberOsDatabase
} from "@cyberos/db";
import { PiActiveTurnUnavailableError, type PiAgentRunner } from "@cyberos/agent";
import { loadConfig, type CyberOsConfig } from "@cyberos/shared";
import { processNextAgentCommand, processNextJob } from "./processor.js";

let tempDir: string;
let rootDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-worker-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir);
  await writeFile(path.join(rootDir, "alpha.txt"), "alpha");
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("worker processor", () => {
  it("claims a queued job and writes ordered agent events", async () => {
    const session = createSession(db, { });
    createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List files"
    });
    const runner: PiAgentRunner = async (input) => {
      await input.emit({
        type: "agent.started",
        runId: "test-turn-1",
        sequence: 1,
        payload: { provider: "pi" }
      });
      await input.emit({
        type: "agent.message",
        runId: "test-turn-1",
        sequence: 2,
        payload: { role: "assistant", content: "Pi response" }
      });
      await input.emit({
        type: "agent.completed",
        runId: "test-turn-1",
        sequence: 3,
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

  it("processes different sessions concurrently in one worker", async () => {
    const firstSession = createSession(db, { });
    const secondSession = createSession(db, { });
    const firstJob = createUserMessageAndJob(db, {
      sessionId: firstSession.id,
      content: "First"
    }).job;
    const secondJob = createUserMessageAndJob(db, {
      sessionId: secondSession.id,
      content: "Second"
    }).job;
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: PiAgentRunner = async (input) => {
      started.push(input.session.id);
      await blocked;
      return { status: "completed", summary: input.session.id };
    };

    const first = processNextJob({
      db,
      config: testConfig(),
      workerId: "worker-1",
      agentRunner: runner
    });
    await vi.waitFor(() => expect(started).toEqual([firstSession.id]));
    const second = processNextJob({
      db,
      config: testConfig(),
      workerId: "worker-1",
      agentRunner: runner
    });
    await vi.waitFor(() => expect(started).toEqual([firstSession.id, secondSession.id]));

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(getJob(db, firstJob.id)?.status).toBe("completed");
    expect(getJob(db, secondJob.id)?.status).toBe("completed");
  });

  it("executes active commands only for the worker holding the session lease", async () => {
    const session = createSession(db, { });
    const { job } = createUserMessageAndJob(db, { sessionId: session.id, content: "Inspect logs" });
    expect(claimNextJob(db, { workerId: "worker-owner", leaseMs: 30_000 })?.id).toBe(job.id);
    const command = createAgentSessionCommand(db, {
      sessionId: session.id,
      idempotencyKey: "steer-owner-1",
      type: "steer",
      payload: { content: "Focus on errors" }
    });
    const commandRunner = vi.fn(async () => ({ disposition: "queued" }));

    await expect(processNextAgentCommand({
      db,
      config: testConfig(),
      workerId: "worker-other",
      commandRunner
    })).resolves.toBe(false);
    await expect(processNextAgentCommand({
      db,
      config: testConfig(),
      workerId: "worker-owner",
      commandRunner
    })).resolves.toBe(true);

    expect(commandRunner).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ id: session.id }) }),
      { type: "steer", payload: { content: "Focus on errors" } }
    );
    expect(getAgentSessionCommand(db, command.id)).toMatchObject({
      status: "completed",
      result: { disposition: "queued" }
    });
    expect(listEvents(db, { sessionId: session.id }).map((event) => event.type)).toEqual([
      "command.running",
      "agent.message",
      "command.completed"
    ]);
  });

  it("cancels the active job before dispatching an abort command", async () => {
    const session = createSession(db, { });
    const { job } = createUserMessageAndJob(db, { sessionId: session.id, content: "Long task" });
    expect(claimNextJob(db, { workerId: "worker-owner", leaseMs: 30_000 })?.id).toBe(job.id);
    const command = createAgentSessionCommand(db, {
      sessionId: session.id,
      idempotencyKey: "abort-1",
      type: "abort"
    });
    const statuses: Array<string | undefined> = [];

    await expect(processNextAgentCommand({
      db,
      config: testConfig(),
      workerId: "worker-owner",
      commandRunner: async () => {
        statuses.push(getJob(db, job.id)?.status);
        return { aborted: true };
      }
    })).resolves.toBe(true);

    expect(statuses).toEqual(["cancelled"]);
    expect(getJob(db, job.id)?.status).toBe("cancelled");
    expect(getAgentSessionCommand(db, command.id)?.status).toBe("completed");
  });

  it("requeues steer while the claimed Pi session is still starting", async () => {
    const session = createSession(db, { });
    const { job } = createUserMessageAndJob(db, { sessionId: session.id, content: "Long task" });
    expect(claimNextJob(db, { workerId: "worker-owner", leaseMs: 30_000 })?.id).toBe(job.id);
    const command = createAgentSessionCommand(db, {
      sessionId: session.id,
      idempotencyKey: "steer-starting-1",
      type: "steer",
      payload: { content: "Focus on errors" }
    });

    await expect(processNextAgentCommand({
      db,
      config: testConfig(),
      workerId: "worker-owner",
      commandRunner: async () => {
        throw new PiActiveTurnUnavailableError("steer");
      }
    })).resolves.toBe(true);

    expect(getAgentSessionCommand(db, command.id)).toMatchObject({ status: "queued", error: null });
  });

  it("signals cancellation when an idle command loses its lease", async () => {
    const session = createSession(db, { });
    const command = createAgentSessionCommand(db, {
      sessionId: session.id,
      idempotencyKey: "compact-lease-loss",
      type: "compact"
    });
    let cancellationObserved = false;

    await expect(processNextAgentCommand({
      db,
      config: testConfig(),
      workerId: "command-worker",
      leaseMs: 1_000,
      heartbeatMs: 5,
      commandRunner: async (input) => {
        db.prepare("UPDATE agent_session_commands SET lease_until = ? WHERE id = ?")
          .run(new Date(0).toISOString(), command.id);
        await vi.waitFor(() => expect(input.isCancelled?.()).toBe(true));
        cancellationObserved = true;
        return { compacted: true };
      }
    })).resolves.toBe(true);

    expect(cancellationObserved).toBe(true);
    expect(getAgentSessionCommand(db, command.id)?.status).toBe("running");
    expect(recoverInterruptedAgentSessionCommands(db)).toBe(1);
    expect(getAgentSessionCommand(db, command.id)).toMatchObject({
      status: "failed",
      error: "Agent worker stopped while executing this command"
    });
  });

  it("applies the persisted Agent MCP switch to new jobs without a worker restart", async () => {
    const session = createSession(db, { });
    const config: CyberOsConfig = {
      ...testConfig(),
      mcp: {
        enabled: true,
        piEnabled: false,
        piTokenFile: path.join(tempDir, "pi.token"),
        externalEnabled: false,
        shellEnabled: false,
        allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
        allowedOrigins: ["localhost", "127.0.0.1", "[::1]"],
        maxConcurrentPerClient: 4
      }
    };
    const observed: boolean[] = [];
    const runner: PiAgentRunner = async (input) => {
      observed.push(Boolean(input.mcp?.enabled));
      return { status: "completed", summary: "Done" };
    };

    saveAgentMcpSettings(db, true);
    createUserMessageAndJob(db, { sessionId: session.id, content: "First" });
    await processNextJob({ db, config, agentRunner: runner });

    saveAgentMcpSettings(db, false);
    createUserMessageAndJob(db, { sessionId: session.id, content: "Second" });
    await processNextJob({ db, config, agentRunner: runner });

    expect(observed).toEqual([true, false]);
  });

  it("marks Pi failures as failed jobs", async () => {
    const session = createSession(db, { });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List files"
    });
    const runner: PiAgentRunner = async (input) => {
      await input.saveProviderSession({
        providerSessionId: "pi-session-failed",
        sessionFile: path.join(tempDir, "pi-sessions", "pi-session-failed.jsonl"),
        providerName: "openai",
        model: "",
        settingsSnapshot: { providerName: "openai" }
      });
      await input.emit({
        type: "agent.started",
        runId: "test-turn-failed",
        sequence: 1,
        payload: { provider: "pi" }
      });
      await input.emit({
        type: "agent.failed",
        runId: "test-turn-failed",
        sequence: 2,
        payload: { provider: "pi", error: "Pi unavailable" }
      });
      return { status: "failed", error: "Pi unavailable" };
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);

    expect(getJob(db, job.id)?.status).toBe("failed");
    expect(getAgentProviderSession(db, session.id)).toBeNull();
    expect(listEvents(db, { sessionId: session.id }).map((event) => event.type)).toEqual([
      "job.running",
      "agent.started",
      "agent.failed",
      "job.failed"
    ]);
  });

  it("clears a provider session saved by a Pi runner that throws", async () => {
    const session = createSession(db, { });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List files"
    });
    const runner: PiAgentRunner = async (input) => {
      await input.saveProviderSession({
        providerSessionId: "pi-session-thrown",
        sessionFile: path.join(tempDir, "pi-sessions", "pi-session-thrown.jsonl"),
        providerName: "openai",
        model: "",
        settingsSnapshot: { providerName: "openai" }
      });
      throw new Error("Pi runner crashed");
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);

    expect(getJob(db, job.id)?.status).toBe("failed");
    expect(getAgentProviderSession(db, session.id)).toBeNull();
    expect(listEvents(db, { sessionId: session.id }).at(-1)).toMatchObject({
      type: "job.failed",
      payload: { error: "Pi runner crashed" }
    });
  });

  it("preserves a durable Pi session when a turn fails after JSONL persistence", async () => {
    const session = createSession(db, { });
    createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List files"
    });
    const sessionFile = path.join(tempDir, "pi-sessions", "pi-session-durable.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, '{"type":"session","id":"pi-session-durable"}\n');
    const runner: PiAgentRunner = async (input) => {
      await input.saveProviderSession({
        providerSessionId: "pi-session-durable",
        sessionFile,
        providerName: "openai",
        model: "",
        settingsSnapshot: { providerName: "openai" },
        projectionCursor: "entry-1"
      });
      throw new Error("Pi failed after persistence");
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);

    expect(getAgentProviderSession(db, session.id)).toMatchObject({
      providerSessionId: "pi-session-durable",
      sessionFile,
      projectionCursor: "entry-1"
    });
  });

  it("preserves an existing provider session when the failing runner did not save one", async () => {
    const session = createSession(db, { });
    saveAgentProviderSession(db, {
      sessionId: session.id,
      providerSessionId: "pi-session-existing",
      sessionFile: path.join(tempDir, "pi-sessions", "pi-session-existing.jsonl"),
      providerName: "openai",
      model: "",
      settingsSnapshot: { providerName: "openai" }
    });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List files"
    });
    const runner: PiAgentRunner = async () => {
      throw new Error("Pi failed before prompting");
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);

    expect(getJob(db, job.id)?.status).toBe("failed");
    expect(getAgentProviderSession(db, session.id)).toMatchObject({
      providerSessionId: "pi-session-existing"
    });
    expect(listEvents(db, { sessionId: session.id }).at(-1)).toMatchObject({
      type: "job.failed",
      payload: { error: "Pi failed before prompting" }
    });
  });

  it("does not clear a newer provider session saved by another turn", async () => {
    const session = createSession(db, { });
    createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List files"
    });
    const runner: PiAgentRunner = async (input) => {
      await input.saveProviderSession({
        providerSessionId: "pi-session-failing",
        sessionFile: path.join(tempDir, "pi-sessions", "pi-session-failing.jsonl"),
        providerName: "openai",
        model: "",
        settingsSnapshot: { providerName: "openai" }
      });
      saveAgentProviderSession(db, {
        sessionId: session.id,
        providerSessionId: "pi-session-newer",
        sessionFile: path.join(tempDir, "pi-sessions", "pi-session-newer.jsonl"),
        providerName: "openai",
        model: "",
        settingsSnapshot: { providerName: "openai" }
      });
      return { status: "failed", error: "Older turn failed" };
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);

    expect(getAgentProviderSession(db, session.id)).toMatchObject({
      providerSessionId: "pi-session-newer"
    });
  });

  it("allows a later successful turn to restore the provider session after failure", async () => {
    const session = createSession(db, { });
    createUserMessageAndJob(db, { sessionId: session.id, content: "First" });
    createUserMessageAndJob(db, { sessionId: session.id, content: "Second" });
    let turn = 0;
    const runner: PiAgentRunner = async (input) => {
      turn += 1;
      expect(input.providerSession).toBeNull();
      await input.saveProviderSession({
        providerSessionId: session.id,
        sessionFile: path.join(tempDir, "pi-sessions", `${session.id}.jsonl`),
        providerName: "openai",
        model: "",
        settingsSnapshot: { providerName: "openai" }
      });
      return turn === 1
        ? { status: "failed", error: "Rejected context" }
        : { status: "completed", summary: "Recovered" };
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);
    expect(getAgentProviderSession(db, session.id)).toBeNull();

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);
    expect(getAgentProviderSession(db, session.id)).toMatchObject({
      providerSessionId: session.id
    });
  });

  it("treats a cascaded job record as cancellation", async () => {
    const session = createSession(db, { });
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

  it("passes the saved Pi provider session back into the next job for the same CyberOS session", async () => {
    const session = createSession(db, { });
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
        runId: `test-turn-${seenProviderSessions.length}`,
        sequence: 1,
        payload: { provider: "pi" }
      });
      return { status: "completed" };
    };

    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);
    await expect(processNextJob({ db, config: testConfig(), agentRunner: runner })).resolves.toBe(true);

    expect(seenProviderSessions).toEqual([null, "pi-session-reused"]);
  });

  it("resumes the same Pi job with a terminal capability run continuation", async () => {
    const session = createSession(db, { });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "Move alpha.txt"
    });
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["cyberos:files:propose"] });
    const pending = createCapabilityProposal(db, {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "pi",
      capabilityId: "cyberos.files.mutate-propose",
      risk: "high",
      redactedInput: { operation: "move", storagePoolId: "local" },
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
    expect(messages[1]).toContain("Internal CyberOS continuation");
    expect(messages[1]).toContain(pending.run.id);
    expect(messages[1]).toContain("APPROVAL_REJECTED");
    expect(messages[1]).not.toContain("Move alpha.txt");
    expect(providerSessions).toEqual([null, "pi-session-continuation"]);
  });

  it("does not hand off an approved continuation until the originating Pi turn is idle", async () => {
    const session = createSession(db, { });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "Move alpha.txt"
    });
    const pending = createCapabilityProposal(db, {
      subjectId: session.id,
      subjectKind: "pi",
      capabilityId: "cyberos.files.mutate-propose",
      risk: "high",
      redactedInput: { operation: "move", storagePoolId: "local" },
      proposal: { target: "beta.txt", revision: "r1" },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    let notifyPending!: () => void;
    let releaseTurn!: () => void;
    const pendingLinked = new Promise<void>((resolve) => {
      notifyPending = resolve;
    });
    const turnReleased = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const runner: PiAgentRunner = async (input) => {
      await input.onCapabilityRunPending?.(pending.run.id, "pi-session-handoff");
      notifyPending();
      await turnReleased;
      return { status: "waiting_approval", runId: pending.run.id };
    };

    const processing = processNextJob({
      db,
      config: testConfig(),
      workerId: "worker-origin",
      agentRunner: runner
    });
    await pendingLinked;

    expect(decideCapabilityApproval(db, {
      approvalId: pending.approval.id,
      expectedRevision: pending.approval.revision,
      decision: "rejected",
      decidedBy: "local-admin"
    })?.run.state).toBe("failed");
    expect(getJob(db, job.id)?.status).toBe("running");
    expect(claimNextCapabilityContinuation(db, {
      workerId: "worker-continuation",
      leaseMs: 30_000
    })).toBeNull();

    releaseTurn();
    await expect(processing).resolves.toBe(true);
    expect(getJob(db, job.id)?.status).toBe("waiting_approval");
    expect(claimNextCapabilityContinuation(db, {
      workerId: "worker-continuation",
      leaseMs: 30_000
    })).toMatchObject({
      jobId: job.id,
      runs: [expect.objectContaining({ id: pending.run.id, state: "failed" })]
    });
  });

  it("links every pending capability and waits for all decisions before continuing", async () => {
    const session = createSession(db, { });
    const { job } = createUserMessageAndJob(db, { sessionId: session.id, content: "Inspect both files" });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proposals = ["alpha.txt", "beta.txt"].map((pathValue) => createCapabilityProposal(db, {
      subjectId: session.id,
      subjectKind: "pi",
      capabilityId: "cyberos.files.read",
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

});

function testConfig(): CyberOsConfig {
  const base = loadConfig({ CYBEROS_CONFIG: path.join(tempDir, "missing.toml"), CYBEROS_ROOT: tempDir }, tempDir);
  return {
    ...base,
    paths: { ...base.paths, dataRoot: rootDir, databasePath: path.join(tempDir, "cyberos.sqlite") },
    api: {
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: []
    },
    worker: {
      pollMs: 10,
      concurrency: 1
    },
    admin: {
      displayName: "Test Admin",
      authMode: "local-only"
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
        username: "cyberos-share",
        password: null
      },
      shares: []
    },
    hostd: { socketPath: "/tmp/hostd.sock", mutationPolicy: "mutable" },
    terminal: { user: "test-user", socketPath: "/tmp/terminald.sock", sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: "/tmp/vod-player.sock", statePath: "/tmp/vod-player-session.json", commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "cyberos" },
  };
}
