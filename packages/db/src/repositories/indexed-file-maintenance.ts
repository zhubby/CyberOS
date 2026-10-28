import { randomUUID } from "node:crypto";
import type { CyberOsDatabase } from "../connection.js";

export function upsertIndexedFile(
  db: CyberOsDatabase,
  input: {
    id?: string;
    storagePoolId: string;
    path: string;
    name: string;
    mimeType?: string | null;
    sizeBytes: number;
    mtimeMs: number;
    hash?: string | null;
    body?: string;
  }
): string {
  const fileId =
    input.id ??
    (db
      .prepare("SELECT id FROM indexed_files WHERE storage_pool_id = ? AND path = ?")
      .pluck()
      .get(input.storagePoolId, input.path) as string | undefined) ??
    randomUUID();
  const indexedAt = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO indexed_files (
        id, storage_pool_id, path, name, mime_type, size_bytes, mtime_ms, hash, indexed_at
      )
      VALUES (@id, @storagePoolId, @path, @name, @mimeType, @sizeBytes, @mtimeMs, @hash, @indexedAt)
      ON CONFLICT(storage_pool_id, path) DO UPDATE SET
        name = excluded.name,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        hash = excluded.hash,
        indexed_at = excluded.indexed_at
    `).run({
      id: fileId,
      storagePoolId: input.storagePoolId,
      path: input.path,
      name: input.name,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes,
      mtimeMs: input.mtimeMs,
      hash: input.hash ?? null,
      indexedAt
    });

    db.prepare("DELETE FROM indexed_content_fts WHERE file_id = ?").run(fileId);
    db.prepare(`
      INSERT INTO indexed_content_fts (file_id, storage_pool_id, path, name, body, terms)
      VALUES (?, ?, ?, ?, ?, '')
    `).run(fileId, input.storagePoolId, input.path, input.name, input.body ?? "");
  });

  tx();
  return fileId;
}

export function removeMissingIndexedFiles(
  db: CyberOsDatabase,
  input: { storagePoolId: string; seenPaths: string[] }
): number {
  const existing = db
    .prepare("SELECT id, path FROM indexed_files WHERE storage_pool_id = ?")
    .all(input.storagePoolId) as Array<{ id: string; path: string }>;
  const seen = new Set(input.seenPaths);
  const stale = existing.filter((row) => !seen.has(row.path));
  const tx = db.transaction(() => {
    const deleteText = db.prepare("DELETE FROM indexed_content_fts WHERE file_id = ?");
    const deleteFile = db.prepare("DELETE FROM indexed_files WHERE id = ?");
    for (const row of stale) {
      deleteText.run(row.id);
      deleteFile.run(row.id);
    }
  });
  tx();
  return stale.length;
}
