import type Database from "better-sqlite3";
import { statSync } from "node:fs";
import type {
  MonitoringCatalogResponse,
  MonitoringConfig,
  MonitoringHealthStatus,
  MonitoringOverviewResponse,
  MonitoringQueryRequest,
  MonitoringQueryResponse
} from "@zos/shared";
import { MONITORING_CATALOG } from "./catalog.js";
import {
  latestMetricValues,
  MonitoringValidationError,
  queryMetrics,
  validateMonitoringQuery
} from "./query.js";
import {
  listCollectorStatuses,
  listMetricSeries,
  metricsDatabaseBytes,
  monitoringWritesPaused,
  openMetricsReader
} from "./store.js";

const STALE_AFTER_MS = 30_000;

export class MonitoringUnavailableError extends Error {
  readonly statusCode = 503;
  readonly expose = true;

  constructor() {
    super("Monitoring data is unavailable");
  }
}

export class MonitoringReader {
  private db: Database.Database | null = null;
  private databaseIdentity: { device: number; inode: number } | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly config: MonitoringConfig
  ) {}

  close(): void {
    this.db?.close();
    this.db = null;
    this.databaseIdentity = null;
  }

  catalog(): MonitoringCatalogResponse {
    if (!this.config.enabled) return { metrics: [...MONITORING_CATALOG], series: [] };
    const db = this.tryDatabase();
    return {
      metrics: [...MONITORING_CATALOG],
      series: db ? listMetricSeries(db) : []
    };
  }

  overview(now = new Date()): MonitoringOverviewResponse {
    if (!this.config.enabled) return this.emptyOverview("disabled", now);
    const db = this.tryDatabase();
    if (!db) return this.emptyOverview("starting", now);
    try {
      const collectors = listCollectorStatuses(db);
      const latest = latestMetricValues(db);
      const writesPaused = monitoringWritesPaused(db);
      const lastSuccessMs = Math.max(
        ...collectors.flatMap((collector) => collector.lastSuccessAt ? [Date.parse(collector.lastSuccessAt)] : []),
        ...latest.flatMap((value) => value.metric === "zos_monitor_last_sample_timestamp_seconds"
          ? [value.value * 1_000]
          : [])
      );
      const degraded = writesPaused || collectors.some((collector) => collector.state === "error");
      const status = !Number.isFinite(lastSuccessMs) && !degraded
        ? "starting"
        : Number.isFinite(lastSuccessMs) && now.getTime() - lastSuccessMs > STALE_AFTER_MS
          ? "unavailable"
          : degraded
            ? "degraded"
            : "ready";
      return {
        status,
        enabled: true,
        sampledAt: now.toISOString(),
        latest,
        collectors,
        retention: this.retention(writesPaused)
      };
    } catch (error) {
      this.invalidate(error);
    }
  }

  query(request: MonitoringQueryRequest): MonitoringQueryResponse {
    validateMonitoringQuery(request);
    if (!this.config.enabled) return emptyQuery(request);
    const db = this.tryDatabase();
    if (!db) return emptyQuery(request);
    try {
      return queryMetrics(db, request, this.config);
    } catch (error) {
      if (error instanceof MonitoringValidationError) throw error;
      this.invalidate(error);
    }
  }

  health(now = new Date()): MonitoringHealthStatus {
    if (!this.config.enabled) return { status: "disabled", lastSampleAt: null };
    try {
      const overview = this.overview(now);
      const lastSampleMs = Math.max(
        ...overview.collectors.flatMap((collector) => collector.lastSuccessAt
          ? [Date.parse(collector.lastSuccessAt)]
          : [])
      );
      return {
        status: overview.status,
        lastSampleAt: Number.isFinite(lastSampleMs) ? new Date(lastSampleMs).toISOString() : null
      };
    } catch {
      return { status: "unavailable", lastSampleAt: null };
    }
  }

  private tryDatabase(): Database.Database | null {
    if (this.db && this.databaseIdentity) {
      try {
        if (sameDatabase(this.databaseIdentity, databaseIdentity(this.databasePath))) return this.db;
      } catch {
        // Reopen below so a transient replacement is handled as a not-ready database.
      }
    }
    this.close();
    let candidate: Database.Database | null = null;
    try {
      const beforeOpen = databaseIdentity(this.databasePath);
      candidate = openMetricsReader(this.databasePath);
      const afterOpen = databaseIdentity(this.databasePath);
      if (!sameDatabase(beforeOpen, afterOpen)) {
        candidate.close();
        return null;
      }
      this.db = candidate;
      candidate = null;
      this.databaseIdentity = afterOpen;
      return this.db;
    } catch (error) {
      candidate?.close();
      if (isNotReadyError(error)) return null;
      throw new MonitoringUnavailableError();
    }
  }

  private invalidate(_error: unknown): never {
    this.close();
    throw new MonitoringUnavailableError();
  }

  private emptyOverview(
    status: "disabled" | "starting",
    now: Date
  ): MonitoringOverviewResponse {
    return {
      status,
      enabled: status !== "disabled",
      sampledAt: now.toISOString(),
      latest: [],
      collectors: [],
      retention: this.retention(false)
    };
  }

  private retention(writesPaused: boolean): MonitoringOverviewResponse["retention"] {
    return {
      rawMs: this.config.rawRetentionMs,
      minuteMs: this.config.minuteRetentionMs,
      hourMs: this.config.hourRetentionMs,
      maxDatabaseBytes: this.config.maxDatabaseBytes,
      databaseBytes: metricsDatabaseBytes(this.databasePath),
      writesPaused
    };
  }
}

export function readMonitoringHealth(
  databasePath: string,
  config: MonitoringConfig,
  now = new Date()
): MonitoringHealthStatus {
  const reader = new MonitoringReader(databasePath, config);
  try {
    return reader.health(now);
  } finally {
    reader.close();
  }
}

function emptyQuery(request: MonitoringQueryRequest): MonitoringQueryResponse {
  const start = new Date(request.start);
  const end = new Date(request.end);
  return {
    start: Number.isFinite(start.getTime()) ? start.toISOString() : request.start,
    end: Number.isFinite(end.getTime()) ? end.toISOString() : request.end,
    series: []
  };
}

function isNotReadyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_CANTOPEN" || code === "ENOENT" || /no such table/iu.test(message);
}

function databaseIdentity(databasePath: string): { device: number; inode: number } {
  const stat = statSync(databasePath);
  return { device: stat.dev, inode: stat.ino };
}

function sameDatabase(
  left: { device: number; inode: number },
  right: { device: number; inode: number }
): boolean {
  return left.device === right.device && left.inode === right.inode;
}
