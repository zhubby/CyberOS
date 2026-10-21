import path from "node:path";
import {
  createTrashEntry,
  getFileOperation,
  getNasRoot,
  getTrashEntry,
  markTrashEntryRestored,
  type ZosDatabase
} from "@zos/db";
import { rollbackFileMutation, restoreTrashPath } from "@zos/nas-tools";
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
  db: ZosDatabase,
  operation: FileOperationRecord,
  system?: SystemManagementDependencies
) {
  const trashEntryId = getStringMetadata(operation.metadata, "trashEntryId");
  if (!trashEntryId) {
    throw new Error("Trash operation is missing trash entry metadata");
  }

  const { entry, root, restored } = await restoreTrashEntry(db, trashEntryId, system);
  const storagePoolId = getStringMetadata(operation.metadata, "storagePoolId");
  return {
    operation: "restore" as const,
    sourcePath: entry.trashPath,
    targetPath: restored.targetPath,
    metadata: {
      ...restored.metadata,
      rootId: root.id,
      rollbackOf: operation.id,
      trashEntryId: entry.id,
      ...(storagePoolId ? { storagePoolId } : {})
    }
  };
}

export async function restoreTrashEntry(
  db: ZosDatabase,
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

  const root = getNasRoot(db, entry.rootId);
  if (!root) {
    throw new TrashRestoreError("NAS root not found", 404);
  }

  const storagePoolId = getStringMetadata(entry.metadata, "storagePoolId");
  if (storagePoolId) {
    const scope = await resolveStoragePoolScope(db, system, root.id, storagePoolId);
    await resolveScopedTargetPath(scope, entry.originalPath);
  }

  const restored = await restoreTrashPath(root, {
    trashPath: entry.trashPath,
    originalPath: entry.originalPath
  });
  markTrashEntryRestored(db, entry.id);
  return {
    entry,
    root,
    restored
  };
}

export async function rollbackRegularOperation(
  db: ZosDatabase,
  operation: FileOperationRecord,
  trashRootPath: string,
  system?: SystemManagementDependencies
) {
  const rootId = getOperationRootId(operation);
  if (!rootId) {
    throw new Error("Operation is missing NAS root metadata");
  }

  const root = getNasRoot(db, rootId);
  if (!root) {
    throw new Error("NAS root not found");
  }

  const storagePoolId = getStringMetadata(operation.metadata, "storagePoolId");
  if (storagePoolId) {
    const scope = await resolveStoragePoolScope(db, system, root.id, storagePoolId);
    await validateStoragePoolProposal(
      scope,
      operation.operation === "restore"
        ? { ...(operation.targetPath ? { targetPath: operation.targetPath } : {}) }
        : {
            ...(operation.sourcePath ? { sourcePath: operation.sourcePath } : {}),
            ...(operation.targetPath ? { targetPath: operation.targetPath } : {})
          }
    );
  }

  const rolledBack = await rollbackFileMutation(root, operation, trashRootPath);
  if (rolledBack.operation === "trash" && rolledBack.metadata.trashEntryId && rolledBack.targetPath) {
    createTrashEntry(db, {
      id: String(rolledBack.metadata.trashEntryId),
      rootId: root.id,
      originalPath: rolledBack.sourcePath ?? ".",
      trashPath: path.join(trashRootPath, rolledBack.targetPath),
      metadata: {
        ...rolledBack.metadata,
        rootId: root.id,
        ...(storagePoolId ? { storagePoolId } : {})
      }
    });
  }

  return {
    ...rolledBack,
    metadata: {
      ...rolledBack.metadata,
      rootId: root.id,
      ...(storagePoolId ? { storagePoolId } : {})
    }
  };
}

function getOperationRootId(operation: FileOperationRecord): string | null {
  const rootId = getStringMetadata(operation.metadata, "rootId");
  if (rootId) {
    return rootId;
  }

  const proposal = operation.metadata.proposal;
  if (proposal && typeof proposal === "object" && "rootId" in proposal) {
    const proposedRootId = (proposal as { rootId?: unknown }).rootId;
    return typeof proposedRootId === "string" ? proposedRootId : null;
  }

  return null;
}

function getStringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}
