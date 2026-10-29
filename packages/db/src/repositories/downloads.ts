import { randomUUID } from "node:crypto";
import type {
  DownloadControlRequest,
  DownloadErrorCode,
  DownloadMode,
  DownloadTaskPhase,
  DownloadTaskRecord,
  DownloadTaskStatus,
  DownloadWorkerHealth
  , TorrentFileRecord
  , TorrentPreviewDetails
  , TorrentPreviewRecord
  , TorrentTaskFileRecord
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import type { DbDownloadTaskRow } from "./repository-rows.js";

const DOWNLOAD_COLUMNS = `
  id, url, storage_pool_id, target_directory, target_file_name,
  target_path, partial_path, status, received_bytes, total_bytes,
  speed_bytes_per_second, etag, last_modified, error, worker_id,
  lease_expires_at, created_at, updated_at, started_at, finished_at,
  last_progress_at, file_operation_id, phase, download_mode,
  expected_sha256, actual_sha256, error_code, error_retryable,
  retry_count, next_retry_at, control_requested, segment_count,
  source_kind, torrent_info_hash, torrent_name, selected_file_count,
  uploaded_bytes, upload_speed_bytes_per_second, peer_count,
  seed_ratio_limit, seed_time_limit_seconds, content_completed_at,
  seed_started_at
`;

const TORRENT_PREVIEW_COLUMNS = `
  id, source_kind, source_uri, status, info_hash, name, total_bytes,
  file_count, is_private, error, worker_id, lease_expires_at,
  created_at, updated_at, expires_at
`;

type DbTorrentPreviewRow = {
  id: string;
  source_kind: "magnet" | "torrent";
  source_uri: string | null;
  status: TorrentPreviewRecord["status"];
  info_hash: string | null;
  name: string | null;
  total_bytes: number | null;
  file_count: number;
  is_private: 0 | 1;
  error: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

type DbTorrentFileRow = {
  file_index: number;
  path: string;
  size_bytes: number;
  selected?: 0 | 1;
  received_bytes?: number;
};

export function createTorrentPreview(
  db: CyberOsDatabase,
  input: {
    sourceKind: "magnet" | "torrent";
    sourceUri?: string | null;
    metainfo?: Uint8Array | null;
    ttlMs?: number;
    now?: Date;
  }
): TorrentPreviewRecord {
  const id = randomUUID();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 30 * 60_000)).toISOString();
  db.prepare(`
    INSERT INTO torrent_previews (
      id, source_kind, source_uri, metainfo, status, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
  `).run(
    id,
    input.sourceKind,
    input.sourceUri ?? null,
    input.metainfo ? Buffer.from(input.metainfo) : null,
    nowIso,
    nowIso,
    expiresAt
  );
  return getRequiredTorrentPreview(db, id);
}

export function getTorrentPreview(db: CyberOsDatabase, id: string): TorrentPreviewDetails | null {
  const row = db.prepare(`
    SELECT ${TORRENT_PREVIEW_COLUMNS}
    FROM torrent_previews
    WHERE id = ?
  `).get(id) as DbTorrentPreviewRow | undefined;
  if (!row) return null;
  const files = db.prepare(`
    SELECT file_index, path, size_bytes
    FROM torrent_preview_files
    WHERE preview_id = ?
    ORDER BY file_index
  `).all(id) as DbTorrentFileRow[];
  return { ...mapTorrentPreview(row), files: files.map(mapTorrentFile) };
}

export function deleteTorrentPreview(db: CyberOsDatabase, id: string): boolean {
  const result = db.prepare(`
    DELETE FROM torrent_previews
    WHERE id = ?
  `).run(id);
  return result.changes === 1;
}

export function claimNextTorrentPreview(
  db: CyberOsDatabase,
  input: { workerId: string; leaseMs: number; now?: Date }
): TorrentPreviewRecord | null {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  db.prepare(`
    UPDATE torrent_previews
    SET status = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'queued' END,
        worker_id = NULL,
        lease_expires_at = NULL,
        updated_at = ?
    WHERE status = 'resolving' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).run(nowIso, nowIso, nowIso);
  db.prepare(`
    UPDATE torrent_previews
    SET status = 'expired', updated_at = ?
    WHERE status = 'queued' AND expires_at <= ?
  `).run(nowIso, nowIso);
  const row = db.prepare(`
    UPDATE torrent_previews
    SET status = 'resolving', worker_id = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = (
      SELECT id FROM torrent_previews
      WHERE status = 'queued' AND expires_at > ?
      ORDER BY created_at
      LIMIT 1
    ) AND status = 'queued'
    RETURNING ${TORRENT_PREVIEW_COLUMNS}
  `).get(input.workerId, leaseExpiresAt, nowIso, nowIso) as DbTorrentPreviewRow | undefined;
  return row ? mapTorrentPreview(row) : null;
}

export function completeTorrentPreview(
  db: CyberOsDatabase,
  input: {
    id: string;
    workerId: string;
    infoHash: string;
    name: string;
    metainfo: Uint8Array;
    totalBytes: number;
    isPrivate: boolean;
    files: TorrentFileRecord[];
    now?: Date;
  }
): TorrentPreviewDetails {
  if (!input.files.length) throw new Error("Torrent preview must contain at least one file");
  const nowIso = (input.now ?? new Date()).toISOString();
  const complete = db.transaction(() => {
    const result = db.prepare(`
      UPDATE torrent_previews
      SET status = 'ready', info_hash = ?, name = ?, metainfo = ?, total_bytes = ?,
          file_count = ?, is_private = ?, error = NULL, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'resolving' AND worker_id = ?
    `).run(
      input.infoHash.toLowerCase(),
      input.name,
      Buffer.from(input.metainfo),
      input.totalBytes,
      input.files.length,
      input.isPrivate ? 1 : 0,
      nowIso,
      input.id,
      input.workerId
    );
    if (result.changes !== 1) throw new Error("Torrent preview lease was lost");
    const insertFile = db.prepare(`
      INSERT INTO torrent_preview_files (preview_id, file_index, path, size_bytes)
      VALUES (?, ?, ?, ?)
    `);
    for (const file of input.files) {
      insertFile.run(input.id, file.fileIndex, file.path, file.sizeBytes);
    }
  });
  complete.immediate();
  return getRequiredTorrentPreview(db, input.id);
}

export function createTorrentDownloadTask(
  db: CyberOsDatabase,
  input: {
    previewId: string;
    selectedFileIndices: number[];
    storagePoolId: string;
    targetDirectory: string;
    targetFileName: string;
    targetPath: string;
    seedRatioLimit?: number;
    seedTimeLimitSeconds?: number;
    now?: Date;
  }
): DownloadTaskRecord {
  const selected = [...new Set(input.selectedFileIndices)].sort((a, b) => a - b);
  if (!selected.length) throw new Error("Select at least one torrent file");
  const id = randomUUID();
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const create = db.transaction(() => {
    const preview = db.prepare(`
      SELECT source_kind, source_uri, metainfo, info_hash, name, is_private
      FROM torrent_previews
      WHERE id = ? AND status = 'ready' AND expires_at > ?
    `).get(input.previewId, nowIso) as {
      source_kind: "magnet" | "torrent";
      source_uri: string | null;
      metainfo: Buffer;
      info_hash: string;
      name: string;
      is_private: 0 | 1;
    } | undefined;
    if (!preview) throw new Error("Torrent preview is unavailable or expired");
    if (preview.is_private === 1) throw new Error("Private torrents are not supported");
    const files = db.prepare(`
      SELECT file_index, path, size_bytes
      FROM torrent_preview_files
      WHERE preview_id = ?
      ORDER BY file_index
    `).all(input.previewId) as DbTorrentFileRow[];
    const selectedSet = new Set(selected);
    if (selected.some((index) => !files.some((file) => file.file_index === index))) {
      throw new Error("Selected torrent file does not exist");
    }
    const totalBytes = files.reduce(
      (sum, file) => sum + (selectedSet.has(file.file_index) ? file.size_bytes : 0),
      0
    );
    const partialPath = `${input.targetDirectory}/.${id}.cyberos-torrent.part`;
    db.prepare(`
      INSERT INTO download_tasks (
        id, url, storage_pool_id, target_directory, target_file_name,
        target_path, partial_path, status, total_bytes, download_mode,
        source_kind, torrent_info_hash, torrent_name, torrent_metainfo,
        selected_file_count, seed_ratio_limit, seed_time_limit_seconds,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 'torrent', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      preview.source_uri ?? `torrent:${preview.info_hash}`,
      input.storagePoolId,
      input.targetDirectory,
      input.targetFileName,
      input.targetPath,
      partialPath,
      totalBytes,
      preview.source_kind,
      preview.info_hash,
      preview.name,
      preview.metainfo,
      selected.length,
      input.seedRatioLimit ?? 1,
      input.seedTimeLimitSeconds ?? 7_200,
      nowIso,
      nowIso
    );
    const insertFile = db.prepare(`
      INSERT INTO download_task_files (
        task_id, file_index, path, size_bytes, selected, received_bytes
      ) VALUES (?, ?, ?, ?, ?, 0)
    `);
    for (const file of files) {
      insertFile.run(
        id,
        file.file_index,
        file.path,
        file.size_bytes,
        selectedSet.has(file.file_index) ? 1 : 0
      );
    }
    db.prepare("DELETE FROM torrent_previews WHERE id = ?").run(input.previewId);
  });
  create.immediate();
  return getRequiredDownloadTask(db, id);
}

export function listDownloadTaskFiles(db: CyberOsDatabase, taskId: string): TorrentTaskFileRecord[] {
  const rows = db.prepare(`
    SELECT file_index, path, size_bytes, selected, received_bytes
    FROM download_task_files
    WHERE task_id = ?
    ORDER BY file_index
  `).all(taskId) as DbTorrentFileRow[];
  return rows.map((row) => ({
    ...mapTorrentFile(row),
    selected: row.selected === 1,
    receivedBytes: row.received_bytes ?? 0
  }));
}

export function createDownloadTask(
  db: CyberOsDatabase,
  input: {
    url: string;
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
      id, url, storage_pool_id, target_directory, target_file_name,
      target_path, partial_path, status, expected_sha256, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `).run(
    id,
    input.url,
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
      AND source_kind = 'http'
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      AND NOT EXISTS (
        SELECT 1 FROM download_publish_journal journal
        WHERE journal.task_id = download_tasks.id
      )
  `).run(nowIso, nowIso, nowIso);
  db.prepare(`
    DELETE FROM download_space_reservations
    WHERE task_id IN (
      SELECT id FROM download_tasks WHERE source_kind = 'http' AND status <> 'running'
    )
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
        AND source_kind = 'http'
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
    WHERE id = ? AND status IN ('running', 'seeding')
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
  const result = db.prepare(
    "DELETE FROM download_tasks WHERE id = ? AND status NOT IN ('running', 'seeding')"
  ).run(id);
  return result.changes === 1;
}

function getRequiredDownloadTask(db: CyberOsDatabase, id: string): DownloadTaskRecord {
  const task = getDownloadTask(db, id);
  if (!task) {
    throw new Error("Download task not found after write");
  }
  return task;
}

function getRequiredTorrentPreview(db: CyberOsDatabase, id: string): TorrentPreviewDetails {
  const preview = getTorrentPreview(db, id);
  if (!preview) throw new Error("Torrent preview not found after write");
  return preview;
}

function mapTorrentPreview(row: DbTorrentPreviewRow): TorrentPreviewRecord {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceUri: row.source_uri,
    status: row.status,
    infoHash: row.info_hash,
    name: row.name,
    totalBytes: row.total_bytes,
    fileCount: row.file_count,
    isPrivate: row.is_private === 1,
    error: row.error,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

function mapTorrentFile(row: DbTorrentFileRow): TorrentFileRecord {
  return {
    fileIndex: row.file_index,
    path: row.path,
    sizeBytes: row.size_bytes
  };
}

function mapDownloadTask(row: DbDownloadTaskRow): DownloadTaskRecord {
  return {
    id: row.id,
    url: row.url,
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
    segmentCount: row.segment_count,
    sourceKind: row.source_kind,
    torrentInfoHash: row.torrent_info_hash,
    torrentName: row.torrent_name,
    selectedFileCount: row.selected_file_count,
    uploadedBytes: row.uploaded_bytes,
    uploadSpeedBytesPerSecond: row.upload_speed_bytes_per_second,
    peerCount: row.peer_count,
    seedRatioLimit: row.seed_ratio_limit,
    seedTimeLimitSeconds: row.seed_time_limit_seconds,
    contentCompletedAt: row.content_completed_at,
    seedStartedAt: row.seed_started_at
  };
}
