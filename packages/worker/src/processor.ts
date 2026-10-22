import {
  runPiAgentTurn,
  runReadOnlyAgentTurn,
  type PhotostaffAgentToolService,
  type PiAgentRunner
} from "@zos/agent";
import { proposePiToolCapability } from "@zos/capability-runtime";
import {
  appendEvent,
  claimNextCapabilityContinuation,
  claimNextJob,
  clearAgentProviderSession,
  agentCapabilityPolicyToPiToolPolicy,
  defaultAgentCapabilityPolicySettings,
  getAgentProviderSession,
  getJob,
  getMessage,
  getModelProviderSettings,
  getNasRoot,
  getPhotostaffLibrarySettings,
  getPhotostaffMetadataDetail,
  getPhotostaffMetadataIndexStatus,
  getAgentCapabilityPolicySettings,
  getSession,
  linkAgentJobToCapabilityRun,
  queryIndexedText,
  queryPhotostaffAssets,
  saveAgentProviderSession,
  updateJobStatus,
  type ZosDatabase
} from "@zos/db";
import type { ModelProviderSettingsRecord, ZosConfig } from "@zos/shared";

export interface ProcessNextJobDependencies {
  db: ZosDatabase;
  config: ZosConfig;
  agentRunner?: PiAgentRunner;
  allowLocalFallback?: boolean;
}

export async function processNextJob({ db, config, agentRunner, allowLocalFallback }: ProcessNextJobDependencies): Promise<boolean> {
  const continuation = claimNextCapabilityContinuation(db);
  const job = continuation ? getJob(db, continuation.jobId) : claimNextJob(db);
  if (!job) {
    return false;
  }

  const session = getSession(db, job.sessionId);
  const message = getMessage(db, job.messageId);
  const root = session ? getNasRoot(db, session.rootId) : null;

  if (!session || !message || !root) {
    const error = "Job references missing session, message, or NAS root";
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
    return !currentJob || currentJob.status === "cancelled";
  };
  let providerSessionSavedThisTurn: string | null = null;

  try {
    const shouldUseLocalFallback =
      allowLocalFallback === true || process.env.ZOS_ENABLE_LOCAL_AGENT_FALLBACK === "1";
    const turnMessage = continuation ? capabilityContinuationMessage(continuation.runs) : message.content;
    const result = shouldUseLocalFallback
      ? await runReadOnlyAgentTurn({
          session,
          root,
          message: turnMessage,
          emit: (event) => {
            appendEvent(db, {
              sessionId: session.id,
              jobId: job.id,
              type: event.type,
              payload: event.payload
            });
          },
          isCancelled,
          queryIndex: async (query, currentPath) => {
            try {
              return queryIndexedText(db, {
                rootId: root.id,
                query,
                path: currentPath,
                limit: 25
              });
            } catch {
              return [];
            }
          },
        })
      : await runPiAgentTurn({
          session,
          root,
          message: turnMessage,
          dataDir: config.dataDir,
          modelSettings: getModelProviderSettings(db) ?? defaultModelProviderSettings(config),
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
              payload: event.payload
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
              settingsSnapshot: providerSession.settingsSnapshot
            });
            providerSessionSavedThisTurn = providerSession.providerSessionId;
          },
          requestCapability: (request) => proposePiToolCapability({
            dependencies: { db, config },
            sessionId: session.id,
            rootId: root.id,
            request
          }),
          onCapabilityRunPending: (runId, providerSessionId) => {
            linkAgentJobToCapabilityRun(db, { jobId: job.id, runId, providerSessionId });
            updateJobStatus(db, job.id, "waiting_approval", null, ["running"]);
          },
          ...(config.mcp?.enabled && config.mcp.piEnabled ? {
            mcp: {
              enabled: true,
              url: `http://127.0.0.1:${config.api.port}/mcp`,
              tokenFile: config.mcp.piTokenFile,
              legacyToolsEnabled: config.mcp.legacyPiToolsEnabled
            }
          } : {}),
          ...photostaffAgentTools(db, root.id)
        });

    if (result.status === "cancelled" || getJob(db, job.id)?.status === "cancelled") {
      return true;
    }

    if (result.status === "failed") {
      const error = result.error ?? "Agent turn failed";
      if (providerSessionSavedThisTurn) {
        clearAgentProviderSession(db, session.id, providerSessionSavedThisTurn);
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
      updateJobStatus(db, job.id, "waiting_approval", null, ["running"]);
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
      clearAgentProviderSession(db, session.id, providerSessionSavedThisTurn);
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
    "Internal ZOS continuation. Do not repeat the user's original request.",
    "All capability runs requested by the previous turn reached terminal states:",
    JSON.stringify(outcomes),
    "Continue the same conversation using these results. Explain the outcomes briefly and only propose another change if it is still required."
  ].join("\n");
}

export function photostaffAgentTools(db: ZosDatabase, sessionRootId: string): { photostaffTools?: PhotostaffAgentToolService } {
  const settings = getPhotostaffLibrarySettings(db);
  if (!settings || settings.rootId !== sessionRootId) return {};
  return {
    photostaffTools: {
      searchPhotostaff: async (request) => {
        const safeRequest = {
          ...request,
          cursor: null,
          limit: Math.max(1, Math.min(request.limit ?? 25, 25)),
          includeFacets: false
        };
        const result = queryPhotostaffAssets(db, {
          libraryUpdatedAt: settings.updatedAt,
          request: safeRequest
        });
        return {
          photostaff: result.photostaff,
          nextCursor: null,
          total: result.total,
          facets: null,
          metadataIndex: getPhotostaffMetadataIndexStatus(db, settings.updatedAt)
        };
      },
      getPhotostaffMetadata: async (assetId) => getPhotostaffMetadataDetail(db, {
        assetId,
        libraryUpdatedAt: settings.updatedAt,
        includeSensitive: false
      })
    }
  };
}

function defaultModelProviderSettings(config: ZosConfig): ModelProviderSettingsRecord {
  return {
    providerName: "openai",
    baseUrl: config.model.localEndpoint,
    model: "",
    apiKey: null,
    updatedAt: new Date(0).toISOString()
  };
}
