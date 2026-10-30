import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  MediaArtworkRecord,
  MediaEpisodeRecord,
  MediaFileRecord,
  MediaHome,
  MediaLibrarySettingsRecord,
  MediaLibraryStatus,
  MediaMatchStatus,
  MediaMetadataSource,
  MediaProgressRecord,
  MediaScanRunRecord,
  MediaSeasonRecord,
  MediaSourceKind,
  MediaSourceRecord,
  MediaTitleDetail,
  MediaTitleKind,
  MediaTitleSummary,
  PublicMediaLibrarySettings
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";

const MEDIA_LIBRARY_SETTING_KEY = "media_library_settings";
const DEFAULT_PROFILE_ID = "local-admin";
const CONTINUE_MINIMUM_SECONDS = 120;
const COMPLETED_RATIO = 0.9;

type MediaSourceRow = {
  id: string;
  name: string;
  kind: MediaSourceKind;
  storage_pool_id: string;
  path: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type MediaTitleRow = {
  id: string;
  source_id: string;
  kind: MediaTitleKind;
  source_path: string;
  tmdb_id: number | null;
  title: string;
  original_title: string | null;
  overview: string | null;
  year: number | null;
  release_date: string | null;
  runtime_minutes: number | null;
  original_language: string | null;
  genres_json: string;
  metadata_source: MediaMetadataSource;
  match_status: MediaMatchStatus;
  match_confidence: number | null;
  poster_key: string | null;
  backdrop_key: string | null;
  added_at: string;
  updated_at: string;
  progress_file_id: string | null;
  progress_profile_id: string | null;
  progress_position_seconds: number | null;
  progress_duration_seconds: number | null;
  progress_completed: number | null;
  progress_updated_at: string | null;
};

type MediaSeasonRow = {
  id: string;
  title_id: string;
  season_number: number;
  name: string | null;
  overview: string | null;
  poster_key: string | null;
  updated_at: string;
};

type MediaEpisodeRow = {
  id: string;
  title_id: string;
  season_id: string;
  episode_number: number;
  name: string | null;
  overview: string | null;
  air_date: string | null;
  runtime_minutes: number | null;
  still_key: string | null;
  updated_at: string;
};

type MediaFileRow = {
  id: string;
  source_id: string;
  title_id: string;
  episode_id: string | null;
  storage_pool_id: string;
  relative_path: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  mtime_ms: number;
  duration_seconds: number | null;
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  updated_at: string;
};

type MediaArtworkRow = {
  id: string;
  title_id: string;
  season_id: string | null;
  episode_id: string | null;
  kind: MediaArtworkRecord["kind"];
  source: MediaArtworkRecord["source"];
  source_url: string | null;
  cache_key: string;
  width: number | null;
  height: number | null;
  language: string | null;
  is_primary: number;
  updated_at: string;
};

type MediaScanRunRow = {
  id: string;
  source_id: string;
  status: MediaScanRunRecord["status"];
  generation: string;
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  unmatched: number;
  current_path: string | null;
  error: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export interface MediaCatalogEntryInput {
  sourceId: string;
  generation: string;
  title: {
    id?: string;
    kind: MediaTitleKind;
    sourcePath: string;
    tmdbId?: number | null;
    title: string;
    originalTitle?: string | null;
    overview?: string | null;
    year?: number | null;
    releaseDate?: string | null;
    runtimeMinutes?: number | null;
    originalLanguage?: string | null;
    genres?: string[];
    metadataSource: MediaMetadataSource;
    matchStatus: MediaMatchStatus;
    matchConfidence?: number | null;
    posterKey?: string | null;
    backdropKey?: string | null;
  };
  season?: {
    id?: string;
    seasonNumber: number;
    name?: string | null;
    overview?: string | null;
    posterKey?: string | null;
  };
  episode?: {
    id?: string;
    episodeNumber: number;
    name?: string | null;
    overview?: string | null;
    airDate?: string | null;
    runtimeMinutes?: number | null;
    stillKey?: string | null;
  };
  file: {
    id?: string;
    relativePath: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    mtimeMs: number;
    durationSeconds?: number | null;
    container?: string | null;
    videoCodec?: string | null;
    audioCodec?: string | null;
  };
}

export function defaultMediaLibrarySettings(): MediaLibrarySettingsRecord {
  return {
    tmdbReadAccessToken: null,
    language: "zh-CN",
    region: "CN",
    updatedAt: new Date(0).toISOString()
  };
}

export function getMediaLibrarySettings(db: CyberOsDatabase): MediaLibrarySettingsRecord | null {
  const row = db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(MEDIA_LIBRARY_SETTING_KEY) as { value_json: string; updated_at: string } | undefined;
  if (!row) return null;
  let parsed: Partial<MediaLibrarySettingsRecord>;
  try {
    parsed = JSON.parse(row.value_json) as Partial<MediaLibrarySettingsRecord>;
  } catch {
    throw new Error("Media library settings are not valid CyberOS 2.0 format");
  }
  if (
    !isNullableNonEmptyString(parsed.tmdbReadAccessToken)
    || typeof parsed.language !== "string"
    || !isNullableNonEmptyString(parsed.region)
    || typeof parsed.updatedAt !== "string"
    || !Number.isFinite(Date.parse(parsed.updatedAt))
  ) {
    throw new Error("Media library settings are not valid CyberOS 2.0 format");
  }
  return {
    tmdbReadAccessToken: textOrNull(parsed.tmdbReadAccessToken),
    language: normalizeLanguage(parsed.language),
    region: normalizeRegion(parsed.region),
    updatedAt: parsed.updatedAt
  };
}

export function saveMediaLibrarySettings(
  db: CyberOsDatabase,
  input: Omit<MediaLibrarySettingsRecord, "updatedAt">,
  now = new Date()
): MediaLibrarySettingsRecord {
  const record: MediaLibrarySettingsRecord = {
    tmdbReadAccessToken: textOrNull(input.tmdbReadAccessToken),
    language: normalizeLanguage(input.language),
    region: normalizeRegion(input.region),
    updatedAt: now.toISOString()
  };
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(MEDIA_LIBRARY_SETTING_KEY, JSON.stringify(record), record.updatedAt);
  return record;
}

export function toPublicMediaLibrarySettings(settings: MediaLibrarySettingsRecord): PublicMediaLibrarySettings {
  return {
    tmdbTokenConfigured: Boolean(settings.tmdbReadAccessToken),
    language: settings.language,
    region: settings.region,
    updatedAt: settings.updatedAt
  };
}

export function createMediaSource(
  db: CyberOsDatabase,
  input: {
    id?: string;
    name: string;
    kind: MediaSourceKind;
    storagePoolId: string;
    path: string;
    enabled?: boolean;
  },
  now = new Date()
): MediaSourceRecord {
  const id = input.id ?? randomUUID();
  const createdAt = now.toISOString();
  const storagePoolId = requiredText(input.storagePoolId, "Media source storage pool is required");
  const sourcePath = normalizeRelativeMediaPath(input.path);
  const name = requiredText(input.name, "Media source name is required");
  assertMediaKind(input.kind);
  db.prepare(`
    INSERT INTO media_sources (
      id, name, kind, storage_pool_id, path, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, input.kind, storagePoolId, sourcePath, input.enabled === false ? 0 : 1, createdAt, createdAt);
  return getRequiredMediaSource(db, id);
}

export function updateMediaSource(
  db: CyberOsDatabase,
  id: string,
  input: Partial<Pick<MediaSourceRecord, "name" | "enabled">>,
  now = new Date()
): MediaSourceRecord | null {
  const existing = getMediaSource(db, id);
  if (!existing) return null;
  const name = input.name === undefined ? existing.name : requiredText(input.name, "Media source name is required");
  db.prepare("UPDATE media_sources SET name = ?, enabled = ?, updated_at = ? WHERE id = ?")
    .run(name, input.enabled === undefined ? Number(existing.enabled) : Number(input.enabled), now.toISOString(), id);
  return getRequiredMediaSource(db, id);
}

export function deleteMediaSource(db: CyberOsDatabase, id: string): boolean {
  return db.prepare("DELETE FROM media_sources WHERE id = ?").run(id).changes === 1;
}

export function getMediaSource(db: CyberOsDatabase, id: string): MediaSourceRecord | null {
  const row = db.prepare("SELECT * FROM media_sources WHERE id = ?").get(id) as MediaSourceRow | undefined;
  return row ? mapMediaSource(row) : null;
}

export function listMediaSources(db: CyberOsDatabase): MediaSourceRecord[] {
  const rows = db.prepare("SELECT * FROM media_sources ORDER BY name COLLATE NOCASE, id").all() as MediaSourceRow[];
  return rows.map(mapMediaSource);
}

export function enqueueMediaScan(db: CyberOsDatabase, sourceId: string, now = new Date()): MediaScanRunRecord {
  const source = getMediaSource(db, sourceId);
  if (!source) throw new Error("Media source not found");
  const tx = db.transaction(() => {
    const existing = db.prepare(`
      SELECT * FROM media_scan_runs
      WHERE source_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at ASC LIMIT 1
    `).get(sourceId) as MediaScanRunRow | undefined;
    if (existing) return mapMediaScanRun(existing);
    const id = randomUUID();
    const timestamp = now.toISOString();
    db.prepare(`
      INSERT INTO media_scan_runs (id, source_id, status, generation, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?)
    `).run(id, sourceId, randomUUID(), timestamp, timestamp);
    return getRequiredMediaScan(db, id);
  });
  return tx.immediate();
}

export function claimNextMediaScan(
  db: CyberOsDatabase,
  input: { workerId: string; leaseMs: number; now?: Date }
): MediaScanRunRecord | null {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  db.prepare(`
    UPDATE media_scan_runs
    SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).run(nowIso, nowIso);
  const row = db.prepare(`
    UPDATE media_scan_runs
    SET status = 'running', worker_id = ?, lease_expires_at = ?,
        started_at = COALESCE(started_at, ?), finished_at = NULL, error = NULL, updated_at = ?
    WHERE id = (
      SELECT r.id FROM media_scan_runs r JOIN media_sources s ON s.id = r.source_id
      WHERE r.status = 'queued' AND s.enabled = 1 ORDER BY r.created_at ASC LIMIT 1
    ) AND status = 'queued'
    RETURNING *
  `).get(
    input.workerId,
    new Date(now.getTime() + input.leaseMs).toISOString(),
    nowIso,
    nowIso
  ) as MediaScanRunRow | undefined;
  return row ? mapMediaScanRun(row) : null;
}

export function updateMediaScanProgress(
  db: CyberOsDatabase,
  input: Pick<MediaScanRunRecord, "id" | "scanned" | "added" | "updated" | "unmatched" | "currentPath"> & {
    workerId: string;
    leaseMs: number;
    now?: Date;
  }
): boolean {
  const now = input.now ?? new Date();
  return db.prepare(`
    UPDATE media_scan_runs
    SET scanned = ?, added = ?, updated = ?, unmatched = ?, current_path = ?,
        lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND worker_id = ?
  `).run(
    input.scanned,
    input.added,
    input.updated,
    input.unmatched,
    input.currentPath,
    new Date(now.getTime() + input.leaseMs).toISOString(),
    now.toISOString(),
    input.id,
    input.workerId
  ).changes === 1;
}

export function finishMediaScan(
  db: CyberOsDatabase,
  input: { id: string; workerId: string; now?: Date }
): MediaScanRunRecord | null {
  const scan = getMediaScan(db, input.id);
  if (!scan || scan.status !== "running" || scan.workerId !== input.workerId) return null;
  const now = (input.now ?? new Date()).toISOString();
  const tx = db.transaction(() => {
    const removed = db.prepare("DELETE FROM media_files WHERE source_id = ? AND scan_generation <> ?")
      .run(scan.sourceId, scan.generation).changes;
    db.prepare("DELETE FROM media_episodes WHERE id NOT IN (SELECT episode_id FROM media_files WHERE episode_id IS NOT NULL)").run();
    db.prepare("DELETE FROM media_seasons WHERE id NOT IN (SELECT season_id FROM media_episodes)").run();
    db.prepare("DELETE FROM media_titles WHERE source_id = ? AND id NOT IN (SELECT title_id FROM media_files)").run(scan.sourceId);
    db.prepare(`
      UPDATE media_scan_runs
      SET status = 'completed', removed = ?, current_path = NULL, worker_id = NULL,
          lease_expires_at = NULL, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?
    `).run(removed, now, now, input.id, input.workerId);
    return getRequiredMediaScan(db, input.id);
  });
  return tx();
}

export function failMediaScan(
  db: CyberOsDatabase,
  input: { id: string; workerId: string; error: string; now?: Date }
): MediaScanRunRecord | null {
  const now = (input.now ?? new Date()).toISOString();
  const changed = db.prepare(`
    UPDATE media_scan_runs
    SET status = 'failed', error = ?, worker_id = NULL, lease_expires_at = NULL,
        finished_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND worker_id = ?
  `).run(input.error.trim() || "Media scan failed", now, now, input.id, input.workerId).changes;
  return changed === 1 ? getRequiredMediaScan(db, input.id) : null;
}

export function getMediaScan(db: CyberOsDatabase, id: string): MediaScanRunRecord | null {
  const row = db.prepare("SELECT * FROM media_scan_runs WHERE id = ?").get(id) as MediaScanRunRow | undefined;
  return row ? mapMediaScanRun(row) : null;
}

export function listMediaScans(db: CyberOsDatabase, sourceId?: string, limit = 20): MediaScanRunRecord[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = sourceId
    ? db.prepare("SELECT * FROM media_scan_runs WHERE source_id = ? ORDER BY created_at DESC LIMIT ?").all(sourceId, safeLimit)
    : db.prepare("SELECT * FROM media_scan_runs ORDER BY created_at DESC LIMIT ?").all(safeLimit);
  return (rows as MediaScanRunRow[]).map(mapMediaScanRun);
}

export function upsertMediaCatalogEntry(
  db: CyberOsDatabase,
  input: MediaCatalogEntryInput,
  now = new Date()
): { title: MediaTitleDetail; file: MediaFileRecord; created: boolean } {
  const source = getRequiredMediaSource(db, input.sourceId);
  if (source.kind !== input.title.kind) throw new Error("Media title kind must match its source");
  const sourcePath = normalizeRelativeMediaPath(input.title.sourcePath);
  const relativePath = normalizeRelativeMediaPath(input.file.relativePath);
  assertPathWithinSource(source.path, relativePath);
  if (source.kind === "series" && (!input.season || !input.episode)) {
    throw new Error("Series media requires season and episode metadata");
  }
  if (source.kind === "movie" && (input.season || input.episode)) {
    throw new Error("Movie media cannot include episode metadata");
  }
  const timestamp = now.toISOString();
  const tx = db.transaction(() => {
    const existingTitleId = db.prepare("SELECT id FROM media_titles WHERE source_id = ? AND source_path = ?")
      .pluck().get(source.id, sourcePath) as string | undefined;
    const titleId = existingTitleId ?? input.title.id ?? randomUUID();
    const genres = normalizeGenres(input.title.genres ?? []);
    db.prepare(`
      INSERT INTO media_titles (
        id, source_id, kind, source_path, tmdb_id, title, original_title, sort_title,
        overview, year, release_date, runtime_minutes, original_language, genres_json,
        metadata_source, match_status, match_confidence, poster_key, backdrop_key,
        scan_generation, added_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, source_path) DO UPDATE SET
        tmdb_id = excluded.tmdb_id, title = excluded.title, original_title = excluded.original_title,
        sort_title = excluded.sort_title, overview = excluded.overview, year = excluded.year,
        release_date = excluded.release_date, runtime_minutes = excluded.runtime_minutes,
        original_language = excluded.original_language, genres_json = excluded.genres_json,
        metadata_source = excluded.metadata_source, match_status = excluded.match_status,
        match_confidence = excluded.match_confidence, poster_key = excluded.poster_key,
        backdrop_key = excluded.backdrop_key, scan_generation = excluded.scan_generation,
        updated_at = excluded.updated_at
    `).run(
      titleId,
      source.id,
      input.title.kind,
      sourcePath,
      input.title.tmdbId ?? null,
      requiredText(input.title.title, "Media title is required"),
      textOrNull(input.title.originalTitle),
      normalizeSortTitle(input.title.title),
      textOrNull(input.title.overview),
      input.title.year ?? null,
      textOrNull(input.title.releaseDate),
      input.title.runtimeMinutes ?? null,
      textOrNull(input.title.originalLanguage),
      JSON.stringify(genres),
      input.title.metadataSource,
      input.title.matchStatus,
      input.title.matchConfidence ?? null,
      textOrNull(input.title.posterKey),
      textOrNull(input.title.backdropKey),
      input.generation,
      timestamp,
      timestamp
    );

    let seasonId: string | null = null;
    let episodeId: string | null = null;
    if (input.season && input.episode) {
      const existingSeasonId = db.prepare("SELECT id FROM media_seasons WHERE title_id = ? AND season_number = ?")
        .pluck().get(titleId, input.season.seasonNumber) as string | undefined;
      seasonId = existingSeasonId ?? input.season.id ?? randomUUID();
      db.prepare(`
        INSERT INTO media_seasons (id, title_id, season_number, name, overview, poster_key, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(title_id, season_number) DO UPDATE SET
          name = excluded.name, overview = excluded.overview,
          poster_key = excluded.poster_key, updated_at = excluded.updated_at
      `).run(
        seasonId,
        titleId,
        nonNegativeInteger(input.season.seasonNumber, "Season number"),
        textOrNull(input.season.name),
        textOrNull(input.season.overview),
        textOrNull(input.season.posterKey),
        timestamp
      );
      const existingEpisodeId = db.prepare("SELECT id FROM media_episodes WHERE season_id = ? AND episode_number = ?")
        .pluck().get(seasonId, input.episode.episodeNumber) as string | undefined;
      episodeId = existingEpisodeId ?? input.episode.id ?? randomUUID();
      db.prepare(`
        INSERT INTO media_episodes (
          id, title_id, season_id, episode_number, name, overview, air_date,
          runtime_minutes, still_key, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(season_id, episode_number) DO UPDATE SET
          name = excluded.name, overview = excluded.overview, air_date = excluded.air_date,
          runtime_minutes = excluded.runtime_minutes, still_key = excluded.still_key,
          updated_at = excluded.updated_at
      `).run(
        episodeId,
        titleId,
        seasonId,
        nonNegativeInteger(input.episode.episodeNumber, "Episode number"),
        textOrNull(input.episode.name),
        textOrNull(input.episode.overview),
        textOrNull(input.episode.airDate),
        input.episode.runtimeMinutes ?? null,
        textOrNull(input.episode.stillKey),
        timestamp
      );
    }

    const existingFileId = db.prepare("SELECT id FROM media_files WHERE source_id = ? AND relative_path = ?")
      .pluck().get(source.id, relativePath) as string | undefined;
    const fileId = existingFileId ?? input.file.id ?? randomUUID();
    db.prepare(`
      INSERT INTO media_files (
        id, source_id, title_id, episode_id, storage_pool_id, relative_path,
        name, mime_type, size_bytes, mtime_ms, duration_seconds, container,
        video_codec, audio_codec, scan_generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, relative_path) DO UPDATE SET
        title_id = excluded.title_id, episode_id = excluded.episode_id,
        name = excluded.name, mime_type = excluded.mime_type, size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms, duration_seconds = excluded.duration_seconds,
        container = excluded.container, video_codec = excluded.video_codec,
        audio_codec = excluded.audio_codec, scan_generation = excluded.scan_generation,
        updated_at = excluded.updated_at
    `).run(
      fileId,
      source.id,
      titleId,
      episodeId,
      source.storagePoolId,
      relativePath,
      requiredText(input.file.name, "Media file name is required"),
      requiredText(input.file.mimeType, "Media MIME type is required"),
      nonNegativeInteger(input.file.sizeBytes, "Media file size"),
      nonNegativeInteger(input.file.mtimeMs, "Media file modification time"),
      input.file.durationSeconds ?? null,
      textOrNull(input.file.container),
      textOrNull(input.file.videoCodec),
      textOrNull(input.file.audioCodec),
      input.generation,
      timestamp,
      timestamp
    );
    const detail = getMediaTitle(db, titleId);
    const file = getMediaFile(db, fileId);
    if (!detail || !file) throw new Error("Media catalog entry was not persisted");
    return { title: detail, file, created: !existingFileId };
  });
  return tx.immediate();
}

export function replaceMediaArtwork(
  db: CyberOsDatabase,
  input: {
    titleId: string;
    seasonId?: string | null;
    episodeId?: string | null;
    artwork: Array<Omit<MediaArtworkRecord, "id" | "titleId" | "seasonId" | "episodeId" | "updatedAt"> & { id?: string }>;
    now?: Date;
  }
): MediaArtworkRecord[] {
  const now = (input.now ?? new Date()).toISOString();
  const seasonId = input.seasonId ?? null;
  const episodeId = input.episodeId ?? null;
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM media_artwork
      WHERE title_id = ? AND season_id IS ? AND episode_id IS ?
    `).run(input.titleId, seasonId, episodeId);
    const insert = db.prepare(`
      INSERT INTO media_artwork (
        id, title_id, season_id, episode_id, kind, source, source_url, cache_key,
        width, height, language, is_primary, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const artwork of input.artwork) {
      insert.run(
        artwork.id ?? randomUUID(),
        input.titleId,
        seasonId,
        episodeId,
        artwork.kind,
        artwork.source,
        artwork.sourceUrl,
        requiredText(artwork.cacheKey, "Artwork cache key is required"),
        artwork.width,
        artwork.height,
        artwork.language,
        Number(artwork.primary),
        now
      );
    }
    return listMediaArtwork(db, input.titleId).filter((artwork) =>
      artwork.seasonId === seasonId && artwork.episodeId === episodeId
    );
  });
  return tx();
}

export function saveMediaProgress(
  db: CyberOsDatabase,
  input: {
    fileId: string;
    profileId?: string;
    positionSeconds: number;
    durationSeconds?: number | null;
    now?: Date;
  }
): MediaProgressRecord {
  if (!getMediaFile(db, input.fileId)) throw new Error("Media file not found");
  const profileId = requiredText(input.profileId ?? DEFAULT_PROFILE_ID, "Media profile is required");
  const positionSeconds = nonNegativeNumber(input.positionSeconds, "Media position");
  const durationSeconds = input.durationSeconds == null
    ? null
    : nonNegativeNumber(input.durationSeconds, "Media duration");
  const completed = durationSeconds !== null && durationSeconds > 0
    ? positionSeconds / durationSeconds >= COMPLETED_RATIO
    : false;
  const updatedAt = (input.now ?? new Date()).toISOString();
  db.prepare(`
    INSERT INTO media_progress (
      file_id, profile_id, position_seconds, duration_seconds, completed, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_id, profile_id) DO UPDATE SET
      position_seconds = excluded.position_seconds,
      duration_seconds = excluded.duration_seconds,
      completed = excluded.completed,
      updated_at = excluded.updated_at
  `).run(input.fileId, profileId, positionSeconds, durationSeconds, Number(completed), updatedAt);
  return {
    fileId: input.fileId,
    profileId,
    positionSeconds,
    durationSeconds,
    completed,
    updatedAt
  };
}

export function getMediaFile(db: CyberOsDatabase, id: string): MediaFileRecord | null {
  const row = db.prepare("SELECT * FROM media_files WHERE id = ?").get(id) as MediaFileRow | undefined;
  return row ? mapMediaFile(row) : null;
}

export function getMediaArtwork(db: CyberOsDatabase, id: string): MediaArtworkRecord | null {
  const row = db.prepare("SELECT * FROM media_artwork WHERE id = ?").get(id) as MediaArtworkRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    titleId: row.title_id,
    seasonId: row.season_id,
    episodeId: row.episode_id,
    kind: row.kind,
    source: row.source,
    sourceUrl: row.source_url,
    cacheKey: row.cache_key,
    width: row.width,
    height: row.height,
    language: row.language,
    primary: row.is_primary === 1,
    updatedAt: row.updated_at
  };
}

export function setMediaMatchOverride(
  db: CyberOsDatabase,
  input: { titleId: string; tmdbId?: number | null; excluded?: boolean; now?: Date }
): MediaTitleDetail | null {
  if (!getMediaTitle(db, input.titleId)) return null;
  const excluded = input.excluded === true;
  const tmdbId = excluded ? null : positiveIntegerOrNull(input.tmdbId, "TMDB id");
  if (!excluded && tmdbId === null) throw new Error("A TMDB id is required unless the title is excluded");
  const updatedAt = (input.now ?? new Date()).toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO media_match_overrides (title_id, tmdb_id, excluded, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(title_id) DO UPDATE SET
        tmdb_id = excluded.tmdb_id, excluded = excluded.excluded, updated_at = excluded.updated_at
    `).run(input.titleId, tmdbId, Number(excluded), updatedAt);
    db.prepare(`
      UPDATE media_titles SET tmdb_id = ?, match_status = ?, match_confidence = ?, updated_at = ?
      WHERE id = ?
    `).run(tmdbId, excluded ? "excluded" : "matched", excluded ? null : 1, updatedAt, input.titleId);
  });
  tx();
  return getMediaTitle(db, input.titleId);
}

export function getMediaTitleSummary(db: CyberOsDatabase, id: string, profileId = DEFAULT_PROFILE_ID): MediaTitleSummary | null {
  const row = db.prepare(`${titleSelect(profileId)} WHERE t.id = ?`).get(id) as MediaTitleRow | undefined;
  return row ? mapMediaTitle(row) : null;
}

export function getMediaTitle(db: CyberOsDatabase, id: string, profileId = DEFAULT_PROFILE_ID): MediaTitleDetail | null {
  const row = db.prepare(`${titleSelect(profileId)} WHERE t.id = ?`).get(id) as MediaTitleRow | undefined;
  if (!row) return null;
  const seasons = (db.prepare("SELECT * FROM media_seasons WHERE title_id = ? ORDER BY season_number")
    .all(id) as MediaSeasonRow[]).map((seasonRow) => {
      const season = mapMediaSeason(seasonRow);
      const episodes = (db.prepare("SELECT * FROM media_episodes WHERE season_id = ? ORDER BY episode_number")
        .all(season.id) as MediaEpisodeRow[]).map((episodeRow) => {
          const episode = mapMediaEpisode(episodeRow);
          const files = (db.prepare("SELECT * FROM media_files WHERE episode_id = ? ORDER BY relative_path")
            .all(episode.id) as MediaFileRow[]).map(mapMediaFile);
          return { ...episode, files };
        });
      return { ...season, episodes };
    });
  const files = (db.prepare("SELECT * FROM media_files WHERE title_id = ? AND episode_id IS NULL ORDER BY relative_path")
    .all(id) as MediaFileRow[]).map(mapMediaFile);
  return { ...mapMediaTitle(row), seasons, files, artwork: listMediaArtwork(db, id) };
}

export function listMediaTitles(
  db: CyberOsDatabase,
  input: {
    kind?: MediaTitleKind;
    matchStatus?: MediaMatchStatus;
    query?: string;
    limit?: number;
    profileId?: string;
  } = {}
): MediaTitleSummary[] {
  const profileId = input.profileId ?? DEFAULT_PROFILE_ID;
  const clauses = input.matchStatus ? ["t.match_status = ?"] : ["t.match_status <> 'excluded'"];
  const values: unknown[] = [];
  if (input.matchStatus) values.push(input.matchStatus);
  if (input.kind) {
    clauses.push("t.kind = ?");
    values.push(input.kind);
  }
  if (input.query?.trim()) {
    clauses.push("(t.title LIKE ? ESCAPE '\\' OR COALESCE(t.original_title, '') LIKE ? ESCAPE '\\')");
    const query = `%${escapeLike(input.query.trim())}%`;
    values.push(query, query);
  }
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 40)));
  values.push(limit);
  const rows = db.prepare(`${titleSelect(profileId)} WHERE ${clauses.join(" AND ")} ORDER BY t.sort_title, t.id LIMIT ?`)
    .all(...values) as MediaTitleRow[];
  return rows.map(mapMediaTitle);
}

export function getMediaHome(db: CyberOsDatabase, profileId = DEFAULT_PROFILE_ID, limit = 20): MediaHome {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const continueRows = db.prepare(`${titleSelect(profileId)}
    WHERE p.completed = 0 AND p.position_seconds >= ?
    ORDER BY p.updated_at DESC, t.id LIMIT ?
  `).all(CONTINUE_MINIMUM_SECONDS, safeLimit) as MediaTitleRow[];
  const recentRows = db.prepare(`${titleSelect(profileId)}
    WHERE t.match_status <> 'excluded'
    ORDER BY t.added_at DESC, t.id DESC LIMIT ?
  `).all(safeLimit) as MediaTitleRow[];
  return {
    continueWatching: continueRows.map(mapMediaTitle),
    recentlyAdded: recentRows.map(mapMediaTitle),
    movies: listMediaTitles(db, { kind: "movie", limit: safeLimit, profileId }),
    series: listMediaTitles(db, { kind: "series", limit: safeLimit, profileId })
  };
}

export function getMediaLibraryStatus(db: CyberOsDatabase): MediaLibraryStatus {
  const counts = db.prepare(`
    SELECT COUNT(*) AS titles,
      SUM(CASE WHEN kind = 'movie' THEN 1 ELSE 0 END) AS movies,
      SUM(CASE WHEN kind = 'series' THEN 1 ELSE 0 END) AS series,
      SUM(CASE WHEN match_status IN ('pending', 'unmatched') THEN 1 ELSE 0 END) AS unmatched
    FROM media_titles
  `).get() as { titles: number; movies: number | null; series: number | null; unmatched: number | null };
  const sources = Number(db.prepare("SELECT COUNT(*) FROM media_sources WHERE enabled = 1").pluck().get());
  const scans = listMediaScans(db, undefined, 20);
  const activeScan = scans.find((scan) => scan.status === "queued" || scan.status === "running") ?? null;
  const latestScan = scans.find((scan) => scan.status !== "queued" && scan.status !== "running") ?? null;
  const state: MediaLibraryStatus["state"] = sources === 0
    ? "unconfigured"
    : activeScan
      ? "scanning"
      : latestScan?.status === "failed"
        ? "degraded"
        : counts.titles > 0
          ? "ready"
          : "idle";
  return {
    state,
    sources,
    titles: counts.titles,
    movies: counts.movies ?? 0,
    series: counts.series ?? 0,
    unmatched: counts.unmatched ?? 0,
    activeScan,
    latestScan
  };
}

function titleSelect(profileId: string): string {
  const quotedProfileId = profileId.replaceAll("'", "''");
  return `
    SELECT t.*,
      p.file_id AS progress_file_id,
      p.profile_id AS progress_profile_id,
      p.position_seconds AS progress_position_seconds,
      p.duration_seconds AS progress_duration_seconds,
      p.completed AS progress_completed,
      p.updated_at AS progress_updated_at
    FROM media_titles t
    LEFT JOIN media_progress p ON p.file_id = (
      SELECT p2.file_id FROM media_progress p2
      JOIN media_files f2 ON f2.id = p2.file_id
      WHERE f2.title_id = t.id AND p2.profile_id = '${quotedProfileId}'
      ORDER BY p2.updated_at DESC LIMIT 1
    )
  `;
}

function listMediaArtwork(db: CyberOsDatabase, titleId: string): MediaArtworkRecord[] {
  return (db.prepare(`
    SELECT * FROM media_artwork WHERE title_id = ?
    ORDER BY is_primary DESC, kind, id
  `).all(titleId) as MediaArtworkRow[]).map((row) => ({
    id: row.id,
    titleId: row.title_id,
    seasonId: row.season_id,
    episodeId: row.episode_id,
    kind: row.kind,
    source: row.source,
    sourceUrl: row.source_url,
    cacheKey: row.cache_key,
    width: row.width,
    height: row.height,
    language: row.language,
    primary: row.is_primary === 1,
    updatedAt: row.updated_at
  }));
}

function mapMediaSource(row: MediaSourceRow): MediaSourceRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    storagePoolId: row.storage_pool_id,
    path: row.path,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMediaTitle(row: MediaTitleRow): MediaTitleSummary {
  return {
    id: row.id,
    sourceId: row.source_id,
    kind: row.kind,
    sourcePath: row.source_path,
    tmdbId: row.tmdb_id,
    title: row.title,
    originalTitle: row.original_title,
    overview: row.overview,
    year: row.year,
    releaseDate: row.release_date,
    runtimeMinutes: row.runtime_minutes,
    originalLanguage: row.original_language,
    genres: parseGenres(row.genres_json),
    metadataSource: row.metadata_source,
    matchStatus: row.match_status,
    matchConfidence: row.match_confidence,
    posterKey: row.poster_key,
    backdropKey: row.backdrop_key,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    progress: row.progress_file_id && row.progress_profile_id && row.progress_updated_at
      ? {
          fileId: row.progress_file_id,
          profileId: row.progress_profile_id,
          positionSeconds: row.progress_position_seconds ?? 0,
          durationSeconds: row.progress_duration_seconds,
          completed: row.progress_completed === 1,
          updatedAt: row.progress_updated_at
        }
      : null
  };
}

function mapMediaSeason(row: MediaSeasonRow): MediaSeasonRecord {
  return {
    id: row.id,
    titleId: row.title_id,
    seasonNumber: row.season_number,
    name: row.name,
    overview: row.overview,
    posterKey: row.poster_key,
    updatedAt: row.updated_at
  };
}

function mapMediaEpisode(row: MediaEpisodeRow): MediaEpisodeRecord {
  return {
    id: row.id,
    titleId: row.title_id,
    seasonId: row.season_id,
    episodeNumber: row.episode_number,
    name: row.name,
    overview: row.overview,
    airDate: row.air_date,
    runtimeMinutes: row.runtime_minutes,
    stillKey: row.still_key,
    updatedAt: row.updated_at
  };
}

function mapMediaFile(row: MediaFileRow): MediaFileRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    titleId: row.title_id,
    episodeId: row.episode_id,
    storagePoolId: row.storage_pool_id,
    relativePath: row.relative_path,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    durationSeconds: row.duration_seconds,
    container: row.container,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    updatedAt: row.updated_at
  };
}

function mapMediaScanRun(row: MediaScanRunRow): MediaScanRunRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    status: row.status,
    generation: row.generation,
    scanned: row.scanned,
    added: row.added,
    updated: row.updated,
    removed: row.removed,
    unmatched: row.unmatched,
    currentPath: row.current_path,
    error: row.error,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function getRequiredMediaSource(db: CyberOsDatabase, id: string): MediaSourceRecord {
  const source = getMediaSource(db, id);
  if (!source) throw new Error("Media source not found");
  return source;
}

function getRequiredMediaScan(db: CyberOsDatabase, id: string): MediaScanRunRecord {
  const scan = getMediaScan(db, id);
  if (!scan) throw new Error("Media scan not found");
  return scan;
}

function normalizeRelativeMediaPath(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.startsWith("/")) throw new Error("Media path must be relative");
  const normalized = path.posix.normalize(trimmed);
  if (normalized === ".." || normalized.startsWith("../")) throw new Error("Media path traversal is not allowed");
  const relative = normalized.replace(/^\.\//u, "").replace(/\/$/u, "");
  return relative || ".";
}

function assertPathWithinSource(sourcePath: string, filePath: string): void {
  if (sourcePath === ".") return;
  if (filePath !== sourcePath && !filePath.startsWith(`${sourcePath}/`)) {
    throw new Error("Media file must stay inside its configured source");
  }
}

function normalizeLanguage(value: unknown): string {
  const language = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(language)) throw new Error("Media language must use a language or language-region code");
  return language;
}

function normalizeRegion(value: unknown): string | null {
  const region = textOrNull(value)?.toUpperCase() ?? null;
  if (region !== null && !/^[A-Z]{2}$/u.test(region)) throw new Error("Media region must be a two-letter code");
  return region;
}

function normalizeGenres(genres: string[]): string[] {
  return [...new Set(genres.map((genre) => genre.trim()).filter(Boolean))].slice(0, 40);
}

function normalizeSortTitle(value: string): string {
  return requiredText(value, "Media title is required").normalize("NFKC").toLocaleLowerCase();
}

function parseGenres(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function requiredText(value: unknown, message: string): string {
  const normalized = textOrNull(value);
  if (!normalized) throw new Error(message);
  return normalized;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Boolean(value.trim()));
}

function assertMediaKind(value: unknown): asserts value is MediaSourceKind {
  if (value !== "movie" && value !== "series") throw new Error("Media source kind must be movie or series");
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function positiveIntegerOrNull(value: number | null | undefined, label: string): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
