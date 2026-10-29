import { createHash } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import {
  CapabilityError,
  createCatalogDescriptors,
  type CapabilityExecution,
  type CapabilitySubject,
  type JsonValue
} from "@cyberos/capabilities";
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
  listRunnableCapabilityRuns,
  queryIndexAdvanced,
  recordAppliedOperation,
  transitionCapabilityRun,
  type CapabilityRunRecord,
  type CyberOsDatabase
} from "@cyberos/db";
import {
  applyFileMutation,
  listDir,
  readText,
  resolveSafeExistingPath,
  resolveSafeTargetPath,
  statPath
} from "@cyberos/storage-tools";
import type { AgentCapabilityId, FileMutationOperation, FileOperationProposal, CyberOsRuntime } from "@cyberos/shared";
import {
  isStoredCapabilityAdapterPayload,
  parseStoredCapabilityAdapterProposal,
  validateCapabilitySecretInput,
  type CapabilityAdapterContext,
  type CapabilityDomainAdapter,
  type PreparedCapabilityAction,
  type StoredCapabilityAdapterPayload,
  type StoredCapabilityAdapterProposal
} from "./adapters.js";
import { executeExtendedFileReadCapability } from "./file-read.js";
import {
  requireStoragePool,
  type ResolvedStoragePool
} from "./storage-pools.js";

const FILE_MUTATION_CAPABILITY = "cyberos.files.mutate";
const PI_MCP_FILE_CAPABILITIES = [
  "cyberos.files.list",
  "cyberos.files.stat",
  "cyberos.files.read",
  "cyberos.files.search",
  "cyberos.files.grep",
  "cyberos.files.find",
  "cyberos.files.git",
  "cyberos.files.archive-inspect"
] as const;
const FILE_PROPOSAL_TTL_MS = 15 * 60_000;
const SUPPORTED_FILE_MUTATIONS = new Set<FileMutationOperation>(["mkdir", "move", "copy", "rename", "trash"]);

interface FileMutationRequest {
  operation: FileMutationOperation;
  storagePoolId: string;
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
  db: CyberOsDatabase;
  config: CyberOsRuntime;
  adapters?: Readonly<Record<string, CapabilityDomainAdapter>>;
}

export type PiMcpFileCapabilityId = typeof PI_MCP_FILE_CAPABILITIES[number];

interface StoredPiMcpFilePayload {
  kind: "pi_mcp_file";
  capabilityId: PiMcpFileCapabilityId;
  input: Record<string, JsonValue>;
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
  const root = requireStoragePool(input.dependencies.config, request.storagePoolId);
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

export async function proposeDomainCapability(input: {
  dependencies: CapabilityRuntimeDependencies;
  subject: CapabilitySubject;
  capabilityId: string;
  request: JsonValue;
  idempotencyKey?: string;
  requiresConfirmation?: boolean;
}): Promise<CapabilityExecution> {
  if (input.subject.kind !== "pi") {
    throw new CapabilityError("FORBIDDEN", "Only the built-in Pi agent can request capability approval");
  }
  const descriptor = createCatalogDescriptors().find((item) => item.id === input.capabilityId);
  if (!descriptor || descriptor.risk === "read" || descriptor.approval === "none" || descriptor.approval === "owner_control") {
    throw new CapabilityError("INVALID_ARGUMENT", "Capability does not support a mutation proposal");
  }
  rejectSecretLikeFields(input.request);
  const adapter = input.dependencies.adapters?.[input.capabilityId];
  if (!adapter) throw new CapabilityError("NOT_READY", "Domain adapter is not installed", { retryable: true });
  const context = adapterContext(input.dependencies, input.subject, input.capabilityId);
  await requireAdapterAvailability(adapter, context);
  let prepared: PreparedCapabilityAction;
  try {
    prepared = await adapter.prepare(input.request, context);
  } catch (error) {
    throw adapterError(error, "Capability request could not be prepared");
  }
  validatePreparedAction(prepared);
  const proposal: StoredCapabilityAdapterProposal = {
    kind: "domain_adapter",
    version: 1,
    capabilityId: input.capabilityId,
    title: descriptor.title,
    summary: prepared.summary,
    target: prepared.target ?? null,
    changes: prepared.changes ?? null,
    revision: prepared.revision ?? null,
    risk: descriptor.risk,
    requiredSecrets: prepared.requiredSecrets ?? []
  };
  const payload: StoredCapabilityAdapterPayload = {
    kind: "domain_adapter",
    version: 1,
    capabilityId: input.capabilityId,
    prepared
  };
  const expiresAt = new Date(Date.now() + FILE_PROPOSAL_TTL_MS).toISOString();
  let created;
  try {
    created = createCapabilityProposal(input.dependencies.db, {
      clientId: input.subject.clientId,
      subjectId: input.subject.id,
      subjectKind: "pi",
      capabilityId: input.capabilityId,
      risk: descriptor.risk,
      redactedInput: toJsonValue({
        request: input.request,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
      }),
      proposal: toJsonValue(proposal),
      privatePayload: toJsonValue(payload),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      requiresConfirmation: input.requiresConfirmation === true || descriptor.approval === "first_party_confirm",
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
      proposal: {
        summary: proposal.summary,
        target: proposal.target,
        changes: proposal.changes,
        revision: proposal.revision,
        requiredSecrets: proposal.requiredSecrets.map(({ name, label, description }) => ({
          name,
          label,
          ...(description ? { description } : {})
        }))
      }
    },
    runId: created.run.id
  };
}

export async function executeApprovedCapabilityRun(
  dependencies: CapabilityRuntimeDependencies,
  runId: string,
  options: { secretInput?: unknown } = {}
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
      const requiredScope = requiredScopeForCapability(initial.capabilityId, payload);
      if (requiredScope && !client.scopes.includes(requiredScope)) {
        return failQueuedRun(dependencies.db, initial, "FORBIDDEN", "Pi client no longer has the required scope");
      }
    }
    if (isStoredPiMcpFilePayload(payload)) {
      return executeApprovedPiMcpFileRun(dependencies, initial, payload);
    }
    if (isStoredCapabilityAdapterPayload(payload)) {
      return executeApprovedDomainAdapterRun(dependencies, initial, payload, options.secretInput);
    }
    if (initial.capabilityId !== FILE_MUTATION_CAPABILITY) {
      return failQueuedRun(dependencies.db, initial, "NOT_READY", "Capability execution adapter is not installed");
    }

    const proposal = parseStoredFileProposal(approval.proposal);
    const root = requireStoragePool(dependencies.config, proposal.request.storagePoolId);
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
      const result = await applyFileMutation(root, fileProposal, path.join(dependencies.config.paths.stateDir, "trash"));
      if (result.proposal.operation === "trash" && result.metadata.trashEntryId && result.targetPath) {
        createTrashEntry(dependencies.db, {
          id: String(result.metadata.trashEntryId),
          storagePoolId: root.id,
          originalPath: result.sourcePath ?? proposal.request.sourcePath ?? ".",
          trashPath: path.join(dependencies.config.paths.stateDir, "trash", result.targetPath),
          metadata: { capabilityRunId: runId }
        });
      }
      const operation = recordAppliedOperation(dependencies.db, {
        operation: result.proposal.operation,
        sourcePath: result.sourcePath,
        targetPath: result.targetPath,
        status: "applied",
        metadata: {
          storagePoolId: root.id,
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

export function capabilityRunSecretRequirements(
  dependencies: Pick<CapabilityRuntimeDependencies, "db">,
  runId: string
) {
  const approval = getCapabilityApprovalByRun(dependencies.db, runId);
  if (!approval) return [];
  try {
    return parseStoredCapabilityAdapterProposal(approval.proposal).requiredSecrets;
  } catch {
    return [];
  }
}

export async function executeStartedSecretCapabilityRun(
  dependencies: CapabilityRuntimeDependencies,
  runId: string,
  secretInput: unknown
): Promise<CapabilityRunRecord> {
  const initial = getCapabilityRun(dependencies.db, runId);
  if (!initial) throw new Error("Capability run not found");
  if (initial.state !== "running") return initial;
  const fail = (code: "INVALID_ARGUMENT" | "FORBIDDEN" | "NOT_READY" | "CONFLICT" | "INTERNAL", message: string) =>
    failRunningRun(dependencies.db, getCapabilityRun(dependencies.db, runId) ?? initial, code, message);
  try {
    const approval = getCapabilityApprovalByRun(dependencies.db, runId);
    if (!approval || approval.status !== "approved") return fail("CONFLICT", "Capability run does not have an approved first-party decision");
    if (initial.subjectKind !== "pi" || !getAgentCapabilityApproval(dependencies.db, approval.id)) {
      return fail("FORBIDDEN", "Approval is not linked to a Pi Agent conversation");
    }
    const policyCapabilityId = agentPolicyCapabilityId(initial.capabilityId);
    if (policyCapabilityId) {
      const policy = (getAgentCapabilityPolicySettings(dependencies.db) ?? defaultAgentCapabilityPolicySettings())
        .policies[policyCapabilityId];
      if (policy === "disabled") return fail("FORBIDDEN", "Capability was disabled after approval was requested");
      if (policy === "confirm" && !approval.requiresConfirmation) {
        return fail("CONFLICT", "Capability now requires a new confirmed approval");
      }
    }
    const client = initial.clientId ? getMcpClient(dependencies.db, initial.clientId) : null;
    const now = new Date().toISOString();
    if (initial.clientId && (!client || client.kind !== "pi" || client.revokedAt || (client.expiresAt && client.expiresAt <= now))) {
      return fail("FORBIDDEN", "Pi client credential is no longer active");
    }
    const payload = getCapabilityRunPayload(dependencies.db, runId);
    if (!isStoredCapabilityAdapterPayload(payload)) {
      return fail("INTERNAL", "Secret-bearing capability payload is invalid");
    }
    if (client) {
      const requiredScope = requiredScopeForCapability(initial.capabilityId, payload);
      if (requiredScope && !client.scopes.includes(requiredScope)) {
        return fail("FORBIDDEN", "Pi client no longer has the required scope");
      }
    }
    if (payload.capabilityId !== initial.capabilityId) return fail("INTERNAL", "Stored capability payload does not match the run");
    const adapter = dependencies.adapters?.[initial.capabilityId];
    if (!adapter) return fail("NOT_READY", "Domain adapter is not installed");
    const proposal = parseStoredCapabilityAdapterProposal(approval.proposal);
    if (proposal.capabilityId !== initial.capabilityId || proposal.revision !== (payload.prepared.revision ?? null)) {
      return fail("CONFLICT", "Capability proposal no longer matches its prepared request");
    }
    const secrets = validateCapabilitySecretInput(proposal.requiredSecrets, secretInput);
    const context = adapterContext(dependencies, {
      id: initial.subjectId,
      clientId: initial.clientId ?? initial.subjectId,
      kind: initial.subjectKind,
      scopes: new Set(client?.scopes ?? [])
    }, initial.capabilityId);
    await requireAdapterAvailability(adapter, context);
    await adapter.revalidate(payload.prepared, context);
    const executed = await adapter.execute(payload.prepared, context, secrets);
    const current = getCapabilityRun(dependencies.db, runId);
    if (!current || current.state !== "running") return current ?? initial;
    const completed = transitionCapabilityRun(dependencies.db, {
      runId,
      expectedRevision: current.revision,
      from: ["running"],
      to: "succeeded",
      progress: { phase: "complete" },
      result: executed.data,
      ...(executed.domainOperationType ? { domainOperationType: executed.domainOperationType } : {}),
      ...(executed.domainOperationId ? { domainOperationId: executed.domainOperationId } : {}),
      cancellable: false
    })!;
    deleteCapabilityRunPayload(dependencies.db, runId);
    return completed;
  } catch (error) {
    return fail(capabilityFailureCode(error), safeFailureMessage(error, dependencies));
  }
}

async function executeApprovedDomainAdapterRun(
  dependencies: CapabilityRuntimeDependencies,
  initial: CapabilityRunRecord,
  payload: StoredCapabilityAdapterPayload,
  secretInput: unknown
): Promise<CapabilityRunRecord> {
  if (payload.capabilityId !== initial.capabilityId) {
    return failQueuedRun(dependencies.db, initial, "INTERNAL", "Stored capability payload does not match the run");
  }
  const adapter = dependencies.adapters?.[initial.capabilityId];
  if (!adapter) {
    return failQueuedRun(dependencies.db, initial, "NOT_READY", "Domain adapter is not installed");
  }
  const approval = getCapabilityApprovalByRun(dependencies.db, initial.id);
  if (!approval) return failQueuedRun(dependencies.db, initial, "CONFLICT", "Capability approval is missing");
  let proposal: StoredCapabilityAdapterProposal;
  try {
    proposal = parseStoredCapabilityAdapterProposal(approval.proposal);
  } catch {
    return failQueuedRun(dependencies.db, initial, "INTERNAL", "Stored capability proposal is invalid");
  }
  if (proposal.capabilityId !== initial.capabilityId || proposal.revision !== (payload.prepared.revision ?? null)) {
    return failQueuedRun(dependencies.db, initial, "CONFLICT", "Capability proposal no longer matches its prepared request");
  }
  let secrets: Readonly<Record<string, string>>;
  try {
    secrets = validateCapabilitySecretInput(proposal.requiredSecrets, secretInput);
  } catch (error) {
    return failQueuedRun(
      dependencies.db,
      initial,
      "INVALID_ARGUMENT",
      error instanceof Error ? error.message : "Required secret input is invalid"
    );
  }
  const client = initial.clientId ? getMcpClient(dependencies.db, initial.clientId) : null;
  const context = adapterContext(dependencies, {
    id: initial.subjectId,
    clientId: initial.clientId ?? initial.subjectId,
    kind: initial.subjectKind,
    scopes: new Set(client?.scopes ?? [])
  }, initial.capabilityId);
  try {
    await requireAdapterAvailability(adapter, context);
    await adapter.revalidate(payload.prepared, context);
  } catch (error) {
    return failQueuedRun(
      dependencies.db,
      initial,
      capabilityFailureCode(error),
      safeFailureMessage(error, dependencies)
    );
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
    const executed = await adapter.execute(payload.prepared, context, secrets);
    const completed = transitionCapabilityRun(dependencies.db, {
      runId: initial.id,
      expectedRevision: running.revision,
      from: ["running"],
      to: "succeeded",
      progress: { phase: "complete" },
      result: executed.data,
      ...(executed.domainOperationType ? { domainOperationType: executed.domainOperationType } : {}),
      ...(executed.domainOperationId ? { domainOperationId: executed.domainOperationId } : {}),
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

function adapterContext(
  dependencies: CapabilityRuntimeDependencies,
  subject: CapabilitySubject,
  capabilityId: string
): CapabilityAdapterContext {
  return { db: dependencies.db, config: dependencies.config, capabilityId, subject };
}

async function requireAdapterAvailability(
  adapter: CapabilityDomainAdapter,
  context: CapabilityAdapterContext
): Promise<void> {
  let availability;
  try {
    availability = await adapter.availability(context);
  } catch (error) {
    throw new CapabilityError(
      "NOT_READY",
      safeFailureMessage(error, { db: context.db, config: context.config }),
      { retryable: true, cause: error }
    );
  }
  if (!availability.available) {
    throw new CapabilityError("NOT_READY", availability.reason ?? "Capability dependency is unavailable", { retryable: true });
  }
}

function validatePreparedAction(prepared: PreparedCapabilityAction): void {
  if (!prepared || typeof prepared.summary !== "string" || !prepared.summary.trim() || prepared.summary.length > 1000) {
    throw new CapabilityError("INTERNAL", "Capability adapter returned an invalid summary");
  }
  const requirements = prepared.requiredSecrets ?? [];
  const names = new Set<string>();
  for (const requirement of requirements) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/u.test(requirement.name) || !requirement.label.trim() || names.has(requirement.name)) {
      throw new CapabilityError("INTERNAL", "Capability adapter returned an invalid secret requirement");
    }
    names.add(requirement.name);
  }
}

function rejectSecretLikeFields(value: JsonValue, pathSegments: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretLikeFields(item, [...pathSegments, String(index)]));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[-_]/gu, "").toLowerCase();
    if (["password", "passphrase", "apikey", "token", "secret", "credential"].includes(normalized)) {
      throw new CapabilityError(
        "INVALID_ARGUMENT",
        `${[...pathSegments, key].join(".")} must be entered in the local approval interface`
      );
    }
    rejectSecretLikeFields(item, [...pathSegments, key]);
  }
}

function requiredScopeForCapability(capabilityId: string, payload: JsonValue | null): string | null {
  if (isStoredPiMcpFilePayload(payload)) return "cyberos:files:read";
  return createCatalogDescriptors().find((descriptor) => descriptor.id === capabilityId)?.requiredScopes[0] ?? null;
}

function adapterError(error: unknown, fallback: string): CapabilityError {
  if (error instanceof CapabilityError) return error;
  return new CapabilityError("INVALID_ARGUMENT", error instanceof Error ? error.message : fallback, { cause: error });
}

export async function executeFileReadCapability(
  dependencies: Pick<CapabilityRuntimeDependencies, "db" | "config">,
  capabilityId: PiMcpFileCapabilityId,
  input: Record<string, JsonValue>
): Promise<CapabilityExecution> {
  const storagePoolId = requiredText(input.storagePoolId, "storagePoolId");
  const root = requireStoragePool(dependencies.config, storagePoolId);
  switch (capabilityId) {
    case "cyberos.files.list": {
      const requestedPath = optionalText(input.path) ?? ".";
      const entries = await mapPathError(() => listDir(root, requestedPath));
      const limit = strictBoundedInteger(input.limit, 50, 1, 200);
      const offset = decodeFileOffsetCursor(optionalText(input.cursor), `${storagePoolId}\0${requestedPath}`);
      const pageEntries = entries.slice(offset, offset + limit);
      const nextOffset = offset + pageEntries.length;
      return {
        data: { storagePoolId, path: requestedPath, entries: toJsonValue(pageEntries) },
        page: {
          limit,
          nextCursor: nextOffset < entries.length
            ? encodeFileOffsetCursor(nextOffset, `${storagePoolId}\0${requestedPath}`)
            : null
        }
      };
    }
    case "cyberos.files.stat": {
      const metadata = await mapPathError(() => statPath(root, requiredText(input.path, "path")));
      return { data: { storagePoolId, stat: toJsonValue(metadata) } };
    }
    case "cyberos.files.read": {
      const maxBytes = strictBoundedInteger(input.maxBytes, 64 * 1024, 1, 128 * 1024);
      const preview = await mapPathError(() => readText(root, requiredText(input.path, "path"), maxBytes));
      return { data: { storagePoolId, maxBytes, preview: toJsonValue(preview) } };
    }
    case "cyberos.files.search": {
      const limit = strictBoundedInteger(input.limit, 50, 1, 100);
      try {
        const page = queryIndexAdvanced(dependencies.db, {
          storagePoolId,
          path: optionalText(input.path) ?? ".",
          query: requiredText(input.query, "query"),
          cursor: optionalText(input.cursor) ?? null,
          limit
        });
        return {
          data: { storagePoolId, files: toJsonValue(page.files) },
          page: { limit, nextCursor: page.nextCursor }
        };
      } catch (error) {
        if (error instanceof CapabilityError) throw error;
        throw new CapabilityError("INVALID_ARGUMENT", "File search request is invalid", { cause: error });
      }
    }
    case "cyberos.files.grep":
    case "cyberos.files.find":
    case "cyberos.files.git":
    case "cyberos.files.archive-inspect":
      return executeExtendedFileReadCapability(dependencies, capabilityId, input);
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
  const storagePoolId = value.storagePoolId;
  if (typeof operation !== "string" || !SUPPORTED_FILE_MUTATIONS.has(operation as FileMutationOperation)) {
    throw new CapabilityError("INVALID_ARGUMENT", "operation must be mkdir, move, copy, rename, or trash");
  }
  if (typeof storagePoolId !== "string" || !storagePoolId.trim() || storagePoolId.length > 128) {
    throw new CapabilityError("INVALID_ARGUMENT", "storagePoolId is required");
  }
  const allowed = new Set(["operation", "storagePoolId", "sourcePath", "targetPath"]);
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
  return { operation: operation as FileMutationOperation, storagePoolId: storagePoolId.trim(), ...(sourcePath ? { sourcePath } : {}), ...(targetPath ? { targetPath } : {}) };
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
    throw new CapabilityError("INVALID_ARGUMENT", `${field} must be a storage-pool-relative path`);
  }
  const normalized = path.normalize(value.trim());
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new CapabilityError("INVALID_ARGUMENT", `${field} must stay inside the storage pool`);
  }
  return normalized;
}

async function validateFileMutation(root: ResolvedStoragePool, request: FileMutationRequest): Promise<void> {
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

async function fileMutationRevision(root: ResolvedStoragePool, request: FileMutationRequest): Promise<string> {
  const state: Record<string, unknown> = { operation: request.operation, storagePoolId: root.id };
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
    case "trash": return `Move ${request.sourcePath} to CyberOS trash`;
    case "move": return `Move ${request.sourcePath} to ${request.targetPath}`;
    case "copy": return `Copy ${request.sourcePath} to ${request.targetPath}`;
    case "rename": return `Rename ${request.sourcePath} to ${request.targetPath}`;
    default: throw new CapabilityError("INVALID_ARGUMENT", "Unsupported file mutation");
  }
}

function toFileOperationProposal(request: FileMutationRequest, summary: string): FileOperationProposal {
  return {
    operation: request.operation,
    storagePoolId: request.storagePoolId,
    ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
    ...(request.targetPath ? { targetPath: request.targetPath } : {}),
    risk: request.operation === "mkdir" ? "low" : "medium",
    reversible: true,
    summary
  };
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
  const root = requireStoragePool(dependencies.config, requiredText(input.storagePoolId, "storagePoolId"));
  switch (capabilityId) {
    case "cyberos.files.list":
      strictBoundedInteger(input.limit, 50, 1, 200);
      decodeFileOffsetCursor(optionalText(input.cursor), `${root.id}\0${optionalText(input.path) ?? "."}`);
      await mapPathError(() => resolveSafeExistingPath(root.path, optionalText(input.path) ?? "."));
      return;
    case "cyberos.files.stat":
      await mapPathError(() => resolveSafeExistingPath(root.path, requiredText(input.path, "path")));
      return;
    case "cyberos.files.read":
      strictBoundedInteger(input.maxBytes, 64 * 1024, 1, 128 * 1024);
      await mapPathError(() => resolveSafeExistingPath(root.path, requiredText(input.path, "path")));
      return;
    case "cyberos.files.search":
      requiredText(input.query, "query");
      strictBoundedInteger(input.limit, 50, 1, 100);
      if (optionalText(input.path)) {
        await mapPathError(() => resolveSafeExistingPath(root.path, optionalText(input.path)!));
      }
      return;
    case "cyberos.files.grep":
      requiredText(input.pattern, "pattern");
      await executeExtendedFileReadCapability(dependencies, capabilityId, { ...input, limit: 1, maxFiles: 1, maxBytes: 1 });
      return;
    case "cyberos.files.find":
      await executeExtendedFileReadCapability(dependencies, capabilityId, { ...input, limit: 1, maxEntries: 1 });
      return;
    case "cyberos.files.git":
    case "cyberos.files.archive-inspect":
      await executeExtendedFileReadCapability(dependencies, capabilityId, input);
      return;
  }
}

function piMcpFileSummary(capabilityId: PiMcpFileCapabilityId, input: Record<string, JsonValue>): string {
  const requestedPath = optionalText(input.path) ?? ".";
  switch (capabilityId) {
    case "cyberos.files.list": return `List ${requestedPath}`;
    case "cyberos.files.stat": return `Inspect ${requestedPath}`;
    case "cyberos.files.read": return `Read ${requestedPath}`;
    case "cyberos.files.search": return `Search ${requestedPath}`;
    case "cyberos.files.grep": return `Search file contents below ${requestedPath}`;
    case "cyberos.files.find": return `Find files below ${requestedPath}`;
    case "cyberos.files.git": return `Inspect Git state at ${requestedPath}`;
    case "cyberos.files.archive-inspect": return `Inspect archive ${requestedPath}`;
  }
}

function agentPolicyCapabilityId(capabilityId: string): AgentCapabilityId | null {
  switch (capabilityId) {
    case "cyberos.files.list": return "cyberos.files.list";
    case "cyberos.files.stat":
    case "cyberos.files.read": return "cyberos.files.read";
    case "cyberos.files.search": return "cyberos.files.search";
    case "cyberos.files.grep": return "cyberos.files.grep";
    case "cyberos.files.find": return "cyberos.files.find";
    case FILE_MUTATION_CAPABILITY: return FILE_MUTATION_CAPABILITY;
    case "cyberos.files.edit": return "cyberos.files.edit";
    case "cyberos.files.write": return "cyberos.files.write";
    case "cyberos.shell.run": return "cyberos.shell.run";
    default: return null;
  }
}

function requiredText(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new CapabilityError("INVALID_ARGUMENT", `${field} is required`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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

function failQueuedRun(
  db: CyberOsDatabase,
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

function failRunningRun(
  db: CyberOsDatabase,
  run: CapabilityRunRecord,
  errorCode: "INVALID_ARGUMENT" | "FORBIDDEN" | "NOT_READY" | "CONFLICT" | "INTERNAL",
  errorMessage: string
): CapabilityRunRecord {
  if (run.state !== "running") return run;
  const failed = transitionCapabilityRun(db, {
    runId: run.id,
    expectedRevision: run.revision,
    from: ["running"],
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
    .replaceAll(dependencies.config.paths.stateDir, "[state]")
    .replaceAll(dependencies.config.paths.rootDir, "[cyberos]")
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
