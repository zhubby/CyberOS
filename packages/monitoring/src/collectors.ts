import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import type { Dirent } from "node:fs";
import {
  getDownloadWorkerHealth,
  getIndexerServiceStatus,
  getIndexRootStatus,
  getOpsTaskOverview,
  getPhotostaffWorkerHealth,
  listBackupRuns,
  listHealthAlerts,
  listNasRoots,
  openZosDbReadOnly,
  type ZosDatabase
} from "@zos/db";
import { DEFAULT_MONITORING_CONFIG, type ZosConfig } from "@zos/shared";
import type { MetricSample } from "./store.js";

const execFile = promisify(execFileCallback);
const SECTOR_BYTES = 512;

export interface CollectorResult {
  samples: MetricSample[];
  state?: "ready" | "unsupported";
}

export interface MonitorCollector {
  id: string;
  intervalMs: number;
  collect(timestampMs: number): Promise<CollectorResult>;
  close?(): void;
}

export interface HostCollectorIo {
  readText(path: string): Promise<string>;
  listDirectory(path: string): Promise<Dirent[]>;
  statFilesystem(path: string): Promise<{ bsize: number | bigint; blocks: number | bigint; bavail: number | bigint }>;
}

const defaultHostIo: HostCollectorIo = {
  readText: (file) => readFile(file, "utf8"),
  listDirectory: (directory) => readdir(directory, { withFileTypes: true }),
  statFilesystem: (target) => statfs(target)
};

export function createFastHostCollector(
  intervalMs: number,
  io: Pick<HostCollectorIo, "readText"> = defaultHostIo
): MonitorCollector {
  let previousCpu: { idle: number; total: number } | null = null;
  return {
    id: "host",
    intervalMs,
    async collect(timestampMs) {
      const [stat, loadavg, meminfo, diskstats, netdev] = await Promise.all([
        io.readText("/proc/stat"),
        io.readText("/proc/loadavg"),
        io.readText("/proc/meminfo"),
        io.readText("/proc/diskstats"),
        io.readText("/proc/net/dev")
      ]);
      const samples = [
        ...loadSamples(loadavg, timestampMs),
        ...memorySamples(meminfo, timestampMs),
        ...diskSamples(diskstats, timestampMs),
        ...networkSamples(netdev, timestampMs)
      ];
      const currentCpu = parseCpu(stat);
      if (previousCpu) {
        const totalDelta = currentCpu.total - previousCpu.total;
        const idleDelta = currentCpu.idle - previousCpu.idle;
        if (totalDelta > 0 && idleDelta >= 0) {
          samples.push(sample("zos_host_cpu_usage_ratio", timestampMs, clamp(1 - idleDelta / totalDelta, 0, 1)));
        }
      }
      previousCpu = currentCpu;
      return { samples };
    }
  };
}

export function createFilesystemCollector(
  config: ZosConfig,
  io: Pick<HostCollectorIo, "statFilesystem"> = defaultHostIo
): MonitorCollector {
  return {
    id: "filesystem",
    intervalMs: config.monitoring?.standardSampleIntervalMs ?? DEFAULT_MONITORING_CONFIG.standardSampleIntervalMs,
    async collect(timestampMs) {
      const targets = [
        { label: "state", path: config.stateDir ?? config.dataDir },
        ...config.nasRoots.map((root) => ({ label: `nas:${root.id}`, path: root.path }))
      ];
      const settled = await Promise.allSettled(targets.map(async (target) => {
        const stats = await io.statFilesystem(target.path);
        const blockSize = Number(stats.bsize);
        return [
          sample("zos_host_filesystem_size_bytes", timestampMs, Number(stats.blocks) * blockSize, { filesystem: target.label }),
          sample("zos_host_filesystem_available_bytes", timestampMs, Number(stats.bavail) * blockSize, { filesystem: target.label })
        ];
      }));
      const samples = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      if (samples.length === 0 && targets.length > 0) throw new Error("No configured filesystem could be sampled");
      return { samples };
    }
  };
}

export function createTemperatureCollector(
  intervalMs: number,
  io: Pick<HostCollectorIo, "readText" | "listDirectory"> = defaultHostIo,
  thermalRoot = "/sys/class/thermal"
): MonitorCollector {
  return {
    id: "temperature",
    intervalMs,
    async collect(timestampMs) {
      let entries: Dirent[];
      try {
        entries = await io.listDirectory(thermalRoot);
      } catch (error) {
        if (isMissingOrDenied(error)) return { samples: [], state: "unsupported" };
        throw error;
      }
      const zones = entries.filter((entry) => entry.isDirectory() && /^thermal_zone\d+$/u.test(entry.name));
      const settled = await Promise.allSettled(zones.map(async (zone) => {
        const base = `${thermalRoot}/${zone.name}`;
        const [type, raw] = await Promise.all([
          io.readText(`${base}/type`),
          io.readText(`${base}/temp`)
        ]);
        const temperature = Number(raw.trim());
        if (!Number.isFinite(temperature)) throw new Error("Invalid thermal sensor value");
        const celsius = Math.abs(temperature) >= 1_000 ? temperature / 1_000 : temperature;
        return sample("zos_host_temperature_celsius", timestampMs, celsius, {
          sensor: `${sanitizeLabel(type.trim()) || "thermal"}:${zone.name.replace("thermal_zone", "")}`
        });
      }));
      const samples = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      return { samples, ...(zones.length === 0 || samples.length === 0 ? { state: "unsupported" as const } : {}) };
    }
  };
}

export const MONITORED_SYSTEMD_UNITS = [
  "zos-api.service",
  "zos-monitor.service",
  "zos-worker@1.service",
  "zos-indexer.service",
  "zos-downloader.service",
  "zos-photostaff.service",
  "zos-hostd.service",
  "zos-termux.service",
  "zos-health.service",
  "zos-maintenance.service",
  "zos-backup-daily.service"
] as const;

export function createSystemdCollector(
  intervalMs: number,
  queryUnit: (unit: string) => Promise<string> = querySystemdUnit
): MonitorCollector {
  return {
    id: "systemd",
    intervalMs,
    async collect(timestampMs) {
      const states = await Promise.all(MONITORED_SYSTEMD_UNITS.map(async (unit) => ({
        unit,
        state: await queryUnit(unit)
      })));
      return {
        samples: states.map(({ unit, state }) => sample(
          "zos_systemd_unit_active",
          timestampMs,
          state.trim() === "active" ? 1 : 0,
          { unit }
        ))
      };
    }
  };
}

export function createZosCollector(config: ZosConfig): MonitorCollector {
  let db: ZosDatabase | null = null;
  const getDb = (): ZosDatabase => {
    db ??= openZosDbReadOnly(config.databasePath);
    return db;
  };
  return {
    id: "zos",
    intervalMs: config.monitoring?.standardSampleIntervalMs ?? DEFAULT_MONITORING_CONFIG.standardSampleIntervalMs,
    async collect(timestampMs) {
      try {
        return { samples: collectZosSamples(getDb(), timestampMs) };
      } catch (error) {
        db?.close();
        db = null;
        throw error;
      }
    },
    close() {
      db?.close();
      db = null;
    }
  };
}

export function collectZosSamples(db: ZosDatabase, timestampMs: number): MetricSample[] {
  const now = new Date(timestampMs);
  const indexer = getIndexerServiceStatus(db, now);
  const downloader = getDownloadWorkerHealth(db, now);
  const photostaff = getPhotostaffWorkerHealth(db, now);
  const samples: MetricSample[] = [
    sample("zos_queue_depth", timestampMs, indexer.queue.queued + indexer.queue.retrying, { queue: "indexer" }),
    sample("zos_queue_depth", timestampMs, downloader.queuedTasks + downloader.retryWaitTasks, { queue: "downloads" }),
    sample("zos_queue_depth", timestampMs, photostaff.queuedJobs + photostaff.retryingJobs, { queue: "photostaff" })
  ];
  const agentQueued = db.prepare("SELECT COUNT(*) FROM jobs WHERE status = 'queued'").pluck().get() as number;
  samples.push(sample("zos_queue_depth", timestampMs, agentQueued, { queue: "agent" }));

  for (const worker of [
    { name: "indexer", heartbeat: indexer.service.lastHeartbeatAt },
    { name: "downloader", heartbeat: downloader.lastHeartbeatAt },
    { name: "photostaff", heartbeat: photostaff.lastHeartbeatAt }
  ]) {
    if (worker.heartbeat) {
      samples.push(sample(
        "zos_worker_heartbeat_age_seconds",
        timestampMs,
        Math.max(0, (timestampMs - Date.parse(worker.heartbeat)) / 1_000),
        { worker: worker.name }
      ));
    }
  }

  const freshness = listNasRoots(db)
    .map((root) => getIndexRootStatus(db, root.id, now).metrics?.freshnessMs ?? null)
    .filter((value): value is number => value !== null);
  if (freshness.length > 0) {
    samples.push(sample("zos_index_freshness_seconds", timestampMs, Math.max(...freshness) / 1_000));
  }

  const latestBackup = listBackupRuns(db, 30).find((run) =>
    (run.kind === "daily" || run.kind === "weekly") && run.status === "completed" && run.finishedAt
  );
  if (latestBackup?.finishedAt) {
    samples.push(sample(
      "zos_last_success_timestamp_seconds",
      timestampMs,
      Date.parse(latestBackup.finishedAt) / 1_000,
      { task: "backup" }
    ));
  }
  for (const task of ["health", "maintenance"] as const) {
    const overview = getOpsTaskOverview(db, task, now);
    if (overview.lastSuccessAt) {
      samples.push(sample(
        "zos_last_success_timestamp_seconds",
        timestampMs,
        Date.parse(overview.lastSuccessAt) / 1_000,
        { task }
      ));
    }
  }
  const activeAlerts = listHealthAlerts(db, { status: "active", limit: 200 });
  for (const severity of ["warning", "critical"] as const) {
    samples.push(sample(
      "zos_health_problem_count",
      timestampMs,
      activeAlerts.filter((alert) => alert.severity === severity).length,
      { severity }
    ));
  }
  return samples;
}

function loadSamples(value: string, timestampMs: number): MetricSample[] {
  const [one, five, fifteen] = value.trim().split(/\s+/u).slice(0, 3).map(Number);
  if (![one, five, fifteen].every(Number.isFinite)) throw new Error("Invalid /proc/loadavg");
  return [
    sample("zos_host_load1", timestampMs, one!),
    sample("zos_host_load5", timestampMs, five!),
    sample("zos_host_load15", timestampMs, fifteen!)
  ];
}

function memorySamples(value: string, timestampMs: number): MetricSample[] {
  const values = new Map(value.split("\n").flatMap((line) => {
    const match = /^(\w+):\s+(\d+)\s+kB$/u.exec(line.trim());
    return match ? [[match[1]!, Number(match[2]) * 1024] as const] : [];
  }));
  const total = requiredValue(values, "MemTotal");
  const available = requiredValue(values, "MemAvailable");
  const swapTotal = values.get("SwapTotal") ?? 0;
  const swapFree = values.get("SwapFree") ?? 0;
  return [
    sample("zos_host_memory_total_bytes", timestampMs, total),
    sample("zos_host_memory_available_bytes", timestampMs, available),
    sample("zos_host_memory_used_bytes", timestampMs, Math.max(0, total - available)),
    sample("zos_host_swap_total_bytes", timestampMs, swapTotal),
    sample("zos_host_swap_used_bytes", timestampMs, Math.max(0, swapTotal - swapFree))
  ];
}

function diskSamples(value: string, timestampMs: number): MetricSample[] {
  return value.trim().split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/u);
    const device = fields[2] ?? "";
    if (!/^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|md\d+|dm-\d+)$/u.test(device)) return [];
    const readSectors = Number(fields[5]);
    const writtenSectors = Number(fields[9]);
    if (!Number.isFinite(readSectors) || !Number.isFinite(writtenSectors)) return [];
    return [
      sample("zos_host_disk_read_bytes_total", timestampMs, readSectors * SECTOR_BYTES, { device }),
      sample("zos_host_disk_written_bytes_total", timestampMs, writtenSectors * SECTOR_BYTES, { device })
    ];
  });
}

function networkSamples(value: string, timestampMs: number): MetricSample[] {
  return value.split("\n").flatMap((line) => {
    const match = /^\s*([^:]+):\s*(.+)$/u.exec(line);
    if (!match) return [];
    const interfaceName = match[1]!.trim();
    if (interfaceName === "lo" || !/^[a-zA-Z0-9_.-]+$/u.test(interfaceName)) return [];
    const fields = match[2]!.trim().split(/\s+/u).map(Number);
    const received = fields[0];
    const transmitted = fields[8];
    if (!Number.isFinite(received) || !Number.isFinite(transmitted)) return [];
    return [
      sample("zos_host_network_receive_bytes_total", timestampMs, received!, { interface: interfaceName }),
      sample("zos_host_network_transmit_bytes_total", timestampMs, transmitted!, { interface: interfaceName })
    ];
  });
}

function parseCpu(value: string): { idle: number; total: number } {
  const line = value.split("\n").find((candidate) => candidate.startsWith("cpu "));
  if (!line) throw new Error("Invalid /proc/stat");
  const fields = line.trim().split(/\s+/u).slice(1).map(Number);
  if (fields.length < 5 || !fields.every(Number.isFinite)) throw new Error("Invalid /proc/stat");
  return {
    idle: fields[3]! + (fields[4] ?? 0),
    total: fields.reduce((total, field) => total + field, 0)
  };
}

async function querySystemdUnit(unit: string): Promise<string> {
  const result = await execFile("systemctl", ["show", "--property=ActiveState", "--value", unit], {
    timeout: 5_000,
    maxBuffer: 16 * 1024
  });
  return result.stdout;
}

function requiredValue(values: Map<string, number>, name: string): number {
  const value = values.get(name);
  if (value === undefined) throw new Error(`Missing ${name} in /proc/meminfo`);
  return value;
}

function sample(
  metric: string,
  timestampMs: number,
  value: number,
  labels?: Record<string, string>
): MetricSample {
  return { metric, timestampMs, value, ...(labels ? { labels } : {}) };
}

function sanitizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 96);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isMissingOrDenied(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES");
}
