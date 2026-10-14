import type { RootReadiness } from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import type { DbReadinessRow } from "./repository-rows.js";

export function upsertRootReadiness(db: ZosDatabase, input: RootReadiness | (Omit<RootReadiness, "checkedAt"> & { checkedAt?: Date | string | null })): RootReadiness {
  const checkedAt = input.checkedAt instanceof Date ? input.checkedAt.toISOString() : input.checkedAt ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO nas_root_readiness (root_id, status, checked_at, reason, source, uuid, fstype)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root_id) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at,
      reason = excluded.reason, source = excluded.source, uuid = excluded.uuid, fstype = excluded.fstype
  `).run(input.rootId, input.status, checkedAt, input.reason, input.source, input.uuid, input.fstype);
  return { ...input, checkedAt };
}

export function getRootReadiness(db: ZosDatabase, rootId: string): RootReadiness | null {
  const row = db.prepare("SELECT root_id, status, checked_at, reason, source, uuid, fstype FROM nas_root_readiness WHERE root_id = ?")
    .get(rootId) as DbReadinessRow | undefined;
  return row ? mapReadiness(row) : null;
}

export function listRootReadiness(db: ZosDatabase, rootIds?: string[]): RootReadiness[] {
  const rows = rootIds !== undefined
    ? rootIds.length
      ? db.prepare(`SELECT root_id, status, checked_at, reason, source, uuid, fstype FROM nas_root_readiness WHERE root_id IN (${rootIds.map(() => "?").join(",")})`).all(...rootIds)
      : []
    : db.prepare("SELECT root_id, status, checked_at, reason, source, uuid, fstype FROM nas_root_readiness ORDER BY root_id").all();
  return (rows as DbReadinessRow[]).map(mapReadiness);
}

function mapReadiness(row: DbReadinessRow): RootReadiness {
  return { rootId: row.root_id, status: row.status, checkedAt: row.checked_at, reason: row.reason, source: row.source, uuid: row.uuid, fstype: row.fstype };
}
