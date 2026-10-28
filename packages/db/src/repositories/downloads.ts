import { randomUUID } from "node:crypto";
import type {
  DownloadControlRequest,
  DownloadErrorCode,
  DownloadMode,
  DownloadTaskPhase,
  DownloadTaskRecord,
  DownloadTaskStatus,
  DownloadWorkerHealth
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import type { DbDownloadTaskRow } from "./repository-rows.js";

const DOWNLOAD_COLUMNS = `
  id, url, root_id, storage_pool_id, target_directory, target_file_name,
  target_path, partial_path, status, received_bytes, total_bytes,
  speed_bytes_per_second, etag, last_modified, error, worker_id,
  lease_expires_at, created_at, updated_at, started_at, finished_at,
  last_progress_at, file_operation_id, phase, download_mode,
  expected_sha256, actual_sha256, error_code, error_retryable,
  retry_count, next_retry_at, control_requested, segment_count
`;

export function createDownloadTask(
  db: CyberOsDatabase,
  input: {
    url: string;
    rootId: string;
    storagePoolId: string;
    targetDirectory: string;
    targetFileName: string;
    targetPath: string;
    expectedSha256?: string | null;
    partialPath?: string;
    now?: Date;
  }
): DownloadTaskRecord {
  const id = randomUUID();
  const now = (input.now ?? new Date()).toISOString();
  const partialPath = input.partialPath ?? `${input.targetDirectory}/.${id}.cyberos-download.part`;
  db.prepare(`
    INSERT INTO download_tasks (
      id, url, root_id, storage_pool_id, target_directory, target_file_name,
      target_path, partial_path, status, expected_sha256, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `).run(
    id,
    input.url,
    input.rootId,
    input.storagePoolId,
    input.targetDirectory,
    input.targetFileName,
    input.targetPath,
    partialPath,
    input.expectedSha256 ?? null,
    now,
    now
  );
  return getRequiredDownloadTask(db, id);
}

export function getDownloadTask(db: CyberOsDatabase, id: string): DownloadTaskRecord | null {
  const row = db
    .prepare(`SELECT ${DOWNLOAD_COLUMNS} FROM download_tasks WHERE id = ?`)
    .get(id) as DbDownloadTaskRow | undefined;
  return row ? mapDownloadTask(row) : null;
}

export function listDownloadTasks(
  db: CyberOsDatabase,
  input: { statuses?: DownloadTaskStatus[]; limit?: number } = {}
): DownloadTaskRecord[] {
  const limit = Math.max(1, Math.min(input.limit ?? 500, 1_000));
  const statuses = input.statuses?.length ? [...new Set(input.statuses)] : null;
  const where = statuses ? `WHERE status IN (${statuses.map(() => "?").join(", ")})` : "";
  const rows = db
    .prepare(`
      SELECT ${DOWNLOAD_COLUMNS}
      FROM download_tasks
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(...(statuses ?? []), limit) as DbDownloadTaskRow[];
  return rows.map(mapDownloadTask);
}

export function recoverExpiredDownloadTasks(db: CyberOsDatabase, now = new Date()): number {
  const nowIso = now.toISOString();
  const result = db.prepare(`
    UPDATE download_tasks
    SET status = CASE control_requested
          WHEN 'pause' THEN 'paused'
          WHEN 'cancel' THEN 'cancelled'
          ELSE 'queued'
        END,
        worker_id = NULL,
        lease_expires_at = NULL,
        speed_bytes_per_second = 0,
        phase = NULL,
        control_requested = NULL,
        finished_at = CASE WHEN control_requested = 'cancel' THEN ? ELSE NULL END,
        updated_at = ?
    WHERE status = 'running'
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      AND NOT EXISTS (
        SELECT 1 FROM download_publish_journal journal
        WHERE journal.task_id = download_tasks.id
      )
  `).run(nowIso, nowIso, nowIso);
  db.prepare(`
    DELETE FROM download_space_reservations
    WHERE task_id IN (SELECT id FROM download_tasks WHERE status <> 'running')
  `).run();
  return result.changes;
}

export function claimNextDownloadTask(
  db: CyberOsDatabase,
  input: { workerId: string; leaseMs: number; now?: Date }
): DownloadTaskRecord | null {
  const now = input.now ?? new Date();
  recoverExpiredDownloadTasks(db, now);
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  const row = db.prepare(`
    UPDATE download_tasks
    SET status = 'running',
        worker_id = ?,
        lease_expires_at = ?,
        started_at = COALESCE(started_at, ?),
        finished_at = NULL,
        error = NULL,
        error_code = NULL,
        error_retryable = 0,
        phase = 'probing',
        next_retry_at = NULL,
        control_requested = NULL,
        updated_at = ?
    WHERE id = (
      SELECT id
      FROM download_tasks
      WHERE status = 'queued'
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM download_publish_journal journal
          WHERE journal.task_id = download_tasks.id
        )
      ORDER BY COALESCE(next_retry_at, created_at) ASC, created_at ASC
      LIMIT 1
    )
      AND status = 'queued'
    RETURNING ${DOWNLOAD_COLUMNS}
  `).get(input.workerId, leaseExpiresAt, nowIso, nowIso, nowIso) as DbDownloadTaskRow | undefined;
  return row ? mapDownloadTask(row) : null;
}

export function renewDownloadTaskLease(
  db: CyberOsDatabase,
  input: { id: string; workerId: string; leaseMs: number; now?: Date }
): boolean {
  const now = input.now ?? new Date();
  const result = db.prepare(`
    UPDATE download_tasks
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND worker_id = ? AND control_requested IS NULL
  `).run(
    new Date(now.getTime() + input.leaseMs).toISOString(),
    now.toISOString(),
    input.id,
    input.workerId
  );
  return result.changes === 1;
}

export function updateDownloadTaskProgress(
  db: CyberOsDatabase,
  input: {
    id: string;
    workerId: string;
    receivedBytes: number;
    totalBytes: number | null;
    speedBytesPerSecond: number;
    etag?: string | null;
    lastModified?: string | null;
    phase?: DownloadTaskPhase;
    downloadMode?: DownloadMode;
    segmentCount?: number;
    leaseMs: number;
    now?: Date;
  }
): boolean {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const result = db.prepare(`
    UPDATE download_tasks
    SET received_bytes = ?,
        total_bytes = ?,
        speed_bytes_per_second = ?,
        etag = COALESCE(?, etag),
        last_modified = COALESCE(?, last_modified),
        phase = COALESCE(?, phase),
        download_mode = COALESCE(?, download_mode),
        segment_count = COALESCE(?, segment_count),
        lease_expires_at = ?,
        last_progress_at = ?,
        updated_at = ?
    WHERE id = ? AND status = 'running' AND worker_id = ? AND control_requested IS NULL
  `).run(
    Math.max(0, Math.floor(input.receivedBytes)),
    input.totalBytes === null ? null : Math.max(0, Math.floor(input.totalBytes)),
    Math.max(0, Math.floor(input.speedBytesPerSecond)),
    input.etag ?? null,
    input.lastModified ?? null,
    input.phase ?? null,
    input.downloadMode ?? null,
    input.segmentCount ?? null,
    new Date(now.getTime() + input.leaseMs).toISOString(),
    nowIso,
    nowIso,
    input.id,
    input.workerId
  );
  return result.changes === 1;
}

export function transitionDownloadTask(
  db: CyberOsDatabase,
  input: {
    id: string;
    from: DownloadTaskStatus[];
    to: DownloadTaskStatus;
    error?: string | null;
    errorCode?: DownloadErrorCode | null;
    errorRetryable?: boolean;
    resetProgress?: boolean;
    now?: Date;
  }
): DownloadTaskRecord | null {
  if (!input.from.length) {
    return null;
  }
  const nowIso = (input.now ?? new Date()).toISOString();
  const finishedAt = input.to === "completed" || input.to === "failed" || input.to === "cancelled"
    ? nowIso
    : null;
  const reset = input.resetProgress === true;
  const row = db.prepare(`
    UPDATE download_tasks
    SET status = ?,
        error = ?,
        error_code = ?,
        error_retryable = ?,
        worker_id = NULL,
        lease_expires_at = NULL,
        speed_bytes_per_second = 0,
        received_bytes = CASE WHEN ? THEN 0 ELSE received_bytes END,
        total_bytes = CASE WHEN ? THEN NULL ELSE total_bytes END,
        etag = CASE WHEN ? THEN NULL ELSE etag END,
        last_modified = CASE WHEN ? THEN NULL ELSE last_modified END,
        actual_sha256 = CASE WHEN ? THEN NULL ELSE actual_sha256 END,
        phase = NULL,
        download_mode = CASE WHEN ? THEN NULL ELSE download_mode END,
        segment_count = CASE WHEN ? THEN 0 ELSE segment_count END,
        retry_count = CASE WHEN ? THEN 0 ELSE retry_count END,
        next_retry_at = NULL,
        control_requested = NULL,
        finished_at = ?,
        updated_at = ?
    WHERE id = ?
      AND status IN (${input.from.map(() => "?").join(", ")})
    RETURNING ${DOWNLOAD_COLUMNS}
  `).get(
    input.to,
    input.error ?? null,
    input.errorCode ?? null,
    input.errorRetryable ? 1 : 0,
    reset ? 1 : 0,
    reset ? 1 : 0,
    reset ? 1 : 0,
    reset ? 1 : 0,
    reset ? 1 : 0,
    reset ? 1 : 0,
    reset ? 1 : 0,
    reset ? 1 : 0,
    finishedAt,
    nowIso,
    input.id,
    ...input.from
  ) as DbDownloadTaskRow | undefined;
  if (row && reset) {
    db.prepare("DELETE FROM download_segments WHERE task_id = ?").run(input.id);
    db.prepare("DELETE FROM download_space_reservations WHERE task_id = ?").run(input.id);
  }
  return row ? mapDownloadTask(row) : null;
}

export function completeDownloadTask(
  db: CyberOsDatabase,
  input: {
    id: string;
    workerId: string;
    receivedBytes: number;
    totalBytes: number | null;
    fileOperationId: string;
    now?: Date;
  }
): DownloadTaskRecord | null {
  const nowIso = (input.now ?? new Date()).toISOString();
  const row = db.prepare(`
    UPDATE download_tasks
    SET status = 'completed',
        received_bytes = ?,
        total_bytes = COALESCE(?, total_bytes, ?),
        speed_bytes_per_second = 0,
        worker_id = NULL,
        lease_expires_at = NULL,
        error = NULL,
        error_code = NULL,
        error_retryable = 0,
        phase = NULL,
        control_requested = NULL,
        next_retry_at = NULL,
        finished_at = ?,
        last_progress_at = ?,
        file_operation_id = ?,
        updated_at = ?
    WHERE id = ? AND status = 'running' AND worker_id = ?
    RETURNING ${DOWNLOAD_COLUMNS}
  `).get(
    Math.max(0, Math.floor(input.receivedBytes)),
    input.totalBytes,
    Math.max(0, Math.floor(input.receivedBytes)),
    nowIso,
    nowIso,
    input.fileOperationId,
    nowIso,
    input.id,
    input.workerId
  ) as DbDownloadTaskRow | undefined;
  return row ? mapDownloadTask(row) : null;
}

export function resetDownloadTaskPartialState(
  db: CyberOsDatabase,
  input: { id: string; workerId: string; now?: Date }
): boolean {
  const nowIso = (input.now ?? new Date()).toISOString();
  const result = db.prepare(`
    UPDATE download_tasks
    SET received_bytes = 0,
        total_bytes = NULL,
        speed_bytes_per_second = 0,
        etag = NULL,
        last_modified = NULL,
        actual_sha256 = NULL,
        download_mode = NULL,
        segment_count = 0,
        last_progress_at = ?,
        updated_at = ?
    WHERE id = ? AND status = 'running' AND worker_id = ?
  `).run(nowIso, nowIso, input.id, input.workerId);
  return result.changes === 1;
}

export function requestDownloadTaskControl(
  db: CyberOsDatabase,
  input: { id: string; request: DownloadControlRequest; now?: Date }
): DownloadTaskRecord | null {
  const row = db.prepare(`
    UPDATE download_tasks
    SET control_requested = CASE
          WHEN control_requested = 'cancel' THEN 'cancel'
          ELSE ?
        END,
        updated_at = ?
    WHERE id = ? AND status = 'running'
    RETURNING ${DOWNLOAD_COLUMNS}
  `).get(input.request, (input.now ?? new Date()).toISOString(), input.id) as DbDownloadTaskRow | undefined;
  return row ? mapDownloadTask(row) : null;
}

export function getDownloadWorkerHealth(db: CyberOsDatabase, now = new Date()): DownloadWorkerHealth {
  const readyCutoff = new Date(now.getTime() - 15_000).toISOString();
  const staleCutoff = new Date(now.getTime() - 60_000).toISOString();
  const workers = db.prepare(`
    SELECT COUNT(*) AS fresh_workers, MAX(heartbeat_at) AS last_heartbeat_at
    FROM download_workers
    WHERE heartbeat_at >= ?
  `).get(readyCutoff) as { fresh_workers: number; last_heartbeat_at: string | null };
  const last = workers.last_heartbeat_at ?? (db.prepare(
    "SELECT MAX(heartbeat_at) FROM download_workers"
  ).pluck().get() as string | null | undefined) ?? null;
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS active_tasks,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_tasks,
      SUM(CASE WHEN status = 'queued' AND phase = 'retry_wait' THEN 1 ELSE 0 END) AS retry_wait_tasks
    FROM download_tasks
  `).get() as { active_tasks: number | null; queued_tasks: number | null; retry_wait_tasks: number | null };
  return {
    status: workers.fresh_workers > 0 ? "ready" : last && last >= staleCutoff ? "stale" : "unavailable",
    freshWorkers: workers.fresh_workers,
    lastHeartbeatAt: last,
    activeTasks: counts.active_tasks ?? 0,
    queuedTasks: counts.queued_tasks ?? 0,
    retryWaitTasks: counts.retry_wait_tasks ?? 0
  };
}

export function deleteDownloadTask(db: CyberOsDatabase, id: string): boolean {
  const result = db.prepare("DELETE FROM download_tasks WHERE id = ? AND status <> 'running'").run(id);
  return result.changes === 1;
}

function getRequiredDownloadTask(db: CyberOsDatabase, id: string): DownloadTaskRecord {
  const task = getDownloadTask(db, id);
  if (!task) {
    throw new Error("Download task not found after write");
  }
  return task;
}

function mapDownloadTask(row: DbDownloadTaskRow): DownloadTaskRecord {
  return {
    id: row.id,
    url: row.url,
    rootId: row.root_id,
    storagePoolId: row.storage_pool_id,
    targetDirectory: row.target_directory,
    targetFileName: row.target_file_name,
    targetPath: row.target_path,
    partialPath: row.partial_path,
    status: row.status,
    receivedBytes: row.received_bytes,
    totalBytes: row.total_bytes,
    speedBytesPerSecond: row.speed_bytes_per_second,
    etag: row.etag,
    lastModified: row.last_modified,
    error: row.error,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastProgressAt: row.last_progress_at,
    fileOperationId: row.file_operation_id,
    phase: row.phase,
    downloadMode: row.download_mode,
    expectedSha256: row.expected_sha256,
    actualSha256: row.actual_sha256,
    errorCode: row.error_code,
    errorRetryable: row.error_retryable === 1,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at,
    controlRequested: row.control_requested,
    segmentCount: row.segment_count
  };
}
