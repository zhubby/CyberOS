import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCyberOsDb, type CyberOsDatabase } from "./connection.js";
import {
  createMusicSource,
  enqueueMusicScan,
  listMusicScans,
  listMusicTracks,
  upsertMusicTrack,
  setMusicFavorite,
  createMusicPlaylist,
  getMusicPlaylist,
  replaceMusicPlaylistTracks,
  removeMusicSource,
  getMusicHome,
  getMusicArtist,
  listMusicAlbums,
  recordMusicPlay,
  updateMusicSource
} from "./repositories/music.js";
let root: string;
let db: CyberOsDatabase;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "cyberos-music-db-"));
  db = openCyberOsDb(path.join(root, "db.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function seed(title = "Song", relativePath = "Music/a.flac") {
  const sources = db.prepare("SELECT id FROM music_sources").get() as
    | {
        id: string;
      }
    | undefined;
  const source =
    sources ??
    createMusicSource(db, {
      name: "Music",
      storagePoolId: "pool",
      path: "Music"
    });
  return upsertMusicTrack(db, {
    sourceId: source.id,
    storagePoolId: "pool",
    relativePath,
    title,
    albumId: "album-a",
    album: "Album",
    artists: ["A", "B"],
    albumArtists: ["Various Artists"],
    genres: ["Rock"],
    generation: "one"
  });
}
describe("music library persistence", () => {
  it("keeps source paths bounded and scan enqueue idempotent", () => {
    expect(() =>
      createMusicSource(db, {
        name: "Bad",
        storagePoolId: "pool",
        path: "../escape"
      })
    ).toThrow();
    const track = seed();
    const one = enqueueMusicScan(db, track.sourceId);
    expect(enqueueMusicScan(db, track.sourceId).id).toBe(one.id);
    expect(listMusicScans(db)).toHaveLength(1);
  });
  it("preserves song identity, favorites and playlist references across rescans and missing sources", () => {
    const track = seed();
    setMusicFavorite(db, "track", track.id, true);
    const playlist = createMusicPlaylist(db, "Favorites", [track.id, track.id]);
    const changed = seed("New title");
    expect(changed.id).toBe(track.id);
    expect(changed.favorite).toBe(true);
    expect(getMusicPlaylist(db, playlist.id)?.tracks.map((t) => t.id)).toEqual([
      track.id,
      track.id
    ]);
    removeMusicSource(db, track.sourceId);
    expect(
      getMusicPlaylist(db, playlist.id)?.tracks.every((t) => t.missing)
    ).toBe(true);
  });
  it("paginates with stable cursors and filters multiple artist tags", () => {
    seed("A", "Music/a.flac");
    seed("B", "Music/b.flac");
    const first = listMusicTracks(db, { limit: 1, artistId: "B" });
    expect(first.items.map((t) => t.title)).toEqual(["A"]);
    expect(first.nextCursor).toBeTruthy();
    expect(
      listMusicTracks(db, {
        limit: 1,
        artistId: "B",
        cursor: first.nextCursor!
      }).items.map((t) => t.title)
    ).toEqual(["B"]);
    expect(() => listMusicTracks(db, { cursor: "garbage" })).toThrow();
  });
  it("reorders playlists atomically and rejects unknown songs", () => {
    const a = seed("A", "Music/a.flac");
    const b = seed("B", "Music/b.flac");
    const playlist = createMusicPlaylist(db, "Mix", [a.id, b.id]);
    expect(() =>
      replaceMusicPlaylistTracks(db, playlist.id, ["missing"])
    ).toThrow();
    expect(getMusicPlaylist(db, playlist.id)?.tracks.map((t) => t.id)).toEqual([
      a.id,
      b.id
    ]);
    replaceMusicPlaylistTracks(db, playlist.id, [b.id, a.id]);
    expect(getMusicPlaylist(db, playlist.id)?.tracks.map((t) => t.id)).toEqual([
      b.id,
      a.id
    ]);
  });
  it("flags a rescan requested during an active scan and cancels it when disabled", () => {
    const t = seed();
    const scan = enqueueMusicScan(db, t.sourceId);
    db.prepare(
      "UPDATE music_scan_runs SET status='running',worker_id='worker' WHERE id=?"
    ).run(scan.id);
    expect(enqueueMusicScan(db, t.sourceId).id).toBe(scan.id);
    expect(
      db
        .prepare("SELECT rescan_requested FROM music_scan_runs WHERE id=?")
        .pluck()
        .get(scan.id)
    ).toBe(1);
    db.prepare("INSERT INTO music_scan_entries VALUES (?, 'Music/a.flac', '{}')").run(scan.id);
    updateMusicSource(db, t.sourceId, { enabled: false });
    expect(listMusicScans(db)[0]?.status).toBe("cancelled");
    expect(db.prepare("SELECT COUNT(*) FROM music_scan_entries").pluck().get()).toBe(0);
    expect(() => enqueueMusicScan(db, t.sourceId)).toThrow("disabled");
    expect(listMusicTracks(db).items[0]?.missing).toBe(false);
  });
  it("returns continuation cursors for artists with more than 100 tracks and albums", () => {
    db.transaction(() => {
      for (let i = 0; i < 105; i++) {
        const track = seed(`Song ${String(i).padStart(3, "0")}`, `Music/${i}.flac`);
        db.prepare("UPDATE music_tracks SET album_id=?,album=? WHERE id=?").run(`album-${i}`, `Album ${String(i).padStart(3, "0")}`, track.id);
      }
    })();
    const detail = getMusicArtist(db, "A")!;
    expect(detail.artist.trackCount).toBe(105);
    expect(detail.tracks).toHaveLength(100);
    expect(detail.albums).toHaveLength(100);
    const moreTracks = listMusicTracks(db, { artistId: "A", limit: 100, cursor: detail.tracksNextCursor! });
    const moreAlbums = listMusicAlbums(db, { artistId: "A", limit: 100, cursor: detail.albumsNextCursor! });
    expect(moreTracks.items).toHaveLength(5);
    expect(moreAlbums.items).toHaveLength(5);
    expect(new Set([...detail.tracks, ...moreTracks.items].map((track) => track.id)).size).toBe(105);
    db.prepare("UPDATE music_tracks SET artists_json=json_array('ZZZ shared artist', title),album_artists_json='[]'").run();
    expect(getMusicArtist(db, "ZZZ shared artist")?.artist.trackCount).toBe(105);
  });
  it("discards staged scan metadata when a source is removed", () => {
    const track = seed();
    const scan = enqueueMusicScan(db, track.sourceId);
    db.prepare("INSERT INTO music_scan_entries VALUES (?, 'Music/a.flac', '{}')").run(scan.id);
    removeMusicSource(db, track.sourceId);
    expect(db.prepare("SELECT COUNT(*) FROM music_scan_entries").pluck().get()).toBe(0);
  });
  it("keeps duplicate titles distinct and rejects cursors after filter or catalog changes", () => {
    seed("Same", "Music/one.flac");
    seed("Same", "Music/two.flac");
    const first = listMusicTracks(db, { limit: 1 });
    const second = listMusicTracks(db, { limit: 1, cursor: first.nextCursor! });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.nextCursor).toBeNull();
    expect(() =>
      listMusicTracks(db, {
        limit: 1,
        query: "Same",
        cursor: first.nextCursor!
      })
    ).toThrow("filters or library changed");
    seed("Earlier", "Music/three.flac");
    expect(() =>
      listMusicTracks(db, { limit: 1, cursor: first.nextCursor! })
    ).toThrow("filters or library changed");
  });
  it("records listening events idempotently and builds history from real plays", () => {
    const t = seed();
    recordMusicPlay(db, {
      id: "event",
      trackId: t.id,
      playedAt: "2026-10-30T01:00:00Z",
      listenedSeconds: 120
    });
    recordMusicPlay(db, {
      id: "event",
      trackId: t.id,
      playedAt: "2026-10-30T01:00:00Z",
      listenedSeconds: 120
    });
    expect(getMusicHome(db).mostPlayed[0]?.playCount).toBe(1);
  });
});
