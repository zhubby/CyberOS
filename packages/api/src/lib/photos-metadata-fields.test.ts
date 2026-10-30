import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { listPhotosMetadataFields, openCyberOsDb } from "@cyberos/db";
import { PHOTOS_METADATA_SCHEMA_VERSION } from "@cyberos/shared";
import { describe, expect, it } from "vitest";
import {
  PhotosMetadataFieldsReader,
  type PhotosMetadataFieldsRequest,
  type PhotosMetadataFieldsResponse
} from "./photos-metadata-fields.js";

class FakeWorker extends EventEmitter {
  readonly messages: PhotosMetadataFieldsRequest[] = [];
  postMessage(message: PhotosMetadataFieldsRequest): void {
    this.messages.push(message);
  }
  result(id: number): void {
    this.emit("message", { type: "result", id, fields: [] } satisfies PhotosMetadataFieldsResponse);
  }
  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

describe("photo metadata field reader", () => {
  it("serializes work, coalesces only pending results, and bounds distinct queries", async () => {
    const worker = new FakeWorker();
    const reader = new PhotosMetadataFieldsReader("test.sqlite", () => worker.asWorker());
    const first = reader.list({ libraryUpdatedAt: "revision" });
    expect(reader.list({ libraryUpdatedAt: "revision", query: "", limit: 100 })).toBe(first);
    const remaining = Array.from({ length: 31 }, (_, index) => reader.list({
      libraryUpdatedAt: "revision", query: String(index)
    }));
    const outcomes = remaining.map((pending) => pending.catch((error: unknown) => error));
    await expect(reader.list({ libraryUpdatedAt: "other-revision" })).rejects.toMatchObject({ statusCode: 503 });
    expect(reader.list({ libraryUpdatedAt: "revision" })).toBe(first);
    expect(worker.messages).toHaveLength(1);
    worker.result(1);
    await expect(first).resolves.toEqual([]);
    expect(worker.messages).toHaveLength(2);
    const fresh = reader.list({ libraryUpdatedAt: "revision" });
    expect(fresh).not.toBe(first);
    const freshOutcome = fresh.catch((error: unknown) => error);
    const close = reader.close();
    expect(worker.messages.at(-1)).toEqual({ type: "close" });
    expect(await freshOutcome).toBeInstanceOf(Error);
    expect((await Promise.all(outcomes)).every((outcome) => outcome instanceof Error)).toBe(true);
    worker.emit("exit", 0);
    await close;
  });

  it("rejects running and queued work on failure and recovers with a fresh worker", async () => {
    const workers: FakeWorker[] = [];
    const reader = new PhotosMetadataFieldsReader("test.sqlite", () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker.asWorker();
    });
    const first = reader.list({ libraryUpdatedAt: "revision" });
    const queued = reader.list({ libraryUpdatedAt: "revision", query: "other" });
    const failed = [expect(first).rejects.toThrow("reader failed"), expect(queued).rejects.toThrow("reader failed")];
    workers[0]!.emit("error", new Error("reader failed"));
    await Promise.all(failed);
    const recovered = reader.list({ libraryUpdatedAt: "revision" });
    workers[0]!.emit("exit", 1);
    workers[1]!.result(3);
    await expect(recovered).resolves.toEqual([]);
    const close = reader.close();
    expect(reader.close()).toBe(close);
    await expect(reader.list({ libraryUpdatedAt: "revision" })).rejects.toThrow("closed");
    workers[1]!.emit("exit", 0);
    await close;
  });

  it("continues after a query error and rejects work on an unexpected clean exit", async () => {
    const worker = new FakeWorker();
    const reader = new PhotosMetadataFieldsReader("test.sqlite", () => worker.asWorker());
    const first = reader.list({ libraryUpdatedAt: "revision" });
    const queued = reader.list({ libraryUpdatedAt: "revision", query: "other" });
    const failed = expect(first).rejects.toThrow("query failed");
    worker.emit("message", { type: "error", id: 1, message: "query failed" } satisfies PhotosMetadataFieldsResponse);
    await failed;
    expect(worker.messages.at(-1)).toMatchObject({ type: "query", id: 2 });
    const exited = expect(queued).rejects.toThrow("exited unexpectedly (0)");
    worker.emit("exit", 0);
    await exited;
    await reader.close();
  });

  it("returns fresh equivalent scoped public fields from a real read-only database", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-fields-reader-"));
    const databasePath = path.join(root, "db.sqlite");
    const db = openCyberOsDb(databasePath);
    const reader = new PhotosMetadataFieldsReader(databasePath);
    try {
      db.transaction(() => {
        for (const id of ["ready", "partial", "stale", "failed", "old"]) {
          db.prepare(`INSERT INTO photos_assets(id,storage_pool_id,path,name,mime_type,size_bytes,mtime_ms,
            taken_at,taken_at_source,status,library_updated_at,indexed_at)
            VALUES (?,'pool',?,?,'image/jpeg',1,1,'date','file_mtime',?,?,'date')`)
            .run(id, `${id}.jpg`, id, id === "failed" ? "failed" : "ready", id === "old" ? "old" : "revision");
          db.prepare(`INSERT INTO photos_asset_metadata(asset_id,schema_version,status,media_kind,capture_source,
            raw_metadata_json,warnings_json,updated_at) VALUES (?,?,?,'image','exif','{}','[]','date')`)
            .run(id, PHOTOS_METADATA_SCHEMA_VERSION + (id === "stale" ? 1 : 0), id === "partial" ? "partial" : "ready");
          const insert = db.prepare(`INSERT INTO photos_metadata_values(asset_id,source,key,value_type,sensitive,ordinal)
            VALUES (?,'exif',?,'text',?,?)`);
          insert.run(id, "exif.Make", 0, 0);
          insert.run(id, "exif.Make", 0, 1);
          insert.run(id, "exif.GPS", 1, 0);
        }
      })();
      for (const query of ["", "  ＭＡＫＥ  ", "GPS", "%", "_"]) {
        const input = { libraryUpdatedAt: "revision", query, limit: 100 };
        expect(await reader.list(input)).toEqual(listPhotosMetadataFields(db, input));
      }
      expect(await reader.list({ libraryUpdatedAt: "revision" })).toEqual([
        { key: "exif.Make", valueType: "text", count: 2, sensitive: false }
      ]);
      db.prepare("DELETE FROM photos_assets WHERE id='partial'").run();
      expect(await reader.list({ libraryUpdatedAt: "revision" })).toEqual([
        { key: "exif.Make", valueType: "text", count: 1, sensitive: false }
      ]);
    } finally {
      await reader.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
