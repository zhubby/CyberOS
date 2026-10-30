import net from "node:net";
import { randomUUID } from "node:crypto";
import { parseMusicPlayerStatus } from "./music-player.js";
import {
  parseVodPlayerBrokerResponse,
  VOD_PLAYER_PROTOCOL_VERSION,
  type VodPlayerCommand,
} from "./vod-player-protocol.js";
import { VodPlayerRuntimeError } from "./vod-player-client.js";
import type { PlaybackRuntime, NasPlaybackStatus } from "./playback.js";
import type { VodPlayerConfig } from "./types.js";
import type { PlaybackPreferences } from "./generated/vod-player.js";

export function parsePlaybackSnapshot(raw: unknown): NasPlaybackStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const music = parseMusicPlayerStatus(raw);
  const frame = parseVodPlayerBrokerResponse(
    JSON.stringify({
      version: VOD_PLAYER_PROTOCOL_VERSION,
      id: "snapshot",
      ok: true,
      status: raw,
    }),
  );
  if (!music || !frame?.ok) return null;
  const p =
    "preferences" in raw
      ? (raw.preferences as PlaybackPreferences)
      : {
          videoVolume: 100,
          videoMuted: false,
          musicMuted: false,
          videoAudioDeviceId: null,
          audioDelays: {},
        };
  if (
    !p ||
    !Number.isFinite(p.videoVolume) ||
    p.videoVolume < 0 ||
    p.videoVolume > 100 ||
    typeof p.videoMuted !== "boolean" ||
    typeof p.musicMuted !== "boolean" ||
    !p.audioDelays ||
    typeof p.audioDelays !== "object" ||
    Array.isArray(p.audioDelays) ||
    (p.videoAudioDeviceId !== null && !bluetoothId(p.videoAudioDeviceId)) ||
    Object.entries(p.audioDelays).some(
      ([key, delay]) =>
        (key !== "tv" &&
          !(key.startsWith("tv:") && key.length <= 512) &&
          !bluetoothId(key)) ||
        typeof delay !== "number" ||
        !Number.isFinite(delay) ||
        Math.abs(delay) > 5000,
    )
  )
    return null;
  const video = frame.status;
  const active = music.owner === "music" ? music : video;
  const requested = active.audioDeviceId;
  const effective = active.effectiveAudioDeviceId;
  const audioDelayKey =
    "audioDelayKey" in raw && typeof raw.audioDelayKey === "string"
      ? raw.audioDelayKey
      : (active.audioDeviceId ?? "tv");
  return {
    audioDelayKey,
    target: "nas",
    owner: music.owner,
    sessionId: music.sessionId,
    serviceInstanceId: music.serviceInstanceId,
    revision: music.revision,
    music,
    video,
    preferences: p,
    output: {
      requested: {
        kind: requested ? "bluetooth" : "default",
        deviceId: requested,
      },
      effective: {
        kind:
          active.errorCode === "AUDIO_UNAVAILABLE"
            ? "unavailable"
            : effective
              ? "bluetooth"
              : ["playing", "paused"].includes(active.state)
                ? "default"
                : "unknown",
        deviceId: effective,
      },
    },
  };
}

export function createPlaybackRuntime(
  config: VodPlayerConfig,
): PlaybackRuntime {
  const request = (
    command: VodPlayerCommand | { type: "status" },
  ): Promise<NasPlaybackStatus> =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = net.createConnection({ path: config.socketPath });
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, status?: NasPlaybackStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else if (status) resolve(status);
      };
      const timer = setTimeout(
        () =>
          finish(
            new VodPlayerRuntimeError(
              "Playback service timed out",
              504,
              "COMMAND_TIMEOUT",
            ),
          ),
        command.type === "status" ? 5000 : 120000,
      );
      timer.unref();
      socket.setEncoding("utf8");
      socket.once("connect", () =>
        socket.write(
          `${JSON.stringify({ version: VOD_PLAYER_PROTOCOL_VERSION, id, command })}\n`,
        ),
      );
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          finish(
            new VodPlayerRuntimeError(
              "Playback response too large",
              502,
              "PROTOCOL_ERROR",
            ),
          );
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const frame = JSON.parse(buffer.slice(0, newline)) as {
            id: string;
            version: number;
            ok: boolean;
            status?: unknown;
            error?: string;
            statusCode?: number;
            code?: string;
          };
          const validated = parseVodPlayerBrokerResponse(
            buffer.slice(0, newline),
          );
          if (
            !validated ||
            validated.id !== id ||
            buffer.slice(newline + 1).trim()
          )
            throw new Error("Invalid frame");
          if (!validated.ok) {
            finish(
              new VodPlayerRuntimeError(
                validated.error,
                validated.statusCode,
                validated.code,
              ),
            );
            return;
          }
          const status = parsePlaybackSnapshot(frame.status);
          if (!status) throw new Error("Invalid snapshot");
          finish(undefined, status);
        } catch {
          finish(
            new VodPlayerRuntimeError(
              "Invalid playback response",
              502,
              "PROTOCOL_ERROR",
            ),
          );
        }
      });
      socket.once("error", () =>
        finish(new VodPlayerRuntimeError("Playback service unavailable")),
      );
      socket.once("close", () => {
        if (!settled)
          finish(new VodPlayerRuntimeError("Playback connection closed"));
      });
    });
  return { getStatus: () => request({ type: "status" }), command: request };
}

function bluetoothId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^bluetooth:(?:adapter-[a-z0-9_.:-]{1,64}\/)?(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(
      value,
    )
  );
}
