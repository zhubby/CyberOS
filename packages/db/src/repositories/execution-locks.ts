import type { CyberOsDatabase } from "../connection.js";

export function acquireExecutionLock(db: CyberOsDatabase, input: { name: string; owner: string; staleAfterMs?: number; now?: Date }): boolean {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const cutoff = new Date(nowDate.getTime() - (input.staleAfterMs ?? 30 * 60 * 1000)).toISOString();
  const result = db.prepare(`
    INSERT INTO execution_locks (name, owner, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at
      WHERE execution_locks.heartbeat_at < ?
  `).run(input.name, input.owner, now, now, cutoff);
  return result.changes === 1;
}

export function isExecutionLockOwner(db: CyberOsDatabase, input: { name: string; owner: string }): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM execution_locks WHERE name = ? AND owner = ?").get(input.name, input.owner)
  );
}

export function heartbeatExecutionLock(db: CyberOsDatabase, input: { name: string; owner: string; now?: Date }): boolean {
  const result = db.prepare("UPDATE execution_locks SET heartbeat_at = ? WHERE name = ? AND owner = ?").run((input.now ?? new Date()).toISOString(), input.name, input.owner);
  return result.changes === 1;
}

export function releaseExecutionLock(db: CyberOsDatabase, input: { name: string; owner: string }): boolean {
  const result = db.prepare("DELETE FROM execution_locks WHERE name = ? AND owner = ?").run(input.name, input.owner);
  return result.changes === 1;
}
