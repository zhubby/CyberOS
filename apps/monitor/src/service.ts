import path from "node:path";
import {
  MetricsWriter,
  MonitorScheduler,
  createFastHostCollector,
  createFilesystemCollector,
  createSystemdCollector,
  createTemperatureCollector,
  createZosCollector,
  type MonitorCollector
} from "@zos/monitoring";
import { DEFAULT_MONITORING_CONFIG, type ZosConfig } from "@zos/shared";

export interface MonitorRuntime {
  state: "disabled" | "running";
  start(): void;
  stop(): Promise<void>;
}

export function createMonitorRuntime(
  config: ZosConfig,
  dependencies: {
    writer?: MetricsWriter;
    collectors?: MonitorCollector[];
    schedulerFactory?: (collectors: MonitorCollector[], writer: MetricsWriter) => MonitorScheduler;
  } = {}
): MonitorRuntime {
  const monitoring = config.monitoring ?? DEFAULT_MONITORING_CONFIG;
  if (!monitoring.enabled) {
    return {
      state: "disabled",
      start() {},
      async stop() {}
    };
  }

  const metricsDatabasePath = config.metricsDatabasePath ?? path.join(config.dataDir, "metrics.sqlite");
  const writer = dependencies.writer ?? new MetricsWriter(metricsDatabasePath, monitoring);
  const collectors = dependencies.collectors ?? [
    createFastHostCollector(monitoring.fastSampleIntervalMs),
    createFilesystemCollector(config),
    createSystemdCollector(monitoring.standardSampleIntervalMs),
    createZosCollector(config),
    createTemperatureCollector(monitoring.temperatureSampleIntervalMs)
  ];
  const scheduler = dependencies.schedulerFactory?.(collectors, writer)
    ?? new MonitorScheduler(collectors, writer);
  let stopped = false;

  return {
    state: "running",
    start() {
      if (!stopped) scheduler.start();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await scheduler.stop();
      writer.close();
    }
  };
}
