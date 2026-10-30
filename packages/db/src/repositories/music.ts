import { createHash, randomUUID } from "node:crypto";
import type {
  MusicAlbum,
  MusicArtist,
  MusicFavoriteKind,
  MusicHome,
  MusicLibraryStatus,
  MusicPage,
  MusicPlaylist,
  MusicPlaylistTrack,
  MusicQuery,
  MusicScan,
  MusicSource,
  MusicTrack
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
type Row = Record<string, unknown>;
const statusCache = new WeakMap<
  CyberOsDatabase,
  { fingerprint: string; status: MusicLibraryStatus }
>();
const now = (): string => new Date().toISOString();
const string = (r: Row, key: string): string => String(r[key] ?? "");
const nullableString = (r: Row, key: string): string | null =>
  r[key] == null ? null : String(r[key]);
const nullableNumber = (r: Row, key: string): number | null =>
  r[key] == null ? null : Number(r[key]);
function strings(value: unknown): string[] {
  try {
    const values: unknown = JSON.parse(String(value ?? "[]"));
    return Array.isArray(values)
      ? values.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}
function row(
  db: CyberOsDatabase,
  sql: string,
  ...args: (string | number | null)[]
): Row | undefined {
  return db.prepare(sql).get(...args) as Row | undefined;
}
function rows(
  db: CyberOsDatabase,
  sql: string,
  ...args: (string | number | null)[]
): Row[] {
  return db.prepare(sql).all(...args) as Row[];
}
function cleanName(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 256 ||
    value.includes("\0")
  )
    throw new Error("A name between 1 and 256 characters is required");
  return value.trim();
}
function relativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("\\")
  )
    throw new Error("Path must remain inside its storage pool");
  const normalized = value.replace(/\/+$/u, "") || ".";
  if (
    normalized !== "." &&
    normalized.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Path traversal is not allowed");
  return normalized;
}
function source(r: Row): MusicSource {
  return {
    id: string(r, "id"),
    name: string(r, "name"),
    storagePoolId: string(r, "storage_pool_id"),
    path: string(r, "path"),
    enabled: r.enabled === 1,
    createdAt: string(r, "created_at"),
    updatedAt: string(r, "updated_at")
  };
}
function scan(r: Row): MusicScan {
  return {
    id: string(r, "id"),
    sourceId: string(r, "source_id"),
    status: string(r, "status") as MusicScan["status"],
    generation: string(r, "generation"),
    scanned: Number(r.scanned),
    added: Number(r.added),
    updated: Number(r.updated),
    removed: Number(r.removed),
    currentPath: nullableString(r, "current_path"),
    error: nullableString(r, "error"),
    createdAt: string(r, "created_at"),
    updatedAt: string(r, "updated_at"),
    startedAt: nullableString(r, "started_at"),
    finishedAt: nullableString(r, "finished_at")
  };
}
const TRACK_SELECT = `SELECT t.*, EXISTS(SELECT 1 FROM music_favorites f WHERE f.kind='track' AND f.entity_id=t.id) AS favorite, (SELECT COUNT(*) FROM music_play_events p WHERE p.track_id=t.id) AS play_count, (SELECT MAX(played_at) FROM music_play_events p WHERE p.track_id=t.id) AS last_played_at FROM music_tracks t`;
function track(r: Row): MusicTrack {
  return {
    id: string(r, "id"),
    sourceId: string(r, "source_id"),
    storagePoolId: string(r, "storage_pool_id"),
    relativePath: string(r, "relative_path"),
    title: string(r, "title"),
    albumId: string(r, "album_id"),
    album: string(r, "album"),
    artists: strings(r.artists_json),
    albumArtists: strings(r.album_artists_json),
    genres: strings(r.genres_json),
    year: nullableNumber(r, "year"),
    trackNumber: nullableNumber(r, "track_number"),
    discNumber: nullableNumber(r, "disc_number"),
    durationSeconds: nullableNumber(r, "duration_seconds"),
    bitrate: nullableNumber(r, "bitrate"),
    sampleRate: nullableNumber(r, "sample_rate"),
    bitDepth: nullableNumber(r, "bit_depth"),
    musicbrainzRecordingId: nullableString(r, "musicbrainz_recording_id"),
    musicbrainzReleaseId: nullableString(r, "musicbrainz_release_id"),
    coverKey: nullableString(r, "artwork_key"),
    missing: r.missing === 1,
    favorite: Number(r.favorite) === 1,
    playCount: Number(r.play_count ?? 0),
    lastPlayedAt: nullableString(r, "last_played_at"),
    addedAt: string(r, "added_at"),
    updatedAt: string(r, "updated_at")
  };
}
export function listMusicSources(db: CyberOsDatabase): MusicSource[] {
  return rows(
    db,
    "SELECT * FROM music_sources WHERE removed=0 ORDER BY name COLLATE NOCASE,id"
  ).map(source);
}
export function getMusicSource(
  db: CyberOsDatabase,
  id: string
): MusicSource | null {
  const r = row(db, "SELECT * FROM music_sources WHERE id=? AND removed=0", id);
  return r ? source(r) : null;
}
export function createMusicSource(
  db: CyberOsDatabase,
  input: {
    name: string;
    storagePoolId: string;
    path: string;
  }
): MusicSource {
  const name = cleanName(input.name);
  const path = relativePath(input.path);
  if (!input.storagePoolId || input.storagePoolId.length > 256)
    throw new Error("Storage pool is required");
  const overlapping = listMusicSources(db).some(
    (s) =>
      s.storagePoolId === input.storagePoolId &&
      (s.path === "." ||
        path === "." ||
        s.path === path ||
        s.path.startsWith(`${path}/`) ||
        path.startsWith(`${s.path}/`))
  );
  if (overlapping) throw new Error("Music source overlaps an existing source");
  const existing = row(
    db,
    "SELECT id FROM music_sources WHERE storage_pool_id=? AND path=?",
    input.storagePoolId,
    path
  );
  const id = existing ? string(existing, "id") : randomUUID();
  const at = now();
  db.prepare(
    "INSERT INTO music_sources(id,name,storage_pool_id,path,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(storage_pool_id,path) DO UPDATE SET name=excluded.name,removed=0,enabled=1,updated_at=excluded.updated_at"
  ).run(id, name, input.storagePoolId, path, at, at);
  return getMusicSource(db, id)!;
}
export function updateMusicSource(
  db: CyberOsDatabase,
  id: string,
  input: {
    name?: string;
    enabled?: boolean;
  }
): MusicSource | null {
  if (!getMusicSource(db, id)) return null;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new Error("Enabled must be boolean");
  return db.transaction(() => {
    const current = getMusicSource(db, id)!;
    const at = now();
    db.prepare(
      "UPDATE music_sources SET name=?,enabled=?,updated_at=? WHERE id=?"
    ).run(
      input.name === undefined ? current.name : cleanName(input.name),
      input.enabled === undefined
        ? Number(current.enabled)
        : Number(input.enabled),
      at,
      id
    );
    if (input.enabled === false) {
      db.prepare(
        "UPDATE music_scan_runs SET status='cancelled',rescan_requested=0,worker_id=NULL,lease_expires_at=NULL,finished_at=?,updated_at=? WHERE source_id=? AND status IN ('queued','running')"
      ).run(at, at, id);
      db.prepare("DELETE FROM music_scan_entries WHERE scan_id IN (SELECT id FROM music_scan_runs WHERE source_id=? AND status='cancelled')").run(id);
    }
    return getMusicSource(db, id);
  })();
}
export function removeMusicSource(db: CyberOsDatabase, id: string): boolean {
  return db.transaction(() => {
    const at = now();
    const result = db
      .prepare(
        "UPDATE music_sources SET removed=1,enabled=0,updated_at=? WHERE id=? AND removed=0"
      )
      .run(at, id);
    if (!result.changes) return false;
    db.prepare(
      "UPDATE music_tracks SET missing=1,updated_at=? WHERE source_id=?"
    ).run(at, id);
    db.prepare(
      "UPDATE music_scan_runs SET status='cancelled',finished_at=?,updated_at=?,worker_id=NULL,lease_expires_at=NULL WHERE source_id=? AND status IN ('queued','running')"
    ).run(at, at, id);
    db.prepare("DELETE FROM music_scan_entries WHERE scan_id IN (SELECT id FROM music_scan_runs WHERE source_id=? AND status='cancelled')").run(id);
    return true;
  })();
}
export function enqueueMusicScan(
  db: CyberOsDatabase,
  sourceId: string
): MusicScan {
  return db
    .transaction(() => {
      const s = getMusicSource(db, sourceId);
      if (!s?.enabled)
        throw new Error("Music source is unavailable or disabled");
      const active = row(
        db,
        "SELECT * FROM music_scan_runs WHERE source_id=? AND status IN ('queued','running')",
        sourceId
      );
      if (active) {
        db.prepare(
          "UPDATE music_scan_runs SET rescan_requested=1,full_scan=1 WHERE id=?"
        ).run(string(active, "id"));
        return scan(active);
      }
      const id = randomUUID();
      const at = now();
      db.prepare(
        "INSERT INTO music_scan_runs(id,source_id,status,generation,created_at,updated_at) VALUES(?,?,'queued',?,?,?)"
      ).run(id, sourceId, randomUUID(), at, at);
      return scan(row(db, "SELECT * FROM music_scan_runs WHERE id=?", id)!);
    })
    .immediate();
}
export function listMusicScans(db: CyberOsDatabase, limit = 20): MusicScan[] {
  return rows(
    db,
    "SELECT * FROM music_scan_runs ORDER BY created_at DESC,id DESC LIMIT ?",
    Math.max(1, Math.min(100, limit))
  ).map(scan);
}
export interface MusicTrackInput {
  sourceId: string;
  storagePoolId: string;
  relativePath: string;
  title: string;
  albumId: string;
  album: string;
  artists?: string[];
  albumArtists?: string[];
  genres?: string[];
  year?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  durationSeconds?: number | null;
  coverKey?: string | null;
  lyricsText?: string | null;
  lyricsFormat?: "lrc" | "text" | null;
  generation: string;
}
export function upsertMusicTrack(
  db: CyberOsDatabase,
  input: MusicTrackInput
): MusicTrack {
  const path = relativePath(input.relativePath);
  const existing = row(
    db,
    "SELECT id FROM music_tracks WHERE storage_pool_id=? AND relative_path=?",
    input.storagePoolId,
    path
  );
  const id = existing ? string(existing, "id") : randomUUID();
  const at = now();
  db.prepare(
    `INSERT INTO music_tracks(id,source_id,storage_pool_id,relative_path,title,album_id,album,artists_json,album_artists_json,genres_json,year,track_number,disc_number,duration_seconds,artwork_key,lyrics_text,lyrics_format,scan_generation,added_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(storage_pool_id,relative_path) DO UPDATE SET source_id=excluded.source_id,title=excluded.title,album_id=excluded.album_id,album=excluded.album,artists_json=excluded.artists_json,album_artists_json=excluded.album_artists_json,genres_json=excluded.genres_json,year=excluded.year,track_number=excluded.track_number,disc_number=excluded.disc_number,duration_seconds=excluded.duration_seconds,artwork_key=excluded.artwork_key,lyrics_text=excluded.lyrics_text,lyrics_format=excluded.lyrics_format,scan_generation=excluded.scan_generation,missing=0,updated_at=excluded.updated_at`
  ).run(
    id,
    input.sourceId,
    input.storagePoolId,
    path,
    input.title,
    input.albumId,
    input.album,
    JSON.stringify(input.artists ?? []),
    JSON.stringify(input.albumArtists ?? []),
    JSON.stringify(input.genres ?? []),
    input.year ?? null,
    input.trackNumber ?? null,
    input.discNumber ?? null,
    input.durationSeconds ?? null,
    input.coverKey ?? null,
    input.lyricsText ?? null,
    input.lyricsFormat ?? null,
    input.generation,
    at,
    at
  );
  return getMusicTrack(db, id)!;
}
export function getMusicTrack(
  db: CyberOsDatabase,
  id: string
): MusicTrack | null {
  const r = row(db, `${TRACK_SELECT} WHERE t.id=?`, id);
  return r ? track(r) : null;
}
function filters(
  q: MusicQuery,
  kind: MusicFavoriteKind
): {
  sql: string;
  args: (string | number)[];
} {
  const terms: string[] = [];
  const args: (string | number)[] = [];
  if (q.query) {
    terms.push(
      "(t.title LIKE ? ESCAPE '\\' OR t.album LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(t.artists_json) a WHERE a.value LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM json_each(t.album_artists_json) a WHERE a.value LIKE ? ESCAPE '\\'))"
    );
    const pattern = `%${q.query.replace(/[\\%_]/gu, "\\$&")}%`;
    args.push(pattern, pattern, pattern, pattern);
  }
  if (q.sourceId) {
    terms.push("t.source_id=?");
    args.push(q.sourceId);
  }
  if (q.albumId) {
    terms.push("t.album_id=?");
    args.push(q.albumId);
  }
  if (q.artistId) {
    terms.push(
      "(EXISTS(SELECT 1 FROM json_each(t.artists_json) a WHERE a.value=?) OR EXISTS(SELECT 1 FROM json_each(t.album_artists_json) a WHERE a.value=?))"
    );
    args.push(q.artistId, q.artistId);
  }
  if (q.year !== undefined) {
    terms.push("t.year=?");
    args.push(q.year);
  }
  if (q.genre) {
    terms.push(
      "EXISTS(SELECT 1 FROM json_each(t.genres_json) g WHERE g.value=?)"
    );
    args.push(q.genre);
  }
  if (q.favorite && kind !== "artist") {
    terms.push(
      `EXISTS(SELECT 1 FROM music_favorites f WHERE f.kind=? AND f.entity_id=${kind === "album" ? "t.album_id" : "t.id"})`
    );
    args.push(kind);
  }
  return { sql: terms.length ? ` WHERE ${terms.join(" AND ")}` : "", args };
}
function pagination(
  db: CyberOsDatabase,
  q: MusicQuery,
  kind: string
): {
  limit: number;
  offset: number;
  signature: string;
} {
  const limit = Math.max(1, Math.min(100, q.limit ?? 40));
  const catalog = row(
    db,
    "SELECT COUNT(*) AS count,MAX(updated_at) AS updated,COALESCE(SUM(missing),0) AS missing FROM music_tracks"
  );
  const changes =
    kind === "playlists"
      ? row(
          db,
          "SELECT COUNT(*) AS count,MAX(updated_at) AS updated FROM music_playlists"
        )
      : q.favorite
        ? row(
            db,
            "SELECT COUNT(*) AS count,MAX(created_at) AS updated FROM music_favorites"
          )
        : null;
  const signature = createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        q.query ?? "",
        q.sourceId ?? "",
        q.albumId ?? "",
        q.artistId ?? "",
        q.year ?? null,
        q.genre ?? "",
        q.favorite ?? false,
        q.sort ?? "name",
        catalog,
        changes
      ])
    )
    .digest("hex");
  let offset = 0;
  if (q.cursor) {
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(q.cursor, "base64url").toString("utf8")
      );
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        !("offset" in decoded) ||
        !("signature" in decoded) ||
        decoded.signature !== signature ||
        !Number.isSafeInteger(decoded.offset) ||
        Number(decoded.offset) < 0 ||
        Number(decoded.offset) > 10_000_000
      )
        throw new Error();
      offset = Number(decoded.offset);
    } catch {
      throw new Error(
        "Invalid music cursor: filters or library changed; refresh the list"
      );
    }
  }
  return { limit, offset, signature };
}
function page<T>(
  items: T[],
  limit: number,
  offset: number,
  signature: string
): MusicPage<T> {
  return {
    items: items.slice(0, limit),
    nextCursor:
      items.length > limit
        ? Buffer.from(
            JSON.stringify({ offset: offset + limit, signature })
          ).toString("base64url")
        : null
  };
}
export function listMusicTracks(
  db: CyberOsDatabase,
  q: MusicQuery = {}
): MusicPage<MusicTrack> {
  const f = filters(q, "track");
  const p = pagination(db, q, "tracks");
  const order = q.albumId
    ? "COALESCE(t.disc_number,1),COALESCE(t.track_number,2147483647),t.title COLLATE NOCASE,t.id"
    : q.sort === "added"
      ? "t.added_at DESC,t.id"
      : q.sort === "year"
        ? "t.year DESC,t.title COLLATE NOCASE,t.id"
        : "t.title COLLATE NOCASE,t.id";
  return page(
    rows(
      db,
      `${TRACK_SELECT}${f.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...f.args,
      p.limit + 1,
      p.offset
    ).map(track),
    p.limit,
    p.offset,
    p.signature
  );
}
const ALBUM_SELECT = `SELECT t.album_id AS id,MIN(t.album) AS title,MIN(t.album_artists_json) AS artists_json,MIN(t.genres_json) AS genres_json,MAX(t.year) AS year,MIN(t.artwork_key) AS artwork_key,COUNT(*) AS track_count,COALESCE(SUM(t.duration_seconds),0) AS duration_seconds,MAX(t.added_at) AS added_at,EXISTS(SELECT 1 FROM music_favorites f WHERE f.kind='album' AND f.entity_id=t.album_id) AS favorite FROM music_tracks t`;
function album(r: Row): MusicAlbum {
  return {
    id: string(r, "id"),
    title: string(r, "title"),
    artists: strings(r.artists_json),
    genres: strings(r.genres_json),
    year: nullableNumber(r, "year"),
    coverKey: nullableString(r, "artwork_key"),
    trackCount: Number(r.track_count),
    durationSeconds: Number(r.duration_seconds),
    favorite: Number(r.favorite) === 1,
    addedAt: string(r, "added_at")
  };
}
export function listMusicAlbums(
  db: CyberOsDatabase,
  q: MusicQuery = {}
): MusicPage<MusicAlbum> {
  const f = filters(q, "album");
  const p = pagination(db, q, "albums");
  const order =
    q.sort === "added"
      ? "added_at DESC,id"
      : q.sort === "year"
        ? "year DESC,title COLLATE NOCASE,id"
        : "title COLLATE NOCASE,id";
  return page(
    rows(
      db,
      `${ALBUM_SELECT} WHERE t.album_id IN (SELECT t.album_id FROM music_tracks t${f.sql}) GROUP BY t.album_id ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...f.args,
      p.limit + 1,
      p.offset
    ).map(album),
    p.limit,
    p.offset,
    p.signature
  );
}
export function getMusicAlbum(
  db: CyberOsDatabase,
  id: string
): {
  album: MusicAlbum;
  tracks: MusicTrack[];
} | null {
  const r = row(
    db,
    `${ALBUM_SELECT} WHERE t.album_id=? GROUP BY t.album_id`,
    id
  );
  if (!r) return null;
  return {
    album: album(r),
    tracks: rows(
      db,
      `${TRACK_SELECT} WHERE t.album_id=? ORDER BY COALESCE(t.disc_number,1),COALESCE(t.track_number,2147483647),t.relative_path,t.id`,
      id
    ).map(track)
  };
}
function artist(r: Row): MusicArtist {
  return {
    id: string(r, "name"),
    name: string(r, "name"),
    albumCount: Number(r.album_count),
    trackCount: Number(r.track_count),
    coverKey: nullableString(r, "artwork_key"),
    favorite: Number(r.favorite) === 1
  };
}
export function listMusicArtists(
  db: CyberOsDatabase,
  q: MusicQuery = {}
): MusicPage<MusicArtist> {
  const artistQuery = { ...q, favorite: false };
  delete artistQuery.query;
  const f = filters(artistQuery, "artist");
  const p = pagination(db, q, "artists");
  const where: string[] = [];
  const args: (string | number)[] = [...f.args];
  if (q.query) {
    where.push("a.name LIKE ? ESCAPE '\\'");
    args.push(`%${q.query.replace(/[\\%_]/gu, "\\$&")}%`);
  }
  if (q.artistId) {
    where.push("a.name=?");
    args.push(q.artistId);
  }
  if (q.favorite)
    where.push(
      "EXISTS(SELECT 1 FROM music_favorites f WHERE f.kind='artist' AND f.entity_id=a.name)"
    );
  const sql = `WITH filtered AS (SELECT t.* FROM music_tracks t${f.sql}), names AS (SELECT t.id,t.album_id,t.artwork_key,j.value AS name FROM filtered t,json_each(t.artists_json) j UNION SELECT t.id,t.album_id,t.artwork_key,j.value AS name FROM filtered t,json_each(t.album_artists_json) j) SELECT a.name,COUNT(DISTINCT a.id) AS track_count,COUNT(DISTINCT a.album_id) AS album_count,MIN(a.artwork_key) AS artwork_key,EXISTS(SELECT 1 FROM music_favorites f WHERE f.kind='artist' AND f.entity_id=a.name) AS favorite FROM names a${where.length ? ` WHERE ${where.join(" AND ")}` : ""} GROUP BY a.name ORDER BY a.name COLLATE NOCASE,a.name LIMIT ? OFFSET ?`;
  return page(
    rows(db, sql, ...args, p.limit + 1, p.offset).map(artist),
    p.limit,
    p.offset,
    p.signature
  );
}
export function getMusicArtist(
  db: CyberOsDatabase,
  id: string
): {
  artist: MusicArtist;
  albums: MusicAlbum[];
  tracks: MusicTrack[];
  albumsNextCursor: string | null;
  tracksNextCursor: string | null;
} | null {
  const found = listMusicArtists(db, { artistId: id, limit: 100 }).items.find(
    (a) => a.id === id
  );
  if (!found) return null;
  const albums = listMusicAlbums(db, { artistId: id, limit: 100 });
  const tracks = listMusicTracks(db, { artistId: id, limit: 100 });
  return {
    artist: found,
    albums: albums.items,
    tracks: tracks.items,
    albumsNextCursor: albums.nextCursor,
    tracksNextCursor: tracks.nextCursor
  };
}
export function setMusicFavorite(
  db: CyberOsDatabase,
  kind: MusicFavoriteKind,
  id: string,
  favorite: boolean
): void {
  if (
    !["track", "album", "artist"].includes(kind) ||
    typeof favorite !== "boolean" ||
    !id ||
    id.length > 512
  )
    throw new Error("Favorite is invalid");
  const exists =
    kind === "track"
      ? getMusicTrack(db, id)
      : kind === "album"
        ? getMusicAlbum(db, id)
        : getMusicArtist(db, id);
  if (!exists) throw new Error("Music item not found");
  if (favorite)
    db.prepare(
      "INSERT OR IGNORE INTO music_favorites(kind,entity_id,created_at) VALUES(?,?,?)"
    ).run(kind, id, now());
  else
    db.prepare("DELETE FROM music_favorites WHERE kind=? AND entity_id=?").run(
      kind,
      id
    );
}
const PLAYLIST_SELECT = `SELECT p.*,COUNT(i.id) AS track_count,COALESCE(SUM(t.duration_seconds),0) AS duration_seconds FROM music_playlists p LEFT JOIN music_playlist_items i ON i.playlist_id=p.id LEFT JOIN music_tracks t ON t.id=i.track_id`;
function playlist(r: Row): MusicPlaylist {
  return {
    id: string(r, "id"),
    name: string(r, "name"),
    trackCount: Number(r.track_count),
    durationSeconds: Number(r.duration_seconds),
    createdAt: string(r, "created_at"),
    updatedAt: string(r, "updated_at")
  };
}
export function listMusicPlaylists(
  db: CyberOsDatabase,
  q: MusicQuery = {}
): MusicPage<MusicPlaylist> {
  const p = pagination(db, q, "playlists");
  const search = q.query ? " WHERE p.name LIKE ?" : "";
  return page(
    rows(
      db,
      `${PLAYLIST_SELECT}${search} GROUP BY p.id ORDER BY p.name COLLATE NOCASE,p.id LIMIT ? OFFSET ?`,
      ...(q.query ? [`%${q.query}%`] : []),
      p.limit + 1,
      p.offset
    ).map(playlist),
    p.limit,
    p.offset,
    p.signature
  );
}
export function getMusicPlaylist(
  db: CyberOsDatabase,
  id: string
): {
  playlist: MusicPlaylist;
  tracks: MusicPlaylistTrack[];
} | null {
  const r = row(db, `${PLAYLIST_SELECT} WHERE p.id=? GROUP BY p.id`, id);
  if (!r) return null;
  const items = rows(
    db,
    `${TRACK_SELECT.replace("SELECT t.*", "SELECT t.*,i.id AS playlist_item_id")} JOIN music_playlist_items i ON i.track_id=t.id WHERE i.playlist_id=? ORDER BY i.position`,
    id
  ).map((r) => ({
    ...track(r),
    playlistItemId: string(r, "playlist_item_id")
  }));
  return { playlist: playlist(r), tracks: items };
}
export function createMusicPlaylist(
  db: CyberOsDatabase,
  name: string,
  trackIds: string[] = []
): MusicPlaylist {
  return db.transaction(() => {
    const id = randomUUID();
    const at = now();
    db.prepare(
      "INSERT INTO music_playlists(id,name,created_at,updated_at) VALUES(?,?,?,?)"
    ).run(id, cleanName(name), at, at);
    replaceMusicPlaylistTracks(db, id, trackIds);
    return getMusicPlaylist(db, id)!.playlist;
  })();
}
export function replaceMusicPlaylistTracks(
  db: CyberOsDatabase,
  id: string,
  trackIds: string[]
): void {
  if (
    !Array.isArray(trackIds) ||
    trackIds.length > 10000 ||
    trackIds.some((v) => typeof v !== "string")
  )
    throw new Error("Playlist is invalid or too large");
  db.transaction(() => {
    if (!row(db, "SELECT id FROM music_playlists WHERE id=?", id))
      throw new Error("Playlist not found");
    for (const trackId of new Set(trackIds))
      if (!getMusicTrack(db, trackId)) throw new Error("Music track not found");
    db.prepare("DELETE FROM music_playlist_items WHERE playlist_id=?").run(id);
    const insert = db.prepare(
      "INSERT INTO music_playlist_items(id,playlist_id,track_id,position) VALUES(?,?,?,?)"
    );
    trackIds.forEach((trackId, index) =>
      insert.run(randomUUID(), id, trackId, index)
    );
    db.prepare("UPDATE music_playlists SET updated_at=? WHERE id=?").run(
      now(),
      id
    );
  })();
}
export function updateMusicPlaylist(
  db: CyberOsDatabase,
  id: string,
  input: {
    name?: string;
    trackIds?: string[];
  }
): MusicPlaylist | null {
  return db.transaction(() => {
    if (!row(db, "SELECT id FROM music_playlists WHERE id=?", id)) return null;
    if (input.name !== undefined)
      db.prepare(
        "UPDATE music_playlists SET name=?,updated_at=? WHERE id=?"
      ).run(cleanName(input.name), now(), id);
    if (input.trackIds !== undefined)
      replaceMusicPlaylistTracks(db, id, input.trackIds);
    return getMusicPlaylist(db, id)!.playlist;
  })();
}
export function deleteMusicPlaylist(db: CyberOsDatabase, id: string): boolean {
  return (
    db.prepare("DELETE FROM music_playlists WHERE id=?").run(id).changes > 0
  );
}
export function recordMusicPlay(
  db: CyberOsDatabase,
  input: {
    id: string;
    trackId: string;
    playedAt: string;
    listenedSeconds: number;
  }
): void {
  db.prepare(
    "INSERT OR IGNORE INTO music_play_events(id,track_id,played_at,listened_seconds) VALUES(?,?,?,?)"
  ).run(input.id, input.trackId, input.playedAt, input.listenedSeconds);
}
export function getMusicHome(db: CyberOsDatabase): MusicHome {
  return {
    recentlyAdded: listMusicAlbums(db, { sort: "added", limit: 12 }).items,
    recentlyPlayed: rows(
      db,
      `${TRACK_SELECT} WHERE EXISTS(SELECT 1 FROM music_play_events e WHERE e.track_id=t.id) ORDER BY last_played_at DESC,t.id LIMIT 12`
    ).map(track),
    mostPlayed: rows(
      db,
      `${TRACK_SELECT} WHERE EXISTS(SELECT 1 FROM music_play_events e WHERE e.track_id=t.id) ORDER BY play_count DESC,last_played_at DESC,t.id LIMIT 12`
    ).map(track),
    favorites: listMusicTracks(db, { favorite: true, limit: 12 }).items
  };
}
export function getMusicLibraryStatus(db: CyberOsDatabase): MusicLibraryStatus {
  // Cross-process writes change data_version; API writes change total_changes.
  // Avoid walking every artist tag each second while the library is unchanged.
  const fingerprint = JSON.stringify([
    db.pragma("data_version", { simple: true }),
    db.prepare("SELECT total_changes()").pluck().get()
  ]);
  const cached = statusCache.get(db);
  if (cached?.fingerprint === fingerprint) return cached.status;
  const c = row(
    db,
    "SELECT COUNT(*) AS tracks,COUNT(DISTINCT album_id) AS albums,COALESCE(SUM(missing),0) AS missing,MAX(updated_at) AS updated FROM music_tracks"
  )!;
  const sourceCount = Number(
    row(db, "SELECT COUNT(*) AS count FROM music_sources WHERE removed=0")
      ?.count ?? 0
  );
  const artistCount = Number(
    row(
      db,
      "SELECT COUNT(*) AS count FROM (SELECT value FROM music_tracks,json_each(music_tracks.artists_json) UNION SELECT value FROM music_tracks,json_each(music_tracks.album_artists_json))"
    )?.count ?? 0
  );
  const scans = listMusicScans(db, 5);
  const userData = row(
    db,
    "SELECT (SELECT COUNT(*) FROM music_favorites) AS favorites,(SELECT MAX(created_at) FROM music_favorites) AS favorite_updated,(SELECT COUNT(*) FROM music_playlists) AS playlists,(SELECT MAX(updated_at) FROM music_playlists) AS playlist_updated,(SELECT COUNT(*) FROM music_play_events) AS plays,(SELECT MAX(played_at) FROM music_play_events) AS last_played"
  );
  const status: MusicLibraryStatus = {
    sourceCount,
    trackCount: Number(c.tracks),
    albumCount: Number(c.albums),
    artistCount,
    missingCount: Number(c.missing),
    scans,
    revision: JSON.stringify([
      c.updated,
      c.tracks,
      c.missing,
      sourceCount,
      scans.map((s) => [s.id, s.updatedAt, s.status]),
      userData
    ])
  };
  statusCache.set(db, { fingerprint, status });
  return status;
}
export function getMusicLyrics(
  db: CyberOsDatabase,
  id: string
): {
  text: string | null;
  format: "lrc" | "text" | null;
} | null {
  const r = row(
    db,
    "SELECT lyrics_text,lyrics_format FROM music_tracks WHERE id=?",
    id
  );
  return r
    ? {
        text: nullableString(r, "lyrics_text"),
        format: nullableString(r, "lyrics_format") as "lrc" | "text" | null
      }
    : null;
}
