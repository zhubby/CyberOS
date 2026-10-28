import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import type {
  MonitoringCollectorState,
  MonitoringCollectorStatus,
  MonitoringSeriesDescriptor
} from "@cyberos/shared";
import { assertSupportedMonitoringSchemaVersion } from "./schema.js";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function openMetricsReader(databasePath: string): Database.Database {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.pragma("query_only = ON");
    assertSupportedMonitoringSchemaVersion(db);
    db.prepare("SELECT version FROM monitoring_schema_migrations ORDER BY version DESC LIMIT 1").get();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function listMetricSeries(db: Database.Database): MonitoringSeriesDescriptor[] {
  return (db.prepare(`
    SELECT
      series.id,
      series.metric_name,
      series.labels_json,
      MAX(
        COALESCE((SELECT MAX(timestamp_ms) FROM metric_samples_raw WHERE series_id = series.id), 0),
        COALESCE((SELECT MAX(last_timestamp_ms) FROM metric_rollups_1m WHERE series_id = series.id), 0),
        COALESCE((SELECT MAX(last_timestamp_ms) FROM metric_rollups_1h WHERE series_id = series.id), 0)
      ) AS last_sample_ms
    FROM metric_series series
    ORDER BY series.metric_name, series.labels_key
  `).all() as Array<{
    id: number;
    metric_name: string;
    labels_json: string;
    last_sample_ms: number;
  }>).map((row) => ({
    id: row.id,
    metric: row.metric_name,
    labels: parseLabels(row.labels_json),
    active: false,
    lastSampleAt: row.last_sample_ms > 0 ? new Date(row.last_sample_ms).toISOString() : null
  }));
}

export function filterSeriesWithDataInRange(
  db: Database.Database,
  series: readonly MonitoringSeriesDescriptor[],
  startMs: number,
  endMs: number
): MonitoringSeriesDescriptor[] {
  if (series.length === 0) return [];
  const placeholders = series.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT id
    FROM metric_series
    WHERE id IN (${placeholders})
      AND (
        EXISTS (
          SELECT 1 FROM metric_samples_raw raw
          WHERE raw.series_id = metric_series.id
            AND raw.timestamp_ms >= @start_ms AND raw.timestamp_ms < @end_ms
        )
        OR EXISTS (
          SELECT 1 FROM metric_rollups_1m minute
          WHERE minute.series_id = metric_series.id
            AND minute.last_timestamp_ms >= @start_ms
            AND minute.first_timestamp_ms < @end_ms
        )
        OR EXISTS (
          SELECT 1 FROM metric_rollups_1h hour
          WHERE hour.series_id = metric_series.id
            AND hour.last_timestamp_ms >= @start_ms
            AND hour.first_timestamp_ms < @end_ms
        )
      )
  `).all(...series.map(({ id }) => id), { start_ms: startMs, end_ms: endMs }) as Array<{ id: number }>;
  const available = new Set(rows.map(({ id }) => id));
  return series.filter(({ id }) => available.has(id));
}

export function listCollectorStatuses(db: Database.Database): MonitoringCollectorStatus[] {
  return (db.prepare(`
    SELECT collector_id, state, last_attempt_ms, last_success_ms, duration_ms, consecutive_failures, error
    FROM collector_status ORDER BY collector_id
  `).all() as Array<{
    collector_id: string;
    state: MonitoringCollectorState;
    last_attempt_ms: number | null;
    last_success_ms: number | null;
    duration_ms: number | null;
    consecutive_failures: number;
    error: string | null;
  }>).map((row) => ({
    collector: row.collector_id,
    state: row.state,
    lastAttemptAt: toIso(row.last_attempt_ms),
    lastSuccessAt: toIso(row.last_success_ms),
    durationMs: row.duration_ms,
    consecutiveFailures: row.consecutive_failures,
    error: row.error
  }));
}

export function monitoringWritesPaused(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM monitoring_metadata WHERE key = 'writes_paused'")
    .get() as { value: string } | undefined;
  return row?.value === "1";
}

export function metricsDatabaseBytes(databasePath: string): number {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]
    .reduce((total, file) => total + (existsSync(file) ? statSync(file).size : 0), 0);
}

export function parseLabels(value: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
