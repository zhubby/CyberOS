import path from "node:path";
import {
  createTrashEntry,
  getFileOperation,
  getTrashEntry,
  markTrashEntryRestored,
  type CyberOsDatabase
} from "@cyberos/db";
import { rollbackFileMutation, restoreTrashPath } from "@cyberos/storage-tools";
import type { SystemManagementDependencies } from "./system-management.js";
import { resolveScopedTargetPath, resolveStoragePoolScope, validateStoragePoolProposal } from "./storage-scope.js";

type FileOperationRecord = NonNullable<ReturnType<typeof getFileOperation>>;

export class TrashRestoreError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "TrashRestoreError";
  }
}

export async function rollbackTrashOperation(
  db: CyberOsDatabase,
  dataRoot: string,
  operation: FileOperationRecord,
  system?: SystemManagementDependencies
) {
  const trashEntryId = getStringMetadata(operation.metadata, "trashEntryId");
  if (!trashEntryId) {
    throw new Error("Trash operation is missing trash entry metadata");
  }

  const { entry, storagePool, restored } = await restoreTrashEntry(db, dataRoot, trashEntryId, system);
  return {
    operation: "restore" as const,
    sourcePath: entry.trashPath,
    targetPath: restored.targetPath,
    metadata: {
      ...restored.metadata,
      storagePoolId: storagePool.id,
      rollbackOf: operation.id,
      trashEntryId: entry.id
    }
  };
}

export async function restoreTrashEntry(
  db: CyberOsDatabase,
  dataRoot: string,
  trashEntryId: string,
  system?: SystemManagementDependencies
) {
  const entry = getTrashEntry(db, trashEntryId);
  if (!entry) {
    throw new TrashRestoreError("Trash entry not found", 404);
  }
  if (entry.restoredAt) {
    throw new TrashRestoreError("Trash entry is already restored", 409);
  }

  const scope = await resolveStoragePoolScope(dataRoot, system, entry.storagePoolId);
  await resolveScopedTargetPath(scope, entry.originalPath);

  const restored = await restoreTrashPath(scope.workspace, {
    storagePoolId: scope.pool.id,
    trashPath: entry.trashPath,
    originalPath: entry.originalPath
  });
  markTrashEntryRestored(db, entry.id);
  return {
    entry,
    storagePool: scope.pool,
    restored
  };
}

export async function rollbackRegularOperation(
  db: CyberOsDatabase,
  dataRoot: string,
  operation: FileOperationRecord,
  trashRootPath: string,
  system?: SystemManagementDependencies
) {
  const storagePoolId = getOperationStoragePoolId(operation);
  if (!storagePoolId) {
    throw new Error("Operation is missing storage pool metadata");
  }

  const scope = await resolveStoragePoolScope(dataRoot, system, storagePoolId);
  await validateStoragePoolProposal(
    scope,
    operation.operation === "restore"
      ? { ...(operation.targetPath ? { targetPath: operation.targetPath } : {}) }
      : {
          ...(operation.sourcePath ? { sourcePath: operation.sourcePath } : {}),
          ...(operation.targetPath ? { targetPath: operation.targetPath } : {})
        }
  );

  const rolledBack = await rollbackFileMutation(scope.workspace, operation, trashRootPath);
  if (rolledBack.operation === "trash" && rolledBack.metadata.trashEntryId && rolledBack.targetPath) {
    createTrashEntry(db, {
      id: String(rolledBack.metadata.trashEntryId),
      storagePoolId: scope.pool.id,
      originalPath: rolledBack.sourcePath ?? ".",
      trashPath: path.join(trashRootPath, rolledBack.targetPath),
      metadata: {
        ...rolledBack.metadata,
        storagePoolId: scope.pool.id
      }
    });
  }

  return {
    ...rolledBack,
    metadata: {
      ...rolledBack.metadata,
      storagePoolId: scope.pool.id
    }
  };
}

function getOperationStoragePoolId(operation: FileOperationRecord): string | null {
  const storagePoolId = getStringMetadata(operation.metadata, "storagePoolId");
  if (storagePoolId) {
    return storagePoolId;
  }

  const proposal = operation.metadata.proposal;
  if (proposal && typeof proposal === "object" && "storagePoolId" in proposal) {
    const proposedStoragePoolId = (proposal as { storagePoolId?: unknown }).storagePoolId;
    return typeof proposedStoragePoolId === "string" ? proposedStoragePoolId : null;
  }

  return null;
}

function getStringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}
