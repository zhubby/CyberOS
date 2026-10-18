import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MonitoringConfig } from "@zos/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  MetricsWriter,
  monitoringWritesPaused,
  openMetricsReader
} from "./store.js";
import { queryMetrics } from "./query.js";

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
  it("creates a dedicated database and supports a concurrent read-only connection", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([sample("zos_host_load1", 1_000, 0.75)]);

    const reader = openMetricsReader(databasePath);
    expect(reader.pragma("query_only", { simple: true })).toBe(1);
    expect(reader.prepare("SELECT COUNT(*) AS count FROM metric_samples_raw").get()).toEqual({ count: 1 });
    expect(() => reader.prepare("DELETE FROM metric_samples_raw").run()).toThrow();

    reader.close();
    writer.close();
  });

  it("replaces duplicate timestamps and rebuilds rollups", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([sample("zos_host_load1", 1_000, 1), sample("zos_host_load1", 20_000, 3)]);
    writer.writeSamples([sample("zos_host_load1", 20_000, 5)]);

    expect(writer.db.prepare("SELECT timestamp_ms, value FROM metric_samples_raw ORDER BY timestamp_ms").all())
      .toEqual([{ timestamp_ms: 1_000, value: 1 }, { timestamp_ms: 20_000, value: 5 }]);
    expect(writer.db.prepare("SELECT sum_value, sample_count, last_value FROM metric_rollups_1m").get())
      .toEqual({ sum_value: 6, sample_count: 2, last_value: 5 });
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

  it("quarantines a corrupt metrics database without touching neighboring files", async () => {
    const databasePath = await tempDatabase();
    const mainDatabasePath = path.join(tempDir!, "zos.sqlite");
    await writeFile(databasePath, "not a sqlite database");
    await writeFile(mainDatabasePath, "main database sentinel");

    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples([sample("zos_host_load1", 1_000, 1)]);
    writer.close();

    expect(await readdir(tempDir!)).toEqual(expect.arrayContaining([
      "metrics.sqlite",
      expect.stringMatching(/^metrics\.sqlite\.corrupt-/u),
      "zos.sqlite"
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
