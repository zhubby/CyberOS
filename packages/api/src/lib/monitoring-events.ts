import { chmod, mkdir, lstat, unlink } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import type { MonitoringStatusStreamEvent, MonitoringStreamEvent } from "@cyberos/shared";
import { getMetricDefinition } from "@cyberos/monitoring";

const MAX_EVENT_BYTES = 256 * 1024;

type EventSubscriber = (event: MonitoringStreamEvent) => void;

export interface MonitoringEventBrokerOptions {
  socketPath: string;
  log?: {
    warn: (data: unknown, message?: string) => void;
  };
}

/**
 * Local event broker between the Rust daemons and browser-facing SSE clients.
 * Events are deliberately transient; SQLite remains the source of truth.
 */
export class MonitoringEventBroker {
  private readonly socketPath: string;
  private readonly log: MonitoringEventBrokerOptions["log"];
  private readonly subscribers = new Set<EventSubscriber>();
  private readonly producers = new Set<Socket>();
  private readonly lastSeen = new Map<"monitor" | "alerter", number>();
  private readonly staleSources = new Set<"monitor" | "alerter">();
  private readonly sequences = new Map<"monitor" | "alerter", number>();
  private server: Server | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: MonitoringEventBrokerOptions) {
    this.socketPath = options.socketPath;
    this.log = options.log;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    let server: Server | null = null;
    try {
      await mkdir(path.dirname(this.socketPath), { recursive: true });
      await removeStaleSocket(this.socketPath);
      const candidate = net.createServer((socket) => this.acceptProducer(socket));
      server = candidate;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          candidate.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          candidate.off("error", onError);
          resolve();
        };
        candidate.once("error", onError);
        candidate.once("listening", onListening);
        candidate.listen(this.socketPath);
      });
      await chmod(this.socketPath, 0o660);
      this.server = candidate;
      candidate.on("error", (error) => {
        this.log?.warn({ err: error, socketPath: this.socketPath }, "Monitoring event broker socket error");
      });
      this.statusTimer = setInterval(() => this.publishStaleStatuses(), 15_000);
      this.statusTimer.unref();
    } catch (error) {
      const failedServer = server;
      if (failedServer?.listening) {
        await new Promise<void>((resolve) => failedServer.close(() => resolve()));
      }
      await removeStaleSocket(this.socketPath).catch(() => undefined);
      this.started = false;
      this.log?.warn({ err: error, socketPath: this.socketPath }, "Monitoring event broker unavailable");
    }
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  isAvailable(): boolean {
    return this.server !== null;
  }

  async close(): Promise<void> {
    for (const producer of this.producers) producer.destroy();
    this.producers.clear();
    const server = this.server;
    this.server = null;
    this.started = false;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeStaleSocket(this.socketPath).catch(() => undefined);
    }
    this.subscribers.clear();
  }

  private acceptProducer(socket: Socket): void {
    this.producers.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_BYTES * 2) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.acceptEvent(line);
        newline = buffer.indexOf("\n");
      }
    });
    const cleanup = () => this.producers.delete(socket);
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  private acceptEvent(line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) return;
    try {
      const candidate: unknown = JSON.parse(line);
      if (!isMonitoringStreamEvent(candidate)) return;
      this.lastSeen.set(candidate.source, Date.now());
      this.sequences.set(candidate.source, candidate.sequence);
      this.staleSources.delete(candidate.source);
      for (const subscriber of this.subscribers) subscriber(candidate);
    } catch {
      // Producers are untrusted process boundaries; malformed events are dropped.
    }
  }

  private publishStaleStatuses(): void {
    const now = Date.now();
    for (const source of ["monitor", "alerter"] as const) {
      const seenAt = this.lastSeen.get(source);
      if (seenAt === undefined || now - seenAt <= 30_000 || this.staleSources.has(source)) continue;
      this.staleSources.add(source);
      const status: MonitoringStatusStreamEvent = {
        protocolVersion: 1,
        source,
        sequence: (this.sequences.get(source) ?? 0) + 1,
        type: "status",
        status: "unavailable",
        detail: `${source} event producer is stale`,
        updatedAt: new Date(now).toISOString()
      };
      this.sequences.set(source, status.sequence);
      for (const subscriber of this.subscribers) subscriber(status);
    }
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket()) throw new Error(`Monitoring event path is not a socket: ${socketPath}`);
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isMonitoringStreamEvent(value: unknown): value is MonitoringStreamEvent {
  if (!isRecord(value) || value.protocolVersion !== 1 || !isFinitePositive(value.sequence)) return false;
  if (value.source !== "monitor" && value.source !== "alerter") return false;
  if (value.type === "samples") return validateSamplesEvent(value);
  if (value.type === "alert_summary") return validateAlertEvent(value);
  return value.type === "status"
    && typeof value.updatedAt === "string"
    && ["disabled", "starting", "ready", "degraded", "unavailable"].includes(String(value.status));
}

function validateSamplesEvent(value: Record<string, unknown>): boolean {
  if (value.source !== "monitor" || typeof value.sampledAt !== "string" || !Array.isArray(value.samples)) return false;
  if (!Array.isArray(value.collectors) || !isMonitoringState(value.status)) return false;
  if (!value.collectors.every(validateCollector)) return false;
  return value.samples.every((sample) => {
    if (!isRecord(sample) || typeof sample.metric !== "string" || !getMetricDefinition(sample.metric)) return false;
    if (!isRecord(sample.labels) || typeof sample.timestamp !== "string" || !isFiniteNumber(sample.value)) return false;
    const definition = getMetricDefinition(sample.metric)!;
    const labels = sample.labels;
    const keys = Object.keys(labels);
    return keys.length === definition.labelKeys.length
      && keys.every((key) => definition.labelKeys.includes(key))
      && keys.every((key) => typeof labels[key] === "string" && labels[key].length > 0 && labels[key].length <= 128)
      && (sample.rate === null || isFiniteNumber(sample.rate));
  });
}

function validateAlertEvent(value: Record<string, unknown>): boolean {
  if (value.source !== "alerter" || typeof value.updatedAt !== "string" || !isRecord(value.summary)) return false;
  const summary = value.summary;
  return Number.isInteger(summary.unreadCount) && Number(summary.unreadCount) >= 0
    && Number.isInteger(summary.firingCount) && Number(summary.firingCount) >= 0
    && ["starting", "ready", "degraded", "unavailable"].includes(String(summary.alerterStatus))
    && (summary.lastEvaluationAt === null || typeof summary.lastEvaluationAt === "string")
    && Number.isInteger(summary.pendingDeliveries) && Number(summary.pendingDeliveries) >= 0;
}

function validateCollector(value: unknown): boolean {
  if (!isRecord(value) || typeof value.collector !== "string" || value.collector.length === 0 || value.collector.length > 64) return false;
  return isCollectorState(value.state)
    && typeof value.lastAttemptAt === "string"
    && (value.lastSuccessAt === null || typeof value.lastSuccessAt === "string")
    && isFiniteNumber(value.durationMs) && value.durationMs >= 0
    && Number.isInteger(value.consecutiveFailures) && Number(value.consecutiveFailures) >= 0
    && (value.error === null || typeof value.error === "string");
}

function isCollectorState(value: unknown): value is "ready" | "error" | "unsupported" | "disabled" {
  return ["ready", "error", "unsupported", "disabled"].includes(String(value));
}

function isMonitoringState(value: unknown): value is "disabled" | "starting" | "ready" | "degraded" | "unavailable" {
  return ["disabled", "starting", "ready", "degraded", "unavailable"].includes(String(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
