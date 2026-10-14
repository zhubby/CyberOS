import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VodPlayerConfig } from "./types.js";
import { createVodPlayerRuntime, VodPlayerRuntimeError } from "./vod-player-client.js";
import { encodeVodPlayerBrokerMessage, type VodPlayerBrokerResponse, type VodPlayerStatus } from "./vod-player-protocol.js";

let temporaryDirectory: string | null = null;
let server: net.Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("VOD player broker client", () => {
  it("correlates a status response over the Unix socket", async () => {
    const socketPath = await startServer((request) => ({
      version: 1,
      id: request.id,
      ok: true,
      status: status()
    }));

    await expect(createVodPlayerRuntime(config(socketPath)).getStatus()).resolves.toMatchObject({
      state: "playing",
      serviceInstanceId: "instance-1",
      revision: 4
    });
  });

  it("rejects a response with the wrong request id", async () => {
    const socketPath = await startServer(() => ({
      version: 1,
      id: "different-request",
      ok: true,
      status: status()
    }));

    await expect(createVodPlayerRuntime(config(socketPath)).getStatus()).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      statusCode: 502
    });
  });

  it("classifies a missing broker and returns a disabled snapshot without connecting", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "zos-vod-client-"));
    const socketPath = path.join(temporaryDirectory, "missing.sock");
    await expect(createVodPlayerRuntime(config(socketPath)).getStatus()).rejects.toBeInstanceOf(VodPlayerRuntimeError);
    await expect(createVodPlayerRuntime(config(socketPath)).getStatus()).rejects.toMatchObject({
      code: "VOD_PLAYER_UNAVAILABLE",
      statusCode: 503
    });
    await expect(createVodPlayerRuntime({ ...config(socketPath), enabled: false }).getStatus()).resolves.toMatchObject({
      serviceInstanceId: "disabled",
      errorCode: "VOD_PLAYER_DISABLED"
    });
  });
});

async function startServer(
  respond: (request: { id: string }) => VodPlayerBrokerResponse
): Promise<string> {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "zos-vod-client-"));
  const socketPath = path.join(temporaryDirectory, "broker.sock");
  server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let frame = "";
    socket.on("data", (chunk: string) => {
      frame += chunk;
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(frame.slice(0, newline)) as { id: string };
      socket.end(encodeVodPlayerBrokerMessage(respond(request)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(socketPath, resolve);
  });
  return socketPath;
}

function config(socketPath: string): VodPlayerConfig {
  return {
    enabled: true,
    socketPath,
    statePath: "/zos/state/vod-player/session.json",
    commandTimeoutMs: 5_000,
    startupTimeoutMs: 15_000,
    checkpointIntervalMs: 5_000,
    retryBaseDelayMs: 2_000,
    retryMaxDelayMs: 60_000,
    videoOutput: "drm",
    drmConnector: null,
    audioOutput: "alsa",
    audioDevice: null,
    hwdec: "auto-safe",
    user: "zos"
  };
}

function status(): VodPlayerStatus {
  return {
    state: "playing",
    sessionId: "session-1",
    serviceInstanceId: "instance-1",
    revision: 4,
    rootId: "primary",
    storagePoolId: "/dev/md/media",
    relativePath: "movies/video.mp4",
    fileName: "video.mp4",
    positionSeconds: 12,
    durationSeconds: 120,
    volume: 80,
    retryCount: 0,
    nextRetryAt: null,
    capabilities: {
      mpvAvailable: true,
      drmAvailable: true,
      audioAvailable: true,
      hardwareDecode: "enabled",
      error: null
    },
    error: null,
    errorCode: null,
    updatedAt: "2026-10-10T00:00:00Z"
  };
}
