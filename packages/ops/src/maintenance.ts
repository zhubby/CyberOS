import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  acquireExecutionLock,
  countUnrestoredTrashEntries,
  heartbeatExecutionLock,
  isExecutionLockOwner,
  releaseExecutionLock,
  runOpsMaintenanceRetention,
  type ZosDatabase
} from "@zos/db";
import type { OpsMaintenanceSummary, ZosConfig } from "@zos/shared";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_LOCK = "ops:maintenance";
const BACKUP_LOCK = "backup";

export async function runMaintenance(input: {
  db: ZosDatabase;
  config: ZosConfig;
  now?: Date;
}): Promise<OpsMaintenanceSummary> {
  const now = input.now ?? new Date();
  const owner = randomUUID();
  if (!acquireExecutionLock(input.db, { name: MAINTENANCE_LOCK, owner })) {
    throw new Error("maintenance already running");
  }
  const heartbeat = setInterval(() => {
    heartbeatExecutionLock(input.db, { name: MAINTENANCE_LOCK, owner });
  }, 5_000);
  heartbeat.unref?.();
  const ensureLease = (): void => {
    if (!isExecutionLockOwner(input.db, { name: MAINTENANCE_LOCK, owner })) {
      throw new Error("maintenance execution lease lost");
    }
  };

  try {
    ensureLease();
    const walCheckpoint = parseWalCheckpoint(input.db.pragma("wal_checkpoint(PASSIVE)"));
    input.db.pragma("optimize");
    ensureLease();
    const restoreStaging = await cleanupRestoreStaging(input.db, input.config, now);
    ensureLease();
    const retention = runOpsMaintenanceRetention(input.db, now);
    return {
      generatedAt: now.toISOString(),
      walCheckpoint,
      trash: { unrestoredEntries: countUnrestoredTrashEntries(input.db) },
      restoreStaging,
      retention
    };
  } finally {
    clearInterval(heartbeat);
    releaseExecutionLock(input.db, { name: MAINTENANCE_LOCK, owner });
  }
}

export async function cleanupRestoreStaging(
  db: ZosDatabase,
  config: ZosConfig,
  now = new Date()
): Promise<OpsMaintenanceSummary["restoreStaging"]> {
  const owner = randomUUID();
  if (!acquireExecutionLock(db, { name: BACKUP_LOCK, owner })) {
    return { status: "deferred", removed: 0, reason: "backup is running" };
  }
  const heartbeat = setInterval(() => {
    heartbeatExecutionLock(db, { name: BACKUP_LOCK, owner });
  }, 5_000);
  heartbeat.unref?.();
  const ensureLease = (): void => {
    if (!isExecutionLockOwner(db, { name: BACKUP_LOCK, owner })) {
      throw new Error("backup execution lease lost during restore staging cleanup");
    }
  };
  try {
    ensureLease();
    const stagingPath = path.resolve(
      config.backup?.stagingPath ?? path.join(config.dataDir, "backup-staging")
    );
    const stagingStat = await lstat(stagingPath).catch(() => null);
    if (!stagingStat) return { status: "completed", removed: 0, reason: null };
    if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
      throw new Error("backup staging path is not a real directory");
    }
    const stagingRealPath = await realpath(stagingPath);
    const entries = await readdir(stagingPath, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      ensureLease();
      if (!/^restore-[A-Za-z0-9._-]+$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(stagingPath, entry.name);
      const before = await lstat(absolutePath).catch(() => null);
      if (!before?.isDirectory() || before.isSymbolicLink()) continue;
      if (now.getTime() - before.mtimeMs < 7 * DAY_MS) continue;
      const candidateRealPath = await realpath(absolutePath).catch(() => null);
      if (!candidateRealPath || !candidateRealPath.startsWith(`${stagingRealPath}${path.sep}`)) {
        throw new Error("restore staging entry escaped the configured boundary");
      }
      const current = await stat(absolutePath).catch(() => null);
      if (!current || current.dev !== before.dev || current.ino !== before.ino) {
        throw new Error("restore staging entry changed during cleanup");
      }
      ensureLease();
      await rm(absolutePath, { recursive: true, force: false });
      removed += 1;
    }
    return { status: "completed", removed, reason: null };
  } finally {
    clearInterval(heartbeat);
    releaseExecutionLock(db, { name: BACKUP_LOCK, owner });
  }
}

function parseWalCheckpoint(value: unknown): OpsMaintenanceSummary["walCheckpoint"] {
  const row = Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === "object"
    ? value[0] as Record<string, unknown>
    : {};
  return {
    busy: numberValue(row.busy),
    logFrames: numberValue(row.log ?? row.logFrames),
    checkpointedFrames: numberValue(row.checkpointed ?? row.checkpointedFrames)
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
