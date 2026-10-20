import { createHash } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import { CapabilityError, type CapabilityExecution, type CapabilitySubject, type JsonValue } from "@zos/capabilities";
import {
  createCapabilityProposal,
  createTrashEntry,
  expireCapabilityApprovals,
  failInterruptedCapabilityRuns,
  getCapabilityApprovalByRun,
  getCapabilityRun,
  getMcpClient,
  getNasRoot,
  getRootReadiness,
  listRunnableCapabilityRuns,
  recordAppliedOperation,
  transitionCapabilityRun,
  type CapabilityRunRecord,
  type ZosDatabase
} from "@zos/db";
import { applyFileMutation, resolveSafeExistingPath, resolveSafeTargetPath } from "@zos/nas-tools";
import type { FileMutationOperation, FileOperationProposal, NasRootRecord, ZosConfig } from "@zos/shared";

const FILE_MUTATION_CAPABILITY = "zos.files.mutate-propose";
const FILE_PROPOSAL_TTL_MS = 15 * 60_000;
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

export async function proposeFileMutation(input: {
  dependencies: CapabilityRuntimeDependencies;
  subject: CapabilitySubject;
  request: JsonValue;
  idempotencyKey?: string;
}): Promise<CapabilityExecution> {
  if (input.subject.kind === "system") throw new CapabilityError("FORBIDDEN", "System subjects cannot create MCP proposals");
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
    const client = initial.clientId ? getMcpClient(dependencies.db, initial.clientId) : null;
    const now = new Date().toISOString();
    if (!client || client.revokedAt || (client.expiresAt && client.expiresAt <= now)) {
      return failQueuedRun(dependencies.db, initial, "FORBIDDEN", "Client credential is no longer active");
    }
    if (!client.scopes.includes("zos:files:propose")) {
      return failQueuedRun(dependencies.db, initial, "FORBIDDEN", "Client no longer has the required scope");
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
      return transitionCapabilityRun(dependencies.db, {
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
    } catch (error) {
      return transitionCapabilityRun(dependencies.db, {
        runId,
        expectedRevision: running.revision,
        from: ["running"],
        to: "failed",
        errorCode: capabilityFailureCode(error),
        errorMessage: safeFailureMessage(error, dependencies),
        cancellable: false
      })!;
    }
  } catch (error) {
    const current = getCapabilityRun(dependencies.db, runId);
    if (!current || current.state !== "queued") return current ?? initial;
    return failQueuedRun(dependencies.db, current, capabilityFailureCode(error), safeFailureMessage(error, dependencies));
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
    const sourceLink = await lstat(source.absolutePath);
    if (sourceLink.isSymbolicLink()) throw new CapabilityError("INVALID_ARGUMENT", "Refusing to mutate through a symlink");
  }
  if (request.targetPath) {
    const target = await mapPathError(() => resolveSafeTargetPath(root.path, request.targetPath!));
    try {
      await lstat(target.absolutePath);
      throw new CapabilityError("CONFLICT", "Mutation target already exists");
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = await mapPathError(() => resolveSafeExistingPath(root.path, path.dirname(target.relativePath)));
    const parentStat = await stat(parent.realPath);
    if (!parentStat.isDirectory()) throw new CapabilityError("INVALID_ARGUMENT", "Mutation target parent must be a directory");
  }
}

async function fileMutationRevision(root: NasRootRecord, request: FileMutationRequest): Promise<string> {
  const state: Record<string, unknown> = { operation: request.operation, rootId: root.id };
  if (request.sourcePath) {
    const source = await resolveSafeExistingPath(root.path, request.sourcePath);
    const sourceStat = await stat(source.realPath);
    state.source = { path: source.relativePath, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, ino: sourceStat.ino, mode: sourceStat.mode };
  }
  if (request.targetPath) {
    const target = await resolveSafeTargetPath(root.path, request.targetPath);
    const parent = await resolveSafeExistingPath(root.path, path.dirname(target.relativePath));
    const parentStat = await stat(parent.realPath);
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

function failQueuedRun(
  db: ZosDatabase,
  run: CapabilityRunRecord,
  errorCode: "INVALID_ARGUMENT" | "FORBIDDEN" | "NOT_READY" | "CONFLICT" | "INTERNAL",
  errorMessage: string
): CapabilityRunRecord {
  return transitionCapabilityRun(db, {
    runId: run.id,
    expectedRevision: run.revision,
    from: ["queued"],
    to: "failed",
    errorCode,
    errorMessage,
    cancellable: false
  }) ?? getCapabilityRun(db, run.id)!;
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
