import { createHash } from "node:crypto";
import {
  PHOTOSTAFF_METADATA_SCHEMA_VERSION,
  type PhotostaffAssetRecord,
  type PhotostaffMapCluster,
  type PhotostaffMapQueryRequest,
  type PhotostaffMetadataDetail,
  type PhotostaffMetadataField,
  type PhotostaffMetadataIndexStatus,
  type PhotostaffMetadataScalar,
  type PhotostaffMetadataSummary,
  type PhotostaffMetadataValueType,
  type PhotostaffQueryAsset,
  type PhotostaffQueryFacets,
  type PhotostaffQueryFilters,
  type PhotostaffQueryRequest
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";

export interface PhotostaffMetadataValueInput {
  source: string;
  key: string;
  valueType: PhotostaffMetadataValueType;
  value: PhotostaffMetadataScalar;
  sensitive: boolean;
  ordinal: number;
}

export interface PhotostaffMetadataWriteInput extends Omit<PhotostaffMetadataSummary, "hasLocation" | "hasSensitiveMetadata"> {
  bodySerial: string | null;
  lensSerial: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  gpsAltitudeM: number | null;
  gpsDirectionDeg: number | null;
  rawMetadata: Record<string, Record<string, PhotostaffMetadataScalar[]>>;
  warnings: string[];
  keywords: string[];
  values: PhotostaffMetadataValueInput[];
  sidecarPath: string | null;
  sidecarSizeBytes: number | null;
  sidecarMtimeMs: number | null;
}

export interface PhotostaffMetadataState {
  schemaVersion: number;
  sidecarPath: string | null;
  sidecarSizeBytes: number | null;
  sidecarMtimeMs: number | null;
}

export interface PhotostaffQueryCursor {
  fingerprint: string;
  sortValue: string | number | null;
  id: string;
}

interface QueryRow {
  id: string;
  root_id: string;
  storage_pool_id: string;
  path: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  mtime_ms: number;
  content_hash: string | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  taken_at: string;
  taken_at_source: PhotostaffAssetRecord["takenAtSource"];
  thumbnail_key: string | null;
  preview_key: string | null;
  status: PhotostaffAssetRecord["status"];
  error: string | null;
  error_code: PhotostaffAssetRecord["errorCode"];
  error_retryable: 0 | 1;
  derivative_schema_version: number;
  indexed_at: string;
  schema_version: number | null;
  metadata_status: PhotostaffMetadataSummary["status"] | null;
  media_kind: PhotostaffMetadataSummary["mediaKind"] | null;
  captured_at: string | null;
  captured_at_local: string | null;
  capture_offset_minutes: number | null;
  capture_source: PhotostaffMetadataSummary["captureSource"] | null;
  duration_ms: number | null;
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  camera_make: string | null;
  camera_model: string | null;
  software: string | null;
  lens_make: string | null;
  lens_model: string | null;
  iso: number | null;
  exposure_time_seconds: number | null;
  aperture: number | null;
  focal_length_mm: number | null;
  focal_length_35_mm: number | null;
  exposure_bias_ev: number | null;
  exposure_program: string | null;
  metering_mode: string | null;
  flash: string | null;
  white_balance: string | null;
  title: string | null;
  description: string | null;
  creator: string | null;
  copyright: string | null;
  rating: number | null;
  gps_latitude: number | null;
  gps_longitude: number | null;
  body_serial: string | null;
  lens_serial: string | null;
  has_sensitive_metadata: 0 | 1;
  distance_m: number | null;
  sort_value: string | number | null;
}

const QUERY_COLUMNS = `
  a.id, a.root_id, a.storage_pool_id, a.path, a.name, a.mime_type,
  a.size_bytes, a.mtime_ms, a.content_hash, a.width, a.height, a.orientation,
  a.taken_at, a.taken_at_source, a.thumbnail_key, a.preview_key, a.status,
  a.error, a.error_code, a.error_retryable, a.derivative_schema_version, a.indexed_at,
  m.schema_version, m.status AS metadata_status, m.media_kind, m.captured_at,
  m.captured_at_local, m.capture_offset_minutes, m.capture_source, m.duration_ms,
  m.container, m.video_codec, m.audio_codec, m.camera_make, m.camera_model,
  m.software, m.body_serial, m.lens_make, m.lens_model, m.lens_serial, m.iso,
  m.exposure_time_seconds, m.aperture, m.focal_length_mm, m.focal_length_35_mm,
  m.exposure_bias_ev, m.exposure_program, m.metering_mode, m.flash,
  m.white_balance, m.title, m.description, m.creator, m.copyright, m.rating,
  m.gps_latitude, m.gps_longitude,
  EXISTS (
    SELECT 1 FROM photostaff_metadata_values sensitive_value
    WHERE sensitive_value.asset_id = a.id AND sensitive_value.sensitive = 1
  ) AS has_sensitive_metadata
`;

const CAPTURE_SORT_EXPRESSION = "COALESCE(m.captured_at, m.captured_at_local, a.taken_at)";

export function replacePhotostaffAssetMetadata(
  db: CyberOsDatabase,
  asset: Pick<PhotostaffAssetRecord, "id" | "name" | "path">,
  input: PhotostaffMetadataWriteInput,
  now = new Date()
): void {
  const previousRowId = db.prepare("SELECT rowid FROM photostaff_asset_metadata WHERE asset_id = ?")
    .pluck().get(asset.id) as number | undefined;
  if (previousRowId !== undefined) {
    db.prepare("DELETE FROM photostaff_geo_index WHERE metadata_rowid = ?").run(previousRowId);
  }
  db.prepare("DELETE FROM photostaff_metadata_values WHERE asset_id = ?").run(asset.id);
  db.prepare("DELETE FROM photostaff_keywords WHERE asset_id = ?").run(asset.id);
  db.prepare("DELETE FROM photostaff_metadata_fts WHERE asset_id = ?").run(asset.id);

  db.prepare(`
    INSERT INTO photostaff_asset_metadata (
      asset_id, schema_version, status, media_kind, captured_at, captured_at_local,
      capture_offset_minutes, capture_source, duration_ms, container, video_codec,
      audio_codec, camera_make, camera_model, software, body_serial, lens_make,
      lens_model, lens_serial, iso, exposure_time_seconds, aperture, focal_length_mm,
      focal_length_35_mm, exposure_bias_ev, exposure_program, metering_mode, flash,
      white_balance, title, description, creator, copyright, rating, gps_latitude,
      gps_longitude, gps_altitude_m, gps_direction_deg, raw_metadata_json,
      warnings_json, sidecar_path, sidecar_size_bytes, sidecar_mtime_ms, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(asset_id) DO UPDATE SET
      schema_version = excluded.schema_version, status = excluded.status,
      media_kind = excluded.media_kind, captured_at = excluded.captured_at,
      captured_at_local = excluded.captured_at_local,
      capture_offset_minutes = excluded.capture_offset_minutes,
      capture_source = excluded.capture_source, duration_ms = excluded.duration_ms,
      container = excluded.container, video_codec = excluded.video_codec,
      audio_codec = excluded.audio_codec, camera_make = excluded.camera_make,
      camera_model = excluded.camera_model, software = excluded.software,
      body_serial = excluded.body_serial, lens_make = excluded.lens_make,
      lens_model = excluded.lens_model, lens_serial = excluded.lens_serial,
      iso = excluded.iso, exposure_time_seconds = excluded.exposure_time_seconds,
      aperture = excluded.aperture, focal_length_mm = excluded.focal_length_mm,
      focal_length_35_mm = excluded.focal_length_35_mm,
      exposure_bias_ev = excluded.exposure_bias_ev,
      exposure_program = excluded.exposure_program, metering_mode = excluded.metering_mode,
      flash = excluded.flash, white_balance = excluded.white_balance,
      title = excluded.title, description = excluded.description,
      creator = excluded.creator, copyright = excluded.copyright, rating = excluded.rating,
      gps_latitude = excluded.gps_latitude, gps_longitude = excluded.gps_longitude,
      gps_altitude_m = excluded.gps_altitude_m, gps_direction_deg = excluded.gps_direction_deg,
      raw_metadata_json = excluded.raw_metadata_json, warnings_json = excluded.warnings_json,
      sidecar_path = excluded.sidecar_path, sidecar_size_bytes = excluded.sidecar_size_bytes,
      sidecar_mtime_ms = excluded.sidecar_mtime_ms, updated_at = excluded.updated_at
  `).run(
    asset.id, input.schemaVersion, input.status, input.mediaKind, input.capturedAt,
    input.capturedAtLocal, input.captureOffsetMinutes, input.captureSource,
    input.durationMs, input.container, input.videoCodec, input.audioCodec,
    input.cameraMake, input.cameraModel, input.software, input.bodySerial,
    input.lensMake, input.lensModel, input.lensSerial, input.iso,
    input.exposureTimeSeconds, input.aperture, input.focalLengthMm,
    input.focalLength35Mm, input.exposureBiasEv, input.exposureProgram,
    input.meteringMode, input.flash, input.whiteBalance, input.title,
    input.description, input.creator, input.copyright, input.rating,
    input.gpsLatitude, input.gpsLongitude, input.gpsAltitudeM,
    input.gpsDirectionDeg, JSON.stringify(input.rawMetadata),
    JSON.stringify(input.warnings), input.sidecarPath, input.sidecarSizeBytes,
    input.sidecarMtimeMs, now.toISOString()
  );

  const insertKeyword = db.prepare(`
    INSERT OR IGNORE INTO photostaff_keywords (asset_id, keyword, normalized_keyword)
    VALUES (?, ?, ?)
  `);
  for (const keyword of input.keywords) {
    const normalized = normalizeText(keyword);
    if (normalized) insertKeyword.run(asset.id, keyword, normalized);
  }

  const insertValue = db.prepare(`
    INSERT INTO photostaff_metadata_values (
      asset_id, source, key, value_type, text_value, normalized_text_value,
      number_value, date_value, boolean_value, sensitive, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of input.values) {
    insertValue.run(
      asset.id,
      value.source,
      value.key,
      value.valueType,
      value.valueType === "text" ? String(value.value) : null,
      value.valueType === "text" ? normalizeText(String(value.value)) : null,
      value.valueType === "number" ? value.value : null,
      value.valueType === "date" ? String(value.value) : null,
      value.valueType === "boolean" ? (value.value ? 1 : 0) : null,
      value.sensitive ? 1 : 0,
      value.ordinal
    );
  }

  db.prepare(`
    INSERT INTO photostaff_metadata_fts (
      asset_id, name, path, title, description, creator, copyright, keywords, camera, lens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    asset.id,
    asset.name,
    asset.path,
    input.title ?? "",
    input.description ?? "",
    input.creator ?? "",
    input.copyright ?? "",
    input.keywords.join(" "),
    [input.cameraMake, input.cameraModel].filter(Boolean).join(" "),
    [input.lensMake, input.lensModel].filter(Boolean).join(" ")
  );

  if (input.gpsLatitude !== null && input.gpsLongitude !== null) {
    const metadataRowId = db.prepare("SELECT rowid FROM photostaff_asset_metadata WHERE asset_id = ?")
      .pluck().get(asset.id) as number;
    db.prepare(`
      INSERT INTO photostaff_geo_index (
        metadata_rowid, min_latitude, max_latitude, min_longitude, max_longitude
      ) VALUES (?, ?, ?, ?, ?)
    `).run(metadataRowId, input.gpsLatitude, input.gpsLatitude, input.gpsLongitude, input.gpsLongitude);
  }
}

export function getPhotostaffMetadataState(db: CyberOsDatabase, assetId: string): PhotostaffMetadataState | null {
  const row = db.prepare(`
    SELECT schema_version, sidecar_path, sidecar_size_bytes, sidecar_mtime_ms
    FROM photostaff_asset_metadata WHERE asset_id = ?
  `).get(assetId) as {
    schema_version: number;
    sidecar_path: string | null;
    sidecar_size_bytes: number | null;
    sidecar_mtime_ms: number | null;
  } | undefined;
  return row ? {
    schemaVersion: row.schema_version,
    sidecarPath: row.sidecar_path,
    sidecarSizeBytes: row.sidecar_size_bytes,
    sidecarMtimeMs: row.sidecar_mtime_ms
  } : null;
}

export function hasStalePhotostaffMetadata(db: CyberOsDatabase, libraryUpdatedAt: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1
    FROM photostaff_assets a
    LEFT JOIN photostaff_asset_metadata m ON m.asset_id = a.id
    WHERE a.library_updated_at = ? AND a.status = 'ready'
      AND (m.asset_id IS NULL OR m.schema_version <> ?)
    LIMIT 1
  `).pluck().get(libraryUpdatedAt, PHOTOSTAFF_METADATA_SCHEMA_VERSION));
}

export function getPhotostaffMetadataIndexStatus(
  db: CyberOsDatabase,
  libraryUpdatedAt: string
): PhotostaffMetadataIndexStatus {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN m.schema_version = ? THEN 1 ELSE 0 END) AS indexed,
      SUM(CASE WHEN m.schema_version = ? AND m.status = 'partial' THEN 1 ELSE 0 END) AS partial
    FROM photostaff_assets a
    LEFT JOIN photostaff_asset_metadata m ON m.asset_id = a.id
    WHERE a.library_updated_at = ? AND a.status = 'ready'
  `).get(PHOTOSTAFF_METADATA_SCHEMA_VERSION, PHOTOSTAFF_METADATA_SCHEMA_VERSION, libraryUpdatedAt) as {
    total: number;
    indexed: number | null;
    partial: number | null;
  };
  const indexed = row.indexed ?? 0;
  return {
    schemaVersion: PHOTOSTAFF_METADATA_SCHEMA_VERSION,
    total: row.total,
    indexed,
    partial: row.partial ?? 0,
    pending: Math.max(0, row.total - indexed)
  };
}

export function photostaffQueryFingerprint(request: Omit<PhotostaffQueryRequest, "cursor">): string {
  const fingerprintedRequest = {
    filters: request.filters ?? {},
    sort: request.sort ?? { field: "captured_at", direction: "desc" }
  };
  return createHash("sha256").update(stableStringify(fingerprintedRequest)).digest("base64url").slice(0, 24);
}

export function queryPhotostaffAssets(
  db: CyberOsDatabase,
  input: {
    libraryUpdatedAt: string;
    request: PhotostaffQueryRequest;
    cursor?: PhotostaffQueryCursor | null;
  }
): { photostaff: PhotostaffQueryAsset[]; hasMore: boolean; total: number; facets: PhotostaffQueryFacets | null } {
  const request = input.request;
  const limit = Math.max(1, Math.min(request.limit ?? 60, 100));
  const query = buildQuery(input.libraryUpdatedAt, request.filters ?? {}, request.sort);
  const cursorSql = buildCursorSql(input.cursor ?? null, request.sort?.direction ?? "desc");
  const orderDirection = request.sort?.direction === "asc" ? "ASC" : "DESC";
  const rows = db.prepare(`
    ${query.cte}
    SELECT * FROM matches
    WHERE ${query.postWhere} ${cursorSql.sql}
    ORDER BY (sort_value IS NULL) ASC, sort_value ${orderDirection}, id ${orderDirection}
    LIMIT ?
  `).all(...query.params, ...query.postParams, ...cursorSql.params, limit + 1) as QueryRow[];
  const total = db.prepare(`
    ${query.cte}
    SELECT COUNT(*) FROM matches WHERE ${query.postWhere}
  `).pluck().get(...query.params, ...query.postParams) as number;
  const pageRows = rows.slice(0, limit);
  const keywords = loadKeywords(db, pageRows.map((row) => row.id));
  return {
    photostaff: pageRows.map((row) => mapQueryAsset(row, keywords.get(row.id) ?? [])),
    hasMore: rows.length > limit,
    total,
    facets: request.includeFacets
      ? loadFacets(db, input.libraryUpdatedAt, request.filters ?? {})
      : null
  };
}

export function listPhotostaffMetadataFields(
  db: CyberOsDatabase,
  input: { libraryUpdatedAt: string; query?: string; limit?: number }
): PhotostaffMetadataField[] {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const query = normalizeText(input.query ?? "");
  const rows = db.prepare(`
    SELECT v.key, v.value_type, COUNT(DISTINCT v.asset_id) AS count
    FROM photostaff_metadata_values v
    JOIN photostaff_assets a ON a.id = v.asset_id
    JOIN photostaff_asset_metadata m ON m.asset_id = a.id AND m.schema_version = ?
    WHERE a.library_updated_at = ? AND a.status = 'ready' AND v.sensitive = 0
      AND (? = '' OR lower(v.key) LIKE '%' || ? || '%')
    GROUP BY v.key, v.value_type
    ORDER BY count DESC, v.key ASC
    LIMIT ?
  `).all(PHOTOSTAFF_METADATA_SCHEMA_VERSION, input.libraryUpdatedAt, query, query, limit) as Array<{
    key: string;
    value_type: PhotostaffMetadataValueType;
    count: number;
  }>;
  return rows.map((row) => ({
    key: row.key,
    valueType: row.value_type,
    count: row.count,
    sensitive: false
  }));
}

export function getPhotostaffMetadataDetail(
  db: CyberOsDatabase,
  input: { assetId: string; libraryUpdatedAt: string; includeSensitive?: boolean }
): PhotostaffMetadataDetail | null {
  const row = db.prepare(`
    SELECT ${QUERY_COLUMNS}, NULL AS distance_m, NULL AS sort_value,
           m.raw_metadata_json, m.warnings_json
    FROM photostaff_assets a
    LEFT JOIN photostaff_asset_metadata m ON m.asset_id = a.id
    WHERE a.id = ? AND a.library_updated_at = ?
  `).get(input.assetId, input.libraryUpdatedAt) as (QueryRow & {
    raw_metadata_json: string | null;
    warnings_json: string | null;
  }) | undefined;
  if (!row) return null;
  const raw = parseGroups(row.raw_metadata_json);
  const sensitiveKeys = db.prepare(`
    SELECT DISTINCT key FROM photostaff_metadata_values WHERE asset_id = ? AND sensitive = 1
  `).all(input.assetId) as Array<{ key: string }>;
  const sensitiveSet = new Set(sensitiveKeys.map((entry) => entry.key));
  const groups: Record<string, Record<string, PhotostaffMetadataScalar[]>> = {};
  const sensitiveGroups: Record<string, Record<string, PhotostaffMetadataScalar[]>> = {};
  for (const [source, entries] of Object.entries(raw)) {
    for (const [key, values] of Object.entries(entries)) {
      const fullKey = `${source}.${key}`;
      const target = sensitiveSet.has(fullKey) ? sensitiveGroups : groups;
      (target[source] ??= {})[key] = values;
    }
  }
  return {
    assetId: input.assetId,
    summary: mapMetadataSummary(row),
    keywords: loadKeywords(db, [input.assetId]).get(input.assetId) ?? [],
    groups,
    ...(input.includeSensitive ? { sensitiveGroups } : {}),
    sensitiveOmitted: !input.includeSensitive && Object.keys(sensitiveGroups).length > 0,
    warnings: parseStringArray(row.warnings_json)
  };
}

export function queryPhotostaffMap(
  db: CyberOsDatabase,
  input: { libraryUpdatedAt: string; request: PhotostaffMapQueryRequest }
): PhotostaffMapCluster[] {
  const columns = Math.max(1, Math.min(input.request.columns ?? 64, 64));
  const rows = Math.max(1, Math.min(input.request.rows ?? 64, 64));
  const filters: PhotostaffQueryFilters = { ...(input.request.filters ?? {}), location: input.request.bounds };
  const query = buildQuery(input.libraryUpdatedAt, filters, { field: "captured_at", direction: "desc" });
  const west = input.request.bounds.west;
  const east = input.request.bounds.east;
  const south = input.request.bounds.south;
  const north = input.request.bounds.north;
  const longitudeSpan = west <= east ? Math.max(0.000001, east - west) : Math.max(0.000001, 360 - west + east);
  const latitudeSpan = Math.max(0.000001, north - south);
  const values = db.prepare(`
    ${query.cte}, located AS (
      SELECT *,
        CASE WHEN ? = 1 AND gps_longitude < ? THEN gps_longitude + 360 ELSE gps_longitude END AS unwrapped_longitude,
        CAST(((CASE WHEN ? = 1 AND gps_longitude < ? THEN gps_longitude + 360 ELSE gps_longitude END) - ?) / ? * ? AS INTEGER) AS x_bucket,
        CAST((gps_latitude - ?) / ? * ? AS INTEGER) AS y_bucket
      FROM matches
      WHERE ${query.postWhere} AND gps_latitude IS NOT NULL AND gps_longitude IS NOT NULL
    )
    SELECT AVG(gps_latitude) AS latitude, AVG(unwrapped_longitude) AS longitude,
           COUNT(*) AS count, CASE WHEN COUNT(*) = 1 THEN MIN(id) ELSE NULL END AS asset_id
    FROM located
    GROUP BY x_bucket, y_bucket
    LIMIT 4096
  `).all(
    ...query.params,
    west > east ? 1 : 0,
    east,
    west > east ? 1 : 0,
    east,
    west,
    longitudeSpan,
    columns,
    south,
    latitudeSpan,
    rows,
    ...query.postParams
  ) as Array<{ latitude: number; longitude: number; count: number; asset_id: string | null }>;
  return values.map((row) => ({
    latitude: row.latitude,
    longitude: normalizeLongitude(row.longitude),
    count: row.count,
    assetId: row.asset_id
  }));
}

function buildQuery(
  libraryUpdatedAt: string,
  filters: PhotostaffQueryFilters,
  sort: PhotostaffQueryRequest["sort"]
): { cte: string; params: unknown[]; postWhere: string; postParams: unknown[] } {
  const where = ["a.library_updated_at = ?", "a.status = 'ready'"];
  const whereParams: unknown[] = [libraryUpdatedAt];
  const postWhere: string[] = ["1 = 1"];
  const postParams: unknown[] = [];
  let requiresMetadata = false;

  if (filters.text?.trim()) {
    where.push("a.id IN (SELECT asset_id FROM photostaff_metadata_fts WHERE photostaff_metadata_fts MATCH ?)");
    whereParams.push(toFtsQuery(filters.text));
    requiresMetadata = true;
  }
  addDateRange(where, whereParams, CAPTURE_SORT_EXPRESSION, filters.capturedAt);
  if (filters.capturedAt) requiresMetadata = true;
  if (filters.mediaKinds?.length) {
    where.push(`m.media_kind IN (${placeholders(filters.mediaKinds.length)})`);
    whereParams.push(...filters.mediaKinds);
    requiresMetadata = true;
  }
  addStringList(where, whereParams, "m.camera_model", filters.cameraModels);
  addStringList(where, whereParams, "m.lens_model", filters.lensModels);
  addNumberRange(where, whereParams, "m.iso", filters.iso);
  addNumberRange(where, whereParams, "m.aperture", filters.aperture);
  addNumberRange(where, whereParams, "m.exposure_time_seconds", filters.exposureTimeSeconds);
  addNumberRange(where, whereParams, "m.focal_length_mm", filters.focalLengthMm);
  addNumberRange(where, whereParams, "m.rating", filters.rating);
  if (filters.cameraModels?.length || filters.lensModels?.length || filters.iso || filters.aperture ||
      filters.exposureTimeSeconds || filters.focalLengthMm || filters.rating) requiresMetadata = true;
  if (filters.keywords?.length) {
    where.push(`EXISTS (
      SELECT 1 FROM photostaff_keywords k
      WHERE k.asset_id = a.id AND k.normalized_keyword IN (${placeholders(filters.keywords.length)})
    )`);
    whereParams.push(...filters.keywords.map(normalizeText));
    requiresMetadata = true;
  }
  if (filters.hasLocation !== undefined) {
    where.push(filters.hasLocation ? "m.gps_latitude IS NOT NULL AND m.gps_longitude IS NOT NULL" : "m.gps_latitude IS NULL");
    requiresMetadata = true;
  }

  let distanceExpression = "NULL";
  const selectParams: unknown[] = [];
  if (filters.location) {
    requiresMetadata = true;
    addBoundsFilter(where, whereParams, filters.location.kind === "bounds" ? filters.location : nearBounds(filters.location));
    if (filters.location.kind === "near") {
      distanceExpression = haversineExpression();
      selectParams.push(filters.location.latitude, filters.location.latitude, filters.location.longitude);
      postWhere.push("distance_m <= ?");
      postParams.push(filters.location.radiusMeters);
    }
  }

  const advanced = filters.advanced?.conditions.slice(0, 25) ?? [];
  if (advanced.length) {
    const clauses: string[] = [];
    for (const condition of advanced) clauses.push(buildMetadataCondition(condition, whereParams));
    where.push(`(${clauses.join(filters.advanced?.mode === "any" ? " OR " : " AND ")})`);
    requiresMetadata = true;
  }
  if (requiresMetadata) {
    where.push("m.schema_version = ?");
    whereParams.push(PHOTOSTAFF_METADATA_SCHEMA_VERSION);
  }

  const sortExpression = sort?.field === "indexed_at" ? "a.indexed_at"
    : sort?.field === "name" ? "lower(a.name)"
      : sort?.field === "size_bytes" ? "a.size_bytes"
        : sort?.field === "rating" ? "m.rating"
          : sort?.field === "distance" ? "NULL"
            : CAPTURE_SORT_EXPRESSION;
  if (sort?.field === "distance" && distanceExpression === "NULL") {
    throw new Error("Distance sorting requires a nearby location filter");
  }
  const cte = `
    WITH candidates AS (
      SELECT ${QUERY_COLUMNS}, ${distanceExpression} AS distance_m, ${sortExpression} AS base_sort_value
      FROM photostaff_assets a
      LEFT JOIN photostaff_asset_metadata m ON m.asset_id = a.id
      WHERE ${where.join(" AND ")}
    ), matches AS (
      SELECT candidates.*,
             ${sort?.field === "distance" ? "distance_m" : "base_sort_value"} AS sort_value
      FROM candidates
    )
  `;
  return { cte, params: [...selectParams, ...whereParams], postWhere: postWhere.join(" AND "), postParams };
}

function buildCursorSql(cursor: PhotostaffQueryCursor | null, direction: "asc" | "desc") {
  if (!cursor) return { sql: "", params: [] as unknown[] };
  if (cursor.sortValue === null) {
    return { sql: `AND sort_value IS NULL AND id ${direction === "asc" ? ">" : "<"} ?`, params: [cursor.id] };
  }
  const operator = direction === "asc" ? ">" : "<";
  return {
    sql: `AND (sort_value IS NULL OR sort_value ${operator} ? OR (sort_value = ? AND id ${operator} ?))`,
    params: [cursor.sortValue, cursor.sortValue, cursor.id]
  };
}

function buildMetadataCondition(condition: NonNullable<PhotostaffQueryFilters["advanced"]>["conditions"][number], params: unknown[]): string {
  const base = ["v.asset_id = a.id", "v.sensitive = 0", "v.key = ?"];
  params.push(condition.key);
  if (condition.operator === "exists") return `EXISTS (SELECT 1 FROM photostaff_metadata_values v WHERE ${base.join(" AND ")})`;
  if (condition.operator === "not_exists") return `NOT EXISTS (SELECT 1 FROM photostaff_metadata_values v WHERE ${base.join(" AND ")})`;
  const value = Array.isArray(condition.value) ? condition.value : [condition.value].filter((entry) => entry !== undefined);
  let comparison: string;
  if (condition.operator === "contains" || condition.operator === "prefix") {
    comparison = `v.normalized_text_value LIKE ? ESCAPE '\\'`;
    const pattern = escapeLikePattern(normalizeText(String(value[0] ?? "")));
    params.push(`${condition.operator === "contains" ? "%" : ""}${pattern}%`);
  } else if (condition.operator === "in") {
    const numbers = value.every((entry) => typeof entry === "number");
    const booleans = value.every((entry) => typeof entry === "boolean");
    const column = numbers ? "v.number_value" : booleans ? "v.boolean_value" : "COALESCE(v.date_value, v.normalized_text_value)";
    comparison = `${column} IN (${placeholders(value.length)})`;
    params.push(...(numbers ? value : booleans ? value.map((entry) => entry ? 1 : 0) : value.map((entry) => normalizeText(String(entry)))));
  } else if (condition.operator === "between") {
    comparison = "COALESCE(v.number_value, v.date_value) BETWEEN ? AND ?";
    params.push(value[0] ?? null, condition.valueTo ?? null);
  } else {
    const operator = ({ eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const)[condition.operator];
    const first = value[0];
    if (typeof first === "number") {
      comparison = `v.number_value ${operator} ?`;
      params.push(first);
    } else if (typeof first === "boolean") {
      comparison = `v.boolean_value ${operator} ?`;
      params.push(first ? 1 : 0);
    } else {
      comparison = `COALESCE(v.date_value, v.normalized_text_value) ${operator} ?`;
      params.push(normalizeText(String(first ?? "")));
    }
  }
  return `EXISTS (SELECT 1 FROM photostaff_metadata_values v WHERE ${[...base, comparison].join(" AND ")})`;
}

function addBoundsFilter(where: string[], params: unknown[], bounds: { west: number; south: number; east: number; north: number }) {
  const rtreeLongitudeClause = bounds.west <= bounds.east
    ? "g.max_longitude >= ? AND g.min_longitude <= ?"
    : "(g.max_longitude >= ? OR g.min_longitude <= ?)";
  const exactLongitudeClause = bounds.west <= bounds.east
    ? "m.gps_longitude BETWEEN ? AND ?"
    : "(m.gps_longitude >= ? OR m.gps_longitude <= ?)";
  where.push(`EXISTS (
    SELECT 1 FROM photostaff_geo_index g
    WHERE g.metadata_rowid = m.rowid
      AND g.max_latitude >= ? AND g.min_latitude <= ? AND ${rtreeLongitudeClause}
  ) AND m.gps_latitude BETWEEN ? AND ? AND ${exactLongitudeClause}`);
  params.push(
    bounds.south, bounds.north, bounds.west, bounds.east,
    bounds.south, bounds.north, bounds.west, bounds.east
  );
}

function nearBounds(input: { latitude: number; longitude: number; radiusMeters: number }) {
  const latitudeDelta = input.radiusMeters / 111_320;
  const longitudeDelta = input.radiusMeters / Math.max(1, 111_320 * Math.cos(input.latitude * Math.PI / 180));
  const coversAllLongitudes = longitudeDelta >= 180;
  const west = coversAllLongitudes ? -180 : normalizeLongitude(input.longitude - longitudeDelta);
  const east = coversAllLongitudes ? 180 : normalizeLongitude(input.longitude + longitudeDelta);
  return {
    west,
    east,
    south: Math.max(-90, input.latitude - latitudeDelta),
    north: Math.min(90, input.latitude + latitudeDelta)
  };
}

function haversineExpression(): string {
  return `6371008.8 * 2 * asin(min(1, sqrt(
    pow(sin(radians(m.gps_latitude - ?) / 2), 2) +
    cos(radians(?)) * cos(radians(m.gps_latitude)) *
    pow(sin(radians(m.gps_longitude - ?) / 2), 2)
  )))`;
}

function loadFacets(
  db: CyberOsDatabase,
  libraryUpdatedAt: string,
  filters: PhotostaffQueryFilters
): PhotostaffQueryFacets {
  const facetQuery = (excluded: keyof PhotostaffQueryFilters) => {
    const next = { ...filters };
    delete next[excluded];
    return buildQuery(libraryUpdatedAt, next, { field: "captured_at", direction: "desc" });
  };
  const categorical = (
    expression: string,
    excluded: keyof PhotostaffQueryFilters
  ): Array<{ value: string; count: number }> => {
    const query = facetQuery(excluded);
    return db.prepare(`
      ${query.cte}
      SELECT CAST(${expression} AS TEXT) AS value, COUNT(*) AS count
      FROM matches
      WHERE ${query.postWhere} AND schema_version = ? AND ${expression} IS NOT NULL AND ${expression} <> ''
      GROUP BY ${expression} ORDER BY count DESC, value ASC LIMIT 100
    `).all(...query.params, ...query.postParams, PHOTOSTAFF_METADATA_SCHEMA_VERSION) as Array<{ value: string; count: number }>;
  };
  const keywordQuery = facetQuery("keywords");
  const keywordRows = db.prepare(`
    ${keywordQuery.cte}
    SELECT k.keyword AS value, COUNT(DISTINCT k.asset_id) AS count
    FROM matches q JOIN photostaff_keywords k ON k.asset_id = q.id
    WHERE ${keywordQuery.postWhere} AND q.schema_version = ?
    GROUP BY k.normalized_keyword ORDER BY count DESC, value ASC LIMIT 100
  `).all(...keywordQuery.params, ...keywordQuery.postParams, PHOTOSTAFF_METADATA_SCHEMA_VERSION) as Array<{ value: string; count: number }>;
  const query = buildQuery(libraryUpdatedAt, filters, { field: "captured_at", direction: "desc" });
  const numericRow = db.prepare(`
    ${query.cte}
    SELECT
      MIN(iso) AS iso_min, MAX(iso) AS iso_max,
      MIN(aperture) AS aperture_min, MAX(aperture) AS aperture_max,
      MIN(exposure_time_seconds) AS exposure_min, MAX(exposure_time_seconds) AS exposure_max,
      MIN(focal_length_mm) AS focal_min, MAX(focal_length_mm) AS focal_max,
      MIN(rating) AS rating_min, MAX(rating) AS rating_max
    FROM matches WHERE ${query.postWhere} AND schema_version = ?
  `).get(...query.params, ...query.postParams, PHOTOSTAFF_METADATA_SCHEMA_VERSION) as {
    iso_min: number | null;
    iso_max: number | null;
    aperture_min: number | null;
    aperture_max: number | null;
    exposure_min: number | null;
    exposure_max: number | null;
    focal_min: number | null;
    focal_max: number | null;
    rating_min: number | null;
    rating_max: number | null;
  };
  const numeric: PhotostaffQueryFacets["numeric"] = {
    iso: { min: numericRow.iso_min, max: numericRow.iso_max },
    aperture: { min: numericRow.aperture_min, max: numericRow.aperture_max },
    exposureTimeSeconds: { min: numericRow.exposure_min, max: numericRow.exposure_max },
    focalLengthMm: { min: numericRow.focal_min, max: numericRow.focal_max },
    rating: { min: numericRow.rating_min, max: numericRow.rating_max }
  };
  return {
    mediaKinds: categorical("media_kind", "mediaKinds"),
    cameraModels: categorical("camera_model", "cameraModels"),
    lensModels: categorical("lens_model", "lensModels"),
    ratings: categorical("rating", "rating"),
    keywords: keywordRows,
    numeric
  };
}

function loadKeywords(db: CyberOsDatabase, assetIds: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!assetIds.length) return result;
  const rows = db.prepare(`
    SELECT asset_id, keyword FROM photostaff_keywords
    WHERE asset_id IN (${placeholders(assetIds.length)})
    ORDER BY normalized_keyword ASC
  `).all(...assetIds) as Array<{ asset_id: string; keyword: string }>;
  for (const row of rows) {
    const list = result.get(row.asset_id) ?? [];
    list.push(row.keyword);
    result.set(row.asset_id, list);
  }
  return result;
}

function mapQueryAsset(row: QueryRow, keywords: string[]): PhotostaffQueryAsset {
  return {
    id: row.id,
    rootId: row.root_id,
    storagePoolId: row.storage_pool_id,
    path: row.path,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    contentHash: row.content_hash,
    width: row.width,
    height: row.height,
    orientation: row.orientation,
    takenAt: row.taken_at,
    takenAtSource: row.taken_at_source,
    thumbnailKey: row.thumbnail_key,
    previewKey: row.preview_key,
    status: row.status,
    error: row.error,
    errorCode: row.error_code,
    errorRetryable: row.error_retryable === 1,
    derivativeSchemaVersion: row.derivative_schema_version,
    indexedAt: row.indexed_at,
    metadata: mapMetadataSummary(row),
    keywords,
    distanceMeters: row.distance_m
  };
}

function mapMetadataSummary(row: QueryRow): PhotostaffMetadataSummary | null {
  if (row.schema_version === null || row.metadata_status === null || row.media_kind === null || row.capture_source === null) return null;
  return {
    schemaVersion: row.schema_version,
    status: row.metadata_status,
    mediaKind: row.media_kind,
    capturedAt: row.captured_at,
    capturedAtLocal: row.captured_at_local,
    captureOffsetMinutes: row.capture_offset_minutes,
    captureSource: row.capture_source,
    durationMs: row.duration_ms,
    container: row.container,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    cameraMake: row.camera_make,
    cameraModel: row.camera_model,
    software: row.software,
    lensMake: row.lens_make,
    lensModel: row.lens_model,
    iso: row.iso,
    exposureTimeSeconds: row.exposure_time_seconds,
    aperture: row.aperture,
    focalLengthMm: row.focal_length_mm,
    focalLength35Mm: row.focal_length_35_mm,
    exposureBiasEv: row.exposure_bias_ev,
    exposureProgram: row.exposure_program,
    meteringMode: row.metering_mode,
    flash: row.flash,
    whiteBalance: row.white_balance,
    title: row.title,
    description: row.description,
    creator: row.creator,
    copyright: row.copyright,
    rating: row.rating,
    hasLocation: row.gps_latitude !== null && row.gps_longitude !== null,
    hasSensitiveMetadata: row.has_sensitive_metadata === 1
  };
}

function addStringList(clauses: string[], params: unknown[], column: string, values?: string[]) {
  if (!values?.length) return;
  clauses.push(`${column} IN (${placeholders(values.length)})`);
  params.push(...values);
}

function addNumberRange(clauses: string[], params: unknown[], column: string, range?: { min?: number; max?: number }) {
  if (range?.min !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(range.min);
  }
  if (range?.max !== undefined) {
    clauses.push(`${column} <= ?`);
    params.push(range.max);
  }
}

function addDateRange(clauses: string[], params: unknown[], column: string, range?: { from?: string; to?: string }) {
  if (range?.from) {
    clauses.push(`${column} >= ?`);
    params.push(range.from);
  }
  if (range?.to) {
    clauses.push(`${column} <= ?`);
    params.push(range.to);
  }
}

function toFtsQuery(value: string): string {
  return value.trim().split(/\s+/u).filter(Boolean).slice(0, 20)
    .map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function normalizeLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseGroups(value: string | null): Record<string, Record<string, PhotostaffMetadataScalar[]>> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, Record<string, PhotostaffMetadataScalar[]>>;
  } catch {
    return {};
  }
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
