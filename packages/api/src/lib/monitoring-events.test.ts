import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MonitoringEventBroker } from "./monitoring-events.js";

let directory: string | null = null;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

describe("MonitoringEventBroker", () => {
  it("validates producer events and fans out accepted samples", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "cyberos-monitoring-events-"));
    const socketPath = path.join(directory, "events.sock");
    const broker = new MonitoringEventBroker({ socketPath });
    await broker.start();
    expect(broker.isAvailable()).toBe(true);

    const eventPromise = new Promise<unknown>((resolve) => {
      broker.subscribe(resolve);
    });
    const producer = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      producer.once("connect", () => resolve());
      producer.once("error", reject);
    });
    producer.write(`${JSON.stringify({
      protocolVersion: 1,
      source: "monitor",
      sequence: 1,
      type: "samples",
      sampledAt: "2026-01-01T00:00:10.000Z",
      status: "ready",
      collectors: [],
      samples: [{
        metric: "cyberos_host_cpu_usage_ratio",
        labels: {},
        timestamp: "2026-01-01T00:00:10.000Z",
        value: 0.25,
        rate: null
      }]
    })}\n`);
    await expect(eventPromise).resolves.toMatchObject({ type: "samples", sequence: 1 });

    const degradedEventPromise = new Promise<unknown>((resolve) => {
      broker.subscribe(resolve);
    });
    producer.write(`${JSON.stringify({
      protocolVersion: 1,
      source: "monitor",
      sequence: 2,
      type: "samples",
      sampledAt: "2026-01-01T00:00:20.000Z",
      status: "degraded",
      collectors: [{
        collector: "host",
        state: "error",
        lastAttemptAt: "2026-01-01T00:00:20.000Z",
        lastSuccessAt: "2026-01-01T00:00:10.000Z",
        durationMs: 12,
        consecutiveFailures: 1,
        error: "Collector failed"
      }],
      samples: []
    })}\n`);
    await expect(degradedEventPromise).resolves.toMatchObject({ type: "samples", status: "degraded", sequence: 2 });

    producer.write(`${JSON.stringify({
      protocolVersion: 1,
      source: "monitor",
      sequence: 2,
      type: "samples",
      sampledAt: "2026-01-01T00:00:20.000Z",
      status: "ready",
      collectors: [],
      samples: [{ metric: "unknown_metric", labels: {}, timestamp: "2026-01-01T00:00:20.000Z", value: 1, rate: null }]
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    producer.destroy();
    await broker.close();
    expect(broker.isAvailable()).toBe(false);
  });
});
