import { existsSync } from "node:fs";
import {
  PiActiveTurnUnavailableError,
  runPiAgentCommand,
  runPiAgentTurn,
  type PiAgentCommand,
  type PiAgentRunner
} from "@cyberos/agent";
import {
  appendEvent,
  claimNextAgentSessionCommand,
  claimNextCapabilityContinuation,
  claimNextJob,
  clearAgentProviderSession,
  agentCapabilityPolicyToPiToolPolicy,
  defaultAgentCapabilityPolicySettings,
  getAgentProviderSession,
  getActiveAgentJobForSession,
  getJob,
  getMessage,
  getModelProviderSettings,
  getAgentCapabilityPolicySettings,
  getAgentMcpSettings,
  getSession,
  finishAgentSessionCommand,
  linkAgentJobToCapabilityRun,
  requeueAgentSessionCommand,
  renewAgentJobLease,
  renewAgentSessionCommandLease,
  saveAgentProviderSession,
  updateJobStatus,
  type CyberOsDatabase
} from "@cyberos/db";
import { type ModelProviderSettingsRecord, type CyberOsConfig } from "@cyberos/shared";

export interface ProcessNextJobDependencies {
  db: CyberOsDatabase;
  config: CyberOsConfig;
  agentRunner?: PiAgentRunner;
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
}

export const AGENT_JOB_LEASE_MS = 30_000;
export const AGENT_JOB_HEARTBEAT_MS = 10_000;
export const AGENT_COMMAND_LEASE_MS = 30_000;
export const AGENT_COMMAND_HEARTBEAT_MS = 10_000;

export interface ProcessNextAgentCommandDependencies {
  db: CyberOsDatabase;
  config: CyberOsConfig;
  workerId: string;
  commandRunner?: typeof runPiAgentCommand;
  leaseMs?: number;
  heartbeatMs?: number;
}

export async function processNextAgentCommand({
  db,
  config,
  workerId,
  commandRunner = runPiAgentCommand,
  leaseMs = AGENT_COMMAND_LEASE_MS,
  heartbeatMs = AGENT_COMMAND_HEARTBEAT_MS
}: ProcessNextAgentCommandDependencies): Promise<boolean> {
  const command = claimNextAgentSessionCommand(db, { workerId, leaseMs });
  if (!command) return false;
  let commandLeaseLost = false;
  const stopHeartbeat = startAgentSessionCommandHeartbeat({
    db,
    commandId: command.id,
    workerId,
    leaseMs,
    heartbeatMs,
    onLeaseLost: () => {
      commandLeaseLost = true;
    }
  });

  try {
  const session = getSession(db, command.sessionId);
  const workspace = { path: config.paths.dataRoot };
  const activeJob = command.jobId
    ? getJob(db, command.jobId)
    : getActiveAgentJobForSession(db, command.sessionId);
  const runId = `command:${command.id}`;
  appendEvent(db, {
    sessionId: command.sessionId,
    jobId: activeJob?.id ?? command.jobId,
    type: "command.running",
    runId,
    sourceId: `${runId}:running`,
    payload: { commandId: command.id, type: command.type }
  });

  if (!session) {
    const error = "Command references a missing session";
    const failed = finishAgentSessionCommand(db, {
      commandId: command.id,
      workerId,
      status: "failed",
      error
    });
    if (failed) {
      appendEvent(db, {
        sessionId: command.sessionId,
        type: "command.failed",
        runId,
        sourceId: `${runId}:failed`,
        payload: { commandId: command.id, type: command.type, error }
      });
    }
    return true;
  }

  try {
    if (command.type === "abort" && activeJob) {
      if (updateJobStatus(db, activeJob.id, "cancelled", null, ["running"])) {
        appendEvent(db, {
          sessionId: session.id,
          jobId: activeJob.id,
          type: "job.cancelled",
          payload: { jobId: activeJob.id }
        });
      }
    }
    const workingPath = activeJob?.workingPath ?? session.currentPath;
    if (command.type === "steer" || command.type === "follow_up") {
      appendEvent(db, {
        sessionId: session.id,
        jobId: activeJob?.id ?? null,
        type: "agent.message",
        runId,
        sourceId: `${runId}:user-message`,
        payload: {
          role: "user",
          content: command.payload.content,
          delivery: command.type
        }
      });
    }
    const result = await commandRunner({
      session: { ...session, currentPath: workingPath },
      root: workspace,
      workingPath,
      dataDir: config.paths.stateDir,
      modelSettings: getModelProviderSettings(db) ?? defaultModelProviderSettings(),
      toolPolicy: agentCapabilityPolicyToPiToolPolicy(
        getAgentCapabilityPolicySettings(db) ?? defaultAgentCapabilityPolicySettings()
      ),
      providerSession: getAgentProviderSession(db, session.id),
      emit: (event) => {
        appendEvent(db, {
          sessionId: session.id,
          jobId: activeJob?.id ?? null,
          type: event.type,
          payload: event.payload,
          ...(event.source === undefined ? {} : { source: event.source }),
          ...(event.sourceId === undefined ? {} : { sourceId: event.sourceId }),
          runId: event.runId,
          sequence: event.sequence
        });
      },
      isCancelled: () => commandLeaseLost,
      saveProviderSession: (providerSession) => {
        saveAgentProviderSession(db, {
          sessionId: session.id,
          providerSessionId: providerSession.providerSessionId,
          sessionFile: providerSession.sessionFile,
          providerName: providerSession.providerName,
          model: providerSession.model,
          settingsSnapshot: providerSession.settingsSnapshot,
          ...(providerSession.runtimeGeneration === undefined ? {} : {
            runtimeGeneration: providerSession.runtimeGeneration
          }),
          ...(providerSession.runtimeProvider === undefined ? {} : {
            runtimeProvider: providerSession.runtimeProvider
          }),
          ...(providerSession.runtimeModel === undefined ? {} : {
            runtimeModel: providerSession.runtimeModel
          }),
          ...(providerSession.projectionCursor === undefined ? {} : {
            projectionCursor: providerSession.projectionCursor
          })
        });
      },
      onCapabilityRunPending: (capabilityRunId, providerSessionId) => {
        if (!activeJob) throw new Error("Idle command cannot wait for a capability approval");
        linkAgentJobToCapabilityRun(db, {
          jobId: activeJob.id,
          runId: capabilityRunId,
          providerSessionId
        });
      },
      ...(config.mcp.enabled && (getAgentMcpSettings(db)?.enabled ?? config.mcp.piEnabled) ? {
        mcp: {
          enabled: true,
          url: `http://127.0.0.1:${config.api.port}/mcp`,
          tokenFile: config.mcp.piTokenFile
        }
      } : {})
    }, {
      type: command.type as PiAgentCommand["type"],
      payload: command.payload
    });
    const completed = finishAgentSessionCommand(db, {
      commandId: command.id,
      workerId,
      status: "completed",
      result
    });
    if (!completed) return true;
    appendEvent(db, {
      sessionId: session.id,
      jobId: activeJob?.id ?? null,
      type: "command.completed",
      runId,
      sourceId: `${runId}:completed`,
      payload: { commandId: command.id, type: command.type, result }
    });
  } catch (error) {
    const currentActiveJob = activeJob ? getJob(db, activeJob.id) : null;
    if (
      error instanceof PiActiveTurnUnavailableError
      && currentActiveJob?.status === "running"
      && currentActiveJob.leaseOwner === workerId
    ) {
      requeueAgentSessionCommand(db, { commandId: command.id, workerId });
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    const failed = finishAgentSessionCommand(db, {
      commandId: command.id,
      workerId,
      status: "failed",
      error: message
    });
    if (!failed) return true;
    appendEvent(db, {
      sessionId: session.id,
      jobId: activeJob?.id ?? null,
      type: "command.failed",
      runId,
      sourceId: `${runId}:failed`,
      payload: { commandId: command.id, type: command.type, error: message }
    });
  }
  return true;
  } finally {
    stopHeartbeat();
  }
}

export async function processNextJob({
  db,
  config,
  agentRunner,
  workerId = `worker-${process.pid}`,
  leaseMs = AGENT_JOB_LEASE_MS,
  heartbeatMs = AGENT_JOB_HEARTBEAT_MS
}: ProcessNextJobDependencies): Promise<boolean> {
  const claim = { workerId, leaseMs };
  const continuation = claimNextCapabilityContinuation(db, claim);
  const job = continuation ? getJob(db, continuation.jobId) : claimNextJob(db, claim);
  if (!job) {
    return false;
  }

  const session = getSession(db, job.sessionId);
  const message = getMessage(db, job.messageId);
  const workspace = { path: config.paths.dataRoot };

  if (!session || !message) {
    const error = "Job references a missing session or message";
    const failed = updateJobStatus(db, job.id, "failed", error, ["running"]);
    if (failed && session) {
      appendEvent(db, {
        sessionId: session.id,
        jobId: job.id,
        type: "job.failed",
        payload: { error }
      });
    }
    return true;
  }

  let leaseLost = false;
  const stopHeartbeat = startAgentJobHeartbeat({
    db,
    jobId: job.id,
    workerId,
    leaseMs,
    heartbeatMs,
    onLeaseLost: () => {
      leaseLost = true;
    }
  });

  try {
    appendEvent(db, {
    sessionId: session.id,
    jobId: job.id,
    type: "job.running",
    payload: {
      jobId: job.id
    }
  });

    const isCancelled = () => {
      const currentJob = getJob(db, job.id);
      if (!currentJob || currentJob.status === "cancelled" || currentJob.status === "failed") return true;
      return currentJob.status === "running" && (leaseLost || currentJob.leaseOwner !== workerId);
    };
    let providerSessionSavedThisTurn: string | null = null;

  try {
    const turnSession = { ...session, currentPath: job.workingPath };
    const turnMessage = continuation ? capabilityContinuationMessage(continuation.runs) : message.content;
    const result = await runPiAgentTurn({
          session: turnSession,
          root: workspace,
          message: turnMessage,
          workingPath: job.workingPath,
          dataDir: config.paths.stateDir,
          modelSettings: getModelProviderSettings(db) ?? defaultModelProviderSettings(),
          toolPolicy: agentCapabilityPolicyToPiToolPolicy(
            getAgentCapabilityPolicySettings(db) ?? defaultAgentCapabilityPolicySettings()
          ),
          providerSession: getAgentProviderSession(db, session.id),
          ...(agentRunner ? { runner: agentRunner } : {}),
          emit: (event) => {
            appendEvent(db, {
              sessionId: session.id,
              jobId: job.id,
              type: event.type,
              payload: event.payload,
              ...(event.source === undefined ? {} : { source: event.source }),
              ...(event.sourceId === undefined ? {} : { sourceId: event.sourceId }),
              runId: event.runId,
              sequence: event.sequence
            });
          },
          isCancelled,
          saveProviderSession: (providerSession) => {
            saveAgentProviderSession(db, {
              sessionId: session.id,
              providerSessionId: providerSession.providerSessionId,
              sessionFile: providerSession.sessionFile,
              providerName: providerSession.providerName,
              model: providerSession.model,
              settingsSnapshot: providerSession.settingsSnapshot,
              ...(providerSession.runtimeGeneration === undefined ? {} : {
                runtimeGeneration: providerSession.runtimeGeneration
              }),
              ...(providerSession.runtimeProvider === undefined ? {} : {
                runtimeProvider: providerSession.runtimeProvider
              }),
              ...(providerSession.runtimeModel === undefined ? {} : {
                runtimeModel: providerSession.runtimeModel
              }),
              ...(providerSession.projectionCursor === undefined ? {} : {
                projectionCursor: providerSession.projectionCursor
              })
            });
            providerSessionSavedThisTurn = providerSession.providerSessionId;
          },
          onCapabilityRunPending: (runId, providerSessionId) => {
            linkAgentJobToCapabilityRun(db, { jobId: job.id, runId, providerSessionId });
          },
          ...(config.mcp.enabled && (getAgentMcpSettings(db)?.enabled ?? config.mcp.piEnabled) ? {
            mcp: {
              enabled: true,
              url: `http://127.0.0.1:${config.api.port}/mcp`,
              tokenFile: config.mcp.piTokenFile
            }
          } : {})
    });

    if (result.status === "cancelled" || getJob(db, job.id)?.status === "cancelled") {
      return true;
    }

    if (result.status === "failed") {
      const error = result.error ?? "Agent turn failed";
      if (providerSessionSavedThisTurn) {
        clearUnpersistedProviderSession(db, session.id, providerSessionSavedThisTurn);
      }
      if (updateJobStatus(db, job.id, "failed", error, ["running", "waiting_approval"])) {
        appendEvent(db, {
          sessionId: session.id,
          jobId: job.id,
          type: "job.failed",
          payload: {
            error
          }
        });
      }
      return true;
    }

    if (result.status === "waiting_approval") {
      if (updateJobStatus(db, job.id, "waiting_approval", null, ["running"])) {
        appendEvent(db, {
          sessionId: session.id,
          jobId: job.id,
          type: "approval.pending",
          sourceId: result.runId ? `approval:${result.runId}:job-waiting` : `job:${job.id}:waiting-approval`,
          runId: result.runId ? `capability:${result.runId}` : `job:${job.id}`,
          payload: {
            jobId: job.id,
            ...(result.runId ? { runId: result.runId } : {})
          }
        });
      }
      return true;
    }

    if (!updateJobStatus(db, job.id, "completed", null, ["running", "waiting_approval"])) {
      return true;
    }
    appendEvent(db, {
      sessionId: session.id,
      jobId: job.id,
      type: "job.completed",
      payload: {
        jobId: job.id
      }
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (providerSessionSavedThisTurn) {
      clearUnpersistedProviderSession(db, session.id, providerSessionSavedThisTurn);
    }
    if (updateJobStatus(db, job.id, "failed", messageText, ["running", "waiting_approval"])) {
      appendEvent(db, {
        sessionId: session.id,
        jobId: job.id,
        type: "job.failed",
        payload: {
          error: messageText
        }
      });
    }
  }

    return true;
  } finally {
    stopHeartbeat();
  }
}

function clearUnpersistedProviderSession(
  db: CyberOsDatabase,
  sessionId: string,
  providerSessionId: string
): void {
  const saved = getAgentProviderSession(db, sessionId);
  if (
    saved?.providerSessionId === providerSessionId
    && saved.sessionFile
    && existsSync(saved.sessionFile)
  ) {
    return;
  }
  clearAgentProviderSession(db, sessionId, providerSessionId);
}

export function startAgentJobHeartbeat(input: {
  db: CyberOsDatabase;
  jobId: string;
  workerId: string;
  leaseMs: number;
  heartbeatMs: number;
  onLeaseLost: () => void;
}): () => void {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (renewAgentJobLease(input.db, {
      jobId: input.jobId,
      workerId: input.workerId,
      leaseMs: input.leaseMs
    })) return;

    const current = getJob(input.db, input.jobId);
    stop();
    if (current?.status === "running") input.onLeaseLost();
  }, input.heartbeatMs);
  timer.unref();
  return stop;
}

export function startAgentSessionCommandHeartbeat(input: {
  db: CyberOsDatabase;
  commandId: string;
  workerId: string;
  leaseMs: number;
  heartbeatMs: number;
  onLeaseLost: () => void;
}): () => void {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (renewAgentSessionCommandLease(input.db, {
      commandId: input.commandId,
      workerId: input.workerId,
      leaseMs: input.leaseMs
    })) return;

    stop();
    input.onLeaseLost();
  }, input.heartbeatMs);
  timer.unref();
  return stop;
}

function capabilityContinuationMessage(
  runs: NonNullable<ReturnType<typeof claimNextCapabilityContinuation>>["runs"]
): string {
  const outcomes = runs.map((run) => ({
    runId: run.id,
    capabilityId: run.capabilityId,
    ...(run.state === "succeeded"
      ? { state: run.state, result: run.result }
      : { state: run.state, error: { code: run.errorCode, message: run.errorMessage } })
  }));
  return [
    "Internal CyberOS continuation. Do not repeat the user's original request.",
    "All capability runs requested by the previous turn reached terminal states:",
    JSON.stringify(outcomes),
    "Continue the same conversation using these results. Explain the outcomes briefly and only propose another change if it is still required."
  ].join("\n");
}

function defaultModelProviderSettings(): ModelProviderSettingsRecord {
  return {
    generation: 1,
    providerName: "openai",
    baseUrl: null,
    model: "",
    apiKey: null,
    updatedAt: new Date(0).toISOString()
  };
}
