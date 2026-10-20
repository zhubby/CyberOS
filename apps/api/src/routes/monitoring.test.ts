import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { MonitoringReader } from "@zos/monitoring";
import { MetricsWriter } from "@zos/monitoring/test-utils";
import { DEFAULT_MONITORING_CONFIG } from "@zos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { registerErrorHandler } from "../errors.js";
import type { ApiRouteContext } from "../context.js";
import { registerMonitoringRoutes } from "./monitoring.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("monitoring routes", () => {
  it("returns successful empty states while disabled or starting", async () => {
    const databasePath = await tempDatabase();
    const disabled = await buildRoutes(new MonitoringReader(databasePath, {
      ...DEFAULT_MONITORING_CONFIG,
      enabled: false
    }));
    expect((await disabled.inject({ method: "GET", url: "/api/monitoring/overview" })).json())
      .toMatchObject({ status: "disabled", enabled: false, latest: [] });
    expect((await disabled.inject({
      method: "POST",
      url: "/api/monitoring/query",
      payload: validQuery()
    })).json()).toMatchObject({ series: [] });
    await disabled.close();

    const starting = await buildRoutes(new MonitoringReader(databasePath, { ...DEFAULT_MONITORING_CONFIG }));
    expect((await starting.inject({ method: "GET", url: "/api/monitoring/overview" })).json())
      .toMatchObject({ status: "starting", enabled: true, latest: [] });
    await starting.close();
  });

  it("serves the fixed catalog and bounded historical queries", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, { ...DEFAULT_MONITORING_CONFIG });
    const timestampMs = Date.parse("2026-01-01T00:00:10.000Z");
    writer.writeSamples([{ metric: "zos_host_load1", value: 0.5, timestampMs }]);
    writer.recordCollectorStatus({ collector: "host", state: "ready", attemptedAtMs: timestampMs, durationMs: 2 });
    writer.close();

    const server = await buildRoutes(new MonitoringReader(databasePath, { ...DEFAULT_MONITORING_CONFIG }));
    const catalog = (await server.inject({ method: "GET", url: "/api/monitoring/catalog" })).json();
    expect(catalog.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "zos_host_load1", kind: "gauge", unit: "load" })
    ]));
    expect(catalog.series).toEqual([
      expect.objectContaining({ metric: "zos_host_load1", labels: {} })
    ]);

    const response = await server.inject({
      method: "POST",
      url: "/api/monitoring/query",
      payload: validQuery()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().series[0]).toMatchObject({
      metric: "zos_host_load1",
      transform: "value",
      points: expect.any(Array)
    });
    expect(response.json().series[0].points.length).toBeLessThanOrEqual(720);
    await server.close();
  });

  it("rejects unsafe selectors and bounds oversized requests", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, { ...DEFAULT_MONITORING_CONFIG });
    writer.writeSamples(Array.from({ length: 64 }, (_, index) => ({
      metric: "zos_queue_depth",
      labels: { queue: `queue-${index}` },
      timestampMs: Date.parse("2026-01-01T00:00:00.000Z"),
      value: index
    })));
    writer.writeSamples([{
      metric: "zos_host_load1",
      timestampMs: Date.parse("2026-01-01T00:00:00.000Z"),
      value: 1
    }]);
    writer.close();
    const server = await buildRoutes(new MonitoringReader(databasePath, { ...DEFAULT_MONITORING_CONFIG }));

    const label = await server.inject({
      method: "POST",
      url: "/api/monitoring/query",
      payload: { ...validQuery(), selectors: [{ metric: "zos_host_load1", labels: { path: "/secret" } }] }
    });
    expect(label.statusCode).toBe(400);
    expect(label.body).not.toContain("/secret");

    const nullSelector = await server.inject({
      method: "POST",
      url: "/api/monitoring/query",
      payload: { ...validQuery(), selectors: [null] }
    });
    expect(nullSelector.statusCode).toBe(400);

    const nonObjectLabels = await server.inject({
      method: "POST",
      url: "/api/monitoring/query",
      payload: { ...validQuery(), selectors: [{ metric: "zos_queue_depth", labels: 42 }] }
    });
    expect(nonObjectLabels.statusCode).toBe(400);

    const selectors = await server.inject({
      method: "POST",
      url: "/api/monitoring/query",
      payload: { ...validQuery(), selectors: Array.from({ length: 13 }, () => ({ metric: "zos_host_load1" })) }
    });
    expect(selectors.statusCode).toBe(400);

    const points = await server.inject({
      method: "POST",
      url: "/api/monitoring/query",
      payload: { ...validQuery(), maxPoints: 721 }
    });
    expect(points.statusCode).toBe(400);

    for (const start of ["0", "2026/01/01", "2026-02-30T00:00:00.000Z", "2026-01-01T00:00:00"]) {
      const timestamp = await server.inject({
        method: "POST",
        url: "/api/monitoring/query",
        payload: { ...validQuery(), start }
      });
      expect(timestamp.statusCode).toBe(400);
    }

    const budgeted = await server.inject({
      method: "POST",
      url: "/api/monitoring/query",
      payload: {
        ...validQuery(),
        selectors: [{ metric: "zos_queue_depth" }]
      }
    });
    expect(budgeted.statusCode).toBe(200);
    expect(budgeted.json().series).toHaveLength(64);
    expect(budgeted.json().series.reduce(
      (total: number, series: { stepMs: number }) => total + Math.ceil(60 * 60_000 / series.stepMs),
      0
    )).toBeLessThanOrEqual(24_000);

    const exactlyAtSeriesLimit = await server.inject({
      method: "POST",
      url: "/api/monitoring/query",
      payload: {
        ...validQuery(),
        maxPoints: 2,
        selectors: [{ metric: "zos_queue_depth" }]
      }
    });
    expect(exactlyAtSeriesLimit.statusCode).toBe(200);
    expect(exactlyAtSeriesLimit.json().series).toHaveLength(64);

    const tooManySeries = await server.inject({
      method: "POST",
      url: "/api/monitoring/query",
      payload: {
        ...validQuery(),
        maxPoints: 2,
        selectors: [{ metric: "zos_queue_depth" }, { metric: "zos_host_load1" }]
      }
    });
    expect(tooManySeries.statusCode).toBe(400);
    expect(tooManySeries.json().error).toMatch(/more than 64 series/iu);
    await server.close();
  });

  it("returns a path-free 503 when the metrics database is corrupt", async () => {
    const databasePath = await tempDatabase();
    await writeFile(databasePath, "not sqlite");
    const server = await buildRoutes(new MonitoringReader(databasePath, { ...DEFAULT_MONITORING_CONFIG }));

    const response = await server.inject({ method: "GET", url: "/api/monitoring/overview" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Monitoring data is unavailable" });
    expect(response.body).not.toContain(databasePath);
    await server.close();
  });

  it("does not expose collector paths in the overview", async () => {
    const databasePath = await tempDatabase();
    const writer = new MetricsWriter(databasePath, { ...DEFAULT_MONITORING_CONFIG });
    writer.recordCollectorStatus({
      collector: "host",
      state: "error",
      attemptedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
      durationMs: 1,
      error: "permission denied: /secret/host/path"
    });
    writer.close();
    const server = await buildRoutes(new MonitoringReader(databasePath, { ...DEFAULT_MONITORING_CONFIG }));

    const response = await server.inject({ method: "GET", url: "/api/monitoring/overview" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("/secret/host/path");
    expect(response.json().collectors[0].error).toBe("Collector permission denied");
    await server.close();
  });
});

async function buildRoutes(monitoring: MonitoringReader) {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerMonitoringRoutes(server, { monitoring } as ApiRouteContext);
  server.addHook("onClose", async () => monitoring.close());
  return server;
}

async function tempDatabase(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-monitoring-routes-"));
  return path.join(tempDir, "metrics.sqlite");
}

function validQuery() {
  return {
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-01T01:00:00.000Z",
    maxPoints: 720,
    selectors: [{ metric: "zos_host_load1" }]
  };
}
