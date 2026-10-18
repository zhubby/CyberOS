import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import type {
  MonitoringCollectorState,
  MonitoringCollectorStatus,
  MonitoringConfig,
  MonitoringSeriesDescriptor
} from "@zos/shared";
import { getMetricDefinition } from "./catalog.js";
import { runMonitoringMigrations } from "./schema.js";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface MetricSample {
  metric: string;
  labels?: Record<string, string>;
  value: number;
  timestampMs: number;
}

export interface CollectorStatusUpdate {
  collector: string;
  state: MonitoringCollectorState;
  attemptedAtMs: number;
  durationMs: number;
  error?: string | null;
}

export interface RetentionResult {
  rawRemoved: number;
  minuteRemoved: number;
  hourRemoved: number;
  databaseBytes: number;
  writesPaused: boolean;
}

export class MetricsWriter {
  readonly db: Database.Database;
  private writesPaused = false;

  constructor(
    readonly databasePath: string,
    private readonly config: MonitoringConfig,
    options: { recoverCorruption?: boolean } = {}
  ) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = openWriter(databasePath, options.recoverCorruption ?? true);
    this.writesPaused = this.readMetadata("writes_paused") === "1";
  }

  close(): void {
    this.db.close();
  }

  isWritePaused(): boolean {
    return this.writesPaused;
  }

  writeSamples(samples: readonly MetricSample[]): number {
    if (this.writesPaused || samples.length === 0) return 0;
    const normalized = samples.map(validateSample);
    const touched = new Map<string, { seriesId: number; timestampMs: number }>();
    const insert = this.db.prepare(`
      INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?)
      ON CONFLICT(series_id, timestamp_ms) DO UPDATE SET value = excluded.value
    `);
    this.db.transaction(() => {
      for (const sample of normalized) {
        const seriesId = this.ensureSeries(sample.metric, sample.labels, sample.timestampMs);
        insert.run(seriesId, sample.timestampMs, sample.value);
        touched.set(`${seriesId}:${Math.floor(sample.timestampMs / MINUTE_MS)}`, {
          seriesId,
          timestampMs: sample.timestampMs
        });
      }
      for (const item of touched.values()) {
        this.rebuildRollup("metric_rollups_1m", item.seriesId, item.timestampMs, MINUTE_MS);
        this.rebuildRollup("metric_rollups_1h", item.seriesId, item.timestampMs, HOUR_MS);
      }
    })();
    return normalized.length;
  }

  recordCollectorStatus(update: CollectorStatusUpdate): void {
    if (!update.collector || update.collector.length > 64) {
      throw new Error("Collector id must contain between 1 and 64 characters");
    }
    const previous = this.db.prepare(`
      SELECT last_success_ms, consecutive_failures FROM collector_status WHERE collector_id = ?
    `).get(update.collector) as { last_success_ms: number | null; consecutive_failures: number } | undefined;
    const succeeded = update.state === "ready" || update.state === "unsupported";
    const lastSuccessMs = succeeded ? update.attemptedAtMs : previous?.last_success_ms ?? null;
    const failures = update.state === "error" ? (previous?.consecutive_failures ?? 0) + 1 : 0;
    this.db.prepare(`
      INSERT INTO collector_status(
        collector_id, state, last_attempt_ms, last_success_ms, duration_ms, consecutive_failures, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collector_id) DO UPDATE SET
        state = excluded.state,
        last_attempt_ms = excluded.last_attempt_ms,
        last_success_ms = excluded.last_success_ms,
        duration_ms = excluded.duration_ms,
        consecutive_failures = excluded.consecutive_failures,
        error = excluded.error
    `).run(
      update.collector,
      update.state,
      update.attemptedAtMs,
      lastSuccessMs,
      Math.max(0, update.durationMs),
      failures,
      sanitizeError(update.error)
    );
  }

  maintain(nowMs = Date.now()): RetentionResult {
    const removed = this.applyRetention(nowMs);
    this.db.pragma("wal_checkpoint(PASSIVE)");
    let databaseBytes = metricsDatabaseBytes(this.databasePath);
    const targetBytes = Math.floor(this.config.maxDatabaseBytes * 0.8);
    if (databaseBytes > this.config.maxDatabaseBytes) {
      for (const table of ["metric_samples_raw", "metric_rollups_1m", "metric_rollups_1h"] as const) {
        while (databaseBytes > targetBytes && this.deleteOldest(table, 5_000) > 0) {
          this.db.pragma("incremental_vacuum(256)");
          this.db.pragma("wal_checkpoint(TRUNCATE)");
          databaseBytes = metricsDatabaseBytes(this.databasePath);
        }
        if (databaseBytes <= targetBytes) break;
      }
    }
    this.writesPaused = databaseBytes > this.config.maxDatabaseBytes;
    this.writeMetadata("writes_paused", this.writesPaused ? "1" : "0");
    return { ...removed, databaseBytes, writesPaused: this.writesPaused };
  }

  private applyRetention(nowMs: number): Omit<RetentionResult, "databaseBytes" | "writesPaused"> {
    return this.db.transaction(() => ({
      rawRemoved: this.db.prepare("DELETE FROM metric_samples_raw WHERE timestamp_ms < ?")
        .run(nowMs - this.config.rawRetentionMs).changes,
      minuteRemoved: this.db.prepare("DELETE FROM metric_rollups_1m WHERE bucket_ms < ?")
        .run(nowMs - this.config.minuteRetentionMs).changes,
      hourRemoved: this.db.prepare("DELETE FROM metric_rollups_1h WHERE bucket_ms < ?")
        .run(nowMs - this.config.hourRetentionMs).changes
    }))();
  }

  private deleteOldest(
    table: "metric_samples_raw" | "metric_rollups_1m" | "metric_rollups_1h",
    limit: number
  ): number {
    const timeColumn = table === "metric_samples_raw" ? "timestamp_ms" : "bucket_ms";
    return this.db.prepare(`
      DELETE FROM ${table}
      WHERE (series_id, ${timeColumn}) IN (
        SELECT series_id, ${timeColumn} FROM ${table} ORDER BY ${timeColumn} ASC LIMIT ?
      )
    `).run(limit).changes;
  }

  private ensureSeries(metric: string, labels: Record<string, string>, createdAtMs: number): number {
    const labelsKey = stableLabels(labels);
    this.db.prepare(`
      INSERT INTO metric_series(metric_name, labels_key, labels_json, created_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(metric_name, labels_key) DO NOTHING
    `).run(metric, labelsKey, labelsKey, createdAtMs);
    const row = this.db.prepare(
      "SELECT id FROM metric_series WHERE metric_name = ? AND labels_key = ?"
    ).get(metric, labelsKey) as { id: number };
    return row.id;
  }

  private rebuildRollup(
    table: "metric_rollups_1m" | "metric_rollups_1h",
    seriesId: number,
    timestampMs: number,
    bucketSizeMs: number
  ): void {
    const bucketMs = Math.floor(timestampMs / bucketSizeMs) * bucketSizeMs;
    const rows = this.db.prepare(`
      SELECT timestamp_ms, value FROM metric_samples_raw
      WHERE series_id = ? AND timestamp_ms >= ? AND timestamp_ms < ?
      ORDER BY timestamp_ms ASC
    `).all(seriesId, bucketMs, bucketMs + bucketSizeMs) as Array<{ timestamp_ms: number; value: number }>;
    if (rows.length === 0) return;
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    let min = first.value;
    let max = first.value;
    let sum = 0;
    for (const row of rows) {
      min = Math.min(min, row.value);
      max = Math.max(max, row.value);
      sum += row.value;
    }
    this.db.prepare(`
      INSERT INTO ${table}(
        series_id, bucket_ms, first_timestamp_ms, last_timestamp_ms, first_value, last_value,
        min_value, max_value, sum_value, sample_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(series_id, bucket_ms) DO UPDATE SET
        first_timestamp_ms = excluded.first_timestamp_ms,
        last_timestamp_ms = excluded.last_timestamp_ms,
        first_value = excluded.first_value,
        last_value = excluded.last_value,
        min_value = excluded.min_value,
        max_value = excluded.max_value,
        sum_value = excluded.sum_value,
        sample_count = excluded.sample_count
    `).run(
      seriesId,
      bucketMs,
      first.timestamp_ms,
      last.timestamp_ms,
      first.value,
      last.value,
      min,
      max,
      sum,
      rows.length
    );
  }

  private readMetadata(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM monitoring_metadata WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private writeMetadata(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO monitoring_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
}

export function openMetricsReader(databasePath: string): Database.Database {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.pragma("query_only = ON");
  db.prepare("SELECT version FROM monitoring_schema_migrations ORDER BY version DESC LIMIT 1").get();
  return db;
}

export function listMetricSeries(db: Database.Database): MonitoringSeriesDescriptor[] {
  return (db.prepare(`
    SELECT id, metric_name, labels_json FROM metric_series ORDER BY metric_name, labels_key
  `).all() as Array<{ id: number; metric_name: string; labels_json: string }>).map((row) => ({
    id: row.id,
    metric: row.metric_name,
    labels: parseLabels(row.labels_json)
  }));
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
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .reduce((total, file) => total + (existsSync(file) ? statSync(file).size : 0), 0);
}

export function parseLabels(value: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function openWriter(databasePath: string, recoverCorruption: boolean): Database.Database {
  let initial: Database.Database | null = null;
  try {
    initial = new Database(databasePath);
    configureWriter(initial);
    runMonitoringMigrations(initial);
    return initial;
  } catch (error) {
    initial?.close();
    if (!recoverCorruption || !isCorruptionError(error)) throw error;
    quarantineDatabase(databasePath);
    const db = new Database(databasePath);
    configureWriter(db);
    runMonitoringMigrations(db);
    return db;
  }
}

function configureWriter(db: Database.Database): void {
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("auto_vacuum = INCREMENTAL");
}

function quarantineDatabase(databasePath: string): void {
  const suffix = `.corrupt-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(file)) renameSync(file, `${file}${suffix}`);
  }
}

function isCorruptionError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/iu.test(message);
}

function validateSample(sample: MetricSample): Required<MetricSample> {
  const definition = getMetricDefinition(sample.metric);
  if (!definition) throw new Error(`Unknown monitoring metric: ${sample.metric}`);
  if (!Number.isFinite(sample.value)) throw new Error(`Metric ${sample.metric} value must be finite`);
  if (!Number.isSafeInteger(sample.timestampMs) || sample.timestampMs < 0) {
    throw new Error(`Metric ${sample.metric} timestamp must be a non-negative integer`);
  }
  const labels = sample.labels ?? {};
  const keys = Object.keys(labels).sort();
  const expected = [...definition.labelKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`Metric ${sample.metric} requires labels: ${expected.join(", ") || "none"}`);
  }
  for (const value of Object.values(labels)) {
    if (!value || value.length > 128) throw new Error(`Metric ${sample.metric} has an invalid label value`);
  }
  return { ...sample, labels };
}

function stableLabels(labels: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))));
}

function sanitizeError(error: string | null | undefined): string | null {
  if (!error) return null;
  return error.replace(/\s+/gu, " ").slice(0, 240);
}

function toIso(timestampMs: number | null): string | null {
  return timestampMs === null ? null : new Date(timestampMs).toISOString();
}
