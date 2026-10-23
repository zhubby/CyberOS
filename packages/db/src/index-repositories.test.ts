import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureNasRoots,
  enqueueIndexTask,
  defaultIndexerSettings,
  getIndexerServiceStatus,
  getIndexerSettings,
  getIndexRootStatus,
  listIndexRootStatuses,
  openZosDb,
  queryIndexAdvanced,
  queryIndexedText,
  recordIndexFailure,
  startIndexRun,
  finishIndexRun,
  saveIndexerSettings,
  upsertIndexedFile,
  type ZosDatabase
} from "./index.js";

let tempDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-db-"));
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [
    {
      id: "local",
      name: "Local",
      path: tempDir
    }
  ]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("SQLite schema and repositories", () => {
  it("tracks the latest index run, recovers interruptions, and cleans up with its root", () => {
    expect(getIndexRootStatus(db, "local")).toMatchObject({
      rootId: "local",
      status: "never_run",
      failures: []
    });

    const first = startIndexRun(db, { rootId: "local", now: new Date("2026-01-01T00:00:00.000Z") });
    expect(listIndexRootStatuses(db, ["local"])[0]).toMatchObject({ status: "running" });
    recordIndexFailure(db, {
      runId: first.id,
      rootId: "local",
      path: "docs/private.txt",
      reason: "permission denied",
      now: new Date("2026-01-01T00:01:00.000Z")
    });
    finishIndexRun(db, {
      runId: first.id,
      status: "failed",
      scanned: 3,
      indexed: 1,
      unchanged: 1,
      removed: 0,
      skipped: 0,
      failed: 1,
      error: "one or more files failed",
      finishedAt: new Date("2026-01-01T00:02:00.000Z")
    });
    expect(getIndexRootStatus(db, "local")).toMatchObject({
      status: "failed",
      scanned: 3,
      failed: 1,
      failures: [{ path: "docs/private.txt", reason: "permission denied" }]
    });

    const interrupted = startIndexRun(db, {
      rootId: "local",
      now: new Date("2026-01-02T00:00:00.000Z")
    });
    const replacement = startIndexRun(db, {
      rootId: "local",
      now: new Date("2026-01-02T00:01:00.000Z")
    });
    expect(
      db.prepare("SELECT status, error FROM index_runs WHERE id = ?").get(interrupted.id)
    ).toEqual({ status: "failed", error: "interrupted/superseded" });
    finishIndexRun(db, {
      runId: replacement.id,
      status: "completed",
      scanned: 3,
      indexed: 0,
      unchanged: 3,
      removed: 0,
      skipped: 0,
      failed: 0,
      finishedAt: new Date("2026-01-02T00:02:00.000Z")
    });

    expect(getIndexRootStatus(db, "local")).toMatchObject({ status: "completed", unchanged: 3, failures: [] });
    expect(db.prepare("SELECT COUNT(*) FROM index_runs WHERE root_id = ?").pluck().get("local")).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM index_failures WHERE root_id = ?").pluck().get("local")).toBe(0);
    expect(
      finishIndexRun(db, {
        runId: interrupted.id,
        status: "failed",
        scanned: 0,
        indexed: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        failed: 0,
        error: "interrupted/superseded"
      })
    ).toBe(false);

    db.prepare("DELETE FROM nas_roots WHERE id = ?").run("local");
    expect(db.prepare("SELECT COUNT(*) FROM index_runs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM index_failures").pluck().get()).toBe(0);
  });

  it("retains only the newest finalized run when repeated starts are interrupted", () => {
    const first = startIndexRun(db, { rootId: "local", now: new Date("2026-02-01T00:00:00.000Z") });
    const second = startIndexRun(db, { rootId: "local", now: new Date("2026-02-01T00:01:00.000Z") });
    const third = startIndexRun(db, { rootId: "local", now: new Date("2026-02-01T00:02:00.000Z") });

    expect(db.prepare("SELECT status, error FROM index_runs WHERE id = ?").get(first.id)).toBeUndefined();
    expect(db.prepare("SELECT status, error FROM index_runs WHERE id = ?").get(second.id)).toEqual({
      status: "failed",
      error: "interrupted/superseded"
    });
    expect(db.prepare("SELECT status FROM index_runs WHERE id = ?").get(third.id)).toEqual({ status: "running" });
    expect(db.prepare("SELECT COUNT(*) FROM index_runs WHERE root_id = ?").pluck().get("local")).toBe(2);
  });

  it("measures freshness from the latest successful scan even when no files changed", () => {
    const successful = startIndexRun(db, {
      rootId: "local",
      now: new Date("2026-02-01T00:00:00.000Z")
    });
    finishIndexRun(db, {
      runId: successful.id,
      status: "completed",
      scanned: 3,
      indexed: 0,
      unchanged: 3,
      removed: 0,
      skipped: 0,
      failed: 0,
      finishedAt: new Date("2026-02-01T00:02:00.000Z")
    });

    expect(
      getIndexRootStatus(db, "local", new Date("2026-02-01T00:32:00.000Z")).metrics?.freshnessMs
    ).toBe(30 * 60 * 1000);

    const failed = startIndexRun(db, {
      rootId: "local",
      now: new Date("2026-02-01T00:35:00.000Z")
    });
    finishIndexRun(db, {
      runId: failed.id,
      status: "failed",
      scanned: 1,
      indexed: 0,
      unchanged: 0,
      removed: 0,
      skipped: 0,
      failed: 1,
      finishedAt: new Date("2026-02-01T00:36:00.000Z")
    });

    expect(
      getIndexRootStatus(db, "local", new Date("2026-02-01T00:42:00.000Z")).metrics?.freshnessMs
    ).toBe(40 * 60 * 1000);
  });

  it("reports the allocated database size without scanning index contents", () => {
    const run = startIndexRun(db, {
      rootId: "local",
      now: new Date("2026-02-01T00:00:00.000Z")
    });
    finishIndexRun(db, {
      runId: run.id,
      status: "completed",
      scanned: 1,
      indexed: 1,
      unchanged: 0,
      removed: 0,
      skipped: 0,
      failed: 0,
      finishedAt: new Date("2026-02-01T00:01:00.000Z")
    });

    const pageCount = Number(db.pragma("page_count", { simple: true }));
    const pageSize = Number(db.pragma("page_size", { simple: true }));
    expect(getIndexRootStatus(db, "local").metrics?.indexSizeBytes).toBe(pageCount * pageSize);
  });

  it("keeps legacy root status tied to the latest full run", () => {
    const full = startIndexRun(db, {
      rootId: "local",
      kind: "full",
      now: new Date("2026-02-01T00:00:00.000Z")
    });
    finishIndexRun(db, {
      runId: full.id,
      status: "completed",
      scanned: 10,
      indexed: 4,
      unchanged: 6,
      removed: 0,
      skipped: 0,
      failed: 0,
      finishedAt: new Date("2026-02-01T00:02:00.000Z")
    });
    const incremental = startIndexRun(db, {
      rootId: "local",
      kind: "incremental",
      now: new Date("2026-02-01T00:10:00.000Z")
    });
    finishIndexRun(db, {
      runId: incremental.id,
      status: "failed",
      scanned: 1,
      indexed: 0,
      unchanged: 0,
      removed: 0,
      skipped: 0,
      failed: 1,
      finishedAt: new Date("2026-02-01T00:11:00.000Z")
    });

    expect(getIndexRootStatus(db, "local", new Date("2026-02-01T00:32:00.000Z"))).toMatchObject({
      status: "completed",
      scanned: 10,
      indexed: 4,
      metrics: { freshnessMs: 30 * 60 * 1000, consecutiveFailures: 0 }
    });
    expect(db.prepare("SELECT kind FROM index_runs WHERE root_id = ? ORDER BY started_at").all("local"))
      .toEqual([{ kind: "full" }, { kind: "incremental" }]);
  });

  it("rejects index failure rows whose root does not match the run", () => {
    ensureNasRoots(db, [
      { id: "local", name: "Local", path: tempDir },
      { id: "other", name: "Other", path: path.join(tempDir, "other") }
    ]);
    const run = startIndexRun(db, { rootId: "local" });

    expect(() =>
      recordIndexFailure(db, {
        runId: run.id,
        rootId: "other",
        path: "bad.txt",
        reason: "permission denied"
      })
    ).toThrow("root does not match");
    expect(db.prepare("SELECT COUNT(*) FROM index_failures").pluck().get()).toBe(0);

    recordIndexFailure(db, {
      runId: run.id,
      path: "ok.txt",
      reason: "filesystem error (EIO)"
    });
    expect(db.prepare("SELECT root_id, path FROM index_failures").all()).toEqual([
      { root_id: "local", path: "ok.txt" }
    ]);

    expect(() =>
      db
        .prepare(
          "INSERT INTO index_failures (id, run_id, root_id, path, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("bad", run.id, "other", "bad.txt", "permission denied", new Date().toISOString())
    ).toThrow("index failure root does not match index run");
    expect(() =>
      db.prepare("UPDATE index_failures SET root_id = ? WHERE run_id = ?").run("other", run.id)
    ).toThrow("index failure root does not match index run");
  });

  it("scopes indexed text to exact directory boundaries and returns file metadata", () => {
    upsertIndexedFile(db, {
      rootId: "local",
      path: "docs/readme.txt",
      name: "readme.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
      mtimeMs: 1_700_000_000_000,
      hash: "hash-docs",
      body: "alpha docs"
    });
    upsertIndexedFile(db, {
      rootId: "local",
      path: "docs-old/readme.txt",
      name: "readme.txt",
      mimeType: "text/plain",
      sizeBytes: 15,
      mtimeMs: 1_700_000_001_000,
      hash: "hash-docs-old",
      body: "alpha old docs"
    });
    upsertIndexedFile(db, {
      rootId: "local",
      path: "100%/readme.txt",
      name: "readme.txt",
      mimeType: "text/plain",
      sizeBytes: 13,
      mtimeMs: 1_700_000_002_000,
      hash: "hash-percent",
      body: "alpha percent"
    });

    expect(queryIndexedText(db, { rootId: "local", path: "docs", query: "alpha" })).toEqual([
      {
        fileId: expect.any(String),
        path: "docs/readme.txt",
        name: "readme.txt",
        snippet: expect.stringContaining("alpha"),
        sizeBytes: 11,
        mtimeMs: 1_700_000_000_000,
        mimeType: "text/plain"
      }
    ]);
    expect(queryIndexedText(db, { rootId: "local", path: "100%", query: "alpha" })).toMatchObject([
      { path: "100%/readme.txt" }
    ]);
  });

  it("coalesces index tasks by path and advances their generation", () => {
    const first = enqueueIndexTask(db, {
      rootId: "local",
      path: "docs/readme.txt",
      kind: "incremental"
    });
    const second = enqueueIndexTask(db, {
      rootId: "local",
      path: "docs/readme.txt",
      recursive: true,
      kind: "manual"
    });

    expect(second).toMatchObject({ id: first.id, generation: 2, status: "queued" });
    expect(db.prepare(`
      SELECT kind, recursive, priority, status FROM index_queue WHERE id = ?
    `).get(first.id)).toEqual({ kind: "manual", recursive: 1, priority: 100, status: "queued" });
    expect(getIndexerServiceStatus(db)).toMatchObject({
      queue: { queued: 1, running: 0, retrying: 0, failed: 0 }
    });
  });

  it("validates and persists indexer settings", () => {
    expect(getIndexerSettings(db)).toMatchObject({
      scanConcurrency: 4,
      extractionConcurrency: 2,
      ocrRootIds: []
    });
    expect(saveIndexerSettings(db, {
      ...defaultIndexerSettings(),
      scanConcurrency: 8,
      ocrRootIds: ["local", "local"]
    })).toMatchObject({ scanConcurrency: 8, ocrRootIds: ["local"] });
    expect(() => saveIndexerSettings(db, { scanConcurrency: 0 })).toThrow("scan concurrency");
  });

  it("searches the new FTS with safe snippets, stable cursors, and query-bound cursors", () => {
    const firstId = upsertIndexedFile(db, {
      rootId: "local",
      path: "docs/alpha.txt",
      name: "alpha.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
      mtimeMs: 1_700_000_000_000,
      body: "legacy alpha"
    });
    const secondId = upsertIndexedFile(db, {
      rootId: "local",
      path: "docs/project.txt",
      name: "project.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      mtimeMs: 1_700_000_001_000,
      body: "legacy alpha project"
    });
    db.prepare(`
      UPDATE indexed_files SET extraction_source = 'plain_text', extraction_status = 'ready'
      WHERE id IN (?, ?)
    `).run(firstId, secondId);
    const insertFts = db.prepare(`
      INSERT INTO indexed_content_fts (file_id, root_id, path, name, body, terms)
      VALUES (?, 'local', ?, ?, ?, ?)
    `);
    insertFts.run(firstId, "docs/alpha.txt", "alpha.txt", "alpha body", "alpha body");
    insertFts.run(secondId, "docs/project.txt", "project.txt", "alpha project body", "alpha project body");
    db.prepare(`
      INSERT INTO index_content_state (root_id, status, updated_at)
      VALUES ('local', 'ready', ?)
      ON CONFLICT(root_id) DO UPDATE SET status = 'ready', updated_at = excluded.updated_at
    `).run(new Date().toISOString());

    const firstPage = queryIndexAdvanced(db, {
      rootId: "local",
      storagePoolId: "pool",
      path: "docs",
      query: "ＡＬＰＨＡ",
      sort: { field: "name", direction: "asc" },
      limit: 1
    });
    expect(firstPage.files).toHaveLength(1);
    expect(firstPage.files[0]).toMatchObject({
      path: "docs/alpha.txt",
      snippet: expect.stringContaining("alpha"),
      extractionStatus: "ready"
    });
    expect(firstPage.files[0]?.snippet).not.toContain("<mark>");
    expect(firstPage.files[0]?.highlightRanges.length).toBeGreaterThan(0);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = queryIndexAdvanced(db, {
      rootId: "local",
      storagePoolId: "pool",
      path: "docs",
      query: "alpha",
      sort: { field: "name", direction: "asc" },
      limit: 1,
      cursor: firstPage.nextCursor
    });
    expect(secondPage.files).toMatchObject([{ path: "docs/project.txt" }]);
    expect(secondPage.nextCursor).toBeNull();

    expect(() => queryIndexAdvanced(db, {
      rootId: "local",
      storagePoolId: "pool",
      path: "docs",
      query: "project",
      sort: { field: "name", direction: "asc" },
      limit: 1,
      cursor: firstPage.nextCursor
    })).toThrow("cursor does not match");

    const callerSort = { field: "relevance" as const, direction: "desc" as const };
    queryIndexAdvanced(db, {
      rootId: "local",
      storagePoolId: "pool",
      path: "docs",
      sort: callerSort
    });
    expect(callerSort).toEqual({ field: "relevance", direction: "desc" });
  });

  it("bounds broad filename-prefix searches before ranking results", () => {
    const insertFts = db.prepare(`
      INSERT INTO indexed_content_fts (file_id, root_id, path, name, body, terms)
      VALUES (?, 'local', ?, ?, 'unrelated body', 'unrelated body')
    `);
    const seed = db.transaction(() => {
      for (let index = 0; index < 205; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const name = `pool-item-${suffix}.txt`;
        const fileId = upsertIndexedFile(db, {
          rootId: "local",
          path: `docs/${name}`,
          name,
          mimeType: "text/plain",
          sizeBytes: 14,
          mtimeMs: index,
          body: "unrelated body"
        });
        insertFts.run(fileId, `docs/${name}`, name);
      }
      db.prepare(`
        INSERT INTO index_content_state (root_id, status, updated_at)
        VALUES ('local', 'ready', ?)
        ON CONFLICT(root_id) DO UPDATE SET status = 'ready', updated_at = excluded.updated_at
      `).run(new Date().toISOString());
    });
    seed();

    const first = queryIndexAdvanced(db, {
      rootId: "local",
      storagePoolId: "pool",
      query: "pool",
      sort: { field: "name", direction: "asc" },
      limit: 100
    });
    expect(first.files).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.files[0]).toMatchObject({ path: "docs/pool-item-000.txt", snippet: "" });

    const second = queryIndexAdvanced(db, {
      rootId: "local",
      storagePoolId: "pool",
      query: "pool",
      sort: { field: "name", direction: "asc" },
      limit: 100,
      cursor: first.nextCursor
    });
    expect(second.files).toHaveLength(100);
    expect(second.nextCursor).toBeNull();
  });
});
