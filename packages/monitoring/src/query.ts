import type Database from "better-sqlite3";
import type {
  MonitoringConfig,
  MonitoringLatestValue,
  MonitoringQueryRequest,
  MonitoringQueryResponse,
  MonitoringQuerySeries,
  MonitoringResolution,
  MonitoringTransform
} from "@zos/shared";
import { getMetricDefinition } from "./catalog.js";
import { listMetricSeries, parseLabels } from "./store.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_SELECTORS = 12;
const MAX_POINTS = 720;

interface SourcePoint {
  bucketMs: number;
  firstTimestampMs: number;
  lastTimestampMs: number;
  firstValue: number;
  lastValue: number;
  sumValue: number;
  sampleCount: number;
}

export class MonitoringValidationError extends Error {}

export function queryMetrics(
  db: Database.Database,
  request: MonitoringQueryRequest,
  config: MonitoringConfig
): MonitoringQueryResponse {
  const normalized = validateMonitoringQuery(request);
  const rangeMs = normalized.endMs - normalized.startMs;
  const targetStepMs = Math.ceil(rangeMs / normalized.maxPoints);
  const resolution = chooseResolution(targetStepMs, rangeMs, config);
  const baseStepMs = resolution === "raw" ? config.fastSampleIntervalMs : resolution === "1m" ? MINUTE_MS : HOUR_MS;
  const stepMs = Math.max(baseStepMs, Math.ceil(targetStepMs / baseStepMs) * baseStepMs);
  const descriptors = listMetricSeries(db);
  const output: MonitoringQuerySeries[] = [];

  for (const selector of normalized.selectors) {
    const definition = getMetricDefinition(selector.metric)!;
    if (selector.transform === "rate" && definition.kind !== "counter") {
      throw new MonitoringValidationError(`Metric ${selector.metric} is not a counter`);
    }
    const matches = descriptors.filter((series) =>
      series.metric === selector.metric
      && Object.entries(selector.labels).every(([key, value]) => series.labels[key] === value)
    );
    for (const descriptor of matches) {
      const source = readSourcePoints(
        db,
        descriptor.id,
        normalized.startMs,
        normalized.endMs,
        resolution
      );
      output.push({
        metric: descriptor.metric,
        labels: descriptor.labels,
        transform: selector.transform,
        resolution,
        stepMs,
        points: bucketPoints(
          source,
          normalized.startMs,
          normalized.endMs,
          stepMs,
          definition.kind,
          selector.transform
        )
      });
    }
  }

  return {
    start: new Date(normalized.startMs).toISOString(),
    end: new Date(normalized.endMs).toISOString(),
    series: output
  };
}

export function latestMetricValues(db: Database.Database): MonitoringLatestValue[] {
  const rows = db.prepare(`
    SELECT s.metric_name, s.labels_json, r.timestamp_ms, r.value
    FROM metric_series s
    JOIN metric_samples_raw r ON r.series_id = s.id
    JOIN (
      SELECT series_id, MAX(timestamp_ms) AS timestamp_ms
      FROM metric_samples_raw GROUP BY series_id
    ) latest ON latest.series_id = r.series_id AND latest.timestamp_ms = r.timestamp_ms
    ORDER BY s.metric_name, s.labels_key
  `).all() as Array<{
    metric_name: string;
    labels_json: string;
    timestamp_ms: number;
    value: number;
  }>;
  return rows.map((row) => ({
    metric: row.metric_name,
    labels: parseLabels(row.labels_json),
    value: row.value,
    sampledAt: new Date(row.timestamp_ms).toISOString()
  }));
}

export function validateMonitoringQuery(request: MonitoringQueryRequest): {
  startMs: number;
  endMs: number;
  maxPoints: number;
  selectors: Array<{ metric: string; labels: Record<string, string>; transform: MonitoringTransform }>;
} {
  if (!request || !Array.isArray(request.selectors) || request.selectors.length < 1 || request.selectors.length > MAX_SELECTORS) {
    throw new MonitoringValidationError(`selectors must contain between 1 and ${MAX_SELECTORS} items`);
  }
  const startMs = Date.parse(request.start);
  const endMs = Date.parse(request.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new MonitoringValidationError("start and end must be valid ISO timestamps with start before end");
  }
  if (endMs - startMs > 366 * 24 * HOUR_MS) {
    throw new MonitoringValidationError("query range cannot exceed 366 days");
  }
  const maxPoints = request.maxPoints ?? MAX_POINTS;
  if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > MAX_POINTS) {
    throw new MonitoringValidationError(`maxPoints must be between 2 and ${MAX_POINTS}`);
  }
  const selectors = request.selectors.map((selector) => {
    const definition = getMetricDefinition(selector.metric);
    if (!definition) throw new MonitoringValidationError(`Unknown metric: ${selector.metric}`);
    const labels = selector.labels ?? {};
    for (const [key, value] of Object.entries(labels)) {
      if (!definition.labelKeys.includes(key)) {
        throw new MonitoringValidationError(`Label ${key} is not allowed for ${selector.metric}`);
      }
      if (typeof value !== "string" || !value || value.length > 128) {
        throw new MonitoringValidationError(`Label ${key} has an invalid value`);
      }
    }
    const transform = selector.transform ?? "value";
    if (transform !== "value" && transform !== "rate") {
      throw new MonitoringValidationError(`Invalid transform for ${selector.metric}`);
    }
    return { metric: selector.metric, labels, transform };
  });
  return { startMs, endMs, maxPoints, selectors };
}

function chooseResolution(
  targetStepMs: number,
  rangeMs: number,
  config: MonitoringConfig
): MonitoringResolution {
  if (targetStepMs <= config.fastSampleIntervalMs && rangeMs <= config.rawRetentionMs) return "raw";
  if (targetStepMs < HOUR_MS && rangeMs <= config.minuteRetentionMs) return "1m";
  return "1h";
}

function readSourcePoints(
  db: Database.Database,
  seriesId: number,
  startMs: number,
  endMs: number,
  resolution: MonitoringResolution
): SourcePoint[] {
  if (resolution === "raw") {
    return (db.prepare(`
      SELECT timestamp_ms, value FROM metric_samples_raw
      WHERE series_id = ? AND timestamp_ms >= ? AND timestamp_ms < ? ORDER BY timestamp_ms
    `).all(seriesId, startMs, endMs) as Array<{ timestamp_ms: number; value: number }>).map((row) => ({
      bucketMs: row.timestamp_ms,
      firstTimestampMs: row.timestamp_ms,
      lastTimestampMs: row.timestamp_ms,
      firstValue: row.value,
      lastValue: row.value,
      sumValue: row.value,
      sampleCount: 1
    }));
  }
  const table = resolution === "1m" ? "metric_rollups_1m" : "metric_rollups_1h";
  return (db.prepare(`
    SELECT bucket_ms, first_timestamp_ms, last_timestamp_ms, first_value, last_value, sum_value, sample_count
    FROM ${table}
    WHERE series_id = ? AND bucket_ms < ? AND bucket_ms >= ? ORDER BY bucket_ms
  `).all(seriesId, endMs, startMs - (resolution === "1m" ? MINUTE_MS : HOUR_MS)) as Array<{
    bucket_ms: number;
    first_timestamp_ms: number;
    last_timestamp_ms: number;
    first_value: number;
    last_value: number;
    sum_value: number;
    sample_count: number;
  }>).filter((row) => row.last_timestamp_ms >= startMs && row.first_timestamp_ms < endMs).map((row) => ({
    bucketMs: row.bucket_ms,
    firstTimestampMs: row.first_timestamp_ms,
    lastTimestampMs: row.last_timestamp_ms,
    firstValue: row.first_value,
    lastValue: row.last_value,
    sumValue: row.sum_value,
    sampleCount: row.sample_count
  }));
}

function bucketPoints(
  source: readonly SourcePoint[],
  startMs: number,
  endMs: number,
  stepMs: number,
  kind: "gauge" | "counter",
  transform: MonitoringTransform
): MonitoringQuerySeries["points"] {
  const count = Math.min(MAX_POINTS, Math.ceil((endMs - startMs) / stepMs));
  const buckets = Array.from({ length: count }, () => [] as SourcePoint[]);
  for (const point of source) {
    const index = Math.floor((point.lastTimestampMs - startMs) / stepMs);
    if (index >= 0 && index < buckets.length) buckets[index]!.push(point);
  }
  let previous: SourcePoint | null = null;
  return buckets.map((parts, index) => {
    let value: number | null = null;
    if (parts.length > 0) {
      const first = parts[0]!;
      const last = parts[parts.length - 1]!;
      if (transform === "rate") {
        if (previous) {
          const elapsedSeconds = (last.lastTimestampMs - previous.lastTimestampMs) / 1_000;
          const delta = last.lastValue >= previous.lastValue
            ? last.lastValue - previous.lastValue
            : last.lastValue;
          value = elapsedSeconds > 0 ? delta / elapsedSeconds : null;
        }
        previous = last;
      } else if (kind === "counter") {
        value = last.lastValue;
      } else {
        const sum = parts.reduce((total, part) => total + part.sumValue, 0);
        const samples = parts.reduce((total, part) => total + part.sampleCount, 0);
        value = samples > 0 ? sum / samples : first.lastValue;
      }
    }
    return { timestamp: new Date(startMs + index * stepMs).toISOString(), value };
  });
}
