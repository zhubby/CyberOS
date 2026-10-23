import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CapabilityError, type CapabilityExecution, type CapabilitySubject, type JsonValue } from "@zos/capabilities";
import {
  createCapabilityProposal,
  createTrashEntry,
  defaultAgentCapabilityPolicySettings,
  deleteCapabilityRunPayload,
  expireCapabilityApprovals,
  failInterruptedCapabilityRuns,
  getCapabilityApprovalByRun,
  getAgentCapabilityApproval,
  getAgentCapabilityPolicySettings,
  getCapabilityRun,
  getCapabilityRunPayload,
  getMcpClient,
  getNasRoot,
  getRootReadiness,
  listRunnableCapabilityRuns,
  queryIndexAdvanced,
  recordAppliedOperation,
  transitionCapabilityRun,
  type CapabilityRunRecord,
  type ZosDatabase
} from "@zos/db";
import {
  applyFileMutation,
  isPathInside,
  listDir,
  readText,
  resolveSafeExistingPath,
  resolveSafeTargetPath,
  statPath,
  toRootRelative
} from "@zos/nas-tools";
import type { AgentCapabilityId, FileMutationOperation, FileOperationProposal, NasRootRecord, ZosConfig } from "@zos/shared";

const FILE_MUTATION_CAPABILITY = "zos.files.mutate";
const PI_MCP_FILE_CAPABILITIES = [
  "zos.files.list",
  "zos.files.stat",
  "zos.files.read",
  "zos.files.search"
] as const;
const FILE_PROPOSAL_TTL_MS = 15 * 60_000;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);
const SUPPORTED_FILE_MUTATIONS = new Set<FileMutationOperation>(["mkdir", "move", "copy", "rename", "trash"]);

interface FileMutationRequest {
  operation: FileMutationOperation;
  rootId: string;
  sourcePath?: string;
  targetPath?: string;
}

interface StoredFileMutationProposal {
  kind: "file_mutation";
  request: FileMutationRequest;
  revision: string;
  summary: string;
}

export interface CapabilityRuntimeDependencies {
  db: ZosDatabase;
  config: ZosConfig;
}

export type PiToolCapabilityName = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";

export interface PiToolCapabilityRequest {
  toolCallId: string;
  toolName: PiToolCapabilityName;
  args: Record<string, unknown>;
  redactedArgs: Record<string, unknown>;
  previewArgs: Record<string, unknown>;
  risk: "low" | "medium" | "high" | "critical";
  summary: string;
  requiresConfirmation: boolean;
}

const PI_TOOL_CAPABILITIES: Record<PiToolCapabilityName, string> = {
  read: "zos.files.read",
  grep: "zos.files.grep",
  find: "zos.files.find",
  ls: "zos.files.list",
  bash: "zos.shell.run",
  edit: "zos.files.edit",
  write: "zos.files.write"
};

interface StoredPiToolPayload {
  kind: "pi_tool";
  rootId: string;
  toolCallId: string;
  toolName: PiToolCapabilityName;
  args: Record<string, JsonValue>;
  revision: string | null;
}

export type PiMcpFileCapabilityId = typeof PI_MCP_FILE_CAPABILITIES[number];

interface StoredPiMcpFilePayload {
  kind: "pi_mcp_file";
  capabilityId: PiMcpFileCapabilityId;
  input: Record<string, JsonValue>;
}

export async function proposePiToolCapability(input: {
  dependencies: CapabilityRuntimeDependencies;
  sessionId: string;
  rootId: string;
  request: PiToolCapabilityRequest;
}): Promise<CapabilityExecution> {
  const root = requireReadyRoot(input.dependencies.db, input.rootId);
  const revision = await validatePiToolRequest(root, input.request.toolName, input.request.args);
  const capabilityId = PI_TOOL_CAPABILITIES[input.request.toolName];
  const expiresAt = new Date(Date.now() + FILE_PROPOSAL_TTL_MS).toISOString();
  const payload: StoredPiToolPayload = {
    kind: "pi_tool",
    rootId: root.id,
    toolCallId: input.request.toolCallId,
    toolName: input.request.toolName,
    args: toJsonValue(input.request.args) as Record<string, JsonValue>,
    revision
  };
  const created = createCapabilityProposal(input.dependencies.db, {
    clientId: null,
    subjectId: input.sessionId,
    subjectKind: "pi",
    capabilityId,
    risk: input.request.risk,
    redactedInput: toJsonValue({
      toolCallId: input.request.toolCallId,
      args: input.request.redactedArgs
    }),
    proposal: toJsonValue({
      kind: "pi_tool",
      toolName: input.request.toolName,
      capabilityId,
      summary: input.request.summary,
      args: input.request.previewArgs,
      revision
    }),
    privatePayload: toJsonValue(payload),
    requiresConfirmation: input.request.requiresConfirmation,
    expiresAt
  });
  return {
    data: {
      state: created.run.state,
      approval: {
        id: created.approval.id,
        status: created.approval.status,
        revision: created.approval.revision,
        expiresAt: created.approval.expiresAt
      },
      proposal: { summary: input.request.summary }
    },
    runId: created.run.id
  };
}

export async function proposePiMcpFileCapability(input: {
  dependencies: CapabilityRuntimeDependencies;
  subject: CapabilitySubject;
  capabilityId: PiMcpFileCapabilityId;
  request: JsonValue;
  requiresConfirmation: boolean;
}): Promise<CapabilityExecution> {
  if (input.subject.kind !== "pi") {
    throw new CapabilityError("FORBIDDEN", "Only the built-in Pi agent can request file capability approval");
  }
  const request = requireJsonObject(input.request);
  await validatePiMcpFileCapability(input.dependencies, input.capabilityId, request);
  const summary = piMcpFileSummary(input.capabilityId, request);
  const expiresAt = new Date(Date.now() + FILE_PROPOSAL_TTL_MS).toISOString();
  const created = createCapabilityProposal(input.dependencies.db, {
    clientId: input.subject.clientId,
    subjectId: input.subject.id,
    subjectKind: "pi",
    capabilityId: input.capabilityId,
    risk: "low",
    redactedInput: toJsonValue(request),
    proposal: toJsonValue({
      kind: "pi_mcp_file",
      capabilityId: input.capabilityId,
      summary,
      args: request
    }),
    privatePayload: toJsonValue({
      kind: "pi_mcp_file",
      capabilityId: input.capabilityId,
      input: request
    } satisfies StoredPiMcpFilePayload),
    requiresConfirmation: input.requiresConfirmation,
    expiresAt
  });
  return {
    data: {
      state: created.run.state,
      approval: {
        id: created.approval.id,
        status: created.approval.status,
        revision: created.approval.revision,
        expiresAt: created.approval.expiresAt
      },
      proposal: { summary }
    },
    runId: created.run.id
  };
}

export async function proposeFileMutation(input: {
  dependencies: CapabilityRuntimeDependencies;
  subject: CapabilitySubject;
  request: JsonValue;
  idempotencyKey?: string;
  requiresConfirmation?: boolean;
}): Promise<CapabilityExecution> {
  if (input.subject.kind !== "pi") {
    throw new CapabilityError("FORBIDDEN", "Only the built-in Pi agent can request mutation approval");
  }
  const request = parseFileMutationRequest(input.request);
  const root = requireReadyRoot(input.dependencies.db, request.rootId);
  await validateFileMutation(root, request);
  const revision = await fileMutationRevision(root, request);
  const summary = fileMutationSummary(request);
  const proposal: StoredFileMutationProposal = { kind: "file_mutation", request, revision, summary };
  const expiresAt = new Date(Date.now() + FILE_PROPOSAL_TTL_MS).toISOString();
  let created;
  try {
    created = createCapabilityProposal(input.dependencies.db, {
      clientId: input.subject.clientId,
      subjectId: input.subject.id,
      subjectKind: input.subject.kind,
      capabilityId: FILE_MUTATION_CAPABILITY,
      risk: "high",
      redactedInput: toJsonValue({ request, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) }),
      proposal: toJsonValue(proposal),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      requiresConfirmation: input.requiresConfirmation === true,
      expiresAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to persist capability proposal";
    if (message.includes("Idempotency key conflicts")) throw new CapabilityError("CONFLICT", message, { cause: error });
    throw new CapabilityError("INTERNAL", "Failed to persist capability proposal", { cause: error });
  }
  return {
    data: {
      state: created.run.state,
      approval: {
        id: created.approval.id,
        status: created.approval.status,
        revision: created.approval.revision,
        expiresAt: created.approval.expiresAt
      },
      proposal: { summary, revision }
    },
    runId: created.run.id
  };
}

export async function executeApprovedCapabilityRun(
  dependencies: CapabilityRuntimeDependencies,
  runId: string
): Promise<CapabilityRunRecord> {
  const initial = getCapabilityRun(dependencies.db, runId);
  if (!initial) throw new Error("Capability run not found");
  if (initial.state !== "queued") return initial;

  try {
    const approval = getCapabilityApprovalByRun(dependencies.db, runId);
    if (!approval || approval.status !== "approved") {
      return failQueuedRun(dependencies.db, initial, "CONFLICT", "Capability run does not have an approved first-party decision");
    }
    if (initial.subjectKind !== "pi" || !getAgentCapabilityApproval(dependencies.db, approval.id)) {
      return failQueuedRun(dependencies.db, initial, "FORBIDDEN", "Approval is not linked to a Pi Agent conversation");
    }
    const policyCapabilityId = agentPolicyCapabilityId(initial.capabilityId);
    if (policyCapabilityId) {
      const policy = (getAgentCapabilityPolicySettings(dependencies.db) ?? defaultAgentCapabilityPolicySettings())
        .policies[policyCapabilityId];
      if (policy === "disabled") {
        return failQueuedRun(dependencies.db, initial, "FORBIDDEN", "Capability was disabled after approval was requested");
      }
      if (policy === "confirm" && !approval.requiresConfirmation) {
        return failQueuedRun(dependencies.db, initial, "CONFLICT", "Capability now requires a new confirmed approval");
      }
    }
    const client = initial.clientId ? getMcpClient(dependencies.db, initial.clientId) : null;
    const now = new Date().toISOString();
    if (initial.clientId && (!client || client.kind !== "pi" || client.revokedAt || (client.expiresAt && client.expiresAt <= now))) {
      return failQueuedRun(dependencies.db, initial, "FORBIDDEN", "Pi client credential is no longer active");
    }
    const payload = getCapabilityRunPayload(dependencies.db, initial.id);
    if (client) {
      const requiredScope = initial.capabilityId === FILE_MUTATION_CAPABILITY
        ? "zos:files:propose"
        : isStoredPiMcpFilePayload(payload) ? "zos:files:read" : null;
      if (requiredScope && !client.scopes.includes(requiredScope)) {
        return failQueuedRun(dependencies.db, initial, "FORBIDDEN", "Pi client no longer has the required scope");
      }
    }
    if (isStoredPiMcpFilePayload(payload)) {
      return executeApprovedPiMcpFileRun(dependencies, initial, payload);
    }
    if (isStoredPiToolPayload(payload)) {
      return executeApprovedPiToolRun(dependencies, initial);
    }
    if (initial.capabilityId !== FILE_MUTATION_CAPABILITY) {
      return failQueuedRun(dependencies.db, initial, "NOT_READY", "Capability execution adapter is not installed");
    }

    const proposal = parseStoredFileProposal(approval.proposal);
    const root = requireReadyRoot(dependencies.db, proposal.request.rootId);
    await validateFileMutation(root, proposal.request);
    const currentRevision = await fileMutationRevision(root, proposal.request);
    if (currentRevision !== proposal.revision) {
      return failQueuedRun(dependencies.db, initial, "CONFLICT", "File state changed after the proposal was created");
    }

    const running = transitionCapabilityRun(dependencies.db, {
      runId,
      expectedRevision: initial.revision,
      from: ["queued"],
      to: "running",
      progress: { phase: "executing" },
      cancellable: false
    });
    if (!running) return getCapabilityRun(dependencies.db, runId)!;

    try {
      const fileProposal = toFileOperationProposal(proposal.request, proposal.summary);
      const result = await applyFileMutation(root, fileProposal, path.join(dependencies.config.dataDir, "trash"));
      if (result.proposal.operation === "trash" && result.metadata.trashEntryId && result.targetPath) {
        createTrashEntry(dependencies.db, {
          id: String(result.metadata.trashEntryId),
          rootId: root.id,
          originalPath: result.sourcePath ?? proposal.request.sourcePath ?? ".",
          trashPath: path.join(dependencies.config.dataDir, "trash", result.targetPath),
          metadata: { capabilityRunId: runId }
        });
      }
      const operation = recordAppliedOperation(dependencies.db, {
        approvalId: null,
        operation: result.proposal.operation,
        sourcePath: result.sourcePath,
        targetPath: result.targetPath,
        status: "applied",
        metadata: {
          rootId: root.id,
          reversible: fileProposal.reversible,
          capabilityRunId: runId,
          ...(result.metadata.trashEntryId ? { trashEntryId: String(result.metadata.trashEntryId) } : {})
        }
      });
      const completed = transitionCapabilityRun(dependencies.db, {
        runId,
        expectedRevision: running.revision,
        from: ["running"],
        to: "succeeded",
        progress: { phase: "complete" },
        result: {
          operationId: operation.id,
          operation: operation.operation,
          sourcePath: operation.sourcePath,
          targetPath: operation.targetPath
        },
        domainOperationType: "file_operation",
        domainOperationId: operation.id,
        cancellable: false
      })!;
      deleteCapabilityRunPayload(dependencies.db, runId);
      return completed;
    } catch (error) {
      const failed = transitionCapabilityRun(dependencies.db, {
        runId,
        expectedRevision: running.revision,
        from: ["running"],
        to: "failed",
        errorCode: capabilityFailureCode(error),
        errorMessage: safeFailureMessage(error, dependencies),
        cancellable: false
      })!;
      deleteCapabilityRunPayload(dependencies.db, runId);
      return failed;
    }
  } catch (error) {
    const current = getCapabilityRun(dependencies.db, runId);
    if (!current || current.state !== "queued") return current ?? initial;
    return failQueuedRun(dependencies.db, current, capabilityFailureCode(error), safeFailureMessage(error, dependencies));
  }
}

export async function executeFileReadCapability(
  dependencies: Pick<CapabilityRuntimeDependencies, "db">,
  capabilityId: PiMcpFileCapabilityId,
  input: Record<string, JsonValue>
): Promise<CapabilityExecution> {
  const rootId = requiredText(input.rootId, "rootId");
  const root = requireReadyRoot(dependencies.db, rootId);
  switch (capabilityId) {
    case "zos.files.list": {
      const requestedPath = optionalText(input.path) ?? ".";
      const entries = await mapPathError(() => listDir(root, requestedPath));
      const limit = strictBoundedInteger(input.limit, 50, 1, 200);
      const offset = decodeFileOffsetCursor(optionalText(input.cursor), `${rootId}\0${requestedPath}`);
      const pageEntries = entries.slice(offset, offset + limit);
      const nextOffset = offset + pageEntries.length;
      return {
        data: { rootId, path: requestedPath, entries: toJsonValue(pageEntries) },
        page: {
          limit,
          nextCursor: nextOffset < entries.length
            ? encodeFileOffsetCursor(nextOffset, `${rootId}\0${requestedPath}`)
            : null
        }
      };
    }
    case "zos.files.stat": {
      const metadata = await mapPathError(() => statPath(root, requiredText(input.path, "path")));
      return { data: { rootId, stat: toJsonValue(metadata) } };
    }
    case "zos.files.read": {
      const maxBytes = strictBoundedInteger(input.maxBytes, 64 * 1024, 1, 128 * 1024);
      const preview = await mapPathError(() => readText(root, requiredText(input.path, "path"), maxBytes));
      return { data: { rootId, maxBytes, preview: toJsonValue(preview) } };
    }
    case "zos.files.search": {
      const limit = strictBoundedInteger(input.limit, 50, 1, 100);
      try {
        const page = queryIndexAdvanced(dependencies.db, {
          rootId,
          storagePoolId: rootId,
          path: optionalText(input.path) ?? ".",
          query: requiredText(input.query, "query"),
          cursor: optionalText(input.cursor) ?? null,
          limit
        });
        return {
          data: { rootId, files: toJsonValue(page.files) },
          page: { limit, nextCursor: page.nextCursor }
        };
      } catch (error) {
        if (error instanceof CapabilityError) throw error;
        throw new CapabilityError("INVALID_ARGUMENT", "File search request is invalid", { cause: error });
      }
    }
  }
}

export async function recoverCapabilityRuns(dependencies: CapabilityRuntimeDependencies): Promise<{
  expired: number;
  interrupted: number;
  resumed: number;
}> {
  const expired = expireCapabilityApprovals(dependencies.db);
  const interrupted = failInterruptedCapabilityRuns(dependencies.db);
  const runnable = listRunnableCapabilityRuns(dependencies.db);
  for (const run of runnable) await executeApprovedCapabilityRun(dependencies, run.id);
  return { expired, interrupted, resumed: runnable.length };
}

function parseFileMutationRequest(value: JsonValue): FileMutationRequest {
  if (!isRecord(value)) throw new CapabilityError("INVALID_ARGUMENT", "request must be an object");
  const operation = value.operation;
  const rootId = value.rootId;
  if (typeof operation !== "string" || !SUPPORTED_FILE_MUTATIONS.has(operation as FileMutationOperation)) {
    throw new CapabilityError("INVALID_ARGUMENT", "operation must be mkdir, move, copy, rename, or trash");
  }
  if (typeof rootId !== "string" || !rootId.trim() || rootId.length > 128) {
    throw new CapabilityError("INVALID_ARGUMENT", "rootId is required");
  }
  const allowed = new Set(["operation", "rootId", "sourcePath", "targetPath"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CapabilityError("INVALID_ARGUMENT", "request contains unsupported fields");
  }
  const sourcePath = optionalRelativePath(value.sourcePath, "sourcePath");
  const targetPath = optionalRelativePath(value.targetPath, "targetPath");
  if (operation === "mkdir" && (!targetPath || sourcePath)) {
    throw new CapabilityError("INVALID_ARGUMENT", "mkdir requires targetPath and does not accept sourcePath");
  }
  if (operation === "trash" && (!sourcePath || targetPath)) {
    throw new CapabilityError("INVALID_ARGUMENT", "trash requires sourcePath and does not accept targetPath");
  }
  if ((operation === "move" || operation === "copy" || operation === "rename") && (!sourcePath || !targetPath)) {
    throw new CapabilityError("INVALID_ARGUMENT", `${operation} requires sourcePath and targetPath`);
  }
  return { operation: operation as FileMutationOperation, rootId: rootId.trim(), ...(sourcePath ? { sourcePath } : {}), ...(targetPath ? { targetPath } : {}) };
}

function parseStoredFileProposal(value: JsonValue): StoredFileMutationProposal {
  if (!isRecord(value) || value.kind !== "file_mutation" || typeof value.revision !== "string" || typeof value.summary !== "string") {
    throw new CapabilityError("INTERNAL", "Stored file proposal is invalid");
  }
  return {
    kind: "file_mutation",
    request: parseFileMutationRequest(value.request ?? null),
    revision: value.revision,
    summary: value.summary
  };
}

function optionalRelativePath(value: JsonValue | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0") || path.isAbsolute(value)) {
    throw new CapabilityError("INVALID_ARGUMENT", `${field} must be a root-relative path`);
  }
  const normalized = path.normalize(value.trim());
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new CapabilityError("INVALID_ARGUMENT", `${field} must stay below the NAS root`);
  }
  return normalized;
}

function requireReadyRoot(db: ZosDatabase, rootId: string): NasRootRecord {
  const root = getNasRoot(db, rootId);
  if (!root || !root.enabled) throw new CapabilityError("INVALID_ARGUMENT", "NAS root not found");
  if (root.mountPolicy === "required") {
    const readiness = getRootReadiness(db, root.id);
    if (readiness?.status !== "ready") throw new CapabilityError("NOT_READY", "NAS root is not ready", { retryable: true });
  }
  return root;
}

async function validateFileMutation(root: NasRootRecord, request: FileMutationRequest): Promise<void> {
  if (request.sourcePath) {
    const source = await mapPathError(() => resolveSafeExistingPath(root.path, request.sourcePath!));
    const sourceLink = await mapPathError(() => lstat(source.absolutePath));
    if (sourceLink.isSymbolicLink()) throw new CapabilityError("INVALID_ARGUMENT", "Refusing to mutate through a symlink");
  }
  if (request.targetPath) {
    const target = await mapPathError(() => resolveSafeTargetPath(root.path, request.targetPath!));
    try {
      await lstat(target.absolutePath);
      throw new CapabilityError("CONFLICT", "Mutation target already exists");
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CapabilityError("INVALID_ARGUMENT", "NAS path is invalid or unavailable", { cause: error });
      }
    }
    const parent = await mapPathError(() => resolveSafeExistingPath(root.path, path.dirname(target.relativePath)));
    const parentStat = await mapPathError(() => stat(parent.realPath));
    if (!parentStat.isDirectory()) throw new CapabilityError("INVALID_ARGUMENT", "Mutation target parent must be a directory");
  }
}

async function fileMutationRevision(root: NasRootRecord, request: FileMutationRequest): Promise<string> {
  const state: Record<string, unknown> = { operation: request.operation, rootId: root.id };
  if (request.sourcePath) {
    const source = await mapPathError(() => resolveSafeExistingPath(root.path, request.sourcePath!));
    const sourceStat = await mapPathError(() => stat(source.realPath));
    state.source = { path: source.relativePath, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, ino: sourceStat.ino, mode: sourceStat.mode };
  }
  if (request.targetPath) {
    const target = await mapPathError(() => resolveSafeTargetPath(root.path, request.targetPath!));
    const parent = await mapPathError(() => resolveSafeExistingPath(root.path, path.dirname(target.relativePath)));
    const parentStat = await mapPathError(() => stat(parent.realPath));
    state.target = { path: target.relativePath, exists: false, parentMtimeMs: parentStat.mtimeMs, parentIno: parentStat.ino };
  }
  return createHash("sha256").update(JSON.stringify(state)).digest("base64url");
}

function fileMutationSummary(request: FileMutationRequest): string {
  switch (request.operation) {
    case "mkdir": return `Create folder ${request.targetPath}`;
    case "trash": return `Move ${request.sourcePath} to ZOS trash`;
    case "move": return `Move ${request.sourcePath} to ${request.targetPath}`;
    case "copy": return `Copy ${request.sourcePath} to ${request.targetPath}`;
    case "rename": return `Rename ${request.sourcePath} to ${request.targetPath}`;
    default: throw new CapabilityError("INVALID_ARGUMENT", "Unsupported file mutation");
  }
}

function toFileOperationProposal(request: FileMutationRequest, summary: string): FileOperationProposal {
  return {
    operation: request.operation,
    rootId: request.rootId,
    ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
    ...(request.targetPath ? { targetPath: request.targetPath } : {}),
    risk: request.operation === "mkdir" ? "low" : "medium",
    reversible: true,
    summary
  };
}

async function executeApprovedPiToolRun(
  dependencies: CapabilityRuntimeDependencies,
  initial: CapabilityRunRecord
): Promise<CapabilityRunRecord> {
  const payload = parseStoredPiToolPayload(getCapabilityRunPayload(dependencies.db, initial.id));
  const root = requireReadyRoot(dependencies.db, payload.rootId);
  const currentRevision = await validatePiToolRequest(root, payload.toolName, payload.args);
  if (payload.revision !== currentRevision) {
    deleteCapabilityRunPayload(dependencies.db, initial.id);
    return failQueuedRun(dependencies.db, initial, "CONFLICT", "File state changed after approval was requested");
  }

  const running = transitionCapabilityRun(dependencies.db, {
    runId: initial.id,
    expectedRevision: initial.revision,
    from: ["queued"],
    to: "running",
    progress: { phase: "executing" },
    cancellable: false
  });
  if (!running) return getCapabilityRun(dependencies.db, initial.id)!;

  try {
    const result = await executePiTool(root, payload.toolName, payload.args);
    let operationId: string | null = null;
    if (payload.toolName === "edit" || payload.toolName === "write") {
      const requestedPath = requiredText(payload.args.path, "path");
      const operation = recordAppliedOperation(dependencies.db, {
        approvalId: null,
        operation: "edit",
        sourcePath: requestedPath,
        targetPath: requestedPath,
        status: "applied",
        metadata: {
          rootId: root.id,
          capabilityRunId: initial.id,
          toolName: payload.toolName,
          reversible: false
        }
      });
      operationId = operation.id;
    }
    const completed = transitionCapabilityRun(dependencies.db, {
      runId: initial.id,
      expectedRevision: running.revision,
      from: ["running"],
      to: "succeeded",
      progress: { phase: "complete" },
      result: toJsonValue(result),
      ...(operationId ? { domainOperationType: "file_operation", domainOperationId: operationId } : {}),
      cancellable: false
    })!;
    deleteCapabilityRunPayload(dependencies.db, initial.id);
    return completed;
  } catch (error) {
    const failed = transitionCapabilityRun(dependencies.db, {
      runId: initial.id,
      expectedRevision: running.revision,
      from: ["running"],
      to: "failed",
      errorCode: capabilityFailureCode(error),
      errorMessage: safeFailureMessage(error, dependencies),
      cancellable: false
    })!;
    deleteCapabilityRunPayload(dependencies.db, initial.id);
    return failed;
  }
}

async function executeApprovedPiMcpFileRun(
  dependencies: CapabilityRuntimeDependencies,
  initial: CapabilityRunRecord,
  payload: StoredPiMcpFilePayload
): Promise<CapabilityRunRecord> {
  await validatePiMcpFileCapability(dependencies, payload.capabilityId, payload.input);
  const running = transitionCapabilityRun(dependencies.db, {
    runId: initial.id,
    expectedRevision: initial.revision,
    from: ["queued"],
    to: "running",
    progress: { phase: "executing" },
    cancellable: false
  });
  if (!running) return getCapabilityRun(dependencies.db, initial.id)!;

  try {
    const result = await executeFileReadCapability(dependencies, payload.capabilityId, payload.input);
    const completed = transitionCapabilityRun(dependencies.db, {
      runId: initial.id,
      expectedRevision: running.revision,
      from: ["running"],
      to: "succeeded",
      progress: { phase: "complete" },
      result: toJsonValue(result),
      cancellable: false
    })!;
    deleteCapabilityRunPayload(dependencies.db, initial.id);
    return completed;
  } catch (error) {
    const failed = transitionCapabilityRun(dependencies.db, {
      runId: initial.id,
      expectedRevision: running.revision,
      from: ["running"],
      to: "failed",
      errorCode: capabilityFailureCode(error),
      errorMessage: safeFailureMessage(error, dependencies),
      cancellable: false
    })!;
    deleteCapabilityRunPayload(dependencies.db, initial.id);
    return failed;
  }
}

function parseStoredPiToolPayload(value: JsonValue | null): StoredPiToolPayload {
  if (!isRecord(value) || value.kind !== "pi_tool") {
    throw new CapabilityError("INTERNAL", "Stored Agent capability payload is missing");
  }
  const toolName = value.toolName;
  if (typeof toolName !== "string" || !(toolName in PI_TOOL_CAPABILITIES)) {
    throw new CapabilityError("INTERNAL", "Stored Agent tool is invalid");
  }
  if (typeof value.rootId !== "string" || typeof value.toolCallId !== "string" || !isRecord(value.args)) {
    throw new CapabilityError("INTERNAL", "Stored Agent capability payload is invalid");
  }
  return {
    kind: "pi_tool",
    rootId: value.rootId,
    toolCallId: value.toolCallId,
    toolName: toolName as PiToolCapabilityName,
    args: value.args,
    revision: typeof value.revision === "string" ? value.revision : null
  };
}

function isStoredPiToolPayload(value: JsonValue | null): value is JsonValue & StoredPiToolPayload {
  return isRecord(value) && value.kind === "pi_tool";
}

function isStoredPiMcpFilePayload(value: JsonValue | null): value is JsonValue & StoredPiMcpFilePayload {
  return isRecord(value)
    && value.kind === "pi_mcp_file"
    && typeof value.capabilityId === "string"
    && PI_MCP_FILE_CAPABILITIES.includes(value.capabilityId as PiMcpFileCapabilityId)
    && isRecord(value.input);
}

async function validatePiMcpFileCapability(
  dependencies: CapabilityRuntimeDependencies,
  capabilityId: PiMcpFileCapabilityId,
  input: Record<string, JsonValue>
): Promise<void> {
  const root = requireReadyRoot(dependencies.db, requiredText(input.rootId, "rootId"));
  switch (capabilityId) {
    case "zos.files.list":
      strictBoundedInteger(input.limit, 50, 1, 200);
      decodeFileOffsetCursor(optionalText(input.cursor), `${root.id}\0${optionalText(input.path) ?? "."}`);
      await mapPathError(() => resolveSafeExistingPath(root.path, optionalText(input.path) ?? "."));
      return;
    case "zos.files.stat":
      await mapPathError(() => resolveSafeExistingPath(root.path, requiredText(input.path, "path")));
      return;
    case "zos.files.read":
      strictBoundedInteger(input.maxBytes, 64 * 1024, 1, 128 * 1024);
      await mapPathError(() => resolveSafeExistingPath(root.path, requiredText(input.path, "path")));
      return;
    case "zos.files.search":
      requiredText(input.query, "query");
      strictBoundedInteger(input.limit, 50, 1, 100);
      if (optionalText(input.path)) {
        await mapPathError(() => resolveSafeExistingPath(root.path, optionalText(input.path)!));
      }
  }
}

function piMcpFileSummary(capabilityId: PiMcpFileCapabilityId, input: Record<string, JsonValue>): string {
  const requestedPath = optionalText(input.path) ?? ".";
  switch (capabilityId) {
    case "zos.files.list": return `List ${requestedPath}`;
    case "zos.files.stat": return `Inspect ${requestedPath}`;
    case "zos.files.read": return `Read ${requestedPath}`;
    case "zos.files.search": return `Search ${requestedPath}`;
  }
}

function agentPolicyCapabilityId(capabilityId: string): AgentCapabilityId | null {
  switch (capabilityId) {
    case "zos.files.list": return "zos.files.list";
    case "zos.files.stat":
    case "zos.files.read": return "zos.files.read";
    case "zos.files.search": return "zos.files.search";
    case "zos.files.grep": return "zos.files.grep";
    case "zos.files.find": return "zos.files.find";
    case FILE_MUTATION_CAPABILITY: return FILE_MUTATION_CAPABILITY;
    case "zos.files.edit": return "zos.files.edit";
    case "zos.files.write": return "zos.files.write";
    case "zos.shell.run": return "zos.shell.run";
    default: return null;
  }
}

async function validatePiToolRequest(
  root: NasRootRecord,
  toolName: PiToolCapabilityName,
  args: Record<string, unknown>
): Promise<string | null> {
  switch (toolName) {
    case "read":
    case "grep":
    case "find":
    case "ls": {
      await resolveSafeExistingPath(root.path, optionalText(args.path) ?? ".");
      return null;
    }
    case "bash": {
      const command = requiredText(args.command, "command");
      if (Buffer.byteLength(command, "utf8") > 64 * 1024) throw new CapabilityError("INVALID_ARGUMENT", "command is too large");
      return null;
    }
    case "edit": {
      const edits = parseEdits(args.edits);
      const preview = await buildEditPreview(root, requiredText(args.path, "path"), edits);
      return createHash("sha256").update(await readFile(preview.absolutePath)).digest("base64url");
    }
    case "write": {
      const target = await assertSafeWriteTarget(root, requiredText(args.path, "path"));
      requiredText(args.content, "content", true);
      return targetRevision(target.absolutePath);
    }
  }
}

async function executePiTool(
  root: NasRootRecord,
  toolName: PiToolCapabilityName,
  args: Record<string, JsonValue>
): Promise<Record<string, JsonValue>> {
  switch (toolName) {
    case "read": {
      const preview = await readText(root, requiredText(args.path, "path"), MAX_TOOL_OUTPUT_BYTES);
      const content = sliceLines(preview.content, optionalInteger(args.offset), optionalInteger(args.limit));
      return { text: truncateText(content + (preview.truncated ? "\n\n[Output truncated]" : "")), truncated: preview.truncated };
    }
    case "ls": {
      const entries = await listDir(root, optionalText(args.path) ?? ".");
      const limit = boundedLimit(args.limit, 100, 1_000);
      return {
        text: entries.slice(0, limit).map((entry) => `${entry.kind.padEnd(9)} ${entry.path}`).join("\n") || "(empty)",
        truncated: entries.length > limit
      };
    }
    case "find": {
      const limit = boundedLimit(args.limit, 100, 1_000);
      const matches = await globNasRoot(root, optionalText(args.path) ?? ".", requiredText(args.pattern, "pattern"), limit);
      return { text: matches.join("\n") || "No matches.", truncated: matches.length >= limit };
    }
    case "grep": {
      const limit = boundedLimit(args.limit, 100, 1_000);
      const matches = await grepNasRoot(root, {
        pattern: requiredText(args.pattern, "pattern"),
        path: optionalText(args.path) ?? ".",
        ignoreCase: args.ignoreCase === true,
        literal: args.literal === true,
        limit
      });
      return { text: truncateText(matches.join("\n") || "No matches."), truncated: matches.length >= limit };
    }
    case "bash": {
      const command = requiredText(args.command, "command");
      const timeout = boundedLimit(args.timeout, 120_000, 600_000);
      try {
        const result = await execFileAsync("/bin/bash", ["-lc", command], {
          cwd: root.path,
          env: safeShellEnvironment(root.path),
          timeout,
          maxBuffer: MAX_TOOL_OUTPUT_BYTES
        });
        return { text: truncateText(`${result.stdout}${result.stderr}`) || "Command completed." };
      } catch (error) {
        const processError = error as Error & { stdout?: string; stderr?: string };
        const output = truncateText(`${processError.stdout ?? ""}${processError.stderr ?? ""}`.trim());
        throw new Error(output || "Shell command failed");
      }
    }
    case "edit": {
      const requestedPath = requiredText(args.path, "path");
      const preview = await buildEditPreview(root, requestedPath, parseEdits(args.edits));
      await writeFile(preview.absolutePath, preview.content, "utf8");
      return { text: `Edited ${preview.relativePath}.` };
    }
    case "write": {
      const target = await assertSafeWriteTarget(root, requiredText(args.path, "path"));
      await mkdir(path.dirname(target.absolutePath), { recursive: true });
      await writeFile(target.absolutePath, requiredText(args.content, "content", true), "utf8");
      return { text: `Wrote ${target.relativePath}.` };
    }
  }
}

async function grepNasRoot(
  root: NasRootRecord,
  input: { pattern: string; path: string; ignoreCase: boolean; literal: boolean; limit: number }
): Promise<string[]> {
  const safe = await resolveSafeExistingPath(root.path, input.path);
  const matcher = input.literal
    ? (line: string) => (input.ignoreCase ? line.toLocaleLowerCase() : line)
        .includes(input.ignoreCase ? input.pattern.toLocaleLowerCase() : input.pattern)
    : (line: string) => new RegExp(input.pattern, input.ignoreCase ? "i" : undefined).test(line);
  const matches: string[] = [];
  async function visit(absolutePath: string): Promise<void> {
    if (matches.length >= input.limit) return;
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink()) return;
    if (entryStat.isDirectory()) {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await visit(path.join(absolutePath, entry.name));
        if (matches.length >= input.limit) return;
      }
      return;
    }
    if (!entryStat.isFile()) return;
    const relativePath = toRootRelative(safe.rootRealPath, absolutePath);
    const preview = await readText(root, relativePath, 256 * 1024);
    preview.content.split("\n").forEach((line, index) => {
      if (matches.length < input.limit && matcher(line)) matches.push(`${relativePath}:${index + 1}:${line}`);
    });
  }
  await visit(safe.realPath);
  return matches;
}

async function globNasRoot(root: NasRootRecord, requestedPath: string, pattern: string, limit: number): Promise<string[]> {
  if (!pattern.trim() || pattern.includes("\0")) throw new CapabilityError("INVALID_ARGUMENT", "pattern must be a non-empty glob");
  const safe = await resolveSafeExistingPath(root.path, requestedPath);
  const matches: string[] = [];
  async function visit(absolutePath: string): Promise<void> {
    if (matches.length >= limit) return;
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink()) return;
    const relativePath = path.relative(safe.realPath, absolutePath).split(path.sep).join("/");
    if (relativePath && (path.matchesGlob(relativePath, pattern) || (!pattern.includes("/") && path.matchesGlob(path.posix.basename(relativePath), pattern)))) {
      matches.push(relativePath);
    }
    if (!entryStat.isDirectory()) return;
    const entries = await readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      await visit(path.join(absolutePath, entry.name));
      if (matches.length >= limit) return;
    }
  }
  await visit(safe.realPath);
  return matches;
}

async function buildEditPreview(
  root: NasRootRecord,
  requestedPath: string,
  edits: Array<{ oldText: string; newText: string }>
): Promise<{ absolutePath: string; relativePath: string; content: string }> {
  const safe = await resolveSafeExistingPath(root.path, requestedPath);
  let content = await readFile(safe.realPath, "utf8");
  for (const edit of edits) {
    if (!edit.oldText) throw new CapabilityError("INVALID_ARGUMENT", "edit oldText cannot be empty");
    if (!content.includes(edit.oldText)) throw new CapabilityError("CONFLICT", `edit oldText was not found in ${safe.relativePath}`);
    content = content.replace(edit.oldText, edit.newText);
  }
  return { absolutePath: safe.realPath, relativePath: safe.relativePath, content };
}

async function assertSafeWriteTarget(root: NasRootRecord, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
  const target = await resolveSafeTargetPath(root.path, requestedPath);
  let current = path.dirname(target.absolutePath);
  while (current && current !== path.dirname(current)) {
    try {
      const currentRealPath = await realpath(current);
      if (!isPathInside(target.rootRealPath, currentRealPath)) throw new CapabilityError("INVALID_ARGUMENT", "Mutation target parent escapes the NAS root");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = path.dirname(current);
    }
  }
  try {
    const targetStat = await lstat(target.absolutePath);
    if (targetStat.isSymbolicLink()) throw new CapabilityError("INVALID_ARGUMENT", "Refusing to write through a symlink");
    if (!isPathInside(target.rootRealPath, await realpath(target.absolutePath))) {
      throw new CapabilityError("INVALID_ARGUMENT", "Mutation target escapes the NAS root");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { absolutePath: target.absolutePath, relativePath: target.relativePath };
}

async function targetRevision(absolutePath: string): Promise<string> {
  try {
    const info = await stat(absolutePath);
    return createHash("sha256").update(JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs, ino: info.ino })).digest("base64url");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function parseEdits(value: unknown): Array<{ oldText: string; newText: string }> {
  if (!Array.isArray(value) || value.length === 0) throw new CapabilityError("INVALID_ARGUMENT", "edits are required");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new CapabilityError("INVALID_ARGUMENT", "edit is invalid");
    const record = entry as Record<string, unknown>;
    return { oldText: requiredText(record.oldText, "oldText", true), newText: requiredText(record.newText, "newText", true) };
  });
}

function requiredText(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new CapabilityError("INVALID_ARGUMENT", `${field} is required`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  return Math.max(1, Math.min(optionalInteger(value) ?? fallback, maximum));
}

function strictBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CapabilityError("INVALID_ARGUMENT", `Integer must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireJsonObject(value: JsonValue): Record<string, JsonValue> {
  if (!isRecord(value)) throw new CapabilityError("INVALID_ARGUMENT", "Tool input must be an object");
  return value;
}

function encodeFileOffsetCursor(offset: number, signatureInput: string): string {
  const signature = createHash("sha256").update(signatureInput).digest("base64url").slice(0, 16);
  return Buffer.from(JSON.stringify({ v: 1, offset, signature }), "utf8").toString("base64url");
}

function decodeFileOffsetCursor(cursor: string | undefined, signatureInput: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      offset?: unknown;
      signature?: unknown;
    };
    const signature = createHash("sha256").update(signatureInput).digest("base64url").slice(0, 16);
    if (
      parsed.v !== 1
      || !Number.isInteger(parsed.offset)
      || Number(parsed.offset) < 0
      || parsed.signature !== signature
    ) {
      throw new Error("invalid cursor");
    }
    return Number(parsed.offset);
  } catch {
    throw new CapabilityError("INVALID_ARGUMENT", "Invalid cursor");
  }
}

function sliceLines(content: string, offset?: number, limit?: number): string {
  const lines = content.split("\n");
  const start = offset ? Math.max(0, offset - 1) : 0;
  return lines.slice(start, limit ? start + Math.max(0, limit) : lines.length).join("\n");
}

function truncateText(text: string): string {
  return Buffer.byteLength(text, "utf8") <= MAX_TOOL_OUTPUT_BYTES
    ? text
    : `${text.slice(0, MAX_TOOL_OUTPUT_BYTES)}\n\n[Output truncated]`;
}

function safeShellEnvironment(cwd: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { HOME: cwd, PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/tmp" };
  for (const name of ["LANG", "LC_ALL", "TZ"] as const) {
    const value = process.env[name];
    if (value && /^[A-Za-z0-9_+./:@-]{1,128}$/u.test(value)) environment[name] = value;
  }
  return environment;
}

function failQueuedRun(
  db: ZosDatabase,
  run: CapabilityRunRecord,
  errorCode: "INVALID_ARGUMENT" | "FORBIDDEN" | "NOT_READY" | "CONFLICT" | "INTERNAL",
  errorMessage: string
): CapabilityRunRecord {
  const failed = transitionCapabilityRun(db, {
    runId: run.id,
    expectedRevision: run.revision,
    from: ["queued"],
    to: "failed",
    errorCode,
    errorMessage,
    cancellable: false
  });
  if (failed) deleteCapabilityRunPayload(db, run.id);
  return failed ?? getCapabilityRun(db, run.id)!;
}

function capabilityFailureCode(error: unknown): "INVALID_ARGUMENT" | "FORBIDDEN" | "NOT_READY" | "CONFLICT" | "INTERNAL" {
  if (error instanceof CapabilityError) {
    if (error.code === "INVALID_ARGUMENT" || error.code === "FORBIDDEN" || error.code === "NOT_READY" || error.code === "CONFLICT") return error.code;
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EEXIST" || code === "ENOTEMPTY") return "CONFLICT";
  if (code === "ENOENT") return "INVALID_ARGUMENT";
  return "INTERNAL";
}

function safeFailureMessage(error: unknown, dependencies: CapabilityRuntimeDependencies): string {
  const raw = error instanceof Error ? error.message : "Capability execution failed";
  return raw
    .replaceAll(dependencies.config.dataDir, "[state]")
    .replaceAll(dependencies.config.rootDir ?? "__no_root__", "[zos]")
    .replaceAll(/\/(?:[^\s/]+\/)+[^\s]*/gu, "[path]")
    .slice(0, 500);
}

async function mapPathError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("INVALID_ARGUMENT", "NAS path is invalid or unavailable", { cause: error });
  }
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
