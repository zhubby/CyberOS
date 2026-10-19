import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type {
  MonitoringCollectorState,
  MonitoringCollectorStatus,
  MonitoringConfig,
  MonitoringSeriesDescriptor
} from "@zos/shared";
import { getMetricDefinition } from "./catalog.js";
import { assertSupportedMonitoringSchemaVersion, runMonitoringMigrations } from "./schema.js";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_CORRUPT_DATABASE_BACKUPS = 1;

export const MAX_MONITORING_SERIES_PER_METRIC = 64;
export const MAX_MONITORING_SERIES = 512;

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
  seriesRemoved: number;
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
    const touchedMinutes = new Map<string, { seriesId: number; timestampMs: number }>();
    const touchedHours = new Map<string, { seriesId: number; timestampMs: number }>();
    let written = 0;
    const insert = this.db.prepare(`
      INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?)
      ON CONFLICT(series_id, timestamp_ms) DO UPDATE SET value = excluded.value
    `);
    this.db.transaction(() => {
      for (const sample of normalized) {
        const seriesId = this.ensureSeries(sample.metric, sample.labels, sample.timestampMs);
        if (seriesId === null) continue;
        insert.run(seriesId, sample.timestampMs, sample.value);
        written += 1;
        touchedMinutes.set(`${seriesId}:${Math.floor(sample.timestampMs / MINUTE_MS)}`, {
          seriesId,
          timestampMs: sample.timestampMs
        });
        touchedHours.set(`${seriesId}:${Math.floor(sample.timestampMs / HOUR_MS)}`, {
          seriesId,
          timestampMs: sample.timestampMs
        });
      }
      for (const item of touchedMinutes.values()) {
        this.rebuildRollupAndNext("metric_rollups_1m", item.seriesId, item.timestampMs, MINUTE_MS);
      }
      for (const item of touchedHours.values()) {
        this.rebuildRollupAndNext("metric_rollups_1h", item.seriesId, item.timestampMs, HOUR_MS);
      }
    })();
    return written;
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
    let seriesRemoved = this.pruneOrphanedSeries();
    const checkpointReady = this.checkpointTruncate();
    let databaseBytes = metricsDatabaseBytes(this.databasePath);
    const targetBytes = Math.floor(this.config.maxDatabaseBytes * 0.8);
    const capacityExceeded = checkpointReady && databaseBytes > this.config.maxDatabaseBytes;
    let capacityMaintenanceBlocked = false;
    if (capacityExceeded) {
      const reclaimed = this.reclaimFreePages(targetBytes);
      databaseBytes = reclaimed.databaseBytes;
      capacityMaintenanceBlocked = reclaimed.blocked;
    }
    if (capacityExceeded && !capacityMaintenanceBlocked && databaseBytes > targetBytes) {
      let trimmingBlocked = false;
      for (const table of ["metric_samples_raw", "metric_rollups_1m", "metric_rollups_1h"] as const) {
        while (databaseBytes > targetBytes && this.deleteOldest(table, 5_000) > 0) {
          if (!this.checkpointTruncate()) {
            trimmingBlocked = true;
            break;
          }
          const reclaimed = this.reclaimFreePages(targetBytes);
          databaseBytes = reclaimed.databaseBytes;
          if (reclaimed.blocked) {
            trimmingBlocked = true;
            break;
          }
        }
        if (trimmingBlocked || databaseBytes <= targetBytes) break;
      }
      seriesRemoved += this.pruneOrphanedSeries();
      if (!trimmingBlocked && seriesRemoved > 0) {
        this.checkpointTruncate();
        databaseBytes = this.reclaimFreePages(targetBytes).databaseBytes;
      }
    }
    this.writesPaused = databaseBytes > this.config.maxDatabaseBytes;
    this.writeMetadata("writes_paused", this.writesPaused ? "1" : "0");
    this.checkpointTruncate();
    databaseBytes = metricsDatabaseBytes(this.databasePath);
    if (!this.writesPaused && databaseBytes > this.config.maxDatabaseBytes) {
      this.writesPaused = true;
      this.writeMetadata("writes_paused", "1");
      this.checkpointTruncate();
      databaseBytes = metricsDatabaseBytes(this.databasePath);
    }
    return { ...removed, seriesRemoved, databaseBytes, writesPaused: this.writesPaused };
  }

  private reclaimFreePages(targetBytes: number): { databaseBytes: number; blocked: boolean } {
    let databaseBytes = metricsDatabaseBytes(this.databasePath);
    if (this.db.pragma("auto_vacuum", { simple: true }) !== 2) {
      return { databaseBytes, blocked: true };
    }
    while (databaseBytes > targetBytes) {
      const freePages = this.db.pragma("freelist_count", { simple: true }) as number;
      if (freePages <= 0) break;
      const previousBytes = databaseBytes;
      this.db.pragma(`incremental_vacuum(${Math.min(freePages, 4_096)})`);
      if (!this.checkpointTruncate()) return { databaseBytes, blocked: true };
      databaseBytes = metricsDatabaseBytes(this.databasePath);
      if (databaseBytes >= previousBytes) break;
    }
    return { databaseBytes, blocked: false };
  }

  private checkpointTruncate(): boolean {
    const rows = this.db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
    return rows[0]?.busy === 0;
  }

  private applyRetention(
    nowMs: number
  ): Omit<RetentionResult, "seriesRemoved" | "databaseBytes" | "writesPaused"> {
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

  private pruneOrphanedSeries(): number {
    return this.db.prepare(`
      DELETE FROM metric_series
      WHERE NOT EXISTS (SELECT 1 FROM metric_samples_raw WHERE series_id = metric_series.id)
        AND NOT EXISTS (SELECT 1 FROM metric_rollups_1m WHERE series_id = metric_series.id)
        AND NOT EXISTS (SELECT 1 FROM metric_rollups_1h WHERE series_id = metric_series.id)
    `).run().changes;
  }

  private ensureSeries(metric: string, labels: Record<string, string>, createdAtMs: number): number | null {
    const labelsKey = stableLabels(labels);
    const existing = this.db.prepare(
      "SELECT id FROM metric_series WHERE metric_name = ? AND labels_key = ?"
    ).get(metric, labelsKey) as { id: number } | undefined;
    if (existing) return existing.id;

    const totalSeries = this.db.prepare("SELECT COUNT(*) FROM metric_series").pluck().get() as number;
    if (totalSeries >= MAX_MONITORING_SERIES) return null;
    const metricSeries = this.db.prepare("SELECT COUNT(*) FROM metric_series WHERE metric_name = ?")
      .pluck().get(metric) as number;
    if (metricSeries >= MAX_MONITORING_SERIES_PER_METRIC) return null;

    const result = this.db.prepare(`
      INSERT INTO metric_series(metric_name, labels_key, labels_json, created_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(metric, labelsKey, labelsKey, createdAtMs);
    return Number(result.lastInsertRowid);
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
    let increase = 0;
    let previousValue = first.value;
    for (const row of rows) {
      min = Math.min(min, row.value);
      max = Math.max(max, row.value);
      sum += row.value;
      if (row !== first) {
        increase += row.value >= previousValue ? row.value - previousValue : row.value;
        previousValue = row.value;
      }
    }
    const priorBucketValue = this.db.prepare(`
      SELECT value FROM metric_samples_raw
      WHERE series_id = ? AND timestamp_ms < ?
      ORDER BY timestamp_ms DESC LIMIT 1
    `).pluck().get(seriesId, first.timestamp_ms) as number | undefined;
    const boundaryIncrease = priorBucketValue === undefined
      ? 0
      : first.value >= priorBucketValue ? first.value - priorBucketValue : first.value;
    this.db.prepare(`
      INSERT INTO ${table}(
        series_id, bucket_ms, first_timestamp_ms, last_timestamp_ms, first_value, last_value,
        min_value, max_value, sum_value, sample_count, increase_value, boundary_increase_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(series_id, bucket_ms) DO UPDATE SET
        first_timestamp_ms = excluded.first_timestamp_ms,
        last_timestamp_ms = excluded.last_timestamp_ms,
        first_value = excluded.first_value,
        last_value = excluded.last_value,
        min_value = excluded.min_value,
        max_value = excluded.max_value,
        sum_value = excluded.sum_value,
        sample_count = excluded.sample_count,
        increase_value = excluded.increase_value,
        boundary_increase_value = excluded.boundary_increase_value
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
      rows.length,
      increase,
      boundaryIncrease
    );
  }

  private rebuildRollupAndNext(
    table: "metric_rollups_1m" | "metric_rollups_1h",
    seriesId: number,
    timestampMs: number,
    bucketSizeMs: number
  ): void {
    this.rebuildRollup(table, seriesId, timestampMs, bucketSizeMs);
    const nextBucketStart = (Math.floor(timestampMs / bucketSizeMs) + 1) * bucketSizeMs;
    const nextTimestampMs = this.db.prepare(`
      SELECT MIN(timestamp_ms) FROM metric_samples_raw
      WHERE series_id = ? AND timestamp_ms >= ?
    `).pluck().get(seriesId, nextBucketStart) as number | null;
    if (nextTimestampMs !== null) {
      this.rebuildRollup(table, seriesId, nextTimestampMs, bucketSizeMs);
    }
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
  db.pragma("foreign_keys = ON");
  assertSupportedMonitoringSchemaVersion(db);
  ensureIncrementalAutoVacuum(db);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
}

function quarantineDatabase(databasePath: string): void {
  const suffix = `.corrupt-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]) {
    if (existsSync(file)) renameSync(file, `${file}${suffix}`);
  }
  pruneCorruptDatabaseBackups(databasePath);
}

function ensureIncrementalAutoVacuum(db: Database.Database): void {
  if (db.pragma("auto_vacuum", { simple: true }) === 2) return;
  db.pragma("auto_vacuum = INCREMENTAL");
  if (db.pragma("auto_vacuum", { simple: true }) !== 2) {
    try {
      db.exec("VACUUM");
    } catch (error) {
      if (!isDatabaseFullError(error)) throw error;
      console.warn("Monitoring database auto-vacuum conversion deferred because storage is full");
      return;
    }
  }
  if (db.pragma("auto_vacuum", { simple: true }) !== 2) {
    throw new Error("Monitoring database could not enable incremental auto vacuum");
  }
}

function isDatabaseFullError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_FULL" || /database or disk is full|no space left on device/iu.test(message);
}

function pruneCorruptDatabaseBackups(databasePath: string): void {
  const directory = path.dirname(databasePath);
  const basename = path.basename(databasePath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^${basename}(?:-wal|-shm|-journal)?\\.corrupt-(.+)$`, "u");
  const groups = new Map<string, string[]>();
  for (const entry of readdirSync(directory)) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const files = groups.get(match[1]!) ?? [];
    files.push(entry);
    groups.set(match[1]!, files);
  }
  const obsolete = [...groups.keys()].sort().reverse().slice(MAX_CORRUPT_DATABASE_BACKUPS);
  for (const suffix of obsolete) {
    for (const entry of groups.get(suffix) ?? []) unlinkSync(path.join(directory, entry));
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
  const normalized = error.replace(/\s+/gu, " ");
  if (/^Monitoring (?:sample writes are paused|series limit rejected)/u.test(normalized)) {
    return normalized.slice(0, 240);
  }
  if (/permission denied|\bEACCES\b|\bEPERM\b/iu.test(normalized)) return "Collector permission denied";
  if (/timed? ?out|\bETIMEDOUT\b/iu.test(normalized)) return "Collector timed out";
  if (/unavailable|no such file|not found|\bENOENT\b|\bSQLITE_CANTOPEN\b|\bECONN/u.test(normalized)) {
    return "Collector dependency unavailable";
  }
  return "Collector failed";
}

function toIso(timestampMs: number | null): string | null {
  return timestampMs === null ? null : new Date(timestampMs).toISOString();
}
