import { describe, expect, it } from "vitest";
import type { VodPlayerStatus } from "../api.js";
import { acceptVodPlayerStatus } from "./vod-player-status.js";

function status(overrides: Partial<VodPlayerStatus> = {}): VodPlayerStatus {
  return {
    state: "playing",
    sessionId: "session-1",
    serviceInstanceId: "instance-1",
    revision: 4,
    rootId: "local",
    storagePoolId: "pool",
    relativePath: "movies/clip.mp4",
    fileName: "clip.mp4",
    positionSeconds: 30,
    durationSeconds: 120,
    volume: 75,
    retryCount: 0,
    nextRetryAt: null,
    audioDeviceId: null,
    effectiveAudioDeviceId: null,
    audioFallbackReason: null,
    capabilities: {
      mpvAvailable: true,
      drmAvailable: true,
      audioAvailable: true,
      hardwareDecode: "enabled",
      error: null
    },
    error: null,
    errorCode: null,
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...overrides
  };
}

describe("VOD player status ordering", () => {
  it("rejects lower revisions from the same service instance", () => {
    const current = status({ revision: 5 });
    expect(acceptVodPlayerStatus(current, status({ revision: 4 }))).toBe(current);
  });

  it("rejects an old instance response after a daemon restart", () => {
    const restarted = status({
      serviceInstanceId: "instance-2",
      revision: 1,
      updatedAt: "2026-09-15T00:00:10.000Z"
    });
    const stale = status({
      serviceInstanceId: "instance-1",
      revision: 99,
      updatedAt: "2026-09-15T00:00:09.000Z"
    });
    expect(acceptVodPlayerStatus(restarted, stale)).toBe(restarted);
  });

  it("replaces a synthetic client error with the next daemon snapshot", () => {
    const clientError = status({
      serviceInstanceId: "client-error",
      revision: 0,
      updatedAt: "2026-09-15T00:00:10.000Z"
    });
    const daemon = status({ updatedAt: "2026-09-15T00:00:09.000Z" });
    expect(acceptVodPlayerStatus(clientError, daemon)).toBe(daemon);
  });
});
