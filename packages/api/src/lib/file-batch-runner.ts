import { stat } from "node:fs/promises";
import path from "node:path";
import {
  claimNextFileBatchItem,
  createTrashEntry,
  finishFileBatchItem,
  getFileOperation,
  getTrashEntry,
  recordAppliedOperation,
  recoverInterruptedFileBatches,
  type ClaimedFileBatchItem,
  type ZosDatabase
} from "@zos/db";
import { applyFileMutation, trashPathFor } from "@zos/nas-tools";
import type { FileBatchRecord, FileOperationProposal, ZosConfig } from "@zos/shared";
import type { SystemManagementDependencies } from "./system-management.js";
import {
  resolveScopedExistingPath,
  resolveStoragePoolScope,
  validateStoragePoolProposal
} from "./storage-scope.js";

export interface FileBatchRuntime {
  start(): void;
  wake(): void;
  stop(): Promise<void>;
}

export class FileBatchRunner implements FileBatchRuntime {
  private stopped = true;
  private active: Promise<void> | null = null;

  constructor(
    private readonly dependencies: {
      db: ZosDatabase;
      config: ZosConfig;
      system?: SystemManagementDependencies;
      log?: { error: (input: unknown, message?: string) => void };
    }
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    recoverInterruptedFileBatches(this.dependencies.db);
    this.wake();
  }

  wake(): void {
    if (this.stopped || this.active) return;
    this.active = this.drain().finally(() => {
      this.active = null;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.active;
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      try {
        const result = await processNextFileBatchItem(this.dependencies);
        if (!result) return;
      } catch (error) {
        this.dependencies.log?.error({ err: error }, "File batch runner failed");
        return;
      }
    }
  }

}

interface ProcessedFileBatchItem {
  batchId: string;
  rootId: string;
  storagePoolId: string;
  completedCount: number;
  totalCount: number;
  finalStatus: "completed" | "failed" | "cancelled" | null;
}

export async function processNextFileBatchItem(
  dependencies: {
    db: ZosDatabase;
    config: ZosConfig;
    system?: SystemManagementDependencies;
  },
  onStarted?: (batch: FileBatchRecord) => void
): Promise<ProcessedFileBatchItem | null> {
  const claimed = claimNextFileBatchItem(dependencies.db);
  if (!claimed) return null;
  onStarted?.(claimed.batch);

  try {
    await applyClaimedItem(dependencies, claimed);
    const finished = finishFileBatchItem(dependencies.db, { itemId: claimed.item.id, status: "completed" });
    return processedResult(finished.batch, finished.finalStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finished = finishFileBatchItem(dependencies.db, {
      itemId: claimed.item.id,
      status: "failed",
      error: message
    });
    return processedResult(finished.batch, finished.finalStatus);
  }
}

async function applyClaimedItem(
  { db, config, system }: {
    db: ZosDatabase;
    config: ZosConfig;
    system?: SystemManagementDependencies;
  },
  { batch, item }: ClaimedFileBatchItem
): Promise<void> {
  if (getFileOperation(db, item.operationId)) return;

  const scope = await resolveStoragePoolScope(db, system, batch.rootId, batch.storagePoolId);
  const trashRoot = path.join(config.dataDir, "trash");
  if (batch.operation === "move" && !item.targetPath) {
    throw new Error("Move batch item is missing its target path");
  }
  if (batch.operation === "trash" && !item.trashEntryId) {
    throw new Error("Trash batch item is missing its recovery id");
  }
  const proposal: FileOperationProposal = batch.operation === "move"
    ? {
        operation: "move",
        rootId: batch.rootId,
        storagePoolId: batch.storagePoolId,
        sourcePath: item.sourcePath,
        targetPath: item.targetPath!,
        risk: "medium",
        reversible: true,
        summary: `Move ${item.sourcePath} to ${item.targetPath ?? ""}`
      }
    : {
        operation: "trash",
        rootId: batch.rootId,
        storagePoolId: batch.storagePoolId,
        sourcePath: item.sourcePath,
        trashEntryId: item.trashEntryId!,
        risk: "medium",
        reversible: true,
        summary: `Move ${item.sourcePath} to ZOS trash`
      };

  const recovered = await recoverAppliedMutation(scope, proposal, trashRoot);
  const result = recovered ?? await (async () => {
    await validateStoragePoolProposal(scope, proposal);
    return await applyFileMutation(scope.root, proposal, trashRoot);
  })();

  if (result.proposal.operation === "trash" && result.metadata.trashEntryId && result.targetPath) {
    const trashEntryId = String(result.metadata.trashEntryId);
    if (!getTrashEntry(db, trashEntryId)) {
      createTrashEntry(db, {
        id: trashEntryId,
        rootId: scope.root.id,
        originalPath: result.sourcePath ?? item.sourcePath,
        trashPath: path.join(trashRoot, result.targetPath),
        metadata: {
          ...result.metadata,
          storagePoolId: batch.storagePoolId,
          fileBatchId: batch.id
        }
      });
    }
  }

  recordAppliedOperation(db, {
    id: item.operationId,
    approvalId: null,
    operation: result.proposal.operation,
    sourcePath: result.sourcePath,
    targetPath: result.targetPath,
    status: "applied",
    metadata: {
      ...result.metadata,
      rootId: scope.root.id,
      storagePoolId: batch.storagePoolId,
      reversible: true,
      fileBatchId: batch.id,
      ...(recovered ? { recovered: true } : {})
    }
  });
}

async function recoverAppliedMutation(
  scope: Awaited<ReturnType<typeof resolveStoragePoolScope>>,
  proposal: FileOperationProposal,
  trashRoot: string
): Promise<Awaited<ReturnType<typeof applyFileMutation>> | null> {
  const sourceExists = await scopedPathExists(scope, proposal.sourcePath);
  if (proposal.operation === "move") {
    const targetExists = await scopedPathExists(scope, proposal.targetPath);
    if (sourceExists || !targetExists || !proposal.targetPath) return null;
    const target = await resolveScopedExistingPath(scope, proposal.targetPath);
    return {
      proposal,
      sourcePath: proposal.sourcePath ?? null,
      targetPath: target.relativePath,
      metadata: { absoluteTargetPath: target.realPath }
    };
  }
  if (proposal.operation !== "trash" || !proposal.sourcePath || !proposal.trashEntryId) return null;
  const trash = trashPathFor(trashRoot, scope.root.id, proposal.sourcePath, proposal.trashEntryId);
  const trashExists = await pathExists(trash.absoluteTrashPath);
  if (sourceExists && trashExists) {
    throw new Error("Trash recovery found both source and destination; refusing to overwrite either path");
  }
  if (sourceExists || !trashExists) return null;
  return {
    proposal: { ...proposal, targetPath: trash.relativeTrashPath },
    sourcePath: proposal.sourcePath,
    targetPath: trash.relativeTrashPath,
    metadata: { trashEntryId: trash.id, absoluteTrashPath: trash.absoluteTrashPath }
  };
}

async function scopedPathExists(
  scope: Awaited<ReturnType<typeof resolveStoragePoolScope>>,
  candidate: string | undefined
): Promise<boolean> {
  if (!candidate) return false;
  try {
    await resolveScopedExistingPath(scope, candidate);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function processedResult(
  batch: FileBatchRecord,
  finalStatus: ProcessedFileBatchItem["finalStatus"]
): ProcessedFileBatchItem {
  return {
    batchId: batch.id,
    rootId: batch.rootId,
    storagePoolId: batch.storagePoolId,
    completedCount: batch.completedCount,
    totalCount: batch.totalCount,
    finalStatus
  };
}
