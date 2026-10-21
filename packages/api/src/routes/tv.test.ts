import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VodPlayerStatus } from "@zos/shared";
import type { ApiRouteContext } from "../context.js";
import { registerTvRoutes } from "./tv.js";

let temporaryDirectory: string | null = null;

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

describe("TV status API", () => {
  it("reports a ready session while keeping missing CEC non-fatal", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "zos-tv-status-"));
    const statusDirectory = path.join(temporaryDirectory, "status");
    const enabledMarker = path.join(temporaryDirectory, "enabled");
    await mkdir(statusDirectory);
    await writeFile(enabledMarker, "enabled\n");
    const now = new Date("2026-10-21T08:00:00.000Z");
    await writeHealth(statusDirectory, "weston", "ready", "wayland-0", now);
    await writeHealth(statusDirectory, "chromium", "ready", "/tv/", now);
    await writeHealth(statusDirectory, "cec", "degraded", "No CEC adapter", now);
    const server = createServer(statusDirectory, enabledMarker, now);

    const response = await server.inject({ method: "GET", url: "/api/tv/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toEqual(expect.objectContaining({
      enabled: true,
      state: "ready",
      weston: expect.objectContaining({ state: "ready" }),
      chromium: expect.objectContaining({ state: "ready" }),
      cec: expect.objectContaining({ state: "degraded" }),
      vodPlayer: expect.objectContaining({ state: "ready" })
    }));
    await server.close();
  });

  it("marks stale required heartbeats as degraded", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "zos-tv-status-"));
    const statusDirectory = path.join(temporaryDirectory, "status");
    const enabledMarker = path.join(temporaryDirectory, "enabled");
    await mkdir(statusDirectory);
    await writeFile(enabledMarker, "enabled\n");
    const stale = new Date("2026-10-21T07:00:00.000Z");
    for (const component of ["weston", "chromium", "cec"]) {
      await writeHealth(statusDirectory, component, "ready", null, stale);
    }
    const server = createServer(statusDirectory, enabledMarker, new Date("2026-10-21T08:00:00.000Z"));
    const status = (await server.inject({ method: "GET", url: "/api/tv/status" })).json().status;
    expect(status.state).toBe("degraded");
    expect(status.weston).toEqual(expect.objectContaining({ state: "unavailable", detail: "weston heartbeat is stale" }));
    await server.close();
  });
});

function createServer(statusDirectory: string, enabledMarker: string, now: Date) {
  const server = Fastify();
  registerTvRoutes(server, {
    vodPlayer: { getStatus: async () => playerStatus(), command: async () => playerStatus() }
  } as unknown as ApiRouteContext, { statusDirectory, enabledMarker, now: () => now });
  return server;
}

async function writeHealth(
  directory: string,
  component: string,
  state: "ready" | "degraded",
  detail: string | null,
  updatedAt: Date
) {
  await writeFile(path.join(directory, `${component}.json`), JSON.stringify({ state, detail, updatedAt: updatedAt.toISOString() }));
}

function playerStatus(): VodPlayerStatus {
  return {
    state: "idle", sessionId: null, serviceInstanceId: "instance", revision: 1, rootId: null,
    storagePoolId: null, relativePath: null, fileName: null, mediaFileId: null, videoOutput: "wayland",
    positionSeconds: 0, durationSeconds: null, volume: 100, retryCount: 0, nextRetryAt: null,
    audioDeviceId: null, effectiveAudioDeviceId: null, audioFallbackReason: null, audioTracks: [], subtitleTracks: [],
    selectedAudioTrackId: null, selectedSubtitleTrackId: null,
    capabilities: { mpvAvailable: true, drmAvailable: true, audioAvailable: true, hardwareDecode: "enabled", error: null },
    error: null, errorCode: null, updatedAt: "2026-10-21T08:00:00.000Z"
  };
}
