import type Database from "better-sqlite3";
import type {
  MonitoringConfig,
  MonitoringLatestValue,
  MonitoringQueryRequest,
  MonitoringQueryResponse,
  MonitoringQuerySeries,
  MonitoringResolution,
  MonitoringSeriesDescriptor,
  MonitoringTransform
} from "@zos/shared";
import { getMetricDefinition } from "./catalog.js";
import { listMetricSeries, parseLabels } from "./database.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_SELECTORS = 12;
const MAX_POINTS = 720;
const MAX_RETURNED_SERIES = 64;
const MAX_TOTAL_POINTS = 24_000;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/u;

interface SourcePoint {
  bucketMs: number;
  firstTimestampMs: number;
  lastTimestampMs: number;
  firstValue: number;
  lastValue: number;
  minValue: number;
  increaseValue: number | null;
  sumValue: number;
  sampleCount: number;
}

interface QueryPlan {
  descriptor: MonitoringSeriesDescriptor;
  transform: MonitoringTransform;
  resolution: MonitoringResolution;
  stepMs: number;
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
  const preferredResolution = chooseResolution(targetStepMs, rangeMs, config);
  const descriptors = listMetricSeries(db);
  const requests: Array<Pick<QueryPlan, "descriptor" | "transform">> = [];
  let returnedSeries = 0;

  for (const selector of normalized.selectors) {
    const definition = getMetricDefinition(selector.metric)!;
    if (selector.transform === "rate" && definition.kind !== "counter") {
      throw new MonitoringValidationError(`Metric ${selector.metric} is not a counter`);
    }
    const matches = descriptors.filter((series) =>
      series.metric === selector.metric
      && Object.entries(selector.labels).every(([key, value]) => series.labels[key] === value)
    );
    returnedSeries += matches.length;
    if (returnedSeries > MAX_RETURNED_SERIES) {
      throw new MonitoringValidationError(`Query expands to more than ${MAX_RETURNED_SERIES} series`);
    }
    if (returnedSeries * normalized.maxPoints > MAX_TOTAL_POINTS) {
      throw new MonitoringValidationError(`Query exceeds the ${MAX_TOTAL_POINTS} point budget`);
    }
    for (const descriptor of matches) {
      requests.push({ descriptor, transform: selector.transform });
    }
  }

  const seriesIds = [...new Set(requests.map(({ descriptor }) => descriptor.id))];
  const resolutions = selectResolutions(
    db,
    seriesIds,
    normalized.startMs,
    normalized.endMs,
    preferredResolution
  );
  const plans = requests.map(({ descriptor, transform }): QueryPlan => {
    const resolution = resolutions.get(descriptor.id) ?? preferredResolution;
    const baseStepMs = resolution === "raw"
      ? config.fastSampleIntervalMs
      : resolution === "1m"
        ? MINUTE_MS
        : HOUR_MS;
    const stepMs = Math.max(baseStepMs, Math.ceil(targetStepMs / baseStepMs) * baseStepMs);
    return { descriptor, transform, resolution, stepMs };
  });
  const sourceByPlan = new Map<string, Map<number, SourcePoint[]>>();
  for (const plan of plans) {
    const kind = getMetricDefinition(plan.descriptor.metric)!.kind;
    const key = `${kind}:${plan.resolution}:${plan.stepMs}`;
    const existing = sourceByPlan.get(key);
    if (existing) continue;
    const ids = [...new Set(plans
      .filter((candidate) =>
        candidate.resolution === plan.resolution
        && candidate.stepMs === plan.stepMs
        && getMetricDefinition(candidate.descriptor.metric)!.kind === kind
      )
      .map((candidate) => candidate.descriptor.id))];
    sourceByPlan.set(
      key,
      kind === "gauge"
        ? readGaugeSourcePoints(
          db,
          ids,
          normalized.startMs,
          normalized.endMs,
          plan.resolution,
          plan.stepMs
        )
        : readCounterSourcePoints(
          db,
          ids,
          normalized.startMs,
          normalized.endMs,
          plan.resolution,
          plan.stepMs
        )
    );
  }

  const output = plans.map((plan): MonitoringQuerySeries => ({
    metric: plan.descriptor.metric,
    labels: plan.descriptor.labels,
    transform: plan.transform,
    resolution: plan.resolution,
    stepMs: plan.stepMs,
    points: bucketPoints(
      sourceByPlan.get(
        `${getMetricDefinition(plan.descriptor.metric)!.kind}:${plan.resolution}:${plan.stepMs}`
      )?.get(plan.descriptor.id) ?? [],
      normalized.startMs,
      normalized.endMs,
      plan.stepMs,
      getMetricDefinition(plan.descriptor.metric)!.kind,
      plan.transform
    )
  }));

  return {
    start: new Date(normalized.startMs).toISOString(),
    end: new Date(normalized.endMs).toISOString(),
    series: output
  };
}

function selectResolutions(
  db: Database.Database,
  seriesIds: readonly number[],
  startMs: number,
  endMs: number,
  preferredResolution: MonitoringResolution
): Map<number, MonitoringResolution> {
  const resolutions = preferredResolution === "raw"
    ? (["raw", "1m", "1h"] as const)
    : preferredResolution === "1m"
      ? (["1m", "1h"] as const)
      : (["1h"] as const);
  const selected = new Map(seriesIds.map((seriesId) => [seriesId, preferredResolution]));
  const selectedSamples = new Map(seriesIds.map((seriesId) => [seriesId, 0]));
  for (const resolution of resolutions) {
    const counts = countRepresentedSamples(db, seriesIds, startMs, endMs, resolution);
    for (const seriesId of seriesIds) {
      const representedSamples = counts.get(seriesId) ?? 0;
      if (representedSamples > (selectedSamples.get(seriesId) ?? 0)) {
        selected.set(seriesId, resolution);
        selectedSamples.set(seriesId, representedSamples);
      }
    }
  }
  return selected;
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
  if (typeof request.start !== "string" || typeof request.end !== "string") {
    throw new MonitoringValidationError("start and end must be ISO timestamp strings");
  }
  const startMs = parseIsoTimestamp(request.start);
  const endMs = parseIsoTimestamp(request.end);
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
  const selectors = request.selectors.map((selector, index) => {
    if (!isRecord(selector) || typeof selector.metric !== "string") {
      throw new MonitoringValidationError(`selector ${index} must be an object with a metric name`);
    }
    const definition = getMetricDefinition(selector.metric);
    if (!definition) throw new MonitoringValidationError(`Unknown metric: ${selector.metric}`);
    if (selector.labels !== undefined && !isRecord(selector.labels)) {
      throw new MonitoringValidationError(`labels for ${selector.metric} must be an object`);
    }
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

function readGaugeSourcePoints(
  db: Database.Database,
  seriesIds: readonly number[],
  startMs: number,
  endMs: number,
  resolution: MonitoringResolution,
  stepMs: number
): Map<number, SourcePoint[]> {
  if (seriesIds.length === 0) return new Map();
  const seriesValues = seriesIds.map(() => "(?)").join(", ");
  const outputBuckets = `
    WITH RECURSIVE output_buckets(output_bucket, bucket_start_ms, bucket_end_ms) AS (
      SELECT 0, @start_ms, MIN(@start_ms + @step_ms, @end_ms)
      UNION ALL
      SELECT output_bucket + 1, bucket_end_ms, MIN(bucket_end_ms + @step_ms, @end_ms)
      FROM output_buckets
      WHERE bucket_end_ms < @end_ms
    ), series_ids(series_id) AS (VALUES ${seriesValues})
  `;
  let rows: GaugeBucketRow[];
  if (resolution === "raw") {
    rows = db.prepare(`${outputBuckets}
      SELECT
        series.series_id,
        bucket.output_bucket,
        (
          SELECT AVG(sample.value)
          FROM metric_samples_raw sample
          WHERE sample.series_id = series.series_id
            AND sample.timestamp_ms >= bucket.bucket_start_ms
            AND sample.timestamp_ms < bucket.bucket_end_ms
        ) AS average_value
      FROM series_ids series
      CROSS JOIN output_buckets bucket
      ORDER BY series.series_id, bucket.output_bucket
    `).all(...seriesIds, { start_ms: startMs, end_ms: endMs, step_ms: stepMs }) as GaugeBucketRow[];
  } else {
    const table = resolution === "1m" ? "metric_rollups_1m" : "metric_rollups_1h";
    const bucketSizeMs = resolution === "1m" ? MINUTE_MS : HOUR_MS;
    if (startMs % bucketSizeMs === 0 && endMs % bucketSizeMs === 0 && stepMs % bucketSizeMs === 0) {
      rows = db.prepare(`${outputBuckets}
        SELECT
          series.series_id,
          bucket.output_bucket,
          (
            SELECT SUM(rollup.sum_value) / NULLIF(SUM(rollup.sample_count), 0)
            FROM ${table} rollup
            WHERE rollup.series_id = series.series_id
              AND rollup.bucket_ms >= bucket.bucket_start_ms
              AND rollup.bucket_ms < bucket.bucket_end_ms
          ) AS average_value
        FROM series_ids series
        CROSS JOIN output_buckets bucket
        ORDER BY series.series_id, bucket.output_bucket
      `).all(...seriesIds, {
        start_ms: startMs,
        end_ms: endMs,
        step_ms: stepMs
      }) as GaugeBucketRow[];
    } else {
      rows = db.prepare(`${outputBuckets}
      SELECT
        series.series_id,
        bucket.output_bucket,
        (
          SELECT total_sum / NULLIF(total_count, 0)
          FROM (
            SELECT
              SUM(
                CASE
                  WHEN rollup.first_timestamp_ms >= @start_ms AND rollup.last_timestamp_ms < @end_ms
                    THEN CASE
                      WHEN rollup.last_timestamp_ms >= bucket.bucket_start_ms
                        AND rollup.last_timestamp_ms < bucket.bucket_end_ms
                      THEN rollup.sum_value ELSE 0
                    END
                  ELSE
                    CASE
                      WHEN rollup.first_timestamp_ms >= @start_ms
                        AND rollup.first_timestamp_ms < @end_ms
                        AND rollup.first_timestamp_ms >= bucket.bucket_start_ms
                        AND rollup.first_timestamp_ms < bucket.bucket_end_ms
                      THEN rollup.first_value ELSE 0
                    END
                    + CASE
                      WHEN rollup.last_timestamp_ms != rollup.first_timestamp_ms
                        AND rollup.last_timestamp_ms >= @start_ms
                        AND rollup.last_timestamp_ms < @end_ms
                        AND rollup.last_timestamp_ms >= bucket.bucket_start_ms
                        AND rollup.last_timestamp_ms < bucket.bucket_end_ms
                      THEN rollup.last_value ELSE 0
                    END
                END
              ) AS total_sum,
              SUM(
                CASE
                  WHEN rollup.first_timestamp_ms >= @start_ms AND rollup.last_timestamp_ms < @end_ms
                    THEN CASE
                      WHEN rollup.last_timestamp_ms >= bucket.bucket_start_ms
                        AND rollup.last_timestamp_ms < bucket.bucket_end_ms
                      THEN rollup.sample_count ELSE 0
                    END
                  ELSE
                    CASE
                      WHEN rollup.first_timestamp_ms >= @start_ms
                        AND rollup.first_timestamp_ms < @end_ms
                        AND rollup.first_timestamp_ms >= bucket.bucket_start_ms
                        AND rollup.first_timestamp_ms < bucket.bucket_end_ms
                      THEN 1 ELSE 0
                    END
                    + CASE
                      WHEN rollup.last_timestamp_ms != rollup.first_timestamp_ms
                        AND rollup.last_timestamp_ms >= @start_ms
                        AND rollup.last_timestamp_ms < @end_ms
                        AND rollup.last_timestamp_ms >= bucket.bucket_start_ms
                        AND rollup.last_timestamp_ms < bucket.bucket_end_ms
                      THEN 1 ELSE 0
                    END
                END
              ) AS total_count
            FROM ${table} rollup
            WHERE rollup.series_id = series.series_id
              AND rollup.bucket_ms >= bucket.bucket_start_ms - @bucket_size_ms
              AND rollup.bucket_ms < bucket.bucket_end_ms
              AND rollup.last_timestamp_ms >= @start_ms
              AND rollup.first_timestamp_ms < @end_ms
          ) totals
        ) AS average_value
      FROM series_ids series
      CROSS JOIN output_buckets bucket
      ORDER BY series.series_id, bucket.output_bucket
    `).all(...seriesIds, {
      start_ms: startMs,
      end_ms: endMs,
      step_ms: stepMs,
      bucket_size_ms: bucketSizeMs
    }) as GaugeBucketRow[];
    }
  }
  const result = new Map<number, SourcePoint[]>();
  for (const row of rows) {
    if (row.average_value === null) continue;
    const timestampMs = startMs + row.output_bucket * stepMs;
    const points = result.get(row.series_id) ?? [];
    points.push({
      bucketMs: row.output_bucket,
      firstTimestampMs: timestampMs,
      lastTimestampMs: timestampMs,
      firstValue: row.average_value,
      lastValue: row.average_value,
      minValue: row.average_value,
      increaseValue: null,
      sumValue: row.average_value,
      sampleCount: 1
    });
    result.set(row.series_id, points);
  }
  return result;
}

interface GaugeBucketRow {
  series_id: number;
  output_bucket: number;
  average_value: number | null;
}

function readCounterSourcePoints(
  db: Database.Database,
  seriesIds: readonly number[],
  startMs: number,
  endMs: number,
  resolution: MonitoringResolution,
  stepMs: number
): Map<number, SourcePoint[]> {
  const result = new Map<number, SourcePoint[]>();
  for (const seriesId of seriesIds) {
    const points = readSourcePoints(db, [seriesId], startMs, endMs, resolution, stepMs).get(seriesId);
    if (points) result.set(seriesId, points);
  }
  return result;
}

function readSourcePoints(
  db: Database.Database,
  seriesIds: readonly number[],
  startMs: number,
  endMs: number,
  resolution: MonitoringResolution,
  stepMs: number
): Map<number, SourcePoint[]> {
  if (seriesIds.length === 0) return new Map();
  const seriesPlaceholders = placeholders(seriesIds.length);
  if (resolution === "raw") {
    const rows = db.prepare(`
      WITH filtered AS (
        SELECT
          series_id,
          timestamp_ms,
          value,
          CAST((timestamp_ms - @start_ms) / @step_ms AS INTEGER) AS output_bucket
        FROM metric_samples_raw
        WHERE series_id IN (${seriesPlaceholders})
          AND timestamp_ms >= @start_ms AND timestamp_ms < @end_ms
      ), sequenced AS (
        SELECT
          *,
          LAG(value) OVER (PARTITION BY series_id, output_bucket ORDER BY timestamp_ms) AS previous_value
        FROM filtered
      ), grouped AS (
        SELECT
          series_id,
          output_bucket,
          MIN(timestamp_ms) AS first_timestamp_ms,
          MAX(timestamp_ms) AS last_timestamp_ms,
          MIN(value) AS min_value,
          SUM(
            CASE
              WHEN previous_value IS NULL THEN 0
              WHEN value >= previous_value THEN value - previous_value
              ELSE value
            END
          ) AS increase_value,
          SUM(value) AS sum_value,
          COUNT(*) AS sample_count
        FROM sequenced
        GROUP BY series_id, output_bucket
      )
      SELECT
        grouped.*,
        first_sample.value AS first_value,
        last_sample.value AS last_value
      FROM grouped
      JOIN metric_samples_raw first_sample
        ON first_sample.series_id = grouped.series_id
        AND first_sample.timestamp_ms = grouped.first_timestamp_ms
      JOIN metric_samples_raw last_sample
        ON last_sample.series_id = grouped.series_id
        AND last_sample.timestamp_ms = grouped.last_timestamp_ms
      ORDER BY grouped.series_id, grouped.output_bucket
    `).all(...seriesIds, { start_ms: startMs, end_ms: endMs, step_ms: stepMs }) as BucketedSourceRow[];
    return sourcePointsBySeries(rows);
  }
  const table = resolution === "1m" ? "metric_rollups_1m" : "metric_rollups_1h";
  const bucketSizeMs = resolution === "1m" ? MINUTE_MS : HOUR_MS;
  const rows = db.prepare(`
    WITH candidates AS (
      SELECT
        series_id,
        bucket_ms,
        first_timestamp_ms,
        last_timestamp_ms,
        first_value,
        last_value,
        min_value,
        increase_value,
        boundary_increase_value,
        sum_value,
        sample_count
      FROM ${table}
      WHERE series_id IN (${seriesPlaceholders})
        AND bucket_ms < @end_ms
        AND bucket_ms >= @earliest_bucket_ms
        AND last_timestamp_ms >= @start_ms
        AND first_timestamp_ms < @end_ms
    ), source_points AS (
      SELECT * FROM candidates
      WHERE first_timestamp_ms >= @start_ms AND last_timestamp_ms < @end_ms
      UNION ALL
      SELECT
        series_id,
        first_timestamp_ms AS bucket_ms,
        first_timestamp_ms,
        first_timestamp_ms AS last_timestamp_ms,
        first_value,
        first_value AS last_value,
        first_value AS min_value,
        0 AS increase_value,
        boundary_increase_value,
        first_value AS sum_value,
        1 AS sample_count
      FROM candidates
      WHERE NOT (first_timestamp_ms >= @start_ms AND last_timestamp_ms < @end_ms)
        AND first_timestamp_ms >= @start_ms AND first_timestamp_ms < @end_ms
      UNION ALL
      SELECT
        series_id,
        last_timestamp_ms AS bucket_ms,
        last_timestamp_ms AS first_timestamp_ms,
        last_timestamp_ms,
        last_value AS first_value,
        last_value,
        last_value AS min_value,
        0 AS increase_value,
        0 AS boundary_increase_value,
        last_value AS sum_value,
        1 AS sample_count
      FROM candidates
      WHERE NOT (first_timestamp_ms >= @start_ms AND last_timestamp_ms < @end_ms)
        AND last_timestamp_ms != first_timestamp_ms
        AND last_timestamp_ms >= @start_ms AND last_timestamp_ms < @end_ms
    ), grouped AS (
      SELECT
        series_id,
        CAST((last_timestamp_ms - @start_ms) / @step_ms AS INTEGER) AS output_bucket,
        MIN(first_timestamp_ms) AS first_timestamp_ms,
        MAX(last_timestamp_ms) AS last_timestamp_ms,
        MIN(min_value) AS min_value,
        CASE
          WHEN SUM(
            CASE
              WHEN increase_value IS NULL OR boundary_increase_value IS NULL THEN 1
              ELSE 0
            END
          ) > 0 THEN NULL
          ELSE SUM(increase_value + boundary_increase_value)
        END AS total_increase_value,
        SUM(sum_value) AS sum_value,
        SUM(sample_count) AS sample_count
      FROM source_points
      GROUP BY series_id, output_bucket
    )
    SELECT
      grouped.series_id,
      grouped.output_bucket,
      grouped.first_timestamp_ms,
      grouped.last_timestamp_ms,
      CASE
        WHEN grouped.first_timestamp_ms = first_rollup.first_timestamp_ms THEN first_rollup.first_value
        ELSE first_rollup.last_value
      END AS first_value,
      CASE
        WHEN grouped.last_timestamp_ms = last_rollup.last_timestamp_ms THEN last_rollup.last_value
        ELSE last_rollup.first_value
      END AS last_value,
      grouped.min_value,
      CASE
        WHEN grouped.total_increase_value IS NULL THEN NULL
        ELSE grouped.total_increase_value - CASE
          WHEN grouped.first_timestamp_ms = first_rollup.first_timestamp_ms
            THEN first_rollup.boundary_increase_value
          ELSE 0
        END
      END AS increase_value,
      grouped.sum_value,
      grouped.sample_count
    FROM grouped
    JOIN ${table} first_rollup
      ON first_rollup.series_id = grouped.series_id
      AND first_rollup.bucket_ms = CAST(grouped.first_timestamp_ms / @bucket_size_ms AS INTEGER) * @bucket_size_ms
    JOIN ${table} last_rollup
      ON last_rollup.series_id = grouped.series_id
      AND last_rollup.bucket_ms = CAST(grouped.last_timestamp_ms / @bucket_size_ms AS INTEGER) * @bucket_size_ms
    ORDER BY grouped.series_id, grouped.output_bucket
  `).all(...seriesIds, {
    start_ms: startMs,
    end_ms: endMs,
    earliest_bucket_ms: startMs - bucketSizeMs,
    bucket_size_ms: bucketSizeMs,
    step_ms: stepMs
  }) as BucketedSourceRow[];
  return sourcePointsBySeries(rows);
}

interface BucketedSourceRow {
  series_id: number;
  output_bucket: number;
  first_timestamp_ms: number;
  last_timestamp_ms: number;
  first_value: number;
  last_value: number;
  min_value: number;
  increase_value: number | null;
  sum_value: number;
  sample_count: number;
}

function sourcePointsBySeries(rows: readonly BucketedSourceRow[]): Map<number, SourcePoint[]> {
  const result = new Map<number, SourcePoint[]>();
  for (const row of rows) {
    const points = result.get(row.series_id) ?? [];
    points.push(sourcePointFromRow(row));
    result.set(row.series_id, points);
  }
  return result;
}

function sourcePointFromRow(row: BucketedSourceRow): SourcePoint {
  return {
    bucketMs: row.output_bucket,
    firstTimestampMs: row.first_timestamp_ms,
    lastTimestampMs: row.last_timestamp_ms,
    firstValue: row.first_value,
    lastValue: row.last_value,
    minValue: row.min_value,
    increaseValue: row.increase_value,
    sumValue: row.sum_value,
    sampleCount: row.sample_count
  };
}

function countRepresentedSamples(
  db: Database.Database,
  seriesIds: readonly number[],
  startMs: number,
  endMs: number,
  resolution: MonitoringResolution
): Map<number, number> {
  if (seriesIds.length === 0) return new Map();
  const seriesPlaceholders = placeholders(seriesIds.length);
  if (resolution === "raw") {
    const rows = db.prepare(`
      SELECT series_id, COUNT(*) AS represented_samples FROM metric_samples_raw
      WHERE series_id IN (${seriesPlaceholders}) AND timestamp_ms >= ? AND timestamp_ms < ?
      GROUP BY series_id
    `).all(...seriesIds, startMs, endMs) as RepresentedSamplesRow[];
    return new Map(rows.map((row) => [row.series_id, row.represented_samples]));
  }
  const table = resolution === "1m" ? "metric_rollups_1m" : "metric_rollups_1h";
  const bucketSizeMs = resolution === "1m" ? MINUTE_MS : HOUR_MS;
  const rows = db.prepare(`
    SELECT series_id, COALESCE(SUM(
      CASE
        WHEN first_timestamp_ms >= @start_ms AND last_timestamp_ms < @end_ms THEN sample_count
        ELSE
          CASE WHEN first_timestamp_ms >= @start_ms AND first_timestamp_ms < @end_ms THEN 1 ELSE 0 END
          + CASE
              WHEN last_timestamp_ms != first_timestamp_ms
                AND last_timestamp_ms >= @start_ms AND last_timestamp_ms < @end_ms
              THEN 1 ELSE 0
            END
      END
    ), 0) AS represented_samples
    FROM ${table}
    WHERE series_id IN (${seriesPlaceholders})
      AND bucket_ms < @end_ms
      AND bucket_ms >= @earliest_bucket_ms
      AND last_timestamp_ms >= @start_ms
      AND first_timestamp_ms < @end_ms
    GROUP BY series_id
  `).all(...seriesIds, {
    start_ms: startMs,
    end_ms: endMs,
    earliest_bucket_ms: startMs - bucketSizeMs
  }) as RepresentedSamplesRow[];
  return new Map(rows.map((row) => [row.series_id, row.represented_samples]));
}

interface RepresentedSamplesRow {
  series_id: number;
  represented_samples: number;
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
        const baselineTimestampMs = previous?.lastTimestampMs ?? first.firstTimestampMs;
        const baselineValue = previous?.lastValue ?? first.firstValue;
        const elapsedSeconds = (last.lastTimestampMs - baselineTimestampMs) / 1_000;
        if (elapsedSeconds > 0) {
          const exact = parts.every((part) => part.increaseValue !== null);
          if (exact) value = exactCounterIncrease(parts, baselineValue) / elapsedSeconds;
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

function exactCounterIncrease(parts: readonly SourcePoint[], baselineValue: number): number {
  let increase = 0;
  let previousValue = baselineValue;
  for (const part of parts) {
    increase += part.firstValue >= previousValue
      ? part.firstValue - previousValue
      : part.firstValue;
    increase += part.increaseValue ?? 0;
    previousValue = part.lastValue;
  }
  return increase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function parseIsoTimestamp(value: string): number {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[9]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (
    day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
  ) {
    return Number.NaN;
  }
  return Date.parse(value);
}
