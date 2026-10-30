import { randomUUID } from "node:crypto";
import net from "node:net";
import type { VodPlayerConfig } from "./types.js";
import { VOD_PLAYER_PROTOCOL_VERSION, type VodPlayerErrorCode, type VodPlayerState } from "./vod-player-protocol.js";
import { VodPlayerRuntimeError } from "./vod-player-client.js";

export type MusicRepeatMode = "off" | "one" | "all";

export interface MusicQueueEntry {
  id: string;
  trackId: string;
  storagePoolId: string;
  relativePath: string;
  title: string;
  artist: string;
  album: string | null;
  durationSeconds: number | null;
  coverKey: string | null;
}

export interface MusicPlayerStatus {
  owner: "music" | "video" | null;
  state: VodPlayerState;
  sessionId: string | null;
  serviceInstanceId: string;
  revision: number;
  queueVersion: number;
  queue: MusicQueueEntry[];
  currentItemId: string | null;
  repeat: MusicRepeatMode;
  shuffle: boolean;
  positionSeconds: number;
  durationSeconds: number | null;
  volume: number;
  audioDeviceId: string | null;
  effectiveAudioDeviceId: string | null;
  error: string | null;
  errorCode: VodPlayerErrorCode | null;
  updatedAt: string;
}

type Versioned = { expectedQueueVersion: number };
type Takeover = { expectedSessionId?: string };
export type MusicPlayerCommand = Versioned & (
  | ({ type: "replace"; entries: MusicQueueEntry[] } & Takeover)
  | { type: "append" | "insert-next"; entries: MusicQueueEntry[] }
  | { type: "remove"; itemId: string }
  | ({ type: "jump"; itemId: string } & Takeover)
  | { type: "reorder"; itemIds: string[] }
  | { type: "clear" | "next" | "previous" | "pause" }
  | ({ type: "resume" } & Takeover)
  | { type: "seek"; seconds: number }
  | { type: "volume"; volume: number }
  | { type: "mode"; repeat: MusicRepeatMode; shuffle: boolean }
  | { type: "output"; audioDeviceId: string | null }
);

type PublicMusicRequest<T> = T extends { entries: MusicQueueEntry[] }
  ? Omit<T, "entries"> & { trackIds: string[] }
  : T;
export type MusicPlayerRequest = PublicMusicRequest<MusicPlayerCommand>;

export interface MusicPlayerRuntime {
  getStatus(): Promise<MusicPlayerStatus>;
  command(command: MusicPlayerCommand): Promise<MusicPlayerStatus>;
}

export function createMusicPlayerRuntime(config: VodPlayerConfig): MusicPlayerRuntime {
  const request = (command: { type: "status" } | { type: "music"; command: MusicPlayerCommand }): Promise<MusicPlayerStatus> => {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: config.socketPath });
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => finish(new VodPlayerRuntimeError("Music player request timed out", 504, "COMMAND_TIMEOUT")),
        command.type === "status" ? 5_000 : config.startupTimeoutMs + config.commandTimeoutMs * 8 + 30_000);
      timer.unref?.();
      function finish(error?: Error, status?: MusicPlayerStatus): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else if (status) resolve(status);
      }
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        const frame = JSON.stringify({ version: VOD_PLAYER_PROTOCOL_VERSION, id, command });
        if (Buffer.byteLength(frame) > 1024 * 1024) {
          finish(new VodPlayerRuntimeError("Music queue request is too large", 413, "INVALID_COMMAND"));
          return;
        }
        socket.write(`${frame}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          finish(new VodPlayerRuntimeError("Music player response is too large", 502, "PROTOCOL_ERROR"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response: unknown = JSON.parse(buffer.slice(0, newline));
          if (!record(response) || response.version !== VOD_PLAYER_PROTOCOL_VERSION || response.id !== id || buffer.slice(newline + 1).trim()) throw new Error("Invalid frame");
          if (response.ok === false) {
            finish(new VodPlayerRuntimeError(typeof response.error === "string" ? response.error : "Music player command failed",
              typeof response.statusCode === "number" ? response.statusCode : 503,
              typeof response.code === "string" ? response.code as VodPlayerErrorCode : "INTERNAL"));
            return;
          }
          const status = parseMusicPlayerStatus(response.status);
          if (response.ok !== true || !status) throw new Error("Invalid status");
          finish(undefined, status);
        } catch {
          finish(new VodPlayerRuntimeError("Invalid response from music player", 502, "PROTOCOL_ERROR"));
        }
      });
      socket.once("error", (error: NodeJS.ErrnoException) => finish(new VodPlayerRuntimeError(
        error.code === "EACCES" ? "Music player access denied" : "Music player is unavailable",
        error.code === "EACCES" ? 403 : 503, error.code === "EACCES" ? "PERMISSION_DENIED" : "VOD_PLAYER_UNAVAILABLE")));
      socket.once("close", () => {
        if (!settled) finish(new VodPlayerRuntimeError("Music player is unavailable"));
      });
    });
  };
  return {
    getStatus: () => request({ type: "status" }),
    command: (command) => request({ type: "music", command })
  };
}

/** Convert the shared engine snapshot into the music view without exposing video details. */
export function parseMusicPlayerStatus(value: unknown): MusicPlayerStatus | null {
  if (!record(value) || !record(value.music)) return null;
  const music = value.music;
  if ((value.owner !== null && value.owner !== "music" && value.owner !== "video") ||
    !Array.isArray(music.queue) || !music.queue.every(isEntry) ||
    !integer(music.queueVersion) || !integer(value.revision) ||
    !nullableString(music.currentItemId) || !["off", "one", "all"].includes(String(music.repeat)) || typeof music.shuffle !== "boolean" ||
    typeof value.serviceInstanceId !== "string" || !nullableString(value.sessionId) ||
    !["idle", "starting", "playing", "paused", "recovering", "stopped", "error"].includes(String(value.state)) ||
    !number(music.positionSeconds) || !number(music.volume) ||
    !nullableString(music.audioDeviceId) || !nullableString(value.effectiveAudioDeviceId) ||
    !nullableString(value.error) || !nullableString(value.errorCode) || typeof value.updatedAt !== "string") return null;
  const active = value.owner === "music";
  const current = music.queue.find((entry) => entry.id === music.currentItemId);
  return {
    owner: value.owner,
    state: active ? value.state as VodPlayerState : music.queue.length ? "paused" : "idle",
    sessionId: value.sessionId,
    serviceInstanceId: value.serviceInstanceId,
    revision: value.revision,
    queueVersion: music.queueVersion,
    queue: music.queue,
    currentItemId: music.currentItemId,
    repeat: music.repeat as MusicRepeatMode,
    shuffle: music.shuffle,
    positionSeconds: active && number(value.positionSeconds) ? value.positionSeconds : music.positionSeconds,
    durationSeconds: active && number(value.durationSeconds) ? value.durationSeconds : current?.durationSeconds ?? null,
    volume: active && number(value.volume) ? value.volume : music.volume,
    audioDeviceId: music.audioDeviceId,
    effectiveAudioDeviceId: active ? value.effectiveAudioDeviceId : null,
    error: active ? value.error : null,
    errorCode: active ? value.errorCode as VodPlayerErrorCode | null : null,
    updatedAt: value.updatedAt
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nullableString(value: unknown): value is string | null { return value === null || typeof value === "string"; }
function number(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function integer(value: unknown): value is number { return number(value) && Number.isSafeInteger(value); }
function isEntry(value: unknown): value is MusicQueueEntry {
  return record(value) && typeof value.id === "string" && typeof value.trackId === "string" &&
    typeof value.storagePoolId === "string" && typeof value.relativePath === "string" &&
    typeof value.title === "string" && typeof value.artist === "string" && nullableString(value.album) &&
    nullableString(value.coverKey) && (value.durationSeconds === null || number(value.durationSeconds));
}
