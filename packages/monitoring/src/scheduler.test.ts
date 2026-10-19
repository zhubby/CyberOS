import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MonitoringConfig } from "@zos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MonitorCollector } from "./collectors.js";
import { MonitoringReader } from "./reader.js";
import { MonitorScheduler, type SchedulerClock } from "./scheduler.js";
import { MAX_MONITORING_SERIES_PER_METRIC, MetricsWriter } from "./store.js";

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

describe("MonitorScheduler", () => {
  it("uses monotonic deadlines, prevents overlap, and drains on stop", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-scheduler-"));
    const writer = new MetricsWriter(path.join(tempDir, "metrics.sqlite"), config);
    let release: (() => void) | undefined;
    const collect = vi.fn(() => new Promise<{ samples: [] }>((resolve) => {
      release = () => resolve({ samples: [] });
    }));
    const collector: MonitorCollector = { id: "slow", intervalMs: 10, collect };
    const fakeClock = new FakeClock();
    const scheduler = new MonitorScheduler([collector], writer, fakeClock);

    scheduler.runDue();
    fakeClock.monotonic = 25;
    fakeClock.wall = 500_000;
    scheduler.runDue();
    expect(collect).toHaveBeenCalledTimes(1);

    const stopping = scheduler.stop();
    let drained = false;
    void stopping.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release?.();
    await stopping;
    expect(drained).toBe(true);
    writer.close();
  });

  it("records failures without preventing other collectors from succeeding", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-scheduler-"));
    const writer = new MetricsWriter(path.join(tempDir, "metrics.sqlite"), config);
    const clock = new FakeClock();
    const scheduler = new MonitorScheduler([
      { id: "broken", intervalMs: 10_000, async collect() { throw new Error("permission denied: /secret/path"); } },
      { id: "healthy", intervalMs: 10_000, async collect(timestampMs) {
        return { samples: [{ metric: "zos_host_load1", timestampMs, value: 1 }] };
      } }
    ], writer, clock);

    scheduler.runDue();
    await scheduler.stop();
    const rows = writer.db.prepare("SELECT collector_id, state, error FROM collector_status ORDER BY collector_id").all();
    expect(rows).toEqual([
      { collector_id: "broken", state: "error", error: "Collector permission denied" },
      { collector_id: "healthy", state: "ready", error: null }
    ]);
    writer.close();
  });

  it("does not advance the successful sample timestamp when every collector fails", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-scheduler-"));
    const writer = new MetricsWriter(path.join(tempDir, "metrics.sqlite"), config);
    const scheduler = new MonitorScheduler([
      { id: "broken", intervalMs: 10_000, async collect() { throw new Error("unavailable"); } }
    ], writer, new FakeClock());

    scheduler.runDue();
    await scheduler.stop();

    expect(writer.db.prepare(`
      SELECT COUNT(*) FROM metric_samples_raw samples
      JOIN metric_series series ON series.id = samples.series_id
      WHERE series.metric_name = 'zos_monitor_last_sample_timestamp_seconds'
    `).pluck().get()).toBe(0);
    writer.close();
  });

  it("reports rejected samples as degraded instead of collector success", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-scheduler-"));
    const databasePath = path.join(tempDir, "metrics.sqlite");
    const writer = new MetricsWriter(databasePath, config);
    writer.writeSamples(Array.from({ length: MAX_MONITORING_SERIES_PER_METRIC }, (_, index) => ({
      metric: "zos_queue_depth",
      labels: { queue: `queue-${index}` },
      timestampMs: 1,
      value: index
    })));
    const scheduler = new MonitorScheduler([{
      id: "queues",
      intervalMs: 10_000,
      async collect(timestampMs) {
        return {
          samples: [{ metric: "zos_queue_depth", labels: { queue: "overflow" }, timestampMs, value: 1 }]
        };
      }
    }], writer, new FakeClock());

    scheduler.runDue();
    await scheduler.stop();

    expect(writer.db.prepare("SELECT state, consecutive_failures, error FROM collector_status WHERE collector_id = 'queues'").get())
      .toEqual({
        state: "error",
        consecutive_failures: 1,
        error: "Monitoring series limit rejected 1 samples"
      });
    const reader = new MonitoringReader(databasePath, config);
    expect(reader.overview(new Date(1_000)).status).toBe("degraded");
    expect(reader.overview(new Date(1_000)).latest).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "zos_monitor_collector_up", labels: { collector: "queues" }, value: 0 })
    ]));
    reader.close();
    writer.close();
  });
});

class FakeClock implements SchedulerClock {
  monotonic = 0;
  wall = 1_000;

  monotonicNow(): number { return this.monotonic; }
  wallNow(): number { return this.wall; }
  setTimer(): ReturnType<typeof setTimeout> { return 1 as unknown as ReturnType<typeof setTimeout>; }
  clearTimer(): void {}
}
