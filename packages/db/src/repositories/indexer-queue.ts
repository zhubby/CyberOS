import { randomUUID } from "node:crypto";
import type {
  IndexerServiceStatus,
  IndexRunKind,
  IndexWatcherStatus
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";

export interface EnqueueIndexTaskInput {
  storagePoolId: string;
  path?: string;
  recursive?: boolean;
  kind?: IndexRunKind;
  priority?: number;
  now?: Date;
}

export interface EnqueuedIndexTask {
  id: string;
  generation: number;
  status: "queued";
}

export function enqueueIndexTask(
  db: CyberOsDatabase,
  input: EnqueueIndexTaskInput
): EnqueuedIndexTask {
  const path = normalizeIndexPath(input.path ?? ".");
  const now = (input.now ?? new Date()).toISOString();
  const kind = input.kind ?? "incremental";
  const priority = input.priority ?? (kind === "manual" ? 100 : kind === "incremental" ? 50 : 10);
  const id = randomUUID();

  db.prepare(`
    INSERT INTO index_queue (
      id, storage_pool_id, path, recursive, kind, generation,
      priority, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, 'queued', ?, ?)
    ON CONFLICT(storage_pool_id, path) DO UPDATE SET
      recursive = MAX(index_queue.recursive, excluded.recursive),
      kind = CASE
        WHEN excluded.kind = 'manual' THEN 'manual'
        WHEN index_queue.kind = 'manual' THEN index_queue.kind
        WHEN excluded.kind = 'full' THEN 'full'
        ELSE index_queue.kind
      END,
      generation = index_queue.generation + 1,
      priority = MAX(index_queue.priority, excluded.priority),
      status = 'queued',
      retry_count = 0,
      next_retry_at = NULL,
      worker_id = NULL,
      lease_expires_at = NULL,
      error = NULL,
      error_code = NULL,
      updated_at = excluded.updated_at,
      finished_at = NULL
  `).run(
    id,
    input.storagePoolId,
    path,
    input.recursive ? 1 : 0,
    kind,
    priority,
    now,
    now
  );

  db.prepare(`
    INSERT INTO index_storage_pool_state (storage_pool_id, reconcile_requested, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(storage_pool_id) DO UPDATE SET
      reconcile_requested = MAX(index_storage_pool_state.reconcile_requested, excluded.reconcile_requested),
      updated_at = excluded.updated_at
  `).run(input.storagePoolId, kind === "full" ? 1 : 0, now);

  const row = db.prepare(`
    SELECT id, generation FROM index_queue WHERE storage_pool_id = ? AND path = ?
  `).get(input.storagePoolId, path) as { id: string; generation: number };
  return { ...row, status: "queued" };
}

export function getIndexerServiceStatus(
  db: CyberOsDatabase,
  now = new Date()
): IndexerServiceStatus {
  const freshCutoff = new Date(now.getTime() - 20_000).toISOString();
  const workers = db.prepare(`
    SELECT COUNT(CASE WHEN heartbeat_at >= ? THEN 1 END) AS fresh_workers,
      MAX(heartbeat_at) AS last_heartbeat_at
    FROM indexer_workers
  `).get(freshCutoff) as { fresh_workers: number; last_heartbeat_at: string | null };
  const queue = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'queued' THEN 1 END) AS queued,
      COUNT(CASE WHEN status = 'running' THEN 1 END) AS running,
      COUNT(CASE WHEN status = 'retrying' THEN 1 END) AS retrying,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed,
      MIN(CASE WHEN status = 'queued' THEN created_at END) AS oldest_queued_at
    FROM index_queue
  `).get() as {
    queued: number;
    running: number;
    retrying: number;
    failed: number;
    oldest_queued_at: string | null;
  };
  const watcherRows = db.prepare(`
    SELECT storage_pool_id, watcher_status, watcher_error
    FROM index_storage_pool_state
    WHERE watcher_status IN ('degraded', 'unsupported')
    ORDER BY storage_pool_id
  `).all() as Array<{ storage_pool_id: string; watcher_status: IndexWatcherStatus; watcher_error: string | null }>;
  const watcherStatus: IndexWatcherStatus = watcherRows.some((row) => row.watcher_status === "degraded")
    ? "degraded"
    : watcherRows.some((row) => row.watcher_status === "unsupported")
      ? "unsupported"
      : workers.fresh_workers > 0
        ? "ready"
        : "starting";
  const rebuild = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'ready' THEN 1 END) AS storage_pools_ready,
      COUNT(*) AS storage_pools_total,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed,
      COUNT(CASE WHEN status = 'rebuilding' THEN 1 END) AS rebuilding
    FROM index_content_state
  `).get() as {
    storage_pools_ready: number;
    storage_pools_total: number;
    failed: number;
    rebuilding: number;
  };
  const oldestQueuedMs = queue.oldest_queued_at ? Date.parse(queue.oldest_queued_at) : Number.NaN;
  return {
    service: {
      status: workers.fresh_workers > 0
        ? "ready"
        : workers.last_heartbeat_at
          ? "stale"
          : "unavailable",
      freshWorkers: workers.fresh_workers,
      lastHeartbeatAt: workers.last_heartbeat_at
    },
    watcher: {
      status: watcherStatus,
      degradedStoragePools: watcherRows.map((row) => row.storage_pool_id),
      reason: watcherRows.find((row) => row.watcher_error)?.watcher_error ?? null
    },
    queue: {
      queued: queue.queued,
      running: queue.running,
      retrying: queue.retrying,
      failed: queue.failed,
      oldestQueuedAt: queue.oldest_queued_at,
      // A queued task can legitimately wait behind a long-running full scan.
      // Only report a stalled queue when no worker is actively processing work.
      stalled: queue.queued > 0
        && queue.running === 0
        && Number.isFinite(oldestQueuedMs)
        && now.getTime() - oldestQueuedMs > 60_000
    },
    rebuild: {
      status: rebuild.failed > 0
        ? "failed"
        : rebuild.rebuilding > 0
          ? "rebuilding"
          : "ready",
      storagePoolsReady: rebuild.storage_pools_ready,
      storagePoolsTotal: rebuild.storage_pools_total
    }
  };
}

function normalizeIndexPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!normalized || normalized === ".") return ".";
  if (normalized.startsWith("/") || normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new Error("Indexer path must be a normalized relative path");
  }
  return normalized;
}
