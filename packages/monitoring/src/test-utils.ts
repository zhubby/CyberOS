import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { MonitoringCollectorState } from "@zos/shared";
import { assertSupportedMonitoringSchemaVersion } from "./schema.js";

const MIGRATIONS = [
  [1, "001_initial.sql"],
  [2, "002_counter_increase.sql"],
  [3, "003_counter_boundary.sql"]
] as const;

export interface MetricsFixtureSample {
  metric: string;
  labels?: Record<string, string>;
  value: number;
  timestampMs: number;
}

export interface MetricsFixtureRollup {
  metric: string;
  labels?: Record<string, string>;
  bucketMs: number;
  firstTimestampMs: number;
  lastTimestampMs: number;
  firstValue: number;
  lastValue: number;
  minValue: number;
  maxValue: number;
  sumValue: number;
  sampleCount: number;
  increaseValue: number | null;
  boundaryIncreaseValue: number | null;
}

export interface MetricsFixtureCollectorStatus {
  collector: string;
  state: MonitoringCollectorState;
  attemptedAtMs: number | null;
  lastSuccessAtMs?: number | null;
  durationMs: number | null;
  consecutiveFailures?: number;
  error?: string | null;
}

/** Test-only database fixture. Production metrics are written exclusively by zos-monitor. */
export class MetricsFixture {
  readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("foreign_keys = ON");
    runMonitoringMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  insertSamples(samples: readonly MetricsFixtureSample[]): void {
    const insert = this.db.prepare(`
      INSERT INTO metric_samples_raw(series_id, timestamp_ms, value)
      VALUES (?, ?, ?)
      ON CONFLICT(series_id, timestamp_ms) DO UPDATE SET value = excluded.value
    `);
    this.db.transaction(() => {
      for (const sample of samples) {
        insert.run(this.ensureSeries(sample.metric, sample.labels ?? {}, sample.timestampMs), sample.timestampMs, sample.value);
      }
    })();
  }

  insertRollups(
    table: "metric_rollups_1m" | "metric_rollups_1h",
    rollups: readonly MetricsFixtureRollup[]
  ): void {
    const insert = this.db.prepare(`
      INSERT INTO ${table}(
        series_id, bucket_ms, first_timestamp_ms, last_timestamp_ms,
        first_value, last_value, min_value, max_value, sum_value, sample_count,
        increase_value, boundary_increase_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const rollup of rollups) {
        const seriesId = this.ensureSeries(
          rollup.metric,
          rollup.labels ?? {},
          rollup.firstTimestampMs
        );
        insert.run(
          seriesId,
          rollup.bucketMs,
          rollup.firstTimestampMs,
          rollup.lastTimestampMs,
          rollup.firstValue,
          rollup.lastValue,
          rollup.minValue,
          rollup.maxValue,
          rollup.sumValue,
          rollup.sampleCount,
          rollup.increaseValue,
          rollup.boundaryIncreaseValue
        );
      }
    })();
  }

  recordCollectorStatus(status: MetricsFixtureCollectorStatus): void {
    const succeeded = status.state === "ready" || status.state === "unsupported";
    this.db.prepare(`
      INSERT INTO collector_status(
        collector_id, state, last_attempt_ms, last_success_ms, duration_ms,
        consecutive_failures, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collector_id) DO UPDATE SET
        state = excluded.state,
        last_attempt_ms = excluded.last_attempt_ms,
        last_success_ms = excluded.last_success_ms,
        duration_ms = excluded.duration_ms,
        consecutive_failures = excluded.consecutive_failures,
        error = excluded.error
    `).run(
      status.collector,
      status.state,
      status.attemptedAtMs,
      status.lastSuccessAtMs ?? (succeeded ? status.attemptedAtMs : null),
      status.durationMs,
      status.consecutiveFailures ?? (status.state === "error" ? 1 : 0),
      status.error ?? null
    );
  }

  private ensureSeries(metric: string, labels: Record<string, string>, createdAtMs: number): number {
    const labelsJson = JSON.stringify(Object.fromEntries(
      Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))
    ));
    this.db.prepare(`
      INSERT OR IGNORE INTO metric_series(metric_name, labels_key, labels_json, created_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(metric, labelsJson, labelsJson, createdAtMs);
    return this.db.prepare(
      "SELECT id FROM metric_series WHERE metric_name = ? AND labels_key = ?"
    ).pluck().get(metric, labelsJson) as number;
  }
}

export function runMonitoringMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitoring_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const currentVersion = assertSupportedMonitoringSchemaVersion(db);
  for (const [version, filename] of MIGRATIONS) {
    if (version <= currentVersion) continue;
    const sql = readFileSync(new URL(`../contracts/migrations/${filename}`, import.meta.url), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO monitoring_schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
    })();
  }
}
