import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  appendEvent,
  deleteDockerComposeHostAccessDraft,
  deleteDockerCreateDraft,
  createTrashEntry,
  enqueuePhotostaffJob,
  getDockerSettings,
  getApproval,
  getDockerOperationByApproval,
  getDockerComposeHostAccessDraftByApproval,
  getDockerCreateDraftByApproval,
  getShareOperationByApproval,
  getShareSettings,
  getStorageOperationByApproval,
  getVmOperationByApproval,
  getNasRoot,
  getPhotostaffLibrarySettings,
  listDockerRegistryCredentials,
  listPendingApprovals,
  recordAppliedOperation,
  saveShareSettings,
  updateDockerOperationStatus,
  updateShareOperationStatus,
  updateStorageOperationStatus,
  updateVmOperationStatus,
  updateApprovalStatus,
  updateJobStatus
} from "@zos/db";
import { applyFileMutation } from "@zos/nas-tools";
import type {
  DockerOperationRecord,
  DockerOperationProposal,
  FileOperationProposal,
  PendingApprovalRecord,
  ShareOperationProposal,
  StorageOperationProposal,
  VmOperationProposal
} from "@zos/shared";
import type { ApiRouteContext } from "../context.js";
import { effectiveDockerConfig } from "../lib/settings.js";
import { redactDockerRegistrySecrets } from "../lib/docker-registry.js";
import { applyDockerOperation, collectDockerSummary, dockerEngine } from "../lib/docker-service.js";
import {
  bindPreparedDockerCreateHostAccess,
  DockerCreateValidationError,
  executeDockerCreate,
  prepareDockerCreate
} from "../lib/docker-create.js";
import { DockerHostAccessPolicy } from "../lib/docker-host-access.js";
import { dockerRegistryAuthHeader, findDockerRegistryCredential } from "../lib/docker-registry.js";
import {
  applyShareOperation,
  safeShareMessage,
  serializeShareMutation,
  shareSettingsFromOperation,
  toPublicShareOperation
} from "../lib/share-service.js";
import { applyStoragePoolOperation } from "../lib/storage-service.js";
import { StorageScopeError, resolveStoragePoolScope, validateStoragePoolProposal } from "../lib/storage-scope.js";
import { safeVmMessage } from "../lib/vm-service.js";
import { applyApprovedVmOperation } from "./vms.js";

export function registerApprovalRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { config, db, system } = context;
  const currentConfig = () => effectiveDockerConfig(config, getDockerSettings(db));
  server.get("/api/approvals", async () => ({
    approvals: listPendingApprovals(db)
  }));

  server.post<{
    Params: { id: string };
  }>("/api/approvals/:id/approve", async (request, reply) => {
    const approval = getApproval(db, request.params.id);
    if (!approval) {
      reply.status(404).send({ error: "Approval not found" });
      return;
    }

    if (approval.kind === "pi_tool_call") {
      if (!updateApprovalStatus(db, approval.id, "approved", ["pending"])) {
        reply.status(409).send({ error: `Approval is already ${approval.status}` });
        return;
      }
      reply.status(202).send({
        approvalId: approval.id,
        status: "approved"
      });
      return;
    }

    if (approval.kind === "docker_operation") {
      const operation = getDockerOperationByApproval(db, approval.id);
      const proposal = dockerOperationProposal(approval);
      if (!operation || !proposal) {
        reply.status(400).send({ error: "Docker approval is missing operation metadata" });
        return;
      }
      if (!updateApprovalStatus(db, approval.id, "approved", ["pending"])) {
        reply.status(409).send({ error: `Approval is already ${approval.status}` });
        return;
      }

      if (proposal.action === "console") {
        const approved = updateDockerOperationStatus(db, operation.id, "approved", {
          approvedAt: new Date().toISOString()
        });
        reply.status(202).send({
          approvalId: approval.id,
          status: "approved",
          operation: approved
        });
        return;
      }

      const registryCredentials = listDockerRegistryCredentials(db);
      try {
        const metadata = proposal.action === "create" && proposal.hostAccess
          ? await applyApprovedDockerHostAccessCreate(context, operation, registryCredentials)
          : await applyDockerOperation(
              currentConfig(),
              operation,
              proposal,
              context.docker,
              registryCredentials
            );
        const applied = updateDockerOperationStatus(db, operation.id, "applied", {
          ...metadata,
          appliedAt: new Date().toISOString()
        });
        updateApprovalStatus(db, approval.id, "applied", ["approved"]);
        updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval"]);
        appendEvent(db, {
          sessionId: approval.sessionId,
          jobId: approval.jobId,
          type: "job.completed",
          payload: {
            jobId: approval.jobId,
            approvalId: approval.id,
            dockerOperation: applied
          }
        });
        reply.status(202).send({
          approvalId: approval.id,
          status: "applied",
          operation: applied
        });
        return;
      } catch (error) {
        deleteDockerHostAccessDraftForApproval(db, approval.id);
        const message = redactDockerRegistrySecrets(error, registryCredentials);
        updateDockerOperationStatus(db, operation.id, "failed", {
          error: message,
          failedAt: new Date().toISOString()
        });
        updateApprovalStatus(db, approval.id, "failed", ["approved"]);
        updateJobStatus(db, approval.jobId, "failed", message, ["waiting_approval"]);
        appendEvent(db, {
          sessionId: approval.sessionId,
          jobId: approval.jobId,
          type: "job.failed",
          payload: { error: message }
        });
        reply.status(getErrorStatusCode(error, 400)).send({ error: message });
        return;
      }
    }

    if (approval.kind === "share_operation") {
      const operation = getShareOperationByApproval(db, approval.id);
      const proposal = shareOperationProposal(approval);
      if (!operation || !proposal) {
        reply.status(400).send({ error: "Share approval is missing operation metadata" });
        return;
      }
      if (!updateApprovalStatus(db, approval.id, "approved", ["pending"])) {
        reply.status(409).send({ error: `Approval is already ${approval.status}` });
        return;
      }

      try {
        const { metadata, saved } = await serializeShareMutation(async () => {
          const proposedSettings = shareSettingsFromOperation(operation);
          const currentSettings = getShareSettings(db);
          const settings = currentSettings
            ? { ...proposedSettings, account: currentSettings.account }
            : proposedSettings;
          const metadata = await applyShareOperation(
            config,
            {
              ...operation,
              metadata: {
                ...operation.metadata,
                settings
              }
            },
            proposal,
            context.shares
          );
          const { updatedAt: _proposedUpdatedAt, ...settingsToSave } = settings;
          return {
            metadata,
            saved: saveShareSettings(db, settingsToSave)
          };
        });
        const applied = updateShareOperationStatus(db, operation.id, "applied", {
          ...metadata,
          settingsUpdatedAt: saved.updatedAt,
          appliedAt: new Date().toISOString()
        });
        updateApprovalStatus(db, approval.id, "applied", ["approved"]);
        updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval"]);
        appendEvent(db, {
          sessionId: approval.sessionId,
          jobId: approval.jobId,
          type: "job.completed",
          payload: {
            jobId: approval.jobId,
            approvalId: approval.id,
            shareOperation: applied ? toPublicShareOperation(applied) : null
          }
        });
        reply.status(202).send({
          approvalId: approval.id,
          status: "applied",
          operation: applied ? toPublicShareOperation(applied) : null
        });
        return;
      } catch (error) {
        const message = safeShareMessage(error);
        updateShareOperationStatus(db, operation.id, "failed", {
          error: message,
          failedAt: new Date().toISOString()
        });
        updateApprovalStatus(db, approval.id, "failed", ["approved"]);
        updateJobStatus(db, approval.jobId, "failed", message, ["waiting_approval"]);
        appendEvent(db, {
          sessionId: approval.sessionId,
          jobId: approval.jobId,
          type: "job.failed",
          payload: { error: message }
        });
        reply.status(400).send({ error: message });
        return;
      }
    }

    if (approval.kind === "storage_operation") {
      const operation = getStorageOperationByApproval(db, approval.id);
      const proposal = storageOperationProposal(approval);
      if (!operation || !proposal) {
        reply.status(400).send({ error: "Storage approval is missing operation metadata" });
        return;
      }
      if (!updateApprovalStatus(db, approval.id, "approved", ["pending"])) {
        reply.status(409).send({ error: `Approval is already ${approval.status}` });
        return;
      }

      try {
        const metadata = await applyStoragePoolOperation(config.hostd.socketPath, proposal);
        const applied = updateStorageOperationStatus(db, operation.id, "applied", {
          ...metadata,
          appliedAt: new Date().toISOString()
        });
        updateApprovalStatus(db, approval.id, "applied", ["approved"]);
        updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval"]);
        appendEvent(db, {
          sessionId: approval.sessionId,
          jobId: approval.jobId,
          type: "job.completed",
          payload: {
            jobId: approval.jobId,
            approvalId: approval.id,
            storageOperation: applied
          }
        });
        reply.status(202).send({
          approvalId: approval.id,
          status: "applied",
          operation: applied
        });
        return;
      } catch (error) {
        const message = safeStorageMessage(error);
        updateStorageOperationStatus(db, operation.id, "failed", {
          error: message,
          failedAt: new Date().toISOString()
        });
        updateApprovalStatus(db, approval.id, "failed", ["approved"]);
        updateJobStatus(db, approval.jobId, "failed", message, ["waiting_approval"]);
        appendEvent(db, {
          sessionId: approval.sessionId,
          jobId: approval.jobId,
          type: "job.failed",
          payload: { error: message }
        });
        reply.status(400).send({ error: message });
        return;
      }
    }

    if (approval.kind === "vm_operation") {
      const operation = getVmOperationByApproval(db, approval.id);
      const proposal = vmOperationProposal(approval);
      if (!operation || !proposal) {
        reply.status(400).send({ error: "VM approval is missing operation metadata" });
        return;
      }
      if (!updateApprovalStatus(db, approval.id, "approved", ["pending"])) {
        reply.status(409).send({ error: `Approval is already ${approval.status}` });
        return;
      }
      if (proposal.action === "console") {
        const approved = updateVmOperationStatus(db, operation.id, "approved", { approvedAt: new Date().toISOString() });
        reply.status(202).send({ approvalId: approval.id, status: "approved", operation: approved });
        return;
      }
      try {
        const applied = await applyApprovedVmOperation(context, approval.id);
        updateApprovalStatus(db, approval.id, "applied", ["approved"]);
        updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval"]);
        appendEvent(db, { sessionId: approval.sessionId, jobId: approval.jobId, type: "job.completed", payload: { jobId: approval.jobId, approvalId: approval.id, vmOperation: applied } });
        reply.status(202).send({ approvalId: approval.id, status: "applied", operation: applied });
      } catch (error) {
        const message = safeVmMessage(error);
        updateVmOperationStatus(db, operation.id, "failed", { error: message, failedAt: new Date().toISOString() });
        updateApprovalStatus(db, approval.id, "failed", ["approved"]);
        updateJobStatus(db, approval.jobId, "failed", message, ["waiting_approval"]);
        appendEvent(db, { sessionId: approval.sessionId, jobId: approval.jobId, type: "job.failed", payload: { jobId: approval.jobId, approvalId: approval.id, error: message } });
        reply.status(400).send({ error: message });
      }
      return;
    }

    if (!updateApprovalStatus(db, approval.id, "approved", ["pending"])) {
      reply.status(409).send({ error: `Approval is already ${approval.status}` });
      return;
    }

    const applied: ReturnType<typeof recordAppliedOperation>[] = [];
    const enqueuePhotostaffRefreshIfNeeded = (): void => {
      const photostaffSettings = getPhotostaffLibrarySettings(db);
      if (!photostaffSettings || !fileOperationProposals(approval).some((proposal) =>
        proposal.rootId === photostaffSettings.rootId &&
        proposal.storagePoolId === photostaffSettings.storagePoolId &&
        [proposal.sourcePath, proposal.targetPath].some((candidate) =>
          candidate ? isPathWithin(photostaffSettings.path, candidate) : false
        )
      )) return;
      enqueuePhotostaffJob(db, { settings: photostaffSettings, kind: "full_scan", path: photostaffSettings.path });
    };
    try {
      for (const proposal of fileOperationProposals(approval)) {
        const root = getNasRoot(db, proposal.rootId);
        if (!root) {
          throw new Error(`NAS root ${proposal.rootId} is not configured`);
        }

        if (proposal.storagePoolId !== undefined) {
          if (typeof proposal.storagePoolId !== "string" || !proposal.storagePoolId.trim()) {
            throw new StorageScopeError("Storage pool selection is invalid", 400);
          }
          const scope = await resolveStoragePoolScope(db, system, proposal.rootId, proposal.storagePoolId);
          await validateStoragePoolProposal(scope, proposal);
        }

        const result = await applyFileMutation(root, proposal, path.join(config.dataDir, "trash"));
        if (result.proposal.operation === "trash" && result.metadata.trashEntryId && result.targetPath) {
          createTrashEntry(db, {
            id: String(result.metadata.trashEntryId),
            rootId: root.id,
            originalPath: result.sourcePath ?? proposal.sourcePath ?? ".",
            trashPath: path.join(config.dataDir, "trash", result.targetPath),
            metadata: {
              ...result.metadata,
              ...(proposal.storagePoolId ? { storagePoolId: proposal.storagePoolId } : {})
            }
          });
        }

        applied.push(
          recordAppliedOperation(db, {
            approvalId: approval.id,
            operation: result.proposal.operation,
            sourcePath: result.sourcePath,
            targetPath: result.targetPath,
            status: "applied",
            metadata: {
              ...result.metadata,
              rootId: root.id,
              ...(proposal.storagePoolId ? { storagePoolId: proposal.storagePoolId } : {}),
              reversible: proposal.reversible
            }
          })
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (applied.length) enqueuePhotostaffRefreshIfNeeded();
      updateApprovalStatus(db, approval.id, "failed", ["approved"]);
      updateJobStatus(db, approval.jobId, "failed", message, ["waiting_approval"]);
      appendEvent(db, {
        sessionId: approval.sessionId,
        jobId: approval.jobId,
        type: "job.failed",
        payload: { error: message }
      });
      const statusCode = getErrorStatusCode(error, 400);
      reply.status(statusCode).send({ error: message });
      return;
    }

    updateApprovalStatus(db, approval.id, "applied", ["approved"]);
    enqueuePhotostaffRefreshIfNeeded();
    updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval"]);
    appendEvent(db, {
      sessionId: approval.sessionId,
      jobId: approval.jobId,
      type: "job.completed",
      payload: {
        jobId: approval.jobId,
        approvalId: approval.id,
        applied
      }
    });
    reply.status(202).send({
      approvalId: approval.id,
      status: "applied",
      operations: applied
    });
  });

  server.post<{
    Params: { id: string };
  }>("/api/approvals/:id/reject", async (request, reply) => {
    const approval = getApproval(db, request.params.id);
    if (!approval) {
      reply.status(404).send({ error: "Approval not found" });
      return;
    }

    if (approval.kind === "pi_tool_call") {
      if (!updateApprovalStatus(db, approval.id, "rejected", ["pending"])) {
        reply.status(409).send({ error: `Approval is already ${approval.status}` });
        return;
      }
      reply.status(202).send({
        approvalId: approval.id,
        status: "rejected"
      });
      return;
    }

    if (approval.kind === "docker_operation") {
      if (!updateApprovalStatus(db, approval.id, "rejected", ["pending"])) {
        reply.status(409).send({ error: `Approval is already ${approval.status}` });
        return;
      }
      const operation = getDockerOperationByApproval(db, approval.id);
      deleteDockerHostAccessDraftForApproval(db, approval.id);
      if (operation) {
        updateDockerOperationStatus(db, operation.id, "failed", {
          rejected: true,
          rejectedAt: new Date().toISOString()
        });
      }
      updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval"]);
      appendEvent(db, {
        sessionId: approval.sessionId,
        jobId: approval.jobId,
        type: "job.completed",
        payload: {
          jobId: approval.jobId,
          approvalId: approval.id,
          rejected: true
        }
      });
      reply.status(202).send({
        approvalId: approval.id,
        status: "rejected"
      });
      return;
    }

    if (approval.kind === "share_operation") {
      if (!updateApprovalStatus(db, approval.id, "rejected", ["pending"])) {
        reply.status(409).send({ error: `Approval is already ${approval.status}` });
        return;
      }
      const operation = getShareOperationByApproval(db, approval.id);
      if (operation) {
        updateShareOperationStatus(db, operation.id, "failed", {
          rejected: true,
          rejectedAt: new Date().toISOString()
        });
      }
      updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval"]);
      appendEvent(db, {
        sessionId: approval.sessionId,
        jobId: approval.jobId,
        type: "job.completed",
        payload: {
          jobId: approval.jobId,
          approvalId: approval.id,
          rejected: true
        }
      });
      reply.status(202).send({
        approvalId: approval.id,
        status: "rejected"
      });
      return;
    }

    if (approval.kind === "storage_operation") {
      if (!updateApprovalStatus(db, approval.id, "rejected", ["pending"])) {
        reply.status(409).send({ error: `Approval is already ${approval.status}` });
        return;
      }
      const operation = getStorageOperationByApproval(db, approval.id);
      if (operation) {
        updateStorageOperationStatus(db, operation.id, "failed", {
          rejected: true,
          rejectedAt: new Date().toISOString()
        });
      }
      updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval"]);
      appendEvent(db, {
        sessionId: approval.sessionId,
        jobId: approval.jobId,
        type: "job.completed",
        payload: {
          jobId: approval.jobId,
          approvalId: approval.id,
          rejected: true
        }
      });
      reply.status(202).send({
        approvalId: approval.id,
        status: "rejected"
      });
      return;
    }

    if (approval.kind === "vm_operation") {
      if (!updateApprovalStatus(db, approval.id, "rejected", ["pending"])) {
        reply.status(409).send({ error: `Approval is already ${approval.status}` });
        return;
      }
      const operation = getVmOperationByApproval(db, approval.id);
      if (operation) updateVmOperationStatus(db, operation.id, "failed", { rejected: true, rejectedAt: new Date().toISOString() });
      updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval"]);
      appendEvent(db, { sessionId: approval.sessionId, jobId: approval.jobId, type: "job.completed", payload: { jobId: approval.jobId, approvalId: approval.id, rejected: true } });
      reply.status(202).send({ approvalId: approval.id, status: "rejected" });
      return;
    }

    if (!updateApprovalStatus(db, approval.id, "rejected", ["pending"])) {
      reply.status(409).send({ error: `Approval is already ${approval.status}` });
      return;
    }

    updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval"]);
    appendEvent(db, {
      sessionId: approval.sessionId,
      jobId: approval.jobId,
      type: "job.completed",
      payload: {
        jobId: approval.jobId,
        approvalId: approval.id,
        rejected: true
      }
    });
    reply.status(202).send({
      approvalId: approval.id,
      status: "rejected"
    });
  });
}

async function applyApprovedDockerHostAccessCreate(
  context: ApiRouteContext,
  operation: DockerOperationRecord,
  registryCredentials: ReturnType<typeof listDockerRegistryCredentials>
): Promise<Record<string, unknown>> {
  if (!operation.approvalId) {
    throw new DockerCreateValidationError("Docker Host Access approval is missing its private draft", 409);
  }
  const draft = getDockerCreateDraftByApproval(context.db, operation.approvalId);
  if (!draft || Date.parse(draft.expiresAt) <= Date.now()) {
    if (draft) deleteDockerCreateDraft(context.db, draft.id);
    throw new DockerCreateValidationError("Docker Host Access approval expired or changed", 409);
  }
  try {
    const config = effectiveDockerConfig(context.config, getDockerSettings(context.db));
    const summary = await collectDockerSummary(config, context.docker);
    if (summary.engine.status !== "ready") {
      throw new DockerCreateValidationError(summary.engine.error ?? "Docker engine is not ready", 503);
    }
    const engine = dockerEngine(config.docker, context.docker);
    if (!engine.resolveImageId) {
      throw new DockerCreateValidationError("Docker image identity resolution is unavailable", 503);
    }
    const imageDigest = await engine.resolveImageId(draft.input.image);
    if (imageDigest !== draft.imageDigest) {
      throw new DockerCreateValidationError("Docker image changed after approval was requested", 409);
    }
    const prepared = await prepareDockerCreate(
      { action: "create", targetType: "container", ...draft.input },
      context,
      summary
    );
    const bound = bindPreparedDockerCreateHostAccess(
      prepared,
      context.hostAccess?.policy ?? new DockerHostAccessPolicy(context.db),
      draft.revision,
      imageDigest
    );
    if (bound.kind !== "container" || bound.hostAccessManifest?.fingerprint !== draft.fingerprint) {
      throw new DockerCreateValidationError("Docker Host Access resources changed after approval was requested", 409);
    }
    const proxyCapabilities = bound.hostAccessManifest.grants
      .map((grant) => grant.capability)
      .filter((capability) => capability === "docker_metadata" || capability === "systemd_status");
    if (proxyCapabilities.length) {
      if (!context.hostAccess?.control) {
        throw new DockerCreateValidationError("Docker Host Access proxy is unavailable", 503);
      }
      await context.hostAccess.control.reconcile({
        scopeId: draft.input.name,
        capabilities: proxyCapabilities
      });
    }
    const executable = {
      ...bound,
      input: { ...bound.input, pullPolicy: "never" as const },
      engineInput: { ...bound.engineInput, image: imageDigest }
    };
    const result = await executeDockerCreate(
      executable,
      engine,
      operation.id,
      () => {
        const credential = findDockerRegistryCredential(registryCredentials, draft.input.image);
        return credential ? dockerRegistryAuthHeader(credential) : undefined;
      }
    );
    if (result.partialSuccess) {
      throw new DockerCreateValidationError("Docker container was created but could not be started", 502);
    }
    return {
      action: "create",
      targetType: "container",
      result: dockerCreateApprovalResult(result),
      hostAccessPolicyVersion: draft.policyVersion,
      hostAccessCapabilities: draft.grants.map((grant) => grant.capability)
    };
  } finally {
    deleteDockerCreateDraft(context.db, draft.id);
  }
}

function deleteDockerHostAccessDraftForApproval(
  db: Parameters<typeof getDockerCreateDraftByApproval>[0],
  approvalId: string
): void {
  const composeDraft = getDockerComposeHostAccessDraftByApproval(db, approvalId);
  if (composeDraft) deleteDockerComposeHostAccessDraft(db, composeDraft.id);
  const createDraft = getDockerCreateDraftByApproval(db, approvalId);
  if (createDraft) deleteDockerCreateDraft(db, createDraft.id);
}

function dockerCreateApprovalResult(result: Awaited<ReturnType<typeof executeDockerCreate>>): Record<string, unknown> {
  const { error: _error, ...safe } = result;
  return safe;
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function getErrorStatusCode(error: unknown, fallback: number): number {
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && ((statusCode >= 400 && statusCode < 500) || statusCode === 503)
    ? statusCode
    : fallback;
}

function dockerOperationProposal(approval: PendingApprovalRecord): DockerOperationProposal | null {
  if (approval.kind !== "docker_operation") {
    return null;
  }
  const proposal = approval.proposal[0];
  if (
    typeof proposal === "object" &&
    proposal !== null &&
    "action" in proposal &&
    typeof (proposal as { action?: unknown }).action === "string"
  ) {
    return proposal as DockerOperationProposal;
  }
  return null;
}

function shareOperationProposal(approval: PendingApprovalRecord): ShareOperationProposal | null {
  if (approval.kind !== "share_operation") {
    return null;
  }
  const proposal = approval.proposal[0];
  if (
    typeof proposal === "object" &&
    proposal !== null &&
    "action" in proposal &&
    (proposal as { action?: unknown }).action === "apply_settings"
  ) {
    return proposal as ShareOperationProposal;
  }
  return null;
}

function storageOperationProposal(approval: PendingApprovalRecord): StorageOperationProposal | null {
  if (approval.kind !== "storage_operation") {
    return null;
  }
  const proposal = approval.proposal[0];
  if (
    typeof proposal === "object" &&
    proposal !== null &&
    "action" in proposal &&
    (proposal as { action?: unknown }).action === "create_pool"
  ) {
    return proposal as StorageOperationProposal;
  }
  return null;
}

function vmOperationProposal(approval: PendingApprovalRecord): VmOperationProposal | null {
  if (approval.kind !== "vm_operation") return null;
  const proposal = approval.proposal[0];
  if (typeof proposal === "object" && proposal !== null && "action" in proposal && typeof (proposal as { action?: unknown }).action === "string") {
    return proposal as VmOperationProposal;
  }
  return null;
}

function safeStorageMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/password["']?\s*[:=]\s*["'][^"']+["']/giu, "password: [redacted]");
}

function fileOperationProposals(approval: PendingApprovalRecord): FileOperationProposal[] {
  if (approval.kind !== "file_operation") {
    return [];
  }
  return approval.proposal.filter(isFileOperationProposal);
}

function isFileOperationProposal(proposal: unknown): proposal is FileOperationProposal {
  return (
    typeof proposal === "object" &&
    proposal !== null &&
    "operation" in proposal &&
    "rootId" in proposal &&
    typeof (proposal as { operation?: unknown }).operation === "string" &&
    typeof (proposal as { rootId?: unknown }).rootId === "string"
  );
}
