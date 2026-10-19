import { performance } from "node:perf_hooks";
import type { MonitorCollector } from "./collectors.js";
import { metricsDatabaseBytes, type MetricSample, type MetricsWriter } from "./store.js";

export interface SchedulerClock {
  monotonicNow(): number;
  wallNow(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const systemClock: SchedulerClock = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer)
};

interface ScheduledTask {
  collector: MonitorCollector;
  nextRun: number;
  running: boolean;
  failures: number;
}

export class MonitorScheduler {
  private readonly tasks: ScheduledTask[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = new Set<Promise<void>>();
  private stopping = false;
  private lastMaintenanceAt = 0;

  constructor(
    collectors: readonly MonitorCollector[],
    private readonly writer: MetricsWriter,
    private readonly clock: SchedulerClock = systemClock
  ) {
    const now = clock.monotonicNow();
    this.tasks = collectors.map((collector) => ({ collector, nextRun: now, running: false, failures: 0 }));
  }

  start(): void {
    if (this.timer || this.stopping) return;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) this.clock.clearTimer(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.active]);
    for (const task of this.tasks) task.collector.close?.();
  }

  runDue(): void {
    if (this.stopping) return;
    this.timer = null;
    const monotonicNow = this.clock.monotonicNow();
    const timestampMs = this.clock.wallNow();
    for (const task of this.tasks) {
      if (task.nextRun > monotonicNow) continue;
      while (task.nextRun <= monotonicNow) task.nextRun += task.collector.intervalMs;
      if (task.running) continue;
      task.running = true;
      const promise = this.runCollector(task, timestampMs)
        .finally(() => {
          task.running = false;
          this.active.delete(promise);
        });
      this.active.add(promise);
    }
    if (timestampMs - this.lastMaintenanceAt >= 60_000) {
      this.lastMaintenanceAt = timestampMs;
      try {
        this.writer.maintain(timestampMs);
      } catch (error) {
        console.error("Monitoring retention failed", error);
      }
    }
    this.scheduleNext();
  }

  private async runCollector(task: ScheduledTask, timestampMs: number): Promise<void> {
    const started = this.clock.monotonicNow();
    try {
      const result = await task.collector.collect(timestampMs);
      const durationMs = Math.max(0, this.clock.monotonicNow() - started);
      const written = this.writer.writeSamples(result.samples);
      if (written !== result.samples.length) {
        const reason = this.writer.isWritePaused()
          ? "Monitoring sample writes are paused because the database is over capacity"
          : `Monitoring series limit rejected ${result.samples.length - written} samples`;
        throw new Error(reason);
      }
      task.failures = 0;
      this.writer.recordCollectorStatus({
        collector: task.collector.id,
        state: result.state ?? "ready",
        attemptedAtMs: timestampMs,
        durationMs
      });
      this.writeSelfSamples(task.collector.id, timestampMs, durationMs, 0, 1);
    } catch (error) {
      const durationMs = Math.max(0, this.clock.monotonicNow() - started);
      task.failures += 1;
      console.error(`Monitoring collector ${task.collector.id} failed`, error);
      this.writer.recordCollectorStatus({
        collector: task.collector.id,
        state: "error",
        attemptedAtMs: timestampMs,
        durationMs,
        error: error instanceof Error ? error.message : String(error)
      });
      this.writeSelfSamples(task.collector.id, timestampMs, durationMs, task.failures, 0);
    }
  }

  private writeSelfSamples(
    collector: string,
    timestampMs: number,
    durationMs: number,
    failures: number,
    up: number
  ): void {
    const samples: MetricSample[] = [
      { metric: "zos_monitor_collector_up", labels: { collector }, timestampMs, value: up },
      { metric: "zos_monitor_collector_duration_seconds", labels: { collector }, timestampMs, value: durationMs / 1_000 },
      { metric: "zos_monitor_collector_consecutive_failures", labels: { collector }, timestampMs, value: failures },
      { metric: "zos_monitor_database_size_bytes", timestampMs, value: metricsDatabaseBytes(this.writer.databasePath) }
    ];
    if (up === 1) {
      samples.push({ metric: "zos_monitor_last_sample_timestamp_seconds", timestampMs, value: timestampMs / 1_000 });
    }
    this.writer.writeSamples(samples);
  }

  private scheduleNext(): void {
    if (this.stopping || this.tasks.length === 0) return;
    const nextRun = Math.min(...this.tasks.map((task) => task.nextRun));
    this.schedule(Math.max(0, nextRun - this.clock.monotonicNow()));
  }

  private schedule(delayMs: number): void {
    this.timer = this.clock.setTimer(() => this.runDue(), delayMs);
  }
}
