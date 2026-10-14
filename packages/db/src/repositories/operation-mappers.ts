import type {
  AgentProviderSessionRecord,
  DockerConsoleAuthorizationRecord,
  DockerOperationProposal,
  DockerOperationRecord,
  FileOperationRecord,
  NasRootRecord,
  PendingApprovalProposal,
  PendingApprovalRecord,
  ShareOperationRecord,
  StorageOperationRecord,
  VmConsoleAuthorizationRecord,
  VmOperationRecord,
  TrashEntryRecord
} from "@zos/shared";
import { normalizeModelProviderName } from "./settings-mappers.js";
import type {
  DbApprovalRow,
  DbDockerConsoleAuthorizationRow,
  DbDockerOperationRow,
  DbNasRootRow,
  DbOperationRow,
  DbProviderSessionRow,
  DbShareOperationRow,
  DbStorageOperationRow,
  DbVmConsoleAuthorizationRow,
  DbVmOperationRow,
  DbTrashEntryRow
} from "./repository-rows.js";

export function mapProviderSession(row: DbProviderSessionRow): AgentProviderSessionRecord {
  return {
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    sessionFile: row.session_file,
    providerName: normalizeModelProviderName(row.provider_name),
    model: row.model,
    settingsSnapshot: JSON.parse(row.settings_snapshot_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapNasRoot(row: DbNasRootRow): NasRootRecord {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    enabled: row.enabled === 1,
    mountPolicy: row.mount_policy ?? "optional",
    expectedSource: row.expected_source,
    expectedUuid: row.expected_uuid,
    expectedFstype: row.expected_fstype,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapApproval(row: DbApprovalRow): PendingApprovalRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    proposal: JSON.parse(row.proposal_json) as PendingApprovalProposal[],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapDockerOperation(row: DbDockerOperationRow): DockerOperationRecord {
  return {
    id: row.id,
    approvalId: row.approval_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapShareOperation(row: DbShareOperationRow): ShareOperationRecord {
  return {
    id: row.id,
    approvalId: row.approval_id,
    action: row.action,
    targetId: row.target_id,
    status: row.status,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapStorageOperation(row: DbStorageOperationRow): StorageOperationRecord {
  return {
    id: row.id,
    approvalId: row.approval_id,
    action: row.action,
    targetId: row.target_id,
    status: row.status,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapVmOperation(row: DbVmOperationRow): VmOperationRecord {
  return {
    id: row.id,
    approvalId: row.approval_id,
    action: row.action,
    targetId: row.target_id,
    status: row.status,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapVmConsoleAuthorization(row: DbVmConsoleAuthorizationRow): VmConsoleAuthorizationRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    approvalId: row.approval_id,
    domainName: row.domain_name,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at
  };
}

export function mapDockerConsoleAuthorization(
  row: DbDockerConsoleAuthorizationRow
): DockerConsoleAuthorizationRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    approvalId: row.approval_id,
    containerId: row.container_id,
    shell: row.shell,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at
  };
}

export function mapOperation(row: DbOperationRow): FileOperationRecord {
  return {
    id: row.id,
    approvalId: row.approval_id,
    operation: row.operation,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    status: row.status,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function dockerProposalTargetId(proposal: DockerOperationProposal): string {
  return (
    proposal.containerId ??
    proposal.containerName ??
    proposal.volumeName ??
    proposal.networkName ??
    proposal.composeProjectId ??
    proposal.composeProjectName ??
    "docker"
  );
}

export function mapTrashEntry(row: DbTrashEntryRow): TrashEntryRecord {
  return {
    id: row.id,
    rootId: row.root_id,
    originalPath: row.original_path,
    trashPath: row.trash_path,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    restoredAt: row.restored_at
  };
}
