import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMusicPlayerRuntime, parseMusicPlayerStatus } from "./music-player.js";
import type { VodPlayerConfig } from "./types.js";
import { VOD_PLAYER_PROTOCOL_VERSION } from "./vod-player-protocol.js";

let directory: string | undefined;
let server: net.Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function snapshot() {
  return {
    owner: "music", state: "playing", sessionId: "session-1", serviceInstanceId: "instance-1", revision: 8,
    positionSeconds: 12, durationSeconds: 120, volume: 65, audioDeviceId: null, effectiveAudioDeviceId: null,
    error: null, errorCode: null, updatedAt: "2026-10-30T00:00:00Z",
    music: { queueVersion: 3, currentItemId: "item-1", repeat: "off", shuffle: false, positionSeconds: 10, volume: 65, audioDeviceId: null,
      queue: [{ id: "item-1", trackId: "track-1", storagePoolId: "pool-1", relativePath: "music/a.flac", title: "Song", artist: "Artist", album: "Album", durationSeconds: 120, coverKey: null }] }
  };
}

async function startServer(respond: (request: { id: string; version: number; command: unknown }) => unknown): Promise<VodPlayerConfig> {
  directory = await mkdtemp(path.join(os.tmpdir(), "cyberos-music-client-"));
  const socketPath = path.join(directory, "player.sock");
  server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let frame = "";
    socket.on("data", (chunk: string) => {
      frame += chunk;
      if (!frame.includes("\n")) return;
      const request = JSON.parse(frame.slice(0, frame.indexOf("\n"))) as { id: string; version: number; command: unknown };
      socket.end(`${JSON.stringify(respond(request))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server?.once("error", reject); server?.listen(socketPath, resolve); });
  return { enabled: false, socketPath, statePath: "/unused/session.json", commandTimeoutMs: 100, startupTimeoutMs: 100,
    checkpointIntervalMs: 5_000, retryBaseDelayMs: 2_000, retryMaxDelayMs: 60_000, videoOutput: "drm", drmConnector: null,
    audioOutput: "alsa", audioDevice: null, hwdec: "no", user: "cyberos" };
}

describe("Music player shared engine view", () => {
  it("retains the music queue position while video owns the output", () => {
    const raw = snapshot();
    raw.owner = "video";
    raw.positionSeconds = 800;
    const status = parseMusicPlayerStatus(raw);
    expect(status).toMatchObject({ owner: "video", state: "paused", positionSeconds: 10, currentItemId: "item-1", queueVersion: 3 });
    expect(parseMusicPlayerStatus({ ...raw, music: { ...raw.music, queueVersion: -1 } })).toBeNull();
  });

  it("uses the NAS engine even when TV is disabled and sends versioned queue commands", async () => {
    const config = await startServer((request) => {
      expect(request.version).toBe(VOD_PLAYER_PROTOCOL_VERSION);
      expect(request.command).toEqual({ type: "music", command: { type: "next", expectedQueueVersion: 3 } });
      return { version: VOD_PLAYER_PROTOCOL_VERSION, id: request.id, ok: true, status: snapshot() };
    });
    await expect(createMusicPlayerRuntime(config).command({ type: "next", expectedQueueVersion: 3 })).resolves.toMatchObject({ owner: "music", state: "playing", positionSeconds: 12 });
  });

  it("preserves session conflicts", async () => {
    const config = await startServer((request) => ({ version: VOD_PLAYER_PROTOCOL_VERSION, id: request.id, ok: false,
      code: "SESSION_CONFLICT", statusCode: 409, error: "The queue changed" }));
    await expect(createMusicPlayerRuntime(config).command({ type: "clear", expectedQueueVersion: 2 })).rejects.toMatchObject({ code: "SESSION_CONFLICT", statusCode: 409 });
  });

  it("rejects responses belonging to another request", async () => {
    const config = await startServer(() => ({ version: VOD_PLAYER_PROTOCOL_VERSION, id: "other-request", ok: true, status: snapshot() }));
    await expect(createMusicPlayerRuntime(config).getStatus()).rejects.toMatchObject({ code: "PROTOCOL_ERROR", statusCode: 502 });
  });
});
