import type { CyberOsDatabase } from "../connection.js";
import type { DbIndexedFileRow } from "./repository-rows.js";

export interface IndexedFileSnapshot {
  id: string;
  rootId: string;
  path: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  mtimeMs: number;
  hash: string | null;
  indexedAt: string;
  hasText: boolean;
}

export function listIndexedFilesForRoot(db: CyberOsDatabase, rootId: string): IndexedFileSnapshot[] {
  const textFileIds = new Set(
    (db
      .prepare("SELECT file_id FROM indexed_text WHERE root_id = ?")
      .pluck()
      .all(rootId) as string[])
  );
  const rows = db
    .prepare(`
      SELECT
        f.id,
        f.root_id,
        f.path,
        f.name,
        f.mime_type,
        f.size_bytes,
        f.mtime_ms,
        f.hash,
        f.indexed_at
      FROM indexed_files f
      WHERE f.root_id = ?
    `)
    .all(rootId) as DbIndexedFileRow[];

  return rows.map((row) => ({
    id: row.id,
    rootId: row.root_id,
    path: row.path,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    hash: row.hash,
    indexedAt: row.indexed_at,
    hasText: textFileIds.has(row.id)
  }));
}

export function removeIndexedFile(db: CyberOsDatabase, input: { rootId: string; path: string }): boolean {
  const row = db
    .prepare("SELECT id FROM indexed_files WHERE root_id = ? AND path = ?")
    .get(input.rootId, input.path) as { id: string } | undefined;
  if (!row) {
    return false;
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM indexed_text WHERE file_id = ?").run(row.id);
    db.prepare("DELETE FROM indexed_files WHERE id = ?").run(row.id);
  });
  tx();
  return true;
}
