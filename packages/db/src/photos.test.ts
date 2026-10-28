import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PHOTOS_METADATA_SCHEMA_VERSION, type PhotosMetadataCondition } from "@cyberos/shared";
import type { PhotosMetadataWriteInput } from "./index.js";
import {
  claimNextPhotosJob,
  enqueuePhotosJob,
  ensurePeriodicPhotosScan,
  findPhotosAssetByHash,
  finishPhotosJob,
  getPhotosMetadataDetail,
  getPhotosMetadataIndexStatus,
  getPhotosLibrarySettings,
  getPhotosLibraryStatus,
  hasCompletedPhotosScan,
  listPhotosAssets,
  listPhotosMetadataFields,
  openCyberOsDb,
  releasePhotosUploadReservation,
  removeStalePhotosAssets,
  removeStalePhotosUploadReservations,
  reservePhotosUpload,
  queryPhotosAssets,
  queryPhotosMap,
  savePhotosLibrarySettings,
  updatePhotosJobProgress,
  upsertPhotosAsset,
  type CyberOsDatabase
} from "./index.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-photos-db-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("photos repositories", () => {
  it("rejects incomplete library settings", () => {
    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
      "photos_library_settings",
      JSON.stringify({ storagePoolId: "pool-a", path: "Photos" }),
      "2026-01-01T00:00:00.000Z"
    );

    expect(getPhotosLibrarySettings(db)).toBeNull();
  });

  it("persists one library and invalidates prior assets and jobs when it changes", () => {
    const first = savePhotosLibrarySettings(db, {
            storagePoolId: "pool-a",
      path: "Photos"
    }, new Date("2026-01-01T00:00:00.000Z"));
    const retrying = enqueuePhotosJob(db, { settings: first });
    db.prepare("UPDATE photos_jobs SET status = 'retrying', next_retry_at = ? WHERE id = ?")
      .run("2026-01-01T00:10:00.000Z", retrying.id);
    upsertReady(first, "Photos/one.jpg", "hash-one", "2025-01-01T00:00:00.000Z");

    const second = savePhotosLibrarySettings(db, {
            storagePoolId: "pool-b",
      path: "Pictures"
    }, new Date("2026-01-02T00:00:00.000Z"));

    expect(getPhotosLibrarySettings(db)).toEqual(second);
    expect(listPhotosAssets(db, { libraryUpdatedAt: first.updatedAt, limit: 10 }).photos).toEqual([]);
    expect(db.prepare("SELECT status FROM photos_jobs WHERE id = ?").pluck().get(retrying.id)).toBe("failed");
    expect(getPhotosLibraryStatus(db, second).state).toBe("queued");
  });

  it("claims jobs with leases and reports progress through completion", () => {
    const settings = saveSettings();
    const queued = enqueuePhotosJob(db, { settings });
    expect(hasCompletedPhotosScan(db, settings.updatedAt)).toBe(false);
    expect(enqueuePhotosJob(db, { settings }).id).toBe(queued.id);

    const claimed = claimNextPhotosJob(db, {
      workerId: "worker-1",
      leaseMs: 30_000,
      now: new Date("2026-01-01T00:00:01.000Z")
    });
    expect(claimed).toMatchObject({ id: queued.id, status: "running", workerId: "worker-1" });
    expect(updatePhotosJobProgress(db, {
      id: queued.id,
      workerId: "worker-1",
      scanned: 3,
      processed: 2,
      failed: 1,
      currentPath: "Photos/bad.jpg",
      leaseMs: 30_000
    })).toBe(true);
    expect(finishPhotosJob(db, { id: queued.id, workerId: "worker-1" })).toMatchObject({
      status: "completed",
      scanned: 3,
      processed: 2,
      failed: 1
    });
    expect(hasCompletedPhotosScan(db, settings.updatedAt)).toBe(true);
    expect(getPhotosLibraryStatus(db, settings)).toMatchObject({ state: "ready", scanned: 3, processed: 2 });
  });

  it("queues stale metadata immediately without waiting for the periodic interval", () => {
    const settings = saveSettings();
    const initial = enqueuePhotosJob(db, { settings, now: new Date("2026-01-01T00:00:00.000Z") });
    expect(claimNextPhotosJob(db, {
      workerId: "worker-1",
      leaseMs: 30_000,
      now: new Date("2026-01-01T00:00:01.000Z")
    })?.id).toBe(initial.id);
    finishPhotosJob(db, { id: initial.id, workerId: "worker-1" });
    upsertReady(settings, "Photos/stale-metadata.jpg", "stale-metadata", "2026-01-01T00:00:00.000Z");

    const queued = ensurePeriodicPhotosScan(db, settings, {
      intervalMs: 30 * 60 * 1_000,
      now: new Date("2026-01-01T00:00:02.000Z")
    });

    expect(queued).toMatchObject({ kind: "full_scan", status: "queued" });
  });

  it("rejects stale asset writes and keeps library revisions monotonic", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const first = savePhotosLibrarySettings(db, {
            storagePoolId: "pool-a",
      path: "Photos"
    }, now);
    const second = savePhotosLibrarySettings(db, {
            storagePoolId: "pool-b",
      path: "Pictures"
    }, now);

    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
    expect(() => upsertReady(first, "Photos/stale.jpg", "stale", now.toISOString())).toThrow(
      "Photos library configuration changed"
    );
  });

  it("returns a stable chronological page and supports stale cleanup and hash lookup", () => {
    const settings = saveSettings();
    const old = upsertReady(settings, "Photos/old.jpg", "same-hash", "2024-01-01T00:00:00.000Z", new Date("2026-01-01T00:00:01.000Z"));
    const newest = upsertReady(settings, "Photos/new.jpg", "new-hash", "2025-01-01T00:00:00.000Z", new Date("2026-01-01T00:00:02.000Z"));

    const firstPage = listPhotosAssets(db, { libraryUpdatedAt: settings.updatedAt, limit: 1 });
    expect(firstPage.photos.map((photos) => photos.id)).toEqual([newest.id]);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = listPhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      limit: 1,
      cursor: { takenAt: newest.takenAt, id: newest.id }
    });
    expect(secondPage.photos.map((photos) => photos.id)).toEqual([old.id]);
    expect(findPhotosAssetByHash(db, { libraryUpdatedAt: settings.updatedAt, contentHash: "same-hash" })?.id).toBe(old.id);
    expect(removeStalePhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      indexedBefore: "2026-01-01T00:00:02.000Z"
    })).toBe(1);
  });

  it("reserves upload hashes transactionally until the worker indexes them", () => {
    const settings = saveSettings();
    const first = reservePhotosUpload(db, {
      settings,
      path: "Photos/one.jpg",
      contentHash: "pending-hash",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    const duplicate = reservePhotosUpload(db, {
      settings,
      path: "Photos/two.jpg",
      contentHash: "pending-hash",
      now: new Date("2026-01-01T00:00:01.000Z")
    });

    expect(first).toMatchObject({ reservation: { path: "Photos/one.jpg" }, conflict: null });
    expect(duplicate).toMatchObject({ reservation: null, duplicate: { id: first.reservation!.id }, conflict: "content_hash" });
    expect(getPhotosLibraryStatus(db, settings).total).toBe(0);
    expect(releasePhotosUploadReservation(db, {
      id: first.reservation!.id,
      libraryUpdatedAt: settings.updatedAt
    })).toBe(true);
    expect(reservePhotosUpload(db, {
      settings,
      path: "Photos/two.jpg",
      contentHash: "pending-hash"
    }).reservation).not.toBeNull();
  });

  it("reserves upload paths, clears indexed reservations, and prunes stale reservations", () => {
    const settings = saveSettings();
    const first = reservePhotosUpload(db, {
      settings,
      path: "Photos/one.jpg",
      contentHash: "hash-one",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(reservePhotosUpload(db, {
      settings,
      path: "Photos/one.jpg",
      contentHash: "hash-two"
    })).toMatchObject({ reservation: null, duplicate: { id: first.reservation!.id }, conflict: "path" });

    upsertReady(settings, "Photos/one.jpg", "hash-one", "2026-01-01T00:00:00.000Z");
    expect(releasePhotosUploadReservation(db, {
      id: first.reservation!.id,
      libraryUpdatedAt: settings.updatedAt
    })).toBe(false);

    reservePhotosUpload(db, {
      settings,
      path: "Photos/stale.jpg",
      contentHash: "stale-hash",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(removeStalePhotosUploadReservations(db, {
      libraryUpdatedAt: settings.updatedAt,
      createdBefore: "2026-01-01T00:00:01.000Z"
    })).toBe(1);
  });

  it("stores normalized and scalar metadata and queries common, advanced, and location dimensions", () => {
    const settings = saveSettings();
    upsertReady(
      settings,
      "Photos/east.jpg",
      "east-hash",
      "2026-01-01T00:00:00.000Z",
      new Date("2026-01-01T00:00:01.000Z"),
      metadata({
        cameraModel: "Alpha 1",
        iso: 800,
        gpsLatitude: 31.23,
        gpsLongitude: 179.8,
        keywords: ["Travel"],
        values: [
          { source: "exif", key: "exif.ISO", valueType: "number", value: 800, sensitive: false, ordinal: 0 },
          { source: "xmp", key: "xmp.Flagged", valueType: "boolean", value: true, sensitive: false, ordinal: 0 }
        ]
      })
    );
    upsertReady(
      settings,
      "Photos/west.jpg",
      "west-hash",
      "2026-01-02T00:00:00.000Z",
      new Date("2026-01-01T00:00:02.000Z"),
      metadata({ cameraModel: "Alpha 1", iso: 100, gpsLatitude: 31.24, gpsLongitude: -179.8, keywords: ["Travel", "Night"] })
    );
    upsertReady(
      settings,
      "Photos/other-camera.jpg",
      "other-hash",
      "2026-01-03T00:00:00.000Z",
      new Date("2026-01-01T00:00:03.000Z"),
      metadata({ cameraModel: "Alpha 7", iso: 800, gpsLatitude: 31.25, gpsLongitude: 179.7, keywords: ["Travel"] })
    );

    const result = queryPhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      request: {
        filters: {
          cameraModels: ["Alpha 1"],
          location: { kind: "bounds", west: 179, south: 30, east: -179, north: 32 },
          advanced: { mode: "all", conditions: [{ key: "exif.ISO", operator: "gte", value: 400 }] }
        },
        includeFacets: true,
        limit: 10
      }
    });

    expect(result.photos.map((photos) => photos.name)).toEqual(["east.jpg"]);
    expect(result.photos[0]?.metadata).toMatchObject({ cameraModel: "Alpha 1", iso: 800, hasLocation: true });
    expect(result.facets?.cameraModels).toContainEqual({ value: "Alpha 1", count: 1 });
    expect(getPhotosMetadataIndexStatus(db, settings.updatedAt)).toMatchObject({ total: 3, indexed: 3, pending: 0 });
    expect(listPhotosMetadataFields(db, { libraryUpdatedAt: settings.updatedAt })).toContainEqual({
      key: "exif.ISO",
      valueType: "number",
      count: 3,
      sensitive: false
    });

    const selfExcludingFacet = queryPhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      request: { filters: { cameraModels: ["Alpha 1"] }, includeFacets: true }
    });
    expect(selfExcludingFacet.facets?.cameraModels).toEqual(expect.arrayContaining([
      { value: "Alpha 1", count: 2 },
      { value: "Alpha 7", count: 1 }
    ]));

    const nearby = queryPhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      request: {
        filters: { location: { kind: "near", latitude: 31.23, longitude: 179.8, radiusMeters: 50_000 } },
        sort: { field: "distance", direction: "asc" }
      }
    });
    expect(nearby.photos[0]).toMatchObject({ name: "east.jpg", distanceMeters: 0 });
    expect(nearby.photos.map((photos) => photos.name)).toEqual(expect.arrayContaining(["west.jpg", "other-camera.jpg"]));

    const map = queryPhotosMap(db, {
      libraryUpdatedAt: settings.updatedAt,
      request: {
        bounds: { kind: "bounds", west: 179, south: 30, east: -179, north: 32 },
        columns: 1,
        rows: 1
      }
    });
    expect(map).toHaveLength(1);
    expect(map[0]).toMatchObject({ count: 3, assetId: null });
    expect(Math.abs(map[0]!.longitude)).toBeGreaterThan(170);

    const booleanSet = queryPhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      request: {
        filters: {
          advanced: { mode: "all", conditions: [{ key: "xmp.Flagged", operator: "in", value: [true] }] }
        }
      }
    });
    expect(booleanSet.photos.map((photos) => photos.name)).toEqual(["east.jpg"]);
  });

  it("supports every advanced scalar operator with literal text matching", () => {
    const settings = saveSettings();
    upsertReady(
      settings,
      "Photos/operator-match.jpg",
      "operator-match",
      "2026-01-02T00:00:00.000Z",
      new Date("2026-01-02T00:00:01.000Z"),
      metadata({
        rawMetadata: {
          exif: { ISO: [800], DateTimeOriginal: ["2026-01-02T00:00:00"] },
          xmp: { Title: ["Field % Notes"], Flagged: [true] }
        },
        values: [
          { source: "exif", key: "exif.ISO", valueType: "number", value: 800, sensitive: false, ordinal: 0 },
          { source: "exif", key: "exif.DateTimeOriginal", valueType: "date", value: "2026-01-02T00:00:00", sensitive: false, ordinal: 0 },
          { source: "xmp", key: "xmp.Title", valueType: "text", value: "Field % Notes", sensitive: false, ordinal: 0 },
          { source: "xmp", key: "xmp.Flagged", valueType: "boolean", value: true, sensitive: false, ordinal: 0 }
        ]
      })
    );
    upsertReady(
      settings,
      "Photos/operator-other.jpg",
      "operator-other",
      "2026-01-01T00:00:00.000Z",
      new Date("2026-01-01T00:00:01.000Z"),
      metadata({
        rawMetadata: {
          exif: { ISO: [100], DateTimeOriginal: ["2026-01-01T00:00:00"] },
          xmp: { Title: ["Field X Notes"] }
        },
        values: [
          { source: "exif", key: "exif.ISO", valueType: "number", value: 100, sensitive: false, ordinal: 0 },
          { source: "exif", key: "exif.DateTimeOriginal", valueType: "date", value: "2026-01-01T00:00:00", sensitive: false, ordinal: 0 },
          { source: "xmp", key: "xmp.Title", valueType: "text", value: "Field X Notes", sensitive: false, ordinal: 0 }
        ]
      })
    );

    const names = (condition: PhotosMetadataCondition) =>
      queryPhotosAssets(db, {
        libraryUpdatedAt: settings.updatedAt,
        request: { filters: { advanced: { mode: "all", conditions: [condition] } } }
      }).photos.map((photos) => photos.name);

    expect(names({ key: "xmp.Title", operator: "eq", value: "Field % Notes" })).toEqual(["operator-match.jpg"]);
    expect(names({ key: "xmp.Title", operator: "contains", value: "%" })).toEqual(["operator-match.jpg"]);
    expect(names({ key: "xmp.Title", operator: "prefix", value: "Field %" })).toEqual(["operator-match.jpg"]);
    expect(names({ key: "xmp.Title", operator: "in", value: ["Field % Notes", "Field X Notes"] })).toHaveLength(2);
    expect(names({ key: "xmp.Flagged", operator: "exists" })).toEqual(["operator-match.jpg"]);
    expect(names({ key: "xmp.Flagged", operator: "not_exists" })).toEqual(["operator-other.jpg"]);
    expect(names({ key: "exif.ISO", operator: "lt", value: 800 })).toEqual(["operator-other.jpg"]);
    expect(names({ key: "exif.ISO", operator: "lte", value: 100 })).toEqual(["operator-other.jpg"]);
    expect(names({ key: "exif.ISO", operator: "gt", value: 100 })).toEqual(["operator-match.jpg"]);
    expect(names({ key: "exif.ISO", operator: "gte", value: 800 })).toEqual(["operator-match.jpg"]);
    expect(names({ key: "exif.ISO", operator: "between", value: 200, valueTo: 900 })).toEqual(["operator-match.jpg"]);
    expect(names({
      key: "exif.DateTimeOriginal",
      operator: "between",
      value: "2026-01-01T12:00:00",
      valueTo: "2026-01-02T12:00:00"
    })).toEqual(["operator-match.jpg"]);

    const any = queryPhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      request: {
        filters: {
          advanced: {
            mode: "any",
            conditions: [
              { key: "exif.ISO", operator: "eq", value: 800 },
              { key: "xmp.Title", operator: "eq", value: "missing" }
            ]
          }
        }
      }
    });
    expect(any.photos.map((photos) => photos.name)).toEqual(["operator-match.jpg"]);
  });

  it("replaces all metadata indexes atomically and rolls back failed replacements", () => {
    const settings = saveSettings();
    const asset = upsertReady(
      settings,
      "Photos/replace.jpg",
      "replace-old",
      "2026-01-01T00:00:00.000Z",
      new Date("2026-01-01T00:00:01.000Z"),
      metadata({
        title: "Previous Title",
        keywords: ["Previous"],
        gpsLatitude: 10,
        gpsLongitude: 20
      })
    );

    expect(() => upsertReady(
      settings,
      "Photos/replace.jpg",
      "replace-invalid",
      "2026-01-02T00:00:00.000Z",
      new Date("2026-01-02T00:00:01.000Z"),
      metadata({ schemaVersion: 0, title: "Invalid Replacement", keywords: ["Invalid"] })
    )).toThrow();
    expect(getPhotosMetadataDetail(db, { assetId: asset.id, libraryUpdatedAt: settings.updatedAt })).toMatchObject({
      summary: { title: "Previous Title", hasLocation: true },
      keywords: ["Previous"]
    });
    expect((db.prepare("SELECT COUNT(*) FROM photos_geo_index").pluck().get() as number)).toBe(1);

    const replaced = upsertReady(
      settings,
      "Photos/replace.jpg",
      "replace-new",
      "2026-01-03T00:00:00.000Z",
      new Date("2026-01-03T00:00:01.000Z"),
      metadata({
        title: "Current Title",
        keywords: ["Current"],
        gpsLatitude: null,
        gpsLongitude: null,
        rawMetadata: { xmp: { Title: ["Current Title"] } },
        values: [{ source: "xmp", key: "xmp.Title", valueType: "text", value: "Current Title", sensitive: false, ordinal: 0 }]
      })
    );

    expect(replaced.id).toBe(asset.id);
    expect(replaced.contentHash).toBe("replace-new");
    expect(queryPhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      request: { filters: { text: "Previous" } }
    }).total).toBe(0);
    expect(queryPhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      request: { filters: { text: "Current" } }
    }).total).toBe(1);
    expect((db.prepare("SELECT COUNT(*) FROM photos_geo_index").pluck().get() as number)).toBe(0);
    expect((db.prepare("SELECT keyword FROM photos_keywords WHERE asset_id = ?").pluck().all(asset.id) as string[])).toEqual(["Current"]);
    expect((db.prepare("SELECT key FROM photos_metadata_values WHERE asset_id = ?").pluck().all(asset.id) as string[])).toEqual(["xmp.Title"]);
  });

  it("redacts sensitive metadata details by default and removes virtual index rows on asset deletion", () => {
    const settings = saveSettings();
    const asset = upsertReady(
      settings,
      "Photos/private.jpg",
      "private-hash",
      "2026-01-01T00:00:00.000Z",
      new Date("2026-01-01T00:00:01.000Z"),
      metadata({ gpsLatitude: 10, gpsLongitude: 20, bodySerial: "SERIAL-1" })
    );

    const redacted = getPhotosMetadataDetail(db, {
      assetId: asset.id,
      libraryUpdatedAt: settings.updatedAt
    });
    expect(redacted?.sensitiveOmitted).toBe(true);
    expect(redacted?.sensitiveGroups).toBeUndefined();
    expect(getPhotosMetadataDetail(db, {
      assetId: asset.id,
      libraryUpdatedAt: settings.updatedAt,
      includeSensitive: true
    })?.sensitiveGroups).toEqual({ exif: { BodySerialNumber: ["SERIAL-1"], GPSLatitude: [10], GPSLongitude: [20] } });

    expect(removeStalePhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      indexedBefore: "2026-01-01T00:00:02.000Z"
    })).toBe(1);
    expect((db.prepare("SELECT COUNT(*) FROM photos_geo_index").pluck().get() as number)).toBe(0);
    expect((db.prepare("SELECT COUNT(*) FROM photos_metadata_fts").pluck().get() as number)).toBe(0);
  });

  it("excludes stale metadata schemas from facets while retaining assets in the unfiltered timeline", () => {
    const settings = saveSettings();
    const current = upsertReady(
      settings,
      "Photos/current.jpg",
      "current-hash",
      "2026-01-02T00:00:00.000Z",
      new Date("2026-01-02T00:00:01.000Z"),
      metadata({ cameraModel: "Current Camera", iso: 200, keywords: ["Current"] })
    );
    const stale = upsertReady(
      settings,
      "Photos/stale.jpg",
      "stale-hash",
      "2026-01-01T00:00:00.000Z",
      new Date("2026-01-01T00:00:01.000Z"),
      metadata({ cameraModel: "Stale Camera", iso: 6400, keywords: ["Stale"] })
    );
    db.prepare("UPDATE photos_asset_metadata SET schema_version = 999 WHERE asset_id = ?").run(stale.id);

    const result = queryPhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      request: { includeFacets: true }
    });

    expect(result.photos.map((photos) => photos.id)).toEqual(expect.arrayContaining([current.id, stale.id]));
    expect(result.facets?.cameraModels).toEqual([{ value: "Current Camera", count: 1 }]);
    expect(result.facets?.keywords).toEqual([{ value: "Current", count: 1 }]);
    expect(result.facets?.numeric.iso).toEqual({ min: 200, max: 200 });
  });

  it("does not expose or query sensitive scalar fields while reporting their presence", () => {
    const settings = saveSettings();
    const asset = upsertReady(
      settings,
      "Photos/contact.jpg",
      "contact-hash",
      "2026-01-01T00:00:00.000Z",
      new Date("2026-01-01T00:00:01.000Z"),
      metadata({
        rawMetadata: { xmp: { "CreatorContactInfo.Email": ["private@example.test"] } },
        values: [{
          source: "xmp",
          key: "xmp.CreatorContactInfo.Email",
          valueType: "text",
          value: "private@example.test",
          sensitive: true,
          ordinal: 0
        }]
      })
    );

    expect(listPhotosMetadataFields(db, { libraryUpdatedAt: settings.updatedAt })).not.toContainEqual(
      expect.objectContaining({ key: "xmp.CreatorContactInfo.Email" })
    );
    expect(queryPhotosAssets(db, {
      libraryUpdatedAt: settings.updatedAt,
      request: {
        filters: {
          advanced: { mode: "all", conditions: [{ key: "xmp.CreatorContactInfo.Email", operator: "exists" }] }
        }
      }
    }).total).toBe(0);
    expect(getPhotosMetadataDetail(db, {
      assetId: asset.id,
      libraryUpdatedAt: settings.updatedAt
    })?.summary?.hasSensitiveMetadata).toBe(true);
  });
});

function saveSettings() {
  return savePhotosLibrarySettings(db, {
        storagePoolId: "pool-a",
    path: "Photos"
  }, new Date("2026-01-01T00:00:00.000Z"));
}

function upsertReady(
  settings: ReturnType<typeof saveSettings>,
  photosPath: string,
  contentHash: string,
  takenAt: string,
  indexedAt = new Date("2026-01-01T00:00:01.000Z"),
  photosMetadata?: PhotosMetadataWriteInput
) {
  return upsertPhotosAsset(db, {
    settings,
    path: photosPath,
    name: path.basename(photosPath),
    mimeType: "image/jpeg",
    sizeBytes: 100,
    mtimeMs: indexedAt.getTime(),
    contentHash,
    width: 10,
    height: 10,
    orientation: 1,
    takenAt,
    takenAtSource: "exif",
    thumbnailKey: `${contentHash}-thumb.webp`,
    previewKey: `${contentHash}-preview.webp`,
    status: "ready",
    error: null,
    ...(photosMetadata ? { metadata: photosMetadata } : {}),
    indexedAt
  });
}

function metadata(overrides: Partial<PhotosMetadataWriteInput> = {}): PhotosMetadataWriteInput {
  const gpsLatitude = overrides.gpsLatitude ?? null;
  const gpsLongitude = overrides.gpsLongitude ?? null;
  const bodySerial = overrides.bodySerial ?? null;
  const rawMetadata = {
    exif: {
      ISO: [overrides.iso ?? 100],
      ...(bodySerial ? { BodySerialNumber: [bodySerial] } : {}),
      ...(gpsLatitude !== null ? { GPSLatitude: [gpsLatitude] } : {}),
      ...(gpsLongitude !== null ? { GPSLongitude: [gpsLongitude] } : {})
    }
  };
  return {
    schemaVersion: PHOTOS_METADATA_SCHEMA_VERSION,
    status: "ready",
    mediaKind: "image",
    capturedAt: "2026-01-01T00:00:00.000Z",
    capturedAtLocal: "2026-01-01T00:00:00",
    captureOffsetMinutes: null,
    captureSource: "exif",
    durationMs: null,
    container: null,
    videoCodec: null,
    audioCodec: null,
    cameraMake: "Sony",
    cameraModel: overrides.cameraModel ?? "Alpha",
    software: null,
    bodySerial,
    lensMake: null,
    lensModel: null,
    lensSerial: null,
    iso: overrides.iso ?? 100,
    exposureTimeSeconds: 0.01,
    aperture: 2.8,
    focalLengthMm: 35,
    focalLength35Mm: 35,
    exposureBiasEv: 0,
    exposureProgram: null,
    meteringMode: null,
    flash: null,
    whiteBalance: null,
    title: null,
    description: null,
    creator: null,
    copyright: null,
    rating: 4,
    gpsLatitude,
    gpsLongitude,
    gpsAltitudeM: null,
    gpsDirectionDeg: null,
    rawMetadata,
    warnings: [],
    keywords: overrides.keywords ?? [],
    values: [
      { source: "exif", key: "exif.ISO", valueType: "number", value: overrides.iso ?? 100, sensitive: false, ordinal: 0 },
      ...(bodySerial ? [{ source: "exif", key: "exif.BodySerialNumber", valueType: "text" as const, value: bodySerial, sensitive: true, ordinal: 0 }] : []),
      ...(gpsLatitude !== null ? [{ source: "exif", key: "exif.GPSLatitude", valueType: "number" as const, value: gpsLatitude, sensitive: true, ordinal: 0 }] : []),
      ...(gpsLongitude !== null ? [{ source: "exif", key: "exif.GPSLongitude", valueType: "number" as const, value: gpsLongitude, sensitive: true, ordinal: 0 }] : [])
    ],
    sidecarPath: null,
    sidecarSizeBytes: null,
    sidecarMtimeMs: null,
    ...overrides
  };
}
