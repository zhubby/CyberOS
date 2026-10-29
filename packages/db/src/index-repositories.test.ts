import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enqueueIndexTask,
  defaultIndexerSettings,
  getIndexerServiceStatus,
  getIndexerSettings,
  getPhotosProcessingSettings,
  getIndexStoragePoolStatus,
  listIndexStoragePoolStatuses,
  openCyberOsDb,
  queryIndexAdvanced,
  queryIndexedText,
  recordIndexFailure,
  startIndexRun,
  finishIndexRun,
  saveIndexerSettings,
  upsertIndexedFile,
  type CyberOsDatabase
} from "./index.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-db-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("SQLite schema and repositories", () => {
  it("tracks the latest index run and recovers interrupted runs", () => {
    expect(getIndexStoragePoolStatus(db, "local")).toMatchObject({
      storagePoolId: "local",
      status: "never_run",
      failures: []
    });

    const first = startIndexRun(db, { storagePoolId: "local", now: new Date("2026-01-01T00:00:00.000Z") });
    expect(listIndexStoragePoolStatuses(db, ["local"])[0]).toMatchObject({ status: "running" });
    recordIndexFailure(db, {
      runId: first.id,
      storagePoolId: "local",
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
    expect(getIndexStoragePoolStatus(db, "local")).toMatchObject({
      status: "failed",
      scanned: 3,
      failed: 1,
      failures: [{ path: "docs/private.txt", reason: "permission denied" }]
    });

    const interrupted = startIndexRun(db, {
      storagePoolId: "local",
      now: new Date("2026-01-02T00:00:00.000Z")
    });
    const replacement = startIndexRun(db, {
      storagePoolId: "local",
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

    expect(getIndexStoragePoolStatus(db, "local")).toMatchObject({ status: "completed", unchanged: 3, failures: [] });
    expect(db.prepare("SELECT COUNT(*) FROM index_runs WHERE storage_pool_id = ?").pluck().get("local")).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM index_failures WHERE storage_pool_id = ?").pluck().get("local")).toBe(0);
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

  });

  it("retains only the newest finalized run when repeated starts are interrupted", () => {
    const first = startIndexRun(db, { storagePoolId: "local", now: new Date("2026-02-01T00:00:00.000Z") });
    const second = startIndexRun(db, { storagePoolId: "local", now: new Date("2026-02-01T00:01:00.000Z") });
    const third = startIndexRun(db, { storagePoolId: "local", now: new Date("2026-02-01T00:02:00.000Z") });

    expect(db.prepare("SELECT status, error FROM index_runs WHERE id = ?").get(first.id)).toBeUndefined();
    expect(db.prepare("SELECT status, error FROM index_runs WHERE id = ?").get(second.id)).toEqual({
      status: "failed",
      error: "interrupted/superseded"
    });
    expect(db.prepare("SELECT status FROM index_runs WHERE id = ?").get(third.id)).toEqual({ status: "running" });
    expect(db.prepare("SELECT COUNT(*) FROM index_runs WHERE storage_pool_id = ?").pluck().get("local")).toBe(2);
  });

  it("measures freshness from the latest successful scan even when no files changed", () => {
    const successful = startIndexRun(db, {
      storagePoolId: "local",
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
      getIndexStoragePoolStatus(db, "local", new Date("2026-02-01T00:32:00.000Z")).metrics?.freshnessMs
    ).toBe(30 * 60 * 1000);

    const failed = startIndexRun(db, {
      storagePoolId: "local",
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
      getIndexStoragePoolStatus(db, "local", new Date("2026-02-01T00:42:00.000Z")).metrics?.freshnessMs
    ).toBe(40 * 60 * 1000);
  });

  it("reports the allocated database size without scanning index contents", () => {
    const run = startIndexRun(db, {
      storagePoolId: "local",
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
    expect(getIndexStoragePoolStatus(db, "local").metrics?.indexSizeBytes).toBe(pageCount * pageSize);
  });

  it("keeps storage pool status tied to the latest full run", () => {
    const full = startIndexRun(db, {
      storagePoolId: "local",
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
      storagePoolId: "local",
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

    expect(getIndexStoragePoolStatus(db, "local", new Date("2026-02-01T00:32:00.000Z"))).toMatchObject({
      status: "completed",
      scanned: 10,
      indexed: 4,
      metrics: { freshnessMs: 30 * 60 * 1000, consecutiveFailures: 0 }
    });
    expect(db.prepare("SELECT kind FROM index_runs WHERE storage_pool_id = ? ORDER BY started_at").all("local"))
      .toEqual([{ kind: "full" }, { kind: "incremental" }]);
  });

  it("rejects index failure rows whose storage pool does not match the run", () => {
    const run = startIndexRun(db, { storagePoolId: "local" });

    expect(() =>
      recordIndexFailure(db, {
        runId: run.id,
        storagePoolId: "other",
        path: "bad.txt",
        reason: "permission denied"
      })
    ).toThrow("storage pool does not match");
    expect(db.prepare("SELECT COUNT(*) FROM index_failures").pluck().get()).toBe(0);

    recordIndexFailure(db, {
      runId: run.id,
      path: "ok.txt",
      reason: "filesystem error (EIO)"
    });
    expect(db.prepare("SELECT storage_pool_id, path FROM index_failures").all()).toEqual([
      { storage_pool_id: "local", path: "ok.txt" }
    ]);

    expect(() =>
      db
        .prepare(
          "INSERT INTO index_failures (id, run_id, storage_pool_id, path, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("bad", run.id, "other", "bad.txt", "permission denied", new Date().toISOString())
    ).toThrow("index failure storage pool does not match index run");
    expect(() =>
      db.prepare("UPDATE index_failures SET storage_pool_id = ? WHERE run_id = ?").run("other", run.id)
    ).toThrow("index failure storage pool does not match index run");
  });

  it("scopes indexed text to exact directory boundaries and returns file metadata", () => {
    upsertIndexedFile(db, {
      storagePoolId: "local",
      path: "docs/readme.txt",
      name: "readme.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
      mtimeMs: 1_700_000_000_000,
      hash: "hash-docs",
      body: "alpha docs"
    });
    upsertIndexedFile(db, {
      storagePoolId: "local",
      path: "docs-old/readme.txt",
      name: "readme.txt",
      mimeType: "text/plain",
      sizeBytes: 15,
      mtimeMs: 1_700_000_001_000,
      hash: "hash-docs-old",
      body: "alpha old docs"
    });
    upsertIndexedFile(db, {
      storagePoolId: "local",
      path: "100%/readme.txt",
      name: "readme.txt",
      mimeType: "text/plain",
      sizeBytes: 13,
      mtimeMs: 1_700_000_002_000,
      hash: "hash-percent",
      body: "alpha percent"
    });

    expect(queryIndexedText(db, { storagePoolId: "local", path: "docs", query: "alpha" })).toEqual([
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
    expect(queryIndexedText(db, { storagePoolId: "local", path: "100%", query: "alpha" })).toMatchObject([
      { path: "100%/readme.txt" }
    ]);
  });

  it("coalesces index tasks by path and advances their generation", () => {
    const first = enqueueIndexTask(db, {
      storagePoolId: "local",
      path: "docs/readme.txt",
      kind: "incremental"
    });
    const second = enqueueIndexTask(db, {
      storagePoolId: "local",
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

  it("does not call a queued task stalled while another task is running", () => {
    const queuedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date("2026-01-01T00:02:00.000Z");
    enqueueIndexTask(db, { storagePoolId: "local", path: "pending.txt", now: queuedAt });
    enqueueIndexTask(db, { storagePoolId: "local", path: "current.txt", now: queuedAt });
    db.prepare(`
      UPDATE index_queue
      SET status = 'running', worker_id = 'worker-1', started_at = ?, updated_at = ?
      WHERE storage_pool_id = ? AND path = ?
    `).run(queuedAt.toISOString(), queuedAt.toISOString(), "local", "current.txt");

    expect(getIndexerServiceStatus(db, now).queue).toMatchObject({
      queued: 1,
      running: 1,
      stalled: false
    });

    db.prepare(`
      UPDATE index_queue SET status = 'queued', worker_id = NULL
      WHERE storage_pool_id = ? AND path = ?
    `).run("local", "current.txt");
    expect(getIndexerServiceStatus(db, now).queue).toMatchObject({
      queued: 2,
      running: 0,
      stalled: true
    });
  });

  it("validates and persists indexer settings", () => {
    expect(getIndexerSettings(db)).toBeNull();
    expect(saveIndexerSettings(db, {
      ...defaultIndexerSettings(),
      scanConcurrency: 8,
      ocrStoragePoolIds: ["local", "local"]
    })).toMatchObject({ scanConcurrency: 8, ocrStoragePoolIds: ["local"] });
    expect(() => saveIndexerSettings(db, { scanConcurrency: 0 })).toThrow("scan concurrency");
  });

  it("rejects incomplete Indexer and Photos processing settings", () => {
    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("indexer_settings", JSON.stringify({ scanConcurrency: 4 }), new Date().toISOString());
    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("photos_processing_settings", JSON.stringify({ processingConcurrency: 1 }), new Date().toISOString());

    expect(() => getIndexerSettings(db)).toThrow(/CyberOS 2.0 format/);
    expect(() => getPhotosProcessingSettings(db)).toThrow(/CyberOS 2.0 format/);
  });

  it("searches the new FTS with safe snippets, stable cursors, and query-bound cursors", () => {
    const firstId = upsertIndexedFile(db, {
      storagePoolId: "local",
      path: "docs/alpha.txt",
      name: "alpha.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
      mtimeMs: 1_700_000_000_000,
      body: "archive alpha"
    });
    const secondId = upsertIndexedFile(db, {
      storagePoolId: "local",
      path: "docs/project.txt",
      name: "project.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      mtimeMs: 1_700_000_001_000,
      body: "archive alpha project"
    });
    db.prepare(`
      UPDATE indexed_files SET extraction_source = 'plain_text', extraction_status = 'ready'
      WHERE id IN (?, ?)
    `).run(firstId, secondId);
    const insertFts = db.prepare(`
      INSERT INTO indexed_content_fts (file_id, storage_pool_id, path, name, body, terms)
      VALUES (?, 'local', ?, ?, ?, ?)
    `);
    insertFts.run(firstId, "docs/alpha.txt", "alpha.txt", "alpha body", "alpha body");
    insertFts.run(secondId, "docs/project.txt", "project.txt", "alpha project body", "alpha project body");
    db.prepare(`
      INSERT INTO index_content_state (storage_pool_id, status, updated_at)
      VALUES ('local', 'ready', ?)
      ON CONFLICT(storage_pool_id) DO UPDATE SET status = 'ready', updated_at = excluded.updated_at
    `).run(new Date().toISOString());

    const firstPage = queryIndexAdvanced(db, {
      storagePoolId: "local",
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

    const contentOnly = queryIndexAdvanced(db, {
      storagePoolId: "local",
      path: "docs",
      query: "body",
      sort: { field: "name", direction: "asc" },
      limit: 10
    });
    expect(contentOnly.files).toMatchObject([
      { path: "docs/alpha.txt", score: 0.5, snippet: expect.stringContaining("body") },
      { path: "docs/project.txt", score: 0.5, snippet: expect.stringContaining("body") }
    ]);

    const secondPage = queryIndexAdvanced(db, {
      storagePoolId: "local",
      path: "docs",
      query: "alpha",
      sort: { field: "name", direction: "asc" },
      limit: 1,
      cursor: firstPage.nextCursor
    });
    expect(secondPage.files).toMatchObject([{ path: "docs/project.txt" }]);
    expect(secondPage.nextCursor).toBeNull();

    expect(() => queryIndexAdvanced(db, {
      storagePoolId: "local",
      path: "docs",
      query: "project",
      sort: { field: "name", direction: "asc" },
      limit: 1,
      cursor: firstPage.nextCursor
    })).toThrow("cursor does not match");

    const callerSort = { field: "relevance" as const, direction: "desc" as const };
    queryIndexAdvanced(db, {
      storagePoolId: "local",
      path: "docs",
      sort: callerSort
    });
    expect(callerSort).toEqual({ field: "relevance", direction: "desc" });
  });

  it("bounds broad filename searches without relying on the content FTS", () => {
    const insertFts = db.prepare(`
      INSERT INTO indexed_content_fts (file_id, storage_pool_id, path, name, body, terms)
      VALUES (?, 'local', ?, ?, 'unrelated body', 'unrelated body')
    `);
    const seed = db.transaction(() => {
      for (let index = 0; index < 205; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const name = `pool-item-${suffix}.txt`;
        const fileId = upsertIndexedFile(db, {
          storagePoolId: "local",
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
        INSERT INTO index_content_state (storage_pool_id, status, updated_at)
        VALUES ('local', 'ready', ?)
        ON CONFLICT(storage_pool_id) DO UPDATE SET status = 'ready', updated_at = excluded.updated_at
      `).run(new Date().toISOString());
    });
    seed();

    const first = queryIndexAdvanced(db, {
      storagePoolId: "local",
      query: "pool",
      sort: { field: "name", direction: "asc" },
      limit: 100
    });
    expect(first.files).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.files[0]).toMatchObject({ path: "docs/pool-item-000.txt", snippet: "" });

    const second = queryIndexAdvanced(db, {
      storagePoolId: "local",
      query: "pool",
      sort: { field: "name", direction: "asc" },
      limit: 100,
      cursor: first.nextCursor
    });
    expect(second.files).toHaveLength(100);
    expect(second.nextCursor).toBeNull();

    upsertIndexedFile(db, {
      storagePoolId: "local",
      path: "target/pool-result.txt",
      name: "pool-result.txt",
      mimeType: "text/plain",
      sizeBytes: 14,
      mtimeMs: 999,
      body: "unrelated body"
    });
    const scoped = queryIndexAdvanced(db, {
      storagePoolId: "local",
      path: "target",
      query: "pool",
      limit: 10
    });
    expect(scoped.files).toMatchObject([{ path: "target/pool-result.txt" }]);
  });
});
