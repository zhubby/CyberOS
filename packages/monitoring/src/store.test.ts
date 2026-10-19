import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { MonitoringConfig } from "@zos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MonitoringReader } from "./reader.js";
import {
  MAX_MONITORING_SERIES,
  MAX_MONITORING_SERIES_PER_METRIC,
  MetricsWriter,
  metricsDatabaseBytes,
  monitoringWritesPaused,
  openMetricsReader
} from "./store.js";
import { queryMetrics } from "./query.js";
import { runMonitoringMigrations } from "./schema.js";

const config: MonitoringConfig = {
  enabled: true,
  fastSampleIntervalMs: 10_000,
  standardSampleIntervalMs: 30_000,
  temperatureSampleIntervalMs: 300_000,
  rawRetentionMs: 48 * 60 * 60_000,
  minuteRetentionMs: 30 * 24 * 60 * 60_000,
  hourRetentionMs: 365 * 24 * 60 * 60_000,
  maxDatabaseBytes: 512 * 1024 * 1024
};

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("MetricsWriter", () => {
  it("migrates v1 rollups without full-table backfills or retained-data loss", async () => {
    const databasePath = await tempDatabase();
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE monitoring_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO monitoring_schema_migrations(version, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z');

      CREATE TABLE metric_series (
        id INTEGER PRIMARY KEY,
        metric_name TEXT NOT NULL,
        labels_key TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(metric_name, labels_key)
      ) STRICT;
      CREATE TABLE metric_samples_raw (
        series_id INTEGER NOT NULL REFERENCES metric_series(id) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY(series_id, timestamp_ms)
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE metric_rollups_1m (
        series_id INTEGER NOT NULL REFERENCES metric_series(id) ON DELETE CASCADE,
        bucket_ms INTEGER NOT NULL,
        first_timestamp_ms INTEGER NOT NULL,
        last_timestamp_ms INTEGER NOT NULL,
        first_value REAL NOT NULL,
        last_value REAL NOT NULL,
        min_value REAL NOT NULL,
        max_value REAL NOT NULL,
        sum_value REAL NOT NULL,
        sample_count INTEGER NOT NULL,
        PRIMARY KEY(series_id, bucket_ms)
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE metric_rollups_1h (
        series_id INTEGER NOT NULL REFERENCES metric_series(id) ON DELETE CASCADE,
        bucket_ms INTEGER NOT NULL,
        first_timestamp_ms INTEGER NOT NULL,
        last_timestamp_ms INTEGER NOT NULL,
        first_value REAL NOT NULL,
        last_value REAL NOT NULL,
        min_value REAL NOT NULL,
        max_value REAL NOT NULL,
        sum_value REAL NOT NULL,
        sample_count INTEGER NOT NULL,
        PRIMARY KEY(series_id, bucket_ms)
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE collector_status (
        collector_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('ready', 'error', 'unsupported', 'disabled')),
        last_attempt_ms INTEGER,
        last_success_ms INTEGER,
        duration_ms REAL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        error TEXT
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE monitoring_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID, STRICT;

      CREATE INDEX metric_samples_raw_timestamp_idx ON metric_samples_raw(timestamp_ms);
      CREATE INDEX metric_rollups_1m_bucket_idx ON metric_rollups_1m(bucket_ms);
      CREATE INDEX metric_rollups_1h_bucket_idx ON metric_rollups_1h(bucket_ms);
    `);
    const seriesId = Number(legacy.prepare(`
      INSERT INTO metric_series(metric_name, labels_key, labels_json, created_at_ms)
      VALUES ('zos_host_network_receive_bytes_total', '{"interface":"eth0"}', '{"interface":"eth0"}', 0)
    `).run().lastInsertRowid);
    const rawInsert = legacy.prepare(
      "INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?)"
    );
    for (const [timestampMs, value] of [[5_000, 100], [15_000, 110], [25_000, 0], [35_000, 150]]) {
      rawInsert.run(seriesId, timestampMs, value);
    }
    for (const table of ["metric_rollups_1m", "metric_rollups_1h"]) {
      legacy.prepare(`
        INSERT INTO ${table}(
          series_id, bucket_ms, first_timestamp_ms, last_timestamp_ms, first_value, last_value,
          min_value, max_value, sum_value, sample_count
        ) VALUES (?, 0, 5000, 35000, 100, 150, 0, 150, 360, 4)
      `).run(seriesId);
    }

    legacy.close();
    const originalPrepare = Database.prototype.prepare;
    const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      source
    ) {
      if (/UPDATE\s+metric_rollups_/iu.test(source)) {
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      }
      return originalPrepare.call(this, source);
    });

    let writer: MetricsWriter | null = null;
    try {
      writer = new MetricsWriter(databasePath, config);

      expect(writer.db.prepare("SELECT MAX(version) FROM monitoring_schema_migrations").pluck().get()).toBe(3);
      expect(writer.db.prepare("SELECT COUNT(*) FROM metric_samples_raw").pluck().get()).toBe(4);
      for (const table of ["metric_rollups_1m", "metric_rollups_1h"]) {
        expect(writer.db.prepare(`
          SELECT first_value, last_value, sum_value, sample_count, increase_value, boundary_increase_value
          FROM ${table}
        `).get()).toEqual({
          first_value: 100,
          last_value: 150,
          sum_value: 360,
          sample_count: 4,
          increase_value: null,
          boundary_increase_value: null
        });
      }
      const historicalRate = queryMetrics(writer.db, {
        start: new Date(0).toISOString(),
        end: new Date(60_000).toISOString(),
        maxPoints: 2,
        selectors: [{ metric: "zos_host_network_receive_bytes_total", transform: "rate" }]
      }, config);
      expect(historicalRate.series[0]?.points).toEqual([
        { timestamp: new Date(0).toISOString(), value: null }
      ]);
    } finally {
      writer?.close();
      prepareSpy.mockRestore();
    }
  });

  it("creates a dedicated database and supports a concurrent read-only connection", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([sample("zos_host_load1", 1_000, 0.75)]);
    expect(writer.db.pragma("auto_vacuum", { simple: true })).toBe(2);

    const reader = openMetricsReader(databasePath);
    expect(reader.pragma("query_only", { simple: true })).toBe(1);
    expect(reader.prepare("SELECT COUNT(*) AS count FROM metric_samples_raw").get()).toEqual({ count: 1 });
    expect(() => reader.prepare("DELETE FROM metric_samples_raw").run()).toThrow();

    reader.close();
    writer.close();
  });

  it("upgrades legacy databases to incremental auto vacuum without losing samples", async () => {
    const databasePath = await tempDatabase();
    const legacy = new Database(databasePath);
    legacy.pragma("journal_mode = WAL");
    runMonitoringMigrations(legacy);
    const series = legacy.prepare(`
      INSERT INTO metric_series(metric_name, labels_key, labels_json, created_at_ms)
      VALUES ('zos_host_load1', '{}', '{}', 1000)
    `).run();
    legacy.prepare("INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, 1000, 0.75)")
      .run(Number(series.lastInsertRowid));
    expect(legacy.pragma("auto_vacuum", { simple: true })).toBe(0);
    legacy.close();

    const writer = new MetricsWriter(databasePath, config);
    expect(writer.db.pragma("auto_vacuum", { simple: true })).toBe(2);
    expect(writer.db.prepare("SELECT value FROM metric_samples_raw").pluck().get()).toBe(0.75);
    writer.close();
  });

  it("keeps a full legacy database available without deleting retained data", async () => {
    const databasePath = await tempDatabase();
    const legacy = new Database(databasePath);
    legacy.pragma("journal_mode = WAL");
    runMonitoringMigrations(legacy);
    legacy.close();
    const originalExec = Database.prototype.exec;
    const execSpy = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, source) {
      if (source === "VACUUM") {
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      }
      return originalExec.call(this, source);
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const writer = new MetricsWriter(databasePath, { ...config, maxDatabaseBytes: 1 });
    expect(writer.db.pragma("auto_vacuum", { simple: true })).toBe(0);
    writer.writeSamples([sample("zos_host_load1", 1_000, 1)]);
    const result = writer.maintain(2_000);

    expect(result.writesPaused).toBe(true);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_samples_raw").pluck().get()).toBe(1);
    writer.close();
    warning.mockRestore();
    execSpy.mockRestore();
  });

  it("replaces duplicate timestamps and rebuilds rollups", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([sample("zos_host_load1", 1_000, 1), sample("zos_host_load1", 20_000, 3)]);
    writer.writeSamples([sample("zos_host_load1", 20_000, 5)]);

    expect(writer.db.prepare("SELECT timestamp_ms, value FROM metric_samples_raw ORDER BY timestamp_ms").all())
      .toEqual([{ timestamp_ms: 1_000, value: 1 }, { timestamp_ms: 20_000, value: 5 }]);
    expect(writer.db.prepare(
      "SELECT sum_value, sample_count, last_value, increase_value FROM metric_rollups_1m"
    ).get()).toEqual({ sum_value: 6, sample_count: 2, last_value: 5, increase_value: 4 });
    writer.close();
  });

  it("returns ordered gaps and handles counter resets when calculating rates", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([
      sample("zos_host_network_receive_bytes_total", 0, 100, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 10_000, 160, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 20_000, 20, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 30_000, 50, { interface: "eth0" }),
      sample("zos_host_load1", 0, 1),
      sample("zos_host_load1", 20_000, 3)
    ]);
    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(0).toISOString(),
      end: new Date(40_000).toISOString(),
      maxPoints: 4,
      selectors: [
        { metric: "zos_host_network_receive_bytes_total", transform: "rate" },
        { metric: "zos_host_load1" }
      ]
    }, config);

    expect(response.series[0]?.points.map((point) => point.value)).toEqual([null, 6, 2, 3]);
    expect(response.series[1]?.points.map((point) => point.value)).toEqual([1, null, 3, null]);
    expect(response.series.every((series) => series.points.length <= 4)).toBe(true);
    reader.close();
    writer.close();
  });

  it("uses sample-weighted averages and preserves gaps on aligned gauge rollups", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([
      sample("zos_host_load1", 0, 1),
      sample("zos_host_load1", 10_000, 3),
      sample("zos_host_load1", 60_000, 9),
      sample("zos_host_load1", 4 * 60_000, 6)
    ]);

    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(0).toISOString(),
      end: new Date(6 * 60_000).toISOString(),
      maxPoints: 3,
      selectors: [{ metric: "zos_host_load1" }]
    }, config);

    expect(response.series[0]).toMatchObject({ resolution: "1m", stepMs: 2 * 60_000 });
    expect(response.series[0]?.points.map((point) => point.value)).toEqual([13 / 3, null, 6]);
    reader.close();
    writer.close();
  });

  it("applies tier retention independently", async () => {
    const databasePath = await tempDatabase();
    const shortConfig = {
      ...config,
      rawRetentionMs: 60 * 60_000,
      minuteRetentionMs: 2 * 60 * 60_000,
      hourRetentionMs: 3 * 60 * 60_000
    };
    const writer = new MetricsWriter(databasePath, shortConfig);
    writer.writeSamples([
      sample("zos_host_load1", 0, 1),
      sample("zos_host_load1", 60 * 60_000, 2),
      sample("zos_host_load1", 2 * 60 * 60_000, 3)
    ]);

    const result = writer.maintain(3 * 60 * 60_000);
    expect(result.rawRemoved).toBe(2);
    expect(result.minuteRemoved).toBe(1);
    expect(result.hourRemoved).toBe(0);
    writer.close();
  });

  it("falls back to retained rollups when raw coverage is incomplete", async () => {
    const databasePath = await tempDatabase();
    const shortConfig = {
      ...config,
      rawRetentionMs: 60 * 60_000,
      minuteRetentionMs: 3 * 60 * 60_000,
      hourRetentionMs: 4 * 60 * 60_000
    };
    const startMs = Date.parse("2026-01-01T00:00:00.000Z");
    const writer = new MetricsWriter(databasePath, shortConfig);
    writer.writeSamples([
      sample("zos_host_load1", startMs + 50 * 60_000, 1),
      sample("zos_host_load1", startMs + 90 * 60_000, 2)
    ]);
    writer.maintain(startMs + 2 * 60 * 60_000);

    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(startMs + 45 * 60_000).toISOString(),
      end: new Date(startMs + 105 * 60_000).toISOString(),
      maxPoints: 720,
      selectors: [{ metric: "zos_host_load1" }]
    }, shortConfig);

    expect(response.series[0]?.resolution).toBe("1m");
    expect(response.series[0]?.points.filter((point) => point.value !== null).map((point) => point.value))
      .toEqual([1, 2]);
    reader.close();
    writer.close();
  });

  it("falls back to hourly rollups after raw and minute samples expire", async () => {
    const databasePath = await tempDatabase();
    const shortConfig = {
      ...config,
      rawRetentionMs: 60 * 60_000,
      minuteRetentionMs: 2 * 60 * 60_000,
      hourRetentionMs: 4 * 60 * 60_000
    };
    const startMs = Date.parse("2026-01-01T00:00:00.000Z");
    const writer = new MetricsWriter(databasePath, shortConfig);
    writer.writeSamples([
      sample("zos_host_load1", startMs + 50 * 60_000, 1),
      sample("zos_host_load1", startMs + 150 * 60_000, 2)
    ]);
    writer.maintain(startMs + 3 * 60 * 60_000);

    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(startMs + 45 * 60_000).toISOString(),
      end: new Date(startMs + 165 * 60_000).toISOString(),
      maxPoints: 720,
      selectors: [{ metric: "zos_host_load1" }]
    }, shortConfig);

    expect(response.series[0]?.resolution).toBe("1h");
    expect(response.series[0]?.points.filter((point) => point.value !== null).map((point) => point.value))
      .toEqual([1, 2]);
    reader.close();
    writer.close();
  });

  it("calculates a reset-aware rate from a single retained hourly rollup", async () => {
    const databasePath = await tempDatabase();
    const shortConfig = {
      ...config,
      rawRetentionMs: 60_000,
      minuteRetentionMs: 60_000,
      hourRetentionMs: 4 * 60 * 60_000
    };
    const writer = new MetricsWriter(databasePath, shortConfig);
    writer.writeSamples([
      sample("zos_host_network_receive_bytes_total", 10 * 60_000, 100, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 20 * 60_000, 20, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 30 * 60_000, 50, { interface: "eth0" })
    ]);
    writer.maintain(2 * 60 * 60_000);

    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(0).toISOString(),
      end: new Date(60 * 60_000).toISOString(),
      maxPoints: 2,
      selectors: [{ metric: "zos_host_network_receive_bytes_total", transform: "rate" }]
    }, shortConfig);

    expect(response.series[0]?.resolution).toBe("1h");
    expect(response.series[0]?.points[0]?.value).toBeCloseTo(50 / (20 * 60), 8);
    reader.close();
    writer.close();
  });

  it("preserves counter increases when a retained rollup resets and passes its old value", async () => {
    const databasePath = await tempDatabase();
    const shortConfig = {
      ...config,
      rawRetentionMs: 60_000,
      minuteRetentionMs: 60_000,
      hourRetentionMs: 4 * 60 * 60_000
    };
    const writer = new MetricsWriter(databasePath, shortConfig);
    writer.writeSamples([
      sample("zos_host_network_receive_bytes_total", 0, 100, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 10 * 60_000, 110, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 20 * 60_000, 0, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 30 * 60_000, 150, { interface: "eth0" })
    ]);
    writer.maintain(2 * 60 * 60_000);

    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(0).toISOString(),
      end: new Date(60 * 60_000).toISOString(),
      maxPoints: 2,
      selectors: [{ metric: "zos_host_network_receive_bytes_total", transform: "rate" }]
    }, shortConfig);

    expect(response.series[0]?.resolution).toBe("1h");
    expect(response.series[0]?.points[0]?.value).toBeCloseTo(160 / (30 * 60), 8);
    reader.close();
    writer.close();
  });

  it("preserves counter resets across hourly rollup and query boundaries", async () => {
    const databasePath = await tempDatabase();
    const shortConfig = {
      ...config,
      rawRetentionMs: 60_000,
      minuteRetentionMs: 60_000,
      hourRetentionMs: 4 * 60 * 60_000
    };
    const writer = new MetricsWriter(databasePath, shortConfig);
    writer.writeSamples([
      sample("zos_host_network_receive_bytes_total", 50 * 60_000, 100, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 59 * 60_000, 200, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 61 * 60_000, 20, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 70 * 60_000, 50, { interface: "eth0" })
    ]);
    writer.maintain(3 * 60 * 60_000);

    const reader = openMetricsReader(databasePath);
    const full = queryMetrics(reader, {
      start: new Date(0).toISOString(),
      end: new Date(2 * 60 * 60_000).toISOString(),
      maxPoints: 2,
      selectors: [{ metric: "zos_host_network_receive_bytes_total", transform: "rate" }]
    }, shortConfig);
    expect(full.series[0]?.points[0]?.value).toBeCloseTo(100 / (9 * 60), 8);
    expect(full.series[0]?.points[1]?.value).toBeCloseTo(50 / (11 * 60), 8);

    const partial = queryMetrics(reader, {
      start: new Date(58 * 60_000).toISOString(),
      end: new Date(65 * 60_000).toISOString(),
      maxPoints: 2,
      selectors: [{ metric: "zos_host_network_receive_bytes_total", transform: "rate" }]
    }, shortConfig);
    expect(partial.series[0]?.points[0]?.value).toBeCloseTo(20 / (2 * 60), 8);
    reader.close();
    writer.close();
  });

  it("includes a partial rollup boundary increase in a coarser output point", async () => {
    const databasePath = await tempDatabase();
    const shortConfig = {
      ...config,
      rawRetentionMs: 1_000,
      minuteRetentionMs: 1_000,
      hourRetentionMs: 4 * 60 * 60_000
    };
    const writer = new MetricsWriter(databasePath, shortConfig);
    writer.writeSamples([
      sample("zos_host_network_receive_bytes_total", 10 * 60_000, 100, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 50 * 60_000, 150, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 60 * 60_000, 180, { interface: "eth0" })
    ]);
    writer.maintain(2 * 60 * 60_000);

    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(-45 * 60_000).toISOString(),
      end: new Date(76 * 60_000).toISOString(),
      maxPoints: 2,
      selectors: [{ metric: "zos_host_network_receive_bytes_total", transform: "rate" }]
    }, shortConfig);

    expect(response.series[0]?.resolution).toBe("1h");
    expect(response.series[0]?.points[0]?.value).toBeCloseTo(80 / (50 * 60), 8);
    reader.close();
    writer.close();
  });

  it("resumes exact rates after a legacy rollup with unknown counter increases", async () => {
    const databasePath = await tempDatabase();
    const shortConfig = {
      ...config,
      rawRetentionMs: 1_000,
      minuteRetentionMs: 1_000,
      hourRetentionMs: 6 * 60 * 60_000
    };
    const writer = new MetricsWriter(databasePath, shortConfig);
    writer.writeSamples(Array.from({ length: 8 }, (_, index) =>
      sample(
        "zos_host_network_receive_bytes_total",
        Math.floor(index / 2) * 60 * 60_000 + (index % 2) * 30 * 60_000,
        index * 60,
        { interface: "eth0" }
      )
    ));
    writer.maintain(5 * 60 * 60_000);
    writer.db.prepare(`
      UPDATE metric_rollups_1h
      SET increase_value = NULL, boundary_increase_value = NULL
      WHERE bucket_ms = ?
    `).run(60 * 60_000);

    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(0).toISOString(),
      end: new Date(4 * 60 * 60_000).toISOString(),
      maxPoints: 4,
      selectors: [{ metric: "zos_host_network_receive_bytes_total", transform: "rate" }]
    }, shortConfig);

    const expectedRate = 120 / (60 * 60);
    expect(response.series[0]?.points.map((point) => point.value)).toEqual([
      60 / (30 * 60),
      null,
      expectedRate,
      expectedRate
    ]);
    reader.close();
    writer.close();
  });

  it("refreshes the next non-empty rollup boundary after a late sample", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([
      sample("zos_host_network_receive_bytes_total", 0, 100, { interface: "eth0" }),
      sample("zos_host_network_receive_bytes_total", 3 * 60 * 60_000, 300, { interface: "eth0" })
    ]);
    writer.writeSamples([
      sample("zos_host_network_receive_bytes_total", 60 * 60_000, 150, { interface: "eth0" })
    ]);

    expect(writer.db.prepare(`
      SELECT boundary_increase_value FROM metric_rollups_1h WHERE bucket_ms = ?
    `).pluck().get(3 * 60 * 60_000)).toBe(150);
    writer.close();
  });

  it("does not prefer a rollup because of samples outside an unaligned query range", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([
      sample("zos_host_load1", 30_000, 100),
      sample("zos_host_load1", 50_000, 2)
    ]);

    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(40_000).toISOString(),
      end: new Date(60_000).toISOString(),
      maxPoints: 2,
      selectors: [{ metric: "zos_host_load1" }]
    }, config);

    expect(response.series[0]?.resolution).toBe("raw");
    expect(response.series[0]?.points.map((point) => point.value)).toEqual([null, 2]);
    reader.close();
    writer.close();
  });

  it("keeps dense raw data for a query inside an overlapping coarse rollup", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples(Array.from({ length: 360 }, (_, index) =>
      sample("zos_host_load1", index * 10_000, index)
    ));

    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(10 * 60_000).toISOString(),
      end: new Date(20 * 60_000).toISOString(),
      maxPoints: 60,
      selectors: [{ metric: "zos_host_load1" }]
    }, config);

    expect(response.series[0]?.resolution).toBe("raw");
    expect(response.series[0]?.points.filter((point) => point.value !== null)).toHaveLength(60);
    expect(response.series[0]?.points[0]?.value).toBe(60);
    reader.close();
    writer.close();
  });

  it("does not leak an expired rollup's unknown interior into a narrow range", async () => {
    const databasePath = await tempDatabase();
    const shortConfig = { ...config, rawRetentionMs: 10_000 };
    const writer = new MetricsWriter(databasePath, shortConfig);
    writer.writeSamples([
      sample("zos_host_load1", 30_000, 3),
      sample("zos_host_load1", 40_000, 4),
      sample("zos_host_load1", 50_000, 5)
    ]);
    writer.maintain(70_000);

    const reader = openMetricsReader(databasePath);
    const response = queryMetrics(reader, {
      start: new Date(35_000).toISOString(),
      end: new Date(45_000).toISOString(),
      maxPoints: 2,
      selectors: [{ metric: "zos_host_load1" }]
    }, shortConfig);

    expect(response.series[0]?.points.map((point) => point.value)).toEqual([null]);
    reader.close();
    writer.close();
  });

  it("physically shrinks the database when capacity trimming removes old samples", async () => {
    const databasePath = await tempDatabase();
    const limitedConfig = { ...config, maxDatabaseBytes: 128 * 1024 };
    const writer = new MetricsWriter(databasePath, limitedConfig);
    writer.writeSamples([sample("zos_host_load1", 0, 1)]);
    const seriesId = writer.db.prepare("SELECT id FROM metric_series WHERE metric_name = 'zos_host_load1'")
      .pluck().get() as number;
    const insert = writer.db.prepare(
      "INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?)"
    );
    writer.db.transaction(() => {
      for (let index = 1; index <= 20_000; index += 1) insert.run(seriesId, index, index);
    })();
    writer.db.pragma("wal_checkpoint(TRUNCATE)");
    const before = metricsDatabaseBytes(databasePath);

    const result = writer.maintain(30_000);

    expect(before).toBeGreaterThan(limitedConfig.maxDatabaseBytes);
    expect(result.databaseBytes).toBeLessThan(before);
    expect(result.databaseBytes).toBeLessThanOrEqual(Math.floor(limitedConfig.maxDatabaseBytes * 0.8));
    expect(result.writesPaused).toBe(false);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_samples_raw").pluck().get()).toBeLessThan(20_001);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_rollups_1m").pluck().get()).toBe(1);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_rollups_1h").pluck().get()).toBe(1);
    writer.close();
  });

  it("reclaims expired pages before trimming samples that are still retained", async () => {
    const databasePath = await tempDatabase();
    const limitedConfig = { ...config, rawRetentionMs: 1_000, maxDatabaseBytes: 128 * 1024 };
    const writer = new MetricsWriter(databasePath, limitedConfig);
    writer.writeSamples([sample("zos_host_load1", 99_500, 42)]);
    const seriesId = writer.db.prepare("SELECT id FROM metric_series WHERE metric_name = 'zos_host_load1'")
      .pluck().get() as number;
    const insert = writer.db.prepare(
      "INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?)"
    );
    writer.db.transaction(() => {
      for (let index = 0; index < 20_000; index += 1) insert.run(seriesId, index, index);
    })();
    writer.db.pragma("wal_checkpoint(TRUNCATE)");

    const result = writer.maintain(100_000);

    expect(result.rawRemoved).toBe(20_000);
    expect(result.writesPaused).toBe(false);
    expect(writer.db.prepare("SELECT timestamp_ms, value FROM metric_samples_raw").all())
      .toEqual([{ timestamp_ms: 99_500, value: 42 }]);
    writer.close();
  });

  it("continues to the 80 percent watermark after an over-capacity event", async () => {
    const databasePath = await tempDatabase();
    const limitedConfig = { ...config, rawRetentionMs: 10_000, maxDatabaseBytes: 350 * 1024 };
    const writer = new MetricsWriter(databasePath, limitedConfig);
    writer.writeSamples([sample("zos_host_load1", 100_000, 42)]);
    const seriesId = writer.db.prepare("SELECT id FROM metric_series WHERE metric_name = 'zos_host_load1'")
      .pluck().get() as number;
    const insert = writer.db.prepare(
      "INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?)"
    );
    writer.db.transaction(() => {
      for (let index = 0; index < 20_000; index += 1) insert.run(seriesId, index, index);
      for (let index = 100_001; index <= 110_000; index += 1) insert.run(seriesId, index, index);
    })();
    writer.db.pragma("wal_checkpoint(TRUNCATE)");
    const before = metricsDatabaseBytes(databasePath);

    const result = writer.maintain(110_000);

    expect(before).toBeGreaterThan(limitedConfig.maxDatabaseBytes);
    expect(result.databaseBytes).toBeLessThanOrEqual(Math.floor(limitedConfig.maxDatabaseBytes * 0.8));
    expect(result.writesPaused).toBe(false);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_samples_raw").pluck().get()).toBeLessThan(10_001);
    writer.close();
  });

  it("drains more than one vacuum batch after retention empties the database", async () => {
    const databasePath = await tempDatabase();
    const limitedConfig = {
      ...config,
      rawRetentionMs: 1_000,
      minuteRetentionMs: 1_000,
      hourRetentionMs: 1_000,
      maxDatabaseBytes: 128 * 1024
    };
    const writer = new MetricsWriter(databasePath, limitedConfig);
    writer.writeSamples([sample("zos_host_load1", 0, 1)]);
    const seriesId = writer.db.prepare("SELECT id FROM metric_series WHERE metric_name = 'zos_host_load1'")
      .pluck().get() as number;
    const insert = writer.db.prepare(
      "INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?)"
    );
    writer.db.transaction(() => {
      for (let index = 1; index <= 100_000; index += 1) insert.run(seriesId, index, index);
    })();
    writer.db.pragma("wal_checkpoint(TRUNCATE)");

    const result = writer.maintain(200_000);

    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_samples_raw").pluck().get()).toBe(0);
    expect(result.databaseBytes).toBeLessThanOrEqual(limitedConfig.maxDatabaseBytes);
    expect(result.writesPaused).toBe(false);
    writer.close();
  });

  it("does not trim retained samples while a reader prevents WAL truncation", async () => {
    const databasePath = await tempDatabase();
    const limitedConfig = { ...config, maxDatabaseBytes: 128 * 1024 };
    const writer = new MetricsWriter(databasePath, limitedConfig);
    writer.writeSamples([sample("zos_host_load1", 0, 1)]);
    writer.db.pragma("wal_checkpoint(TRUNCATE)");
    writer.db.pragma("busy_timeout = 1");
    const reader = openMetricsReader(databasePath);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM metric_samples_raw").get();
    const seriesId = writer.db.prepare("SELECT id FROM metric_series WHERE metric_name = 'zos_host_load1'")
      .pluck().get() as number;
    const insert = writer.db.prepare(
      "INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?)"
    );
    writer.db.transaction(() => {
      for (let index = 1; index <= 20_000; index += 1) insert.run(seriesId, index, index);
    })();

    const blocked = writer.maintain(30_000);

    expect(blocked.writesPaused).toBe(true);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_samples_raw").pluck().get()).toBe(20_001);
    reader.exec("ROLLBACK");
    reader.close();

    const recovered = writer.maintain(30_000);
    expect(recovered.writesPaused).toBe(false);
    expect(recovered.databaseBytes).toBeLessThanOrEqual(Math.floor(limitedConfig.maxDatabaseBytes * 0.8));
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_samples_raw").pluck().get()).toBeLessThan(20_001);
    writer.close();
  });

  it("stops before lower tiers when a checkpoint becomes busy during trimming", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, { ...config, maxDatabaseBytes: 1 });
    writer.db.pragma("busy_timeout = 1");
    writer.writeSamples([sample("zos_host_load1", 0, 1)]);
    const seriesId = writer.db.prepare("SELECT id FROM metric_series WHERE metric_name = 'zos_host_load1'")
      .pluck().get() as number;
    const rawInsert = writer.db.prepare(
      "INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?)"
    );
    const rollupInsert = writer.db.prepare(`
      INSERT INTO metric_rollups_1m(
        series_id, bucket_ms, first_timestamp_ms, last_timestamp_ms, first_value, last_value,
        min_value, max_value, sum_value, sample_count
      ) VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1, 1)
    `);
    const hourInsert = writer.db.prepare(`
      INSERT INTO metric_rollups_1h(
        series_id, bucket_ms, first_timestamp_ms, last_timestamp_ms, first_value, last_value,
        min_value, max_value, sum_value, sample_count
      ) VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1, 1)
    `);
    writer.db.transaction(() => {
      for (let index = 1; index <= 6_000; index += 1) {
        rawInsert.run(seriesId, index, index);
        const bucketMs = index * 60_000;
        rollupInsert.run(seriesId, bucketMs, bucketMs, bucketMs);
        hourInsert.run(seriesId, bucketMs, bucketMs, bucketMs);
      }
    })();
    writer.db.pragma("wal_checkpoint(TRUNCATE)");
    const reader = openMetricsReader(databasePath);
    const checkpointTarget = writer as unknown as { checkpointTruncate(): boolean };
    const originalCheckpoint = checkpointTarget.checkpointTruncate.bind(writer);
    let checkpointCalls = 0;
    const checkpointSpy = vi.spyOn(checkpointTarget, "checkpointTruncate").mockImplementation(() => {
      checkpointCalls += 1;
      if (checkpointCalls === 2) {
        reader.exec("BEGIN");
        reader.prepare("SELECT COUNT(*) FROM metric_samples_raw").get();
      }
      return originalCheckpoint();
    });

    const result = writer.maintain(10_000);

    expect(result.writesPaused).toBe(true);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_samples_raw").pluck().get()).toBe(1_001);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_rollups_1m").pluck().get()).toBe(6_001);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_rollups_1h").pluck().get()).toBe(6_001);
    reader.exec("ROLLBACK");
    reader.close();
    checkpointSpy.mockRestore();
    writer.close();
  });

  it("pauses samples when the database cannot be reduced below its cap", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, { ...config, maxDatabaseBytes: 1 });
    writer.writeSamples([sample("zos_host_load1", 1_000, 1)]);
    const result = writer.maintain(2_000);

    expect(result.writesPaused).toBe(true);
    expect(writer.writeSamples([sample("zos_host_load1", 3_000, 2)])).toBe(0);
    expect(monitoringWritesPaused(writer.db)).toBe(true);
    writer.close();
  });

  it("bounds series cardinality and removes series after all samples expire", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    const samples = Array.from({ length: MAX_MONITORING_SERIES_PER_METRIC + 1 }, (_, index) =>
      sample("zos_queue_depth", 1_000, index, { queue: `queue-${index}` })
    );

    expect(writer.writeSamples(samples)).toBe(MAX_MONITORING_SERIES_PER_METRIC);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_series").pluck().get())
      .toBe(MAX_MONITORING_SERIES_PER_METRIC);

    writer.maintain(config.hourRetentionMs + 2_000);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_series").pluck().get()).toBe(0);
    writer.close();
  });

  it("enforces the global series budget", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    const insert = writer.db.prepare(`
      INSERT INTO metric_series(metric_name, labels_key, labels_json, created_at_ms)
      VALUES (?, ?, ?, 0)
    `);
    const metrics = [
      "zos_queue_depth",
      "zos_worker_heartbeat_age_seconds",
      "zos_last_success_timestamp_seconds",
      "zos_host_temperature_celsius",
      "zos_systemd_unit_active",
      "zos_host_network_receive_bytes_total",
      "zos_host_network_transmit_bytes_total",
      "zos_host_disk_read_bytes_total"
    ];
    writer.db.transaction(() => {
      for (let index = 0; index < MAX_MONITORING_SERIES; index += 1) {
        const value = `value-${index}`;
        insert.run(metrics[Math.floor(index / MAX_MONITORING_SERIES_PER_METRIC)]!, JSON.stringify({ value }), JSON.stringify({ value }));
      }
    })();

    expect(writer.writeSamples([sample("zos_host_load1", 1_000, 1)])).toBe(0);
    expect(writer.db.prepare("SELECT COUNT(*) FROM metric_series").pluck().get()).toBe(MAX_MONITORING_SERIES);
    writer.close();
  });

  it("rejects databases created by a newer monitoring schema", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.close();
    const future = new Database(databasePath);
    future.prepare("INSERT INTO monitoring_schema_migrations(version, applied_at) VALUES (999, ?)")
      .run(new Date().toISOString());
    future.close();

    expect(() => new MetricsWriter(databasePath, config)).toThrow(/newer than supported/iu);
    expect(() => openMetricsReader(databasePath)).toThrow(/newer than supported/iu);
    const preserved = new Database(databasePath, { readonly: true });
    expect(preserved.prepare("SELECT MAX(version) FROM monitoring_schema_migrations").pluck().get()).toBe(999);
    preserved.close();
    expect((await readdir(tempDir!)).some((entry) => entry.includes(".corrupt-"))).toBe(false);
  });

  it("reopens a long-lived reader after the metrics database is replaced", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([sample("zos_host_load1", 1_000, 1)]);
    writer.db.pragma("wal_checkpoint(TRUNCATE)");
    const reader = new MonitoringReader(databasePath, config);
    expect(reader.overview(new Date(1_000)).latest.find((item) => item.metric === "zos_host_load1")?.value).toBe(1);
    writer.close();

    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      try {
        await rename(file, `${file}.replaced`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    expect(reader.overview(new Date(1_500)).status).toBe("starting");
    const replacement = new MetricsWriter(databasePath, config);
    replacement.writeSamples([sample("zos_host_load1", 2_000, 2)]);

    expect(reader.overview(new Date(2_000)).latest.find((item) => item.metric === "zos_host_load1")?.value).toBe(2);
    reader.close();
    replacement.close();
  });

  it("quarantines a corrupt metrics database without touching neighboring files", async () => {
    const databasePath = await tempDatabase();
    const mainDatabasePath = path.join(tempDir!, "zos.sqlite");
    await writeFile(databasePath, "not a sqlite database");
    await writeFile(mainDatabasePath, "main database sentinel");

    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([sample("zos_host_load1", 1_000, 1)]);
    writer.close();

    const firstEntries = await readdir(tempDir!);
    expect(firstEntries).toEqual(expect.arrayContaining([
      "metrics.sqlite",
      expect.stringMatching(/^metrics\.sqlite\.corrupt-/u),
      "zos.sqlite"
    ]));
    const firstBase = firstEntries.find((entry) => /^metrics\.sqlite\.corrupt-/u.test(entry))!;
    const firstSuffix = firstBase.slice("metrics.sqlite".length);
    for (const sidecar of ["-wal", "-shm", "-journal"]) {
      await writeFile(`${databasePath}${sidecar}${firstSuffix}`, sidecar);
    }

    await new Promise((resolve) => setTimeout(resolve, 2));
    await writeFile(databasePath, "corrupt again");
    const replacement = new MetricsWriter(databasePath, config);
    replacement.close();
    const entries = await readdir(tempDir!);
    const retainedBase = entries.filter((entry) => /^metrics\.sqlite\.corrupt-/u.test(entry));
    expect(retainedBase).toHaveLength(1);
    expect(entries.some((entry) => entry.endsWith(firstSuffix))).toBe(false);
    const retainedSuffix = retainedBase[0]!.slice("metrics.sqlite".length);
    for (const sidecar of ["-wal", "-shm", "-journal"]) {
      await writeFile(`${databasePath}${sidecar}${retainedSuffix}`, sidecar);
    }
    expect(await readdir(tempDir!)).toEqual(expect.arrayContaining([
      retainedBase[0]!,
      `metrics.sqlite-wal${retainedSuffix}`,
      `metrics.sqlite-shm${retainedSuffix}`,
      `metrics.sqlite-journal${retainedSuffix}`
    ]));
  });
});

async function tempDatabase(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-monitoring-"));
  return path.join(tempDir, "metrics.sqlite");
}

function sample(
  metric: string,
  timestampMs: number,
  value: number,
  labels?: Record<string, string>
) {
  return { metric, timestampMs, value, ...(labels ? { labels } : {}) };
}
