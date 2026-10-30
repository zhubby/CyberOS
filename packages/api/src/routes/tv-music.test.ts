import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { VodPlayerRuntimeError, type MusicPlayerStatus } from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { registerTvRoutes } from "./tv.js";

function snapshot(owner: "music" | "video"): MusicPlayerStatus {
  return { owner, state: "playing", sessionId: "session", serviceInstanceId: "instance", revision: 1, queueVersion: 1, queue: [], currentItemId: null, repeat: "off", shuffle: false, positionSeconds: 10, durationSeconds: 100, volume: 50, audioDeviceId: null, effectiveAudioDeviceId: null, error: null, errorCode: null, updatedAt: "2026-10-30T00:00:00Z" };
}

describe("TV and music lifecycle", () => {
  it("stops only the observed video session using the daemon's conditional command", async () => {
    const command = vi.fn().mockResolvedValue({});
    const server = Fastify();
    registerTvRoutes(server, { musicPlayer: { getStatus: async () => snapshot("video") }, vodPlayer: { command } } as unknown as ApiRouteContext);
    const response = await server.inject({ method: "POST", url: "/api/tv/stop-video" });
    expect(response.statusCode).toBe(200);
    expect(command).toHaveBeenCalledWith({ type: "stop-video", sessionId: "session" });
    await server.close();
  });

  it("leaves music playing when TV is disabled", async () => {
    const command = vi.fn();
    const server = Fastify();
    registerTvRoutes(server, { musicPlayer: { getStatus: async () => snapshot("music") }, vodPlayer: { command } } as unknown as ApiRouteContext);
    expect((await server.inject({ method: "POST", url: "/api/tv/stop-video" })).json()).toEqual({ stopped: false });
    expect(command).not.toHaveBeenCalled();
    await server.close();
  });

  it("does not stop a music session that takes over after the video snapshot", async () => {
    const command = vi.fn().mockRejectedValue(new VodPlayerRuntimeError("Session changed", 409, "SESSION_CONFLICT"));
    const server = Fastify();
    registerTvRoutes(server, { musicPlayer: { getStatus: async () => snapshot("video") }, vodPlayer: { command } } as unknown as ApiRouteContext);
    const response = await server.inject({ method: "POST", url: "/api/tv/stop-video" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stopped: false });
    await server.close();
  });
});
