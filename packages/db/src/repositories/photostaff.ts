import { randomUUID } from "node:crypto";
import type {
  PhotostaffAssetRecord,
  PhotostaffAssetStatus,
  PhotostaffJobKind,
  PhotostaffJobPhase,
  PhotostaffJobRecord,
  PhotostaffLibrarySettingsRecord,
  PhotostaffLibraryStatus,
  PhotostaffWorkerHealth,
  PhotostaffTakenAtSource
} from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import type { DbPhotostaffAssetRow, DbPhotostaffJobRow, DbSystemSettingRow } from "./repository-rows.js";
import {
  getPhotostaffMetadataIndexStatus,
  hasStalePhotostaffMetadata,
  replacePhotostaffAssetMetadata,
  type PhotostaffMetadataWriteInput
} from "./photostaff-metadata.js";

const PHOTOSTAFF_LIBRARY_SETTING_KEY = "photostaff_library_settings";
const PHOTOSTAFF_ASSET_COLUMNS = `
  id, root_id, storage_pool_id, path, name, mime_type, size_bytes, mtime_ms,
  content_hash, width, height, orientation, taken_at, taken_at_source,
  thumbnail_key, preview_key, status, error, error_code, error_retryable,
  derivative_schema_version, library_updated_at, indexed_at
`;
const PHOTOSTAFF_JOB_COLUMNS = `
  id, kind, status, root_id, storage_pool_id, path, library_updated_at,
  scanned, processed, failed, current_path, phase, error, error_code,
  error_retryable, retry_count, next_retry_at, scan_generation, worker_id, lease_expires_at,
  created_at, updated_at, started_at, finished_at
`;

export interface PhotostaffTimelineCursor {
  takenAt: string;
  id: string;
}

export interface PhotostaffUploadReservationInput {
  settings: PhotostaffLibrarySettingsRecord;
  path: string;
  contentHash: string;
  now?: Date;
}

export interface PhotostaffUploadReservationRecord {
  id: string;
  libraryUpdatedAt: string;
  contentHash: string;
  path: string;
  createdAt: string;
}

export interface PhotostaffUploadReservationResult {
  reservation: PhotostaffUploadReservationRecord | null;
  duplicate: PhotostaffAssetRecord | PhotostaffUploadReservationRecord | null;
  conflict: "content_hash" | "path" | null;
}

export function getPhotostaffLibrarySettings(db: ZosDatabase): PhotostaffLibrarySettingsRecord | null {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(PHOTOSTAFF_LIBRARY_SETTING_KEY) as DbSystemSettingRow | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json) as Partial<PhotostaffLibrarySettingsRecord>;
    if (!isNonEmptyString(parsed.rootId) || !isNonEmptyString(parsed.storagePoolId) || !isNonEmptyString(parsed.path)) {
      return null;
    }
    return {
      rootId: parsed.rootId,
      storagePoolId: parsed.storagePoolId,
      path: parsed.path,
      updatedAt: isNonEmptyString(parsed.updatedAt) ? parsed.updatedAt : row.updated_at
    };
  } catch {
    return null;
  }
}

export function savePhotostaffLibrarySettings(
  db: ZosDatabase,
  input: Omit<PhotostaffLibrarySettingsRecord, "updatedAt">,
  now = new Date()
): PhotostaffLibrarySettingsRecord {
  const existing = getPhotostaffLibrarySettings(db);
  if (
    existing &&
    existing.rootId === input.rootId.trim() &&
    existing.storagePoolId === input.storagePoolId.trim() &&
    existing.path === input.path.trim()
  ) {
    return existing;
  }
  const requestedUpdatedAt = now.getTime();
  const previousUpdatedAt = existing ? Date.parse(existing.updatedAt) : Number.NaN;
  const updatedAt = new Date(Number.isFinite(previousUpdatedAt)
    ? Math.max(requestedUpdatedAt, previousUpdatedAt + 1)
    : requestedUpdatedAt).toISOString();
  const record: PhotostaffLibrarySettingsRecord = {
    rootId: input.rootId.trim(),
    storagePoolId: input.storagePoolId.trim(),
    path: input.path.trim(),
    updatedAt
  };
  if (!record.rootId || !record.storagePoolId || !record.path) {
    throw new Error("Photostaff library root, storage pool, and path are required");
  }
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO system_settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(PHOTOSTAFF_LIBRARY_SETTING_KEY, JSON.stringify(record), updatedAt);
    db.prepare("DELETE FROM photostaff_assets").run();
    db.prepare("DELETE FROM photostaff_upload_reservations").run();
    db.prepare(`
      UPDATE photostaff_jobs
      SET status = 'failed', error = 'Photostaff library configuration changed',
          worker_id = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
      WHERE status IN ('queued', 'running', 'retrying')
    `).run(updatedAt, updatedAt);
  });
  tx();
  return record;
}

export function enqueuePhotostaffJob(
  db: ZosDatabase,
  input: {
    settings: PhotostaffLibrarySettingsRecord;
    kind?: PhotostaffJobKind;
    path?: string;
    now?: Date;
    queueAfterRunning?: boolean;
  }
): PhotostaffJobRecord {
  const kind = input.kind ?? "full_scan";
  const jobPath = input.path ?? input.settings.path;
  const now = (input.now ?? new Date()).toISOString();
  const tx = db.transaction(() => {
    const existing = db.prepare(`
      SELECT ${PHOTOSTAFF_JOB_COLUMNS}
      FROM photostaff_jobs
      WHERE library_updated_at = ? AND kind = ? AND path = ?
        AND ${input.queueAfterRunning ? "status = 'queued'" : "status IN ('queued', 'running')"}
      ORDER BY created_at ASC LIMIT 1
    `).get(input.settings.updatedAt, kind, jobPath) as DbPhotostaffJobRow | undefined;
    if (existing) return mapPhotostaffJob(existing);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO photostaff_jobs (
        id, kind, status, root_id, storage_pool_id, path, library_updated_at,
        scan_generation, created_at, updated_at
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      kind,
      input.settings.rootId,
      input.settings.storagePoolId,
      jobPath,
      input.settings.updatedAt,
      id,
      now,
      now
    );
    return getRequiredPhotostaffJob(db, id);
  });
  return tx();
}

export function ensurePeriodicPhotostaffScan(
  db: ZosDatabase,
  settings: PhotostaffLibrarySettingsRecord,
  input: { intervalMs: number; now?: Date }
): PhotostaffJobRecord | null {
  const now = input.now ?? new Date();
  const latest = db.prepare(`
    SELECT ${PHOTOSTAFF_JOB_COLUMNS}
    FROM photostaff_jobs
    WHERE library_updated_at = ? AND kind = 'full_scan'
    ORDER BY created_at DESC LIMIT 1
  `).get(settings.updatedAt) as DbPhotostaffJobRow | undefined;
  if (latest && (latest.status === "queued" || latest.status === "running")) return mapPhotostaffJob(latest);
  if (hasStalePhotostaffMetadata(db, settings.updatedAt)) return enqueuePhotostaffJob(db, { settings, now });
  if (latest && now.getTime() - new Date(latest.created_at).getTime() < input.intervalMs) return null;
  return enqueuePhotostaffJob(db, { settings, now });
}

export function recoverExpiredPhotostaffJobs(db: ZosDatabase, now = new Date()): number {
  const nowIso = now.toISOString();
  return db.prepare(`
    UPDATE photostaff_jobs
    SET status = 'queued', worker_id = NULL, lease_expires_at = NULL,
        phase = NULL, error = NULL, error_code = NULL, error_retryable = 0,
        next_retry_at = NULL, updated_at = ?
    WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).run(nowIso, nowIso).changes;
}

export function claimNextPhotostaffJob(
  db: ZosDatabase,
  input: { workerId: string; leaseMs: number; now?: Date }
): PhotostaffJobRecord | null {
  const now = input.now ?? new Date();
  recoverExpiredPhotostaffJobs(db, now);
  const nowIso = now.toISOString();
  const row = db.prepare(`
    UPDATE photostaff_jobs
    SET status = 'running', worker_id = ?, lease_expires_at = ?,
        started_at = COALESCE(started_at, ?), finished_at = NULL,
        phase = COALESCE(phase, 'discovering'), error = NULL, error_code = NULL,
        error_retryable = 0, next_retry_at = NULL, updated_at = ?
    WHERE id = (
      SELECT id FROM photostaff_jobs
      WHERE status = 'queued' OR (status = 'retrying' AND next_retry_at <= ?)
      ORDER BY created_at ASC LIMIT 1
    ) AND (status = 'queued' OR (status = 'retrying' AND next_retry_at <= ?))
    RETURNING ${PHOTOSTAFF_JOB_COLUMNS}
  `).get(
    input.workerId,
    new Date(now.getTime() + input.leaseMs).toISOString(),
    nowIso,
    nowIso,
    nowIso,
    nowIso
  ) as DbPhotostaffJobRow | undefined;
  return row ? mapPhotostaffJob(row) : null;
}

export function updatePhotostaffJobProgress(
  db: ZosDatabase,
  input: {
    id: string;
    workerId: string;
    scanned: number;
    processed: number;
    failed: number;
    currentPath: string | null;
    phase?: PhotostaffJobPhase;
    leaseMs: number;
    now?: Date;
  }
): boolean {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  return db.prepare(`
    UPDATE photostaff_jobs
    SET scanned = ?, processed = ?, failed = ?, current_path = ?, phase = COALESCE(?, phase),
        lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND worker_id = ?
  `).run(
    input.scanned,
    input.processed,
    input.failed,
    input.currentPath,
    input.phase ?? null,
    new Date(now.getTime() + input.leaseMs).toISOString(),
    nowIso,
    input.id,
    input.workerId
  ).changes === 1;
}

export function finishPhotostaffJob(
  db: ZosDatabase,
  input: { id: string; workerId: string; error?: string | null; now?: Date }
): PhotostaffJobRecord | null {
  const nowIso = (input.now ?? new Date()).toISOString();
  const status = input.error ? "failed" : "completed";
  const row = db.prepare(`
    UPDATE photostaff_jobs
    SET status = ?, error = ?, worker_id = NULL, lease_expires_at = NULL,
        current_path = NULL, phase = NULL,
        error_code = CASE WHEN ? IS NULL THEN NULL ELSE 'INTERNAL' END,
        error_retryable = 0, next_retry_at = NULL, finished_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND worker_id = ?
    RETURNING ${PHOTOSTAFF_JOB_COLUMNS}
  `).get(status, input.error ?? null, input.error ?? null, nowIso, nowIso, input.id, input.workerId) as DbPhotostaffJobRow | undefined;
  return row ? mapPhotostaffJob(row) : null;
}

export function upsertPhotostaffAsset(
  db: ZosDatabase,
  input: {
    settings: PhotostaffLibrarySettingsRecord;
    path: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    mtimeMs: number;
    contentHash: string | null;
    width: number | null;
    height: number | null;
    orientation: number | null;
    takenAt: string;
    takenAtSource: PhotostaffTakenAtSource;
    thumbnailKey: string | null;
    previewKey: string | null;
    status: PhotostaffAssetStatus;
    error: string | null;
    metadata?: PhotostaffMetadataWriteInput;
    indexedAt?: Date;
  }
): PhotostaffAssetRecord {
  const tx = db.transaction(() => {
    const currentSettings = getPhotostaffLibrarySettings(db);
    if (!currentSettings || currentSettings.updatedAt !== input.settings.updatedAt) {
      throw new Error("Photostaff library configuration changed");
    }
    const id = randomUUID();
    const indexedAt = (input.indexedAt ?? new Date()).toISOString();
    db.prepare(`
      INSERT INTO photostaff_assets (
        id, root_id, storage_pool_id, path, name, mime_type, size_bytes, mtime_ms,
        content_hash, width, height, orientation, taken_at, taken_at_source,
        thumbnail_key, preview_key, status, error, library_updated_at, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(root_id, storage_pool_id, path) DO UPDATE SET
        name = excluded.name, mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms,
        content_hash = excluded.content_hash, width = excluded.width,
        height = excluded.height, orientation = excluded.orientation,
        taken_at = excluded.taken_at, taken_at_source = excluded.taken_at_source,
        thumbnail_key = excluded.thumbnail_key, preview_key = excluded.preview_key,
        status = excluded.status, error = excluded.error,
        library_updated_at = excluded.library_updated_at, indexed_at = excluded.indexed_at
    `).run(
      id,
      input.settings.rootId,
      input.settings.storagePoolId,
      input.path,
      input.name,
      input.mimeType,
      input.sizeBytes,
      input.mtimeMs,
      input.contentHash,
      input.width,
      input.height,
      input.orientation,
      input.takenAt,
      input.takenAtSource,
      input.thumbnailKey,
      input.previewKey,
      input.status,
      input.error,
      input.settings.updatedAt,
      indexedAt
    );
    const row = db.prepare(`
      SELECT ${PHOTOSTAFF_ASSET_COLUMNS} FROM photostaff_assets
      WHERE root_id = ? AND storage_pool_id = ? AND path = ?
    `).get(input.settings.rootId, input.settings.storagePoolId, input.path) as DbPhotostaffAssetRow;
    db.prepare(`
      DELETE FROM photostaff_upload_reservations
      WHERE library_updated_at = ? AND path = ?
    `).run(input.settings.updatedAt, input.path);
    const asset = mapPhotostaffAsset(row);
    if (input.metadata) replacePhotostaffAssetMetadata(db, asset, input.metadata, input.indexedAt);
    return asset;
  });
  return tx();
}

export function getPhotostaffAsset(db: ZosDatabase, id: string, libraryUpdatedAt: string): PhotostaffAssetRecord | null {
  const row = db.prepare(`
    SELECT ${PHOTOSTAFF_ASSET_COLUMNS} FROM photostaff_assets
    WHERE id = ? AND library_updated_at = ?
  `).get(id, libraryUpdatedAt) as DbPhotostaffAssetRow | undefined;
  return row ? mapPhotostaffAsset(row) : null;
}

export function getPhotostaffAssetByPath(
  db: ZosDatabase,
  input: { rootId: string; storagePoolId: string; path: string }
): PhotostaffAssetRecord | null {
  const row = db.prepare(`
    SELECT ${PHOTOSTAFF_ASSET_COLUMNS} FROM photostaff_assets
    WHERE root_id = ? AND storage_pool_id = ? AND path = ?
  `).get(input.rootId, input.storagePoolId, input.path) as DbPhotostaffAssetRow | undefined;
  return row ? mapPhotostaffAsset(row) : null;
}

export function findPhotostaffAssetByHash(
  db: ZosDatabase,
  input: { libraryUpdatedAt: string; contentHash: string }
): PhotostaffAssetRecord | null {
  const row = db.prepare(`
    SELECT ${PHOTOSTAFF_ASSET_COLUMNS} FROM photostaff_assets
    WHERE library_updated_at = ? AND content_hash = ? AND status = 'ready'
    ORDER BY indexed_at ASC LIMIT 1
  `).get(input.libraryUpdatedAt, input.contentHash) as DbPhotostaffAssetRow | undefined;
  return row ? mapPhotostaffAsset(row) : null;
}

export function reservePhotostaffUpload(
  db: ZosDatabase,
  input: PhotostaffUploadReservationInput
): PhotostaffUploadReservationResult {
  const reserve = db.transaction(() => {
    const currentSettings = getPhotostaffLibrarySettings(db);
    if (!currentSettings || currentSettings.updatedAt !== input.settings.updatedAt) {
      throw new Error("Photostaff library configuration changed");
    }
    const duplicate = findPhotostaffAssetByHash(db, {
      libraryUpdatedAt: input.settings.updatedAt,
      contentHash: input.contentHash
    });
    if (duplicate) return { reservation: null, duplicate, conflict: "content_hash" } as const;

    const id = randomUUID();
    const createdAt = (input.now ?? new Date()).toISOString();
    const inserted = db.prepare(`
      INSERT INTO photostaff_upload_reservations (id, library_updated_at, content_hash, path, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(id, input.settings.updatedAt, input.contentHash, input.path, createdAt);
    if (inserted.changes === 1) {
      return {
        reservation: { id, libraryUpdatedAt: input.settings.updatedAt, contentHash: input.contentHash, path: input.path, createdAt },
        duplicate: null,
        conflict: null
      } as const;
    }

    const hashConflict = getPhotostaffUploadReservation(db, {
      libraryUpdatedAt: input.settings.updatedAt,
      contentHash: input.contentHash
    });
    if (hashConflict) return { reservation: null, duplicate: hashConflict, conflict: "content_hash" } as const;
    const pathConflict = getPhotostaffUploadReservation(db, {
      libraryUpdatedAt: input.settings.updatedAt,
      path: input.path
    });
    if (pathConflict) return { reservation: null, duplicate: pathConflict, conflict: "path" } as const;
    throw new Error("Photostaff upload reservation conflict could not be resolved");
  });
  return reserve.immediate();
}

export function releasePhotostaffUploadReservation(
  db: ZosDatabase,
  input: { id: string; libraryUpdatedAt: string }
): boolean {
  return db.prepare(`
    DELETE FROM photostaff_upload_reservations
    WHERE id = ? AND library_updated_at = ?
  `).run(input.id, input.libraryUpdatedAt).changes === 1;
}

export function removeStalePhotostaffUploadReservations(
  db: ZosDatabase,
  input: { libraryUpdatedAt: string; createdBefore: string }
): number {
  return db.prepare(`
    DELETE FROM photostaff_upload_reservations
    WHERE library_updated_at = ? AND created_at < ?
  `).run(input.libraryUpdatedAt, input.createdBefore).changes;
}

export function hasCompletedPhotostaffScan(db: ZosDatabase, libraryUpdatedAt: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM photostaff_jobs
    WHERE library_updated_at = ? AND kind = 'full_scan' AND status = 'completed'
    LIMIT 1
  `).pluck().get(libraryUpdatedAt));
}

export function listPhotostaffAssets(
  db: ZosDatabase,
  input: { libraryUpdatedAt: string; limit: number; cursor?: PhotostaffTimelineCursor | null }
): { photostaff: PhotostaffAssetRecord[]; hasMore: boolean } {
  const limit = Math.max(1, Math.min(input.limit, 100));
  const cursorClause = input.cursor ? "AND (taken_at < ? OR (taken_at = ? AND id < ?))" : "";
  const cursorParams = input.cursor ? [input.cursor.takenAt, input.cursor.takenAt, input.cursor.id] : [];
  const rows = db.prepare(`
    SELECT ${PHOTOSTAFF_ASSET_COLUMNS}
    FROM photostaff_assets
    WHERE library_updated_at = ? AND status = 'ready' ${cursorClause}
    ORDER BY taken_at DESC, id DESC
    LIMIT ?
  `).all(input.libraryUpdatedAt, ...cursorParams, limit + 1) as DbPhotostaffAssetRow[];
  return { photostaff: rows.slice(0, limit).map(mapPhotostaffAsset), hasMore: rows.length > limit };
}

export function removeStalePhotostaffAssets(
  db: ZosDatabase,
  input: { libraryUpdatedAt: string; indexedBefore: string }
): number {
  return db.prepare(`
    DELETE FROM photostaff_assets WHERE library_updated_at = ? AND indexed_at < ?
  `).run(input.libraryUpdatedAt, input.indexedBefore).changes;
}

export function listPhotostaffDerivativeKeys(db: ZosDatabase, libraryUpdatedAt: string): Set<string> {
  const rows = db.prepare(`
    SELECT thumbnail_key, preview_key FROM photostaff_assets
    WHERE library_updated_at = ? AND status = 'ready'
  `).all(libraryUpdatedAt) as Array<{ thumbnail_key: string | null; preview_key: string | null }>;
  return new Set(rows.flatMap((row) => [row.thumbnail_key, row.preview_key].filter((key): key is string => Boolean(key))));
}

export function getPhotostaffLibraryStatus(
  db: ZosDatabase,
  settings: PhotostaffLibrarySettingsRecord | null
): PhotostaffLibraryStatus {
  if (!settings) {
    return { state: "unconfigured", total: 0, failed: 0, scanned: 0, processed: 0, currentPath: null, phase: null, error: null, errorCode: null, retryCount: 0, nextRetryAt: null, updatedAt: null };
  }
  const counts = db.prepare(`
    SELECT SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS total,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM photostaff_assets WHERE library_updated_at = ?
  `).get(settings.updatedAt) as { total: number | null; failed: number | null };
  const row = db.prepare(`
    SELECT ${PHOTOSTAFF_JOB_COLUMNS} FROM photostaff_jobs
    WHERE library_updated_at = ? ORDER BY created_at DESC LIMIT 1
  `).get(settings.updatedAt) as DbPhotostaffJobRow | undefined;
  const total = counts.total ?? 0;
  const failed = counts.failed ?? 0;
  const metadataIndex = getPhotostaffMetadataIndexStatus(db, settings.updatedAt);
  if (!row) {
    return { state: "queued", total, failed, metadataIndex, scanned: 0, processed: 0, currentPath: null, phase: null, error: null, errorCode: null, retryCount: 0, nextRetryAt: null, updatedAt: settings.updatedAt };
  }
  const job = mapPhotostaffJob(row);
  const state = job.status === "queued"
    ? "queued"
    : job.status === "running"
      ? job.phase === "processing" || job.phase === "publishing"
        ? "processing"
        : "discovering"
      : job.status === "retrying"
        ? "retrying"
      : job.status === "failed"
        ? "degraded"
        : failed > 0
          ? "degraded"
          : "ready";
  return {
    state,
    total,
    failed,
    metadataIndex,
    scanned: job.scanned,
    processed: job.processed,
    currentPath: job.currentPath,
    phase: job.phase,
    error: job.error,
    errorCode: job.errorCode,
    retryCount: job.retryCount,
    nextRetryAt: job.nextRetryAt,
    updatedAt: job.updatedAt
  };
}

export function getPhotostaffWorkerHealth(db: ZosDatabase, now = new Date()): PhotostaffWorkerHealth {
  const worker = db.prepare("SELECT heartbeat_at FROM photostaff_workers ORDER BY heartbeat_at DESC LIMIT 1")
    .get() as { heartbeat_at: string } | undefined;
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS active_jobs,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_jobs,
      SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END) AS retrying_jobs
    FROM photostaff_jobs
  `).get() as { active_jobs: number | null; queued_jobs: number | null; retrying_jobs: number | null };
  const lastHeartbeatAt = worker?.heartbeat_at ?? null;
  const ageMs = lastHeartbeatAt ? now.getTime() - Date.parse(lastHeartbeatAt) : Number.POSITIVE_INFINITY;
  const status = ageMs <= 15_000 ? "ready" : ageMs <= 60_000 ? "stale" : "unavailable";
  const freshWorkers = db.prepare("SELECT COUNT(*) FROM photostaff_workers WHERE heartbeat_at >= ?")
    .pluck().get(new Date(now.getTime() - 15_000).toISOString()) as number;
  return {
    status,
    freshWorkers,
    lastHeartbeatAt,
    activeJobs: counts.active_jobs ?? 0,
    queuedJobs: counts.queued_jobs ?? 0,
    retryingJobs: counts.retrying_jobs ?? 0
  };
}

function getRequiredPhotostaffJob(db: ZosDatabase, id: string): PhotostaffJobRecord {
  const row = db.prepare(`SELECT ${PHOTOSTAFF_JOB_COLUMNS} FROM photostaff_jobs WHERE id = ?`).get(id) as DbPhotostaffJobRow | undefined;
  if (!row) throw new Error(`Photostaff job ${id} was not created`);
  return mapPhotostaffJob(row);
}

function getPhotostaffUploadReservation(
  db: ZosDatabase,
  input: { libraryUpdatedAt: string; contentHash?: string; path?: string }
): PhotostaffUploadReservationRecord | null {
  const column = input.contentHash !== undefined ? "content_hash" : "path";
  const value = input.contentHash ?? input.path;
  if (value === undefined) return null;
  const row = db.prepare(`
    SELECT id, library_updated_at, content_hash, path, created_at
    FROM photostaff_upload_reservations
    WHERE library_updated_at = ? AND ${column} = ?
    LIMIT 1
  `).get(input.libraryUpdatedAt, value) as {
    id: string;
    library_updated_at: string;
    content_hash: string;
    path: string;
    created_at: string;
  } | undefined;
  return row ? {
    id: row.id,
    libraryUpdatedAt: row.library_updated_at,
    contentHash: row.content_hash,
    path: row.path,
    createdAt: row.created_at
  } : null;
}

function mapPhotostaffAsset(row: DbPhotostaffAssetRow): PhotostaffAssetRecord {
  return {
    id: row.id,
    rootId: row.root_id,
    storagePoolId: row.storage_pool_id,
    path: row.path,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    contentHash: row.content_hash,
    width: row.width,
    height: row.height,
    orientation: row.orientation,
    takenAt: row.taken_at,
    takenAtSource: row.taken_at_source,
    thumbnailKey: row.thumbnail_key,
    previewKey: row.preview_key,
    status: row.status,
    error: row.error,
    errorCode: row.error_code,
    errorRetryable: row.error_retryable === 1,
    derivativeSchemaVersion: row.derivative_schema_version,
    indexedAt: row.indexed_at
  };
}

function mapPhotostaffJob(row: DbPhotostaffJobRow): PhotostaffJobRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    rootId: row.root_id,
    storagePoolId: row.storage_pool_id,
    path: row.path,
    libraryUpdatedAt: row.library_updated_at,
    scanned: row.scanned,
    processed: row.processed,
    failed: row.failed,
    currentPath: row.current_path,
    phase: row.phase,
    error: row.error,
    errorCode: row.error_code,
    errorRetryable: row.error_retryable === 1,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at,
    scanGeneration: row.scan_generation,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}
