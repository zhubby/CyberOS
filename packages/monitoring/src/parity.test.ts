import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { DEFAULT_MONITORING_CONFIG } from "@zos/shared";
import { describe, expect, it } from "vitest";
import fixture from "../contracts/golden/metrics-parity.json" with { type: "json" };
import { queryMetrics } from "./query.js";
import {
  MetricsFixture,
  type MetricsFixtureCollectorStatus,
  type MetricsFixtureRollup
} from "./test-utils.js";

describe("Rust metrics schema compatibility fixture", () => {
  it("reads the v3 raw, rollup, reset, query, and collector contracts", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "zos-monitor-parity-"));
    const databasePath = path.join(directory, "metrics.sqlite");
    const metrics = new MetricsFixture(databasePath);
    try {
      metrics.insertSamples(fixture.expected.raw);
      metrics.insertRollups("metric_rollups_1m", withGoldenLabels(fixture.expected.rollups1m));
      metrics.insertRollups("metric_rollups_1h", withGoldenLabels(fixture.expected.rollups1h));
      metrics.recordCollectorStatus({
        collector: fixture.expected.collectorStatus.collector,
        state: fixture.expected.collectorStatus.state as MetricsFixtureCollectorStatus["state"],
        attemptedAtMs: fixture.expected.collectorStatus.lastAttemptMs,
        lastSuccessAtMs: fixture.expected.collectorStatus.lastSuccessMs,
        durationMs: fixture.expected.collectorStatus.durationMs,
        consecutiveFailures: fixture.expected.collectorStatus.consecutiveFailures,
        error: fixture.expected.collectorStatus.error
      });

      expect(readRaw(metrics)).toEqual(fixture.expected.raw);
      expect(readRollups(metrics, "metric_rollups_1m")).toEqual(fixture.expected.rollups1m);
      expect(readRollups(metrics, "metric_rollups_1h")).toEqual(fixture.expected.rollups1h);
      expect(readCollectorStatus(metrics)).toEqual(fixture.expected.collectorStatus);

      const query = queryMetrics(metrics.db, {
        start: "1970-01-01T00:00:00.000Z",
        end: "1970-01-01T00:03:00.000Z",
        maxPoints: 3,
        selectors: [
          { metric: "zos_host_load1", transform: "value" },
          { metric: "zos_host_network_receive_bytes_total", labels: { interface: "eth0" }, transform: "rate" }
        ]
      }, DEFAULT_MONITORING_CONFIG);
      expect(query.series[0]?.points.map(({ value }) => value)).toEqual(fixture.expected.query.gaugeValues);
      expect(query.series[1]?.points.map(({ value }) => value)).toEqual(fixture.expected.query.counterRateValues);
    } finally {
      metrics.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function withGoldenLabels(
  rollups: readonly Omit<MetricsFixtureRollup, "labels">[]
): MetricsFixtureRollup[] {
  return rollups.map((rollup) => ({
    ...rollup,
    labels: fixture.expected.raw.find((sample) => sample.metric === rollup.metric)?.labels ?? {}
  }));
}

function readRaw(metrics: MetricsFixture) {
  return (metrics.db.prepare(`
    SELECT series.metric_name AS metric, series.labels_json AS labels, sample.timestamp_ms AS timestampMs,
      sample.value AS value
    FROM metric_samples_raw sample JOIN metric_series series ON series.id = sample.series_id
    ORDER BY series.metric_name, series.labels_key, sample.timestamp_ms
  `).all() as Array<{ metric: string; labels: string; timestampMs: number; value: number }>)
    .map((row) => ({ ...row, labels: JSON.parse(row.labels) as Record<string, string> }));
}

function readRollups(metrics: MetricsFixture, table: "metric_rollups_1m" | "metric_rollups_1h") {
  return (metrics.db.prepare(`
    SELECT series.metric_name AS metric, rollup.bucket_ms AS bucketMs,
      rollup.first_timestamp_ms AS firstTimestampMs, rollup.last_timestamp_ms AS lastTimestampMs,
      rollup.first_value AS firstValue, rollup.last_value AS lastValue, rollup.min_value AS minValue,
      rollup.max_value AS maxValue, rollup.sum_value AS sumValue, rollup.sample_count AS sampleCount,
      rollup.increase_value AS increaseValue, rollup.boundary_increase_value AS boundaryIncreaseValue
    FROM ${table} rollup JOIN metric_series series ON series.id = rollup.series_id
    ORDER BY series.metric_name, series.labels_key, rollup.bucket_ms
  `).all());
}

function readCollectorStatus(metrics: MetricsFixture) {
  return metrics.db.prepare(`
    SELECT collector_id AS collector, state, last_attempt_ms AS lastAttemptMs,
      last_success_ms AS lastSuccessMs, duration_ms AS durationMs,
      consecutive_failures AS consecutiveFailures, error
    FROM collector_status WHERE collector_id = 'fast-host'
  `).get();
}
