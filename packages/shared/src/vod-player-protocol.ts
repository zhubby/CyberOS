import type {
  VodPlayerCapabilities as GeneratedVodPlayerCapabilities,
  VodPlayerErrorCode as GeneratedVodPlayerErrorCode,
  VodPlayerState as GeneratedVodPlayerState,
  VodPlayerStatus as GeneratedVodPlayerStatus,
  VodPlayerWireCommand
} from "./generated/vod-player.js";

export const VOD_PLAYER_PROTOCOL_VERSION = 1 as const;
export const VOD_PLAYER_BROKER_MAX_FRAME_BYTES = 128 * 1024;
export const VOD_PLAYER_BROKER_CONNECT_TIMEOUT_MS = 5_000;

export type VodPlayerState = GeneratedVodPlayerState;
export type VodPlayerErrorCode = GeneratedVodPlayerErrorCode;
export type VodPlayerCapabilities = GeneratedVodPlayerCapabilities;
export type VodPlayerStatus = GeneratedVodPlayerStatus;

type GeneratedPlayCommand = Extract<VodPlayerWireCommand, { type: "play" }>;
export type VodPlayerCommand =
  | Exclude<VodPlayerWireCommand, { type: "status" | "play" }>
  | Omit<GeneratedPlayCommand, "startPositionSeconds" | "audioDeviceId">
    & { startPositionSeconds?: number; audioDeviceId?: string };

export type VodPlayerBrokerRequest = {
  version: typeof VOD_PLAYER_PROTOCOL_VERSION;
  id: string;
  command: VodPlayerCommand | { type: "status" };
};

export type VodPlayerBrokerResponse =
  | {
      version: typeof VOD_PLAYER_PROTOCOL_VERSION;
      id: string;
      ok: true;
      status: VodPlayerStatus;
    }
  | {
      version: typeof VOD_PLAYER_PROTOCOL_VERSION;
      id: string;
      ok: false;
      error: string;
      code: VodPlayerErrorCode;
      statusCode: number;
    };

export function encodeVodPlayerBrokerMessage(message: VodPlayerBrokerRequest | VodPlayerBrokerResponse): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseVodPlayerBrokerRequest(raw: string): VodPlayerBrokerRequest | null {
  const value = parseJsonRecord(raw);
  if (!baseEnvelope(value) || !hasOnlyKeys(value, ["version", "id", "command"]) || !isRecord(value.command)) return null;
  const command = parseCommand(value.command);
  return command ? { version: VOD_PLAYER_PROTOCOL_VERSION, id: value.id, command } : null;
}

export function parseVodPlayerBrokerResponse(raw: string): VodPlayerBrokerResponse | null {
  const value = parseJsonRecord(raw);
  if (!baseEnvelope(value) || typeof value.ok !== "boolean") return null;
  if (!value.ok) {
    if (
      !hasOnlyKeys(value, ["version", "id", "ok", "error", "code", "statusCode"]) ||
      typeof value.error !== "string" || value.error.length > 4096 ||
      !isVodPlayerErrorCode(value.code) ||
      typeof value.statusCode !== "number" || !Number.isInteger(value.statusCode) ||
      value.statusCode < 400 || value.statusCode > 599
    ) return null;
    return {
      version: VOD_PLAYER_PROTOCOL_VERSION,
      id: value.id,
      ok: false,
      error: value.error,
      code: value.code,
      statusCode: value.statusCode
    };
  }
  if (!hasOnlyKeys(value, ["version", "id", "ok", "status"])) return null;
  const status = parseStatus(value.status);
  return status ? { version: VOD_PLAYER_PROTOCOL_VERSION, id: value.id, ok: true, status } : null;
}

function parseCommand(value: Record<string, unknown>): VodPlayerBrokerRequest["command"] | null {
  if (value.type === "status") return hasOnlyKeys(value, ["type"]) ? { type: "status" } : null;
  if (value.type === "play") {
    if (
      !hasOnlyKeys(value, ["type", "rootId", "storagePoolId", "relativePath", "startPositionSeconds", "audioDeviceId"]) ||
      !safeIdentifier(value.rootId) || !safeIdentifier(value.storagePoolId) ||
      typeof value.relativePath !== "string" || !safeRelativePath(value.relativePath) ||
      (value.audioDeviceId !== undefined && value.audioDeviceId !== null && !isBluetoothAudioDeviceId(value.audioDeviceId))
    ) return null;
    const startPositionSeconds = optionalNonNegative(value.startPositionSeconds);
    if (value.startPositionSeconds !== undefined && value.startPositionSeconds !== null && startPositionSeconds === null) return null;
    return {
      type: "play",
      rootId: value.rootId,
      storagePoolId: value.storagePoolId,
      relativePath: value.relativePath,
      ...(startPositionSeconds === null ? {} : { startPositionSeconds }),
      ...(typeof value.audioDeviceId === "string" ? { audioDeviceId: value.audioDeviceId } : {})
    };
  }
  if (!safeIdentifier(value.sessionId)) return null;
  if (value.type === "pause" || value.type === "resume" || value.type === "stop" || value.type === "retry") {
    return hasOnlyKeys(value, ["type", "sessionId"])
      ? { type: value.type, sessionId: value.sessionId }
      : null;
  }
  if (value.type === "seek") {
    if (!hasOnlyKeys(value, ["type", "sessionId", "seconds"])) return null;
    const seconds = nonNegative(value.seconds);
    return seconds === null ? null : { type: "seek", sessionId: value.sessionId, seconds };
  }
  if (value.type === "set-volume") {
    if (!hasOnlyKeys(value, ["type", "sessionId", "volume"])) return null;
    const volume = finiteNumber(value.volume);
    return volume === null || volume < 0 || volume > 100
      ? null
      : { type: "set-volume", sessionId: value.sessionId, volume };
  }
  return null;
}

function parseStatus(value: unknown): VodPlayerStatus | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "state", "sessionId", "serviceInstanceId", "revision", "rootId", "storagePoolId",
      "relativePath", "fileName", "positionSeconds", "durationSeconds", "volume", "retryCount",
      "nextRetryAt", "audioDeviceId", "effectiveAudioDeviceId", "audioFallbackReason",
      "capabilities", "error", "errorCode", "updatedAt"
    ]) ||
    !isVodPlayerState(value.state)
  ) return null;
  const positionSeconds = nonNegative(value.positionSeconds);
  const durationSeconds = value.durationSeconds === null ? null : nonNegative(value.durationSeconds);
  const volume = finiteNumber(value.volume);
  const revision = nonNegativeInteger(value.revision);
  const retryCount = nonNegativeInteger(value.retryCount);
  const capabilities = parseCapabilities(value.capabilities);
  if (
    (typeof value.sessionId !== "string" && value.sessionId !== null) ||
    typeof value.serviceInstanceId !== "string" || !value.serviceInstanceId ||
    revision === null || retryCount === null ||
    (typeof value.rootId !== "string" && value.rootId !== null) ||
    (typeof value.storagePoolId !== "string" && value.storagePoolId !== null) ||
    (typeof value.relativePath !== "string" && value.relativePath !== null) ||
    (typeof value.fileName !== "string" && value.fileName !== null) ||
    positionSeconds === null || (value.durationSeconds !== null && durationSeconds === null) ||
    volume === null || volume < 0 || volume > 100 ||
    (typeof value.nextRetryAt !== "string" && value.nextRetryAt !== null) ||
    (value.audioDeviceId !== null && !isBluetoothAudioDeviceId(value.audioDeviceId)) ||
    (value.effectiveAudioDeviceId !== null && !isBluetoothAudioDeviceId(value.effectiveAudioDeviceId)) ||
    !isNullableString(value.audioFallbackReason) ||
    !capabilities || (typeof value.error !== "string" && value.error !== null) ||
    (value.errorCode !== null && !isVodPlayerErrorCode(value.errorCode)) ||
    typeof value.updatedAt !== "string"
  ) return null;
  return {
    state: value.state,
    sessionId: value.sessionId,
    serviceInstanceId: value.serviceInstanceId,
    revision,
    rootId: value.rootId,
    storagePoolId: value.storagePoolId,
    relativePath: value.relativePath,
    fileName: value.fileName,
    positionSeconds,
    durationSeconds,
    volume,
    retryCount,
    nextRetryAt: value.nextRetryAt,
    audioDeviceId: value.audioDeviceId,
    effectiveAudioDeviceId: value.effectiveAudioDeviceId,
    audioFallbackReason: value.audioFallbackReason,
    capabilities,
    error: value.error,
    errorCode: value.errorCode,
    updatedAt: value.updatedAt
  };
}

function parseCapabilities(value: unknown): VodPlayerCapabilities | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["mpvAvailable", "drmAvailable", "audioAvailable", "hardwareDecode", "error"])) return null;
  const hardwareDecode = value.hardwareDecode;
  if (
    typeof value.mpvAvailable !== "boolean" || typeof value.drmAvailable !== "boolean" ||
    typeof value.audioAvailable !== "boolean" ||
    !["enabled", "software", "unknown"].includes(String(hardwareDecode)) ||
    (typeof value.error !== "string" && value.error !== null)
  ) return null;
  return {
    mpvAvailable: value.mpvAvailable,
    drmAvailable: value.drmAvailable,
    audioAvailable: value.audioAvailable,
    hardwareDecode: hardwareDecode as VodPlayerCapabilities["hardwareDecode"],
    error: value.error
  };
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  if (Buffer.byteLength(raw, "utf8") > VOD_PLAYER_BROKER_MAX_FRAME_BYTES) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function baseEnvelope(value: Record<string, unknown> | null): value is Record<string, unknown> & { id: string } {
  return Boolean(value && value.version === VOD_PLAYER_PROTOCOL_VERSION && safeRequestId(value.id));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
}

function safeRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("\0");
}

function safeRelativePath(value: string): boolean {
  return !value.startsWith("/") && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function isBluetoothAudioDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^bluetooth:(?:adapter-[a-z0-9_.:-]{1,64}\/)?(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = nonNegative(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function optionalNonNegative(value: unknown): number | null {
  return value === undefined ? null : nonNegative(value);
}

function isVodPlayerState(value: unknown): value is VodPlayerState {
  return typeof value === "string" && ["idle", "starting", "playing", "paused", "recovering", "stopped", "error"].includes(value);
}

function isVodPlayerErrorCode(value: unknown): value is VodPlayerErrorCode {
  return typeof value === "string" && [
    "VOD_PLAYER_DISABLED", "VOD_PLAYER_UNAVAILABLE", "MPV_UNAVAILABLE", "DRM_UNAVAILABLE",
    "AUDIO_UNAVAILABLE", "PERMISSION_DENIED", "STORAGE_UNAVAILABLE", "SOURCE_CHANGED",
    "UNSUPPORTED_MEDIA", "PLAYBACK_FAILED", "COMMAND_TIMEOUT", "SESSION_CONFLICT",
    "INVALID_COMMAND", "INVALID_PATH", "PROTOCOL_ERROR", "INTERNAL"
  ].includes(value);
}
