import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  encodeVodPlayerBrokerMessage,
  parseVodPlayerBrokerRequest,
  parseVodPlayerBrokerResponse,
  type VodPlayerStatus,
  VOD_PLAYER_PROTOCOL_VERSION
} from "./vod-player-protocol.js";

const status: VodPlayerStatus = {
  state: "playing",
  sessionId: "session-1",
  serviceInstanceId: "instance-1",
  revision: 7,
  rootId: "primary",
  storagePoolId: "/dev/md/media",
  relativePath: "movies/clip.mp4",
  fileName: "clip.mp4",
  mediaFileId: "file-1",
  videoOutput: "wayland",
  positionSeconds: 12.5,
  durationSeconds: 90,
  volume: 80,
  retryCount: 0,
  nextRetryAt: null,
  audioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF",
  effectiveAudioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF",
  audioFallbackReason: null,
  audioTracks: [{ id: 1, language: "eng", title: "Stereo", default: true, forced: false, external: false }],
  subtitleTracks: [{ id: 2, language: "zho", title: "中文", default: false, forced: false, external: true }],
  selectedAudioTrackId: 1,
  selectedSubtitleTrackId: 2,
  capabilities: {
    mpvAvailable: true,
    drmAvailable: true,
    audioAvailable: true,
    hardwareDecode: "enabled",
    error: null
  },
  error: null,
  errorCode: null,
  updatedAt: new Date().toISOString()
};

describe("VOD player broker protocol", () => {
  it("round-trips a versioned play request and status response", () => {
    const request = parseVodPlayerBrokerRequest(
      encodeVodPlayerBrokerMessage({
        version: VOD_PLAYER_PROTOCOL_VERSION,
        id: "request-1",
        command: {
          type: "play",
          rootId: "primary",
          storagePoolId: "/dev/md/media",
          relativePath: "movies/clip.mp4",
          startPositionSeconds: 4,
          audioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF",
          mediaFileId: "file-1"
        }
      }).trim()
    );
    expect(request?.command).toEqual({
      type: "play",
      rootId: "primary",
      storagePoolId: "/dev/md/media",
      relativePath: "movies/clip.mp4",
      startPositionSeconds: 4,
      audioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF",
      mediaFileId: "file-1"
    });
    expect(parseVodPlayerBrokerRequest(JSON.stringify({
      version: 2,
      id: "request-2",
      command: {
        type: "play",
        rootId: "primary",
        storagePoolId: "/dev/md/media",
        relativePath: "movies/clip.mp4",
        audioDeviceId: "bluetooth:adapter-hci1/AA:BB:CC:DD:EE:FF"
      }
    }))?.command).toMatchObject({ audioDeviceId: "bluetooth:adapter-hci1/AA:BB:CC:DD:EE:FF" });

    expect(parseVodPlayerBrokerResponse(encodeVodPlayerBrokerMessage({
      version: VOD_PLAYER_PROTOCOL_VERSION,
      id: "request-1",
      ok: true,
      status
    }).trim())).toMatchObject({ id: "request-1", ok: true, status });
  });

  it("requires the protocol version, safe paths, session ids, and bounded values", () => {
    expect(parseVodPlayerBrokerRequest(JSON.stringify({ id: "request-1", command: { type: "status" } }))).toBeNull();
    expect(parseVodPlayerBrokerRequest(JSON.stringify({
      version: 2,
      id: "request-1",
      command: { type: "play", rootId: "primary", storagePoolId: "pool", relativePath: "../video.mp4" }
    }))).toBeNull();
    expect(parseVodPlayerBrokerRequest(JSON.stringify({
      version: 2,
      id: "request-1",
      command: { type: "play", rootId: "primary", storagePoolId: "pool", relativePath: "video.mp4", audioDeviceId: "alsa/arbitrary" }
    }))).toBeNull();
    expect(parseVodPlayerBrokerRequest(JSON.stringify({
      version: 2,
      id: "request-1",
      command: { type: "pause" }
    }))).toBeNull();
    expect(parseVodPlayerBrokerRequest(JSON.stringify({
      version: 2,
      id: "request-1",
      command: { type: "set-volume", sessionId: "session-1", volume: 101 }
    }))).toBeNull();
    expect(parseVodPlayerBrokerRequest("x".repeat(128 * 1024 + 1))).toBeNull();
    expect(parseVodPlayerBrokerRequest(JSON.stringify({
      version: 2,
      id: "request-1",
      command: { type: "status", extra: true }
    }))).toBeNull();
    expect(parseVodPlayerBrokerRequest(JSON.stringify({
      version: 2,
      id: "x".repeat(129),
      command: { type: "status" }
    }))).toBeNull();
  });

  it("round-trips stable errors", () => {
    expect(parseVodPlayerBrokerResponse(JSON.stringify({
      version: 2,
      id: "request-1",
      ok: false,
      error: "The session changed",
      code: "SESSION_CONFLICT",
      statusCode: 409
    }))).toEqual({
      version: 2,
      id: "request-1",
      ok: false,
      error: "The session changed",
      code: "SESSION_CONFLICT",
      statusCode: 409
    });
    expect(parseVodPlayerBrokerResponse(JSON.stringify({
      version: 2,
      id: "request-1",
      ok: true,
      status: { ...status, extra: true }
    }))).toBeNull();
  });

  it("keeps the checked-in golden frames valid", async () => {
    const fixtures = JSON.parse(await readFile(new URL("../fixtures/vod-player-protocol-v2.json", import.meta.url), "utf8")) as {
      requests: string[];
      responses: string[];
    };
    expect(fixtures.requests.map(parseVodPlayerBrokerRequest).every(Boolean)).toBe(true);
    expect(fixtures.responses.map(parseVodPlayerBrokerResponse).every(Boolean)).toBe(true);
  });
});
