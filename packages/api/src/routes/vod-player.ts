import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  createOperationNotification,
  getBluetoothSettings,
  getOperationNotificationByOperation,
  updateOperationNotificationForOperation
} from "@zos/db";
import { inferMimeType, inferPreviewKind } from "@zos/nas-tools";
import type { VodPlayerCommand, VodPlayerErrorCode, VodPlayerStatus } from "@zos/shared";
import type { ApiRouteContext } from "../context.js";
import { createVodPlayerRuntime, VodPlayerRuntimeError, type VodPlayerRuntime } from "../lib/vod-player.js";
import { StorageScopeError, resolveScopedExistingPath, resolveStoragePoolScope } from "../lib/storage-scope.js";

type VodPlayerCommandBody =
  | { type: "play"; rootId?: string; storagePoolId?: string; path?: string; startPositionSeconds?: number; audioDeviceId?: string }
  | { type: "pause" | "resume" | "stop" | "retry"; sessionId?: string }
  | { type: "seek"; sessionId?: string; seconds?: number }
  | { type: "set-volume"; sessionId?: string; volume?: number };

export function registerVodPlayerRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const runtime: VodPlayerRuntime = context.vodPlayer ?? createVodPlayerRuntime(context.config.vodPlayer);

  server.get("/api/vod-player/status", async (_request, reply) => {
    try {
      const status = await runtime.getStatus();
      recordAudioFallback(context, status);
      reply.send({ status });
    } catch (error) {
      sendVodPlayerError(reply, error);
    }
  });

  server.post<{ Body: VodPlayerCommandBody }>("/api/vod-player/command", async (request, reply) => {
    try {
      const command = await buildCommand(request.body, context);
      const status = await runtime.command(command);
      recordAudioFallback(context, status);
      reply.send({ status });
    } catch (error) {
      sendVodPlayerError(reply, error);
    }
  });
}

function recordAudioFallback(context: ApiRouteContext, status: VodPlayerStatus): void {
  if (!status.sessionId || !status.audioDeviceId || !status.audioFallbackReason) return;
  const operationId = `vod-audio-fallback:${status.sessionId}`;
  if (!getOperationNotificationByOperation(context.db, operationId)) {
    createOperationNotification(context.db, {
      operationId,
      kind: "media",
      status: "failed",
      summary: `Bluetooth audio fallback${status.fileName ? ` for ${status.fileName}` : ""}`
    });
  }
  updateOperationNotificationForOperation(context.db, {
    operationId,
    status: "failed",
    error: status.audioFallbackReason
  });
}

async function buildCommand(body: VodPlayerCommandBody | undefined, context: ApiRouteContext): Promise<VodPlayerCommand> {
  if (!body || typeof body.type !== "string") {
    throw new VodPlayerRuntimeError("VOD Player command is required", 400, "INVALID_COMMAND");
  }
  if (body.type === "play") {
    if (!body.rootId?.trim() || !body.storagePoolId?.trim() || typeof body.path !== "string" || !body.path) {
      throw new VodPlayerRuntimeError("A root, storage pool, and path are required", 400, "INVALID_PATH");
    }
    if (body.startPositionSeconds !== undefined && (!Number.isFinite(body.startPositionSeconds) || body.startPositionSeconds < 0)) {
      throw new VodPlayerRuntimeError("Start position must be non-negative", 400, "INVALID_COMMAND");
    }
    const configuredAudioDeviceId = getBluetoothSettings(context.db)?.defaultAudioDeviceId ?? null;
    if (body.audioDeviceId !== undefined && body.audioDeviceId !== configuredAudioDeviceId) {
      throw new VodPlayerRuntimeError("Bluetooth audio device is not selected in system settings", 400, "INVALID_COMMAND");
    }
    const audioDeviceId = body.audioDeviceId ?? configuredAudioDeviceId;
    const scope = await resolveStoragePoolScope(context.db, context.system, body.rootId, body.storagePoolId);
    const safe = await resolveScopedExistingPath(scope, body.path);
    const metadata = await stat(safe.realPath);
    if (!metadata.isFile()) throw new VodPlayerRuntimeError("Selected path is not a file", 400, "INVALID_PATH");
    if (inferPreviewKind(inferMimeType(safe.realPath)) !== "video") {
      throw new VodPlayerRuntimeError("Selected file is not video-previewable", 415, "UNSUPPORTED_MEDIA");
    }
    return {
      type: "play",
      rootId: scope.root.id,
      storagePoolId: scope.pool.id,
      relativePath: safe.relativePath,
      ...(body.startPositionSeconds === undefined ? {} : { startPositionSeconds: body.startPositionSeconds }),
      ...(audioDeviceId ? { audioDeviceId } : {})
    };
  }
  const sessionId = body.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new VodPlayerRuntimeError("A current playback session is required", 409, "SESSION_CONFLICT");
  }
  if (body.type === "pause" || body.type === "resume" || body.type === "stop" || body.type === "retry") {
    return { type: body.type, sessionId };
  }
  if (body.type === "seek") {
    if (typeof body.seconds !== "number" || !Number.isFinite(body.seconds) || body.seconds < 0) {
      throw new VodPlayerRuntimeError("Seek position must be non-negative", 400, "INVALID_COMMAND");
    }
    return { type: "seek", sessionId, seconds: body.seconds };
  }
  if (body.type !== "set-volume") {
    throw new VodPlayerRuntimeError("Unsupported VOD Player command", 400, "INVALID_COMMAND");
  }
  if (typeof body.volume !== "number" || !Number.isFinite(body.volume) || body.volume < 0 || body.volume > 100) {
    throw new VodPlayerRuntimeError("Volume must be between 0 and 100", 400, "INVALID_COMMAND");
  }
  return { type: "set-volume", sessionId, volume: body.volume };
}

function sendVodPlayerError(reply: { status(code: number): { send(payload: unknown): void } }, error: unknown): void {
  const classified = classifyVodPlayerError(error);
  const message = error instanceof Error ? error.message : "VOD Player request failed";
  reply.status(classified.statusCode).send({ error: message, code: classified.code });
}

function classifyVodPlayerError(error: unknown): { statusCode: number; code: VodPlayerErrorCode } {
  if (error instanceof VodPlayerRuntimeError) {
    return { statusCode: error.statusCode, code: error.code };
  }
  if (error instanceof StorageScopeError) {
    const unavailable = /unavailable|not mounted/iu.test(error.message);
    return {
      statusCode: unavailable ? 503 : error.statusCode,
      code: unavailable ? "STORAGE_UNAVAILABLE" : "INVALID_PATH"
    };
  }
  const fileCode = typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  if (fileCode === "EACCES" || fileCode === "EPERM") {
    return { statusCode: 403, code: "PERMISSION_DENIED" };
  }
  if (["EIO", "ENODEV", "ESTALE"].includes(fileCode ?? "")) {
    return { statusCode: 503, code: "STORAGE_UNAVAILABLE" };
  }
  if (fileCode === "ENOENT" || fileCode === "ENOTDIR") {
    return { statusCode: 404, code: "INVALID_PATH" };
  }
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : 500;
  return {
    statusCode,
    code: statusCode >= 400 && statusCode < 500 ? "INVALID_PATH" : "INTERNAL"
  };
}
