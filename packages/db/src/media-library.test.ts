import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimNextMediaScan,
  createMediaSource,
  deleteMediaSource,
  enqueueMediaScan,
  ensureNasRoots,
  failMediaScan,
  finishMediaScan,
  getMediaHome,
  getMediaLibrarySettings,
  getMediaLibraryStatus,
  getMediaTitle,
  listMediaSources,
  listMediaTitles,
  openCyberOsDb,
  saveMediaLibrarySettings,
  saveMediaProgress,
  toPublicMediaLibrarySettings,
  updateMediaScanProgress,
  updateMediaSource,
  upsertMediaCatalogEntry,
  type MediaCatalogEntryInput,
  type CyberOsDatabase
} from "./index.js";

let directory: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cyberos-media-db-"));
  db = openCyberOsDb(path.join(directory, "state.sqlite"));
  ensureNasRoots(db, [{ id: "root", name: "Root", path: directory }]);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("media library persistence", () => {
  it("stores redacted scraper settings and validates source paths", () => {
    expect(getMediaLibrarySettings(db)).toBeNull();
    const saved = saveMediaLibrarySettings(db, {
      tmdbReadAccessToken: " secret-token ",
      language: "zh-CN",
      region: "cn"
    }, new Date("2026-01-01T00:00:00.000Z"));
    expect(getMediaLibrarySettings(db)).toEqual(saved);
    expect(toPublicMediaLibrarySettings(saved)).toEqual({
      tmdbTokenConfigured: true,
      language: "zh-CN",
      region: "CN",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(JSON.stringify(toPublicMediaLibrarySettings(saved))).not.toContain("secret-token");

    const source = createMediaSource(db, {
      name: " Movies ", kind: "movie", rootId: "root", storagePoolId: "pool", path: "Media/Movies/"
    });
    expect(source).toMatchObject({ name: "Movies", path: "Media/Movies", enabled: true });
    expect(updateMediaSource(db, source.id, { name: "Cinema", enabled: false })).toMatchObject({
      name: "Cinema", enabled: false
    });
    expect(listMediaSources(db)).toHaveLength(1);
    expect(() => createMediaSource(db, {
      name: "Escape", kind: "series", rootId: "root", storagePoolId: "pool", path: "../outside"
    })).toThrow("traversal");
  });

  it("leases scans, publishes movie entries, and removes stale generations", () => {
    const source = movieSource();
    const queued = enqueueMediaScan(db, source.id, new Date("2026-01-01T00:00:00.000Z"));
    expect(enqueueMediaScan(db, source.id).id).toBe(queued.id);
    const claimed = claimNextMediaScan(db, {
      workerId: "worker-1", leaseMs: 30_000, now: new Date("2026-01-01T00:00:01.000Z")
    });
    expect(claimed).toMatchObject({ id: queued.id, status: "running", workerId: "worker-1" });

    const first = upsertMovie(claimed!.generation, "Movies/Arrival (2016)/Arrival.mkv", "Arrival", 2016);
    upsertMovie("stale-generation", "Movies/Old/Old.mkv", "Old", 1999);
    expect(updateMediaScanProgress(db, {
      id: queued.id, workerId: "worker-1", leaseMs: 30_000,
      scanned: 2, added: 2, updated: 0, unmatched: 1,
      currentPath: "Movies/Arrival (2016)/Arrival.mkv"
    })).toBe(true);
    expect(finishMediaScan(db, { id: queued.id, workerId: "worker-1" })).toMatchObject({
      status: "completed", removed: 1, scanned: 2
    });
    expect(listMediaTitles(db).map((title) => title.title)).toEqual(["Arrival"]);
    expect(getMediaTitle(db, first.title.id)?.files).toHaveLength(1);
    expect(getMediaLibraryStatus(db)).toMatchObject({ state: "ready", titles: 1, movies: 1, unmatched: 0 });
  });

  it("publishes a series hierarchy and keeps the catalog isolated by source", () => {
    const source = createMediaSource(db, {
      name: "Series", kind: "series", rootId: "root", storagePoolId: "pool", path: "TV"
    });
    const generation = "series-generation";
    const entry = upsertMediaCatalogEntry(db, {
      sourceId: source.id,
      generation,
      title: {
        kind: "series", sourcePath: "TV/The Bear", title: "The Bear", year: 2022,
        metadataSource: "nfo", matchStatus: "matched", tmdbId: 136315
      },
      season: { seasonNumber: 1, name: "Season 1" },
      episode: { episodeNumber: 1, name: "System" },
      file: {
        relativePath: "TV/The Bear/Season 01/The.Bear.S01E01.mkv",
        name: "The.Bear.S01E01.mkv", mimeType: "video/x-matroska", sizeBytes: 100, mtimeMs: 200
      }
    });
    expect(entry.title.seasons[0]?.episodes[0]).toMatchObject({ episodeNumber: 1, name: "System" });
    expect(() => upsertMediaCatalogEntry(db, {
      ...seriesInput(source.id, generation),
      file: { ...seriesInput(source.id, generation).file, relativePath: "Movies/outside.mkv" }
    })).toThrow("inside its configured source");
  });

  it("tracks continue watching and treats ninety percent as completed", () => {
    movieSource();
    const first = upsertMovie("g1", "Movies/One/One.mkv", "One", 2020);
    const second = upsertMovie("g1", "Movies/Two/Two.mkv", "Two", 2021);
    saveMediaProgress(db, {
      fileId: first.file.id, positionSeconds: 130, durationSeconds: 1_000,
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(saveMediaProgress(db, {
      fileId: second.file.id, positionSeconds: 900, durationSeconds: 1_000
    }).completed).toBe(true);
    expect(getMediaHome(db).continueWatching.map((title) => title.title)).toEqual(["One"]);
    expect(getMediaTitle(db, second.title.id)?.progress?.completed).toBe(true);
  });

  it("fails owned scans and cascades catalog data when a source is removed", () => {
    const source = movieSource();
    const scan = claimNextMediaScan(db, { workerId: "worker", leaseMs: 1000 }) ?? (() => {
      enqueueMediaScan(db, source.id);
      return claimNextMediaScan(db, { workerId: "worker", leaseMs: 1000 })!;
    })();
    expect(failMediaScan(db, { id: scan.id, workerId: "other", error: "wrong owner" })).toBeNull();
    expect(failMediaScan(db, { id: scan.id, workerId: "worker", error: "offline" })).toMatchObject({
      status: "failed", error: "offline"
    });
    upsertMovie("g1", "Movies/One/One.mkv", "One", 2020);
    expect(deleteMediaSource(db, source.id)).toBe(true);
    expect(listMediaTitles(db)).toEqual([]);
  });
});

function movieSource() {
  const existing = listMediaSources(db).find((source) => source.kind === "movie");
  return existing ?? createMediaSource(db, {
    name: "Movies", kind: "movie", rootId: "root", storagePoolId: "pool", path: "Movies"
  });
}

function upsertMovie(generation: string, relativePath: string, title: string, year: number) {
  const source = movieSource();
  const sourcePath = relativePath.split("/").slice(0, -1).join("/");
  return upsertMediaCatalogEntry(db, {
    sourceId: source.id,
    generation,
    title: {
      kind: "movie", sourcePath, title, year, metadataSource: "filename",
      matchStatus: title === "Old" ? "unmatched" : "matched", matchConfidence: 0.95
    },
    file: {
      relativePath,
      name: path.posix.basename(relativePath),
      mimeType: "video/x-matroska",
      sizeBytes: 100,
      mtimeMs: 200
    }
  });
}

function seriesInput(sourceId: string, generation: string): MediaCatalogEntryInput {
  return {
    sourceId,
    generation,
    title: {
      kind: "series", sourcePath: "TV/Show", title: "Show",
      metadataSource: "filename", matchStatus: "unmatched"
    },
    season: { seasonNumber: 1 },
    episode: { episodeNumber: 1 },
    file: {
      relativePath: "TV/Show/Show.S01E01.mkv", name: "Show.S01E01.mkv",
      mimeType: "video/x-matroska", sizeBytes: 1, mtimeMs: 1
    }
  };
}
