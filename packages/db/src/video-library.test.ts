import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createMediaSource,
  saveMediaProgress,
  openCyberOsDb,
  upsertMediaCatalogEntry,
  type CyberOsDatabase,
} from "./index.js";
import {
  createMediaCollection,
  updateMediaCollection,
  listMediaCollections,
  getVideoHome,
  getVideoTitle,
  getNextVideoFile,
  listVideoTitles,
  saveEpisodeWatched,
  saveMediaState,
} from "./repositories/video-library.js";

let directory: string;
let db: CyberOsDatabase;
let sourceId: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "cyberos-video-"));
  db = openCyberOsDb(path.join(directory, "db.sqlite"));
  sourceId = createMediaSource(db, {
    name: "Movies",
    kind: "movie",
    storagePoolId: "pool-1",
    path: "Movies",
  }).id;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function movie(name: string) {
  return upsertMediaCatalogEntry(db, {
    sourceId,
    generation: "one",
    title: {
      kind: "movie",
      sourcePath: `Movies/${name}`,
      title: name,
      metadataSource: "filename",
      matchStatus: "unmatched",
    },
    file: {
      relativePath: `Movies/${name}.mp4`,
      name: `${name}.mp4`,
      mimeType: "video/mp4",
      sizeBytes: 1,
      mtimeMs: 1,
    },
  });
}
it("paginates the full library without dropping equal titles and binds cursors to filters", () => {
  for (let n = 0; n < 5; n++) movie(`Movie ${n}`);
  const first = listVideoTitles(db, { limit: 2 });
  const second = listVideoTitles(db, { limit: 2, cursor: first.nextCursor! });
  const third = listVideoTitles(db, { limit: 2, cursor: second.nextCursor! });
  expect(
    new Set(
      [...first.titles, ...second.titles, ...third.titles].map((t) => t.id),
    ).size,
  ).toBe(5);
  expect(third.nextCursor).toBeNull();
  expect(() =>
    listVideoTitles(db, { cursor: first.nextCursor!, query: "different" }),
  ).toThrow();
});
it("keeps watchlist independent from completed playback and persists state across rescans", () => {
  const { title } = movie("Arrival");
  saveMediaState(db, title.id, {
    favorite: true,
    watchlist: true,
    watched: true,
  });
  movie("Arrival");
  expect(getVideoTitle(db, title.id)?.personal).toMatchObject({
    favorite: true,
    watchlist: true,
    watched: true,
  });
  expect(getVideoHome(db).watchlist.map((t) => t.id)).toEqual([title.id]);
  expect(listVideoTitles(db, { favorite: true }).titles).toHaveLength(1);
});
it("edits collection membership atomically and rejects nonexistent titles", () => {
  const a = movie("Arrival").title.id;
  const b = movie("Dune").title.id;
  const collection = createMediaCollection(db, "Science fiction");
  updateMediaCollection(db, collection.id, { titleIds: [b, a] });
  expect(listMediaCollections(db)[0]?.titleIds).toEqual([b, a]);
  expect(() =>
    updateMediaCollection(db, collection.id, { titleIds: [a, "missing"] }),
  ).toThrow();
  expect(listMediaCollections(db)[0]?.titleIds).toEqual([b, a]);
});

it("orders next episodes across seasons, excludes specials, and requires all episodes for watched series", () => {
  const source = createMediaSource(db, {
    name: "Series",
    kind: "series",
    storagePoolId: "pool-1",
    path: "TV",
  });
  const episode = (seasonNumber: number, episodeNumber: number) =>
    upsertMediaCatalogEntry(db, {
      sourceId: source.id,
      generation: "one",
      title: {
        kind: "series",
        sourcePath: "TV/Show",
        title: "Show",
        metadataSource: "filename",
        matchStatus: "unmatched",
      },
      season: { seasonNumber },
      episode: { episodeNumber },
      file: {
        relativePath: `TV/Show/S${seasonNumber}E${episodeNumber}.mp4`,
        name: "episode.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1,
        mtimeMs: 1,
      },
    });
  episode(0, 1);
  const first = episode(1, 1);
  const second = episode(1, 2);
  const third = episode(2, 1);
  saveMediaProgress(db, {
    fileId: first.file.id,
    positionSeconds: 600,
    durationSeconds: 600,
  });
  expect(getVideoHome(db).upNext[0]?.fileId).toBe(second.file.id);
  expect(getNextVideoFile(db, second.file.id)?.fileId).toBe(third.file.id);
  expect(listVideoTitles(db, { watched: true }).titles).toHaveLength(0);
  saveEpisodeWatched(db, second.file.episodeId!, true);
  saveEpisodeWatched(db, third.file.episodeId!, true);
  expect(getVideoTitle(db, first.title.id)?.watched).toBe(true);
  saveEpisodeWatched(db, first.file.episodeId!, false);
  expect(listVideoTitles(db, { watched: false }).titles).toHaveLength(1);
  saveMediaState(db, first.title.id, { watched: true });
  expect(listVideoTitles(db, { watched: true }).titles).toHaveLength(1);
});
