import { randomUUID } from "node:crypto";
import type {
  BluetoothTransferRecord,
  BluetoothTransferServiceHealth,
  BluetoothTransferStatus
} from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import type { DbBluetoothTransferRow } from "./repository-rows.js";

const COLUMNS = `
  id, direction, adapter_id, device_address, root_id, storage_pool_id,
  relative_path, display_name, status, transferred_bytes, total_bytes,
  error, obex_transfer_path, control_requested, read_at, created_at,
  updated_at, started_at, finished_at, last_progress_at
`;

export function createBluetoothSendTransfers(
  db: ZosDatabase,
  input: {
    adapterId: string;
    deviceAddress: string;
    rootId: string;
    storagePoolId: string;
    files: Array<{ relativePath: string; displayName: string; totalBytes: number }>;
    now?: Date;
  }
): BluetoothTransferRecord[] {
  const timestamp = (input.now ?? new Date()).toISOString();
  const insert = db.prepare(`
    INSERT INTO bluetooth_transfers (
      id, direction, adapter_id, device_address, root_id, storage_pool_id,
      relative_path, display_name, status, total_bytes, created_at, updated_at
    ) VALUES (?, 'send', ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `);
  return db.transaction(() => input.files.map((file) => {
    const id = randomUUID();
    insert.run(
      id,
      input.adapterId,
      input.deviceAddress,
      input.rootId,
      input.storagePoolId,
      file.relativePath,
      file.displayName,
      Math.max(0, Math.floor(file.totalBytes)),
      timestamp,
      timestamp
    );
    return getRequiredBluetoothTransfer(db, id);
  }))();
}

export function getBluetoothTransfer(db: ZosDatabase, id: string): BluetoothTransferRecord | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM bluetooth_transfers WHERE id = ?`)
    .get(id) as DbBluetoothTransferRow | undefined;
  return row ? mapTransfer(row) : null;
}

export function listBluetoothTransfers(
  db: ZosDatabase,
  input: { statuses?: BluetoothTransferStatus[]; limit?: number } = {}
): BluetoothTransferRecord[] {
  const statuses = input.statuses?.length ? [...new Set(input.statuses)] : null;
  const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
  const where = statuses ? `WHERE status IN (${statuses.map(() => "?").join(", ")})` : "";
  const rows = db.prepare(`
    SELECT ${COLUMNS} FROM bluetooth_transfers
    ${where}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(...(statuses ?? []), limit) as DbBluetoothTransferRow[];
  return rows.map(mapTransfer);
}

export function requestBluetoothTransferCancellation(db: ZosDatabase, id: string): BluetoothTransferRecord | null {
  const timestamp = new Date().toISOString();
  const row = db.prepare(`
    UPDATE bluetooth_transfers
    SET control_requested = 'cancel',
        status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
        finished_at = CASE WHEN status = 'queued' THEN ? ELSE finished_at END,
        read_at = NULL,
        updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running', 'paused')
    RETURNING ${COLUMNS}
  `).get(timestamp, timestamp, id) as DbBluetoothTransferRow | undefined;
  return row ? mapTransfer(row) : null;
}

export function markBluetoothTransferRead(db: ZosDatabase, id: string, now = new Date()): BluetoothTransferRecord | null {
  const row = db.prepare(`
    UPDATE bluetooth_transfers SET read_at = COALESCE(read_at, ?)
    WHERE id = ? RETURNING ${COLUMNS}
  `).get(now.toISOString(), id) as DbBluetoothTransferRow | undefined;
  return row ? mapTransfer(row) : null;
}

export function markAllBluetoothTransfersRead(db: ZosDatabase, now = new Date()): number {
  return db.prepare("UPDATE bluetooth_transfers SET read_at = ? WHERE read_at IS NULL")
    .run(now.toISOString()).changes;
}

export function countUnreadBluetoothTransfers(db: ZosDatabase): number {
  return Number(db.prepare("SELECT COUNT(*) FROM bluetooth_transfers WHERE read_at IS NULL").pluck().get() ?? 0);
}

export function getBluetoothTransferServiceHealth(db: ZosDatabase, now = new Date()): BluetoothTransferServiceHealth {
  const row = db.prepare("SELECT heartbeat_at, error FROM bluetooth_transfer_service_state WHERE id = 'primary'")
    .get() as { heartbeat_at: string; error: string | null } | undefined;
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
    FROM bluetooth_transfers
  `).get() as { active: number | null; queued: number | null };
  const heartbeatTime = row ? Date.parse(row.heartbeat_at) : Number.NaN;
  const status = !row ? "unavailable" : Number.isFinite(heartbeatTime) && now.getTime() - heartbeatTime <= 30_000
    ? "ready"
    : "stale";
  return {
    status,
    heartbeatAt: row?.heartbeat_at ?? null,
    error: row?.error ?? null,
    activeTransfers: counts.active ?? 0,
    queuedTransfers: counts.queued ?? 0
  };
}

function getRequiredBluetoothTransfer(db: ZosDatabase, id: string): BluetoothTransferRecord {
  const transfer = getBluetoothTransfer(db, id);
  if (!transfer) throw new Error("Bluetooth transfer was not persisted");
  return transfer;
}

function mapTransfer(row: DbBluetoothTransferRow): BluetoothTransferRecord {
  return {
    id: row.id,
    direction: row.direction,
    adapterId: row.adapter_id,
    deviceAddress: row.device_address,
    rootId: row.root_id,
    storagePoolId: row.storage_pool_id,
    relativePath: row.relative_path,
    displayName: row.display_name,
    status: row.status,
    transferredBytes: row.transferred_bytes,
    totalBytes: row.total_bytes,
    error: row.error,
    obexTransferPath: row.obex_transfer_path,
    controlRequested: row.control_requested,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastProgressAt: row.last_progress_at
  };
}
