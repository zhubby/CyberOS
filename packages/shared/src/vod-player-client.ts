import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  encodeVodPlayerBrokerMessage,
  parseVodPlayerBrokerResponse,
  VOD_PLAYER_BROKER_CONNECT_TIMEOUT_MS,
  VOD_PLAYER_BROKER_MAX_FRAME_BYTES,
  VOD_PLAYER_PROTOCOL_VERSION,
  type VodPlayerCommand,
  type VodPlayerErrorCode,
  type VodPlayerStatus
} from "./vod-player-protocol.js";
import type { VodPlayerConfig } from "./types.js";

export interface VodPlayerRuntime {
  getStatus(): Promise<VodPlayerStatus>;
  command(command: VodPlayerCommand): Promise<VodPlayerStatus>;
}

export class VodPlayerRuntimeError extends Error {
  readonly expose = true;

  constructor(
    message: string,
    readonly statusCode = 503,
    readonly code: VodPlayerErrorCode = "VOD_PLAYER_UNAVAILABLE"
  ) {
    super(message);
    this.name = "VodPlayerRuntimeError";
  }
}

export function createVodPlayerRuntime(config: VodPlayerConfig): VodPlayerRuntime {
  return new UnixSocketVodPlayerRuntime(config);
}

class UnixSocketVodPlayerRuntime implements VodPlayerRuntime {
  constructor(private readonly config: VodPlayerConfig) {}

  async getStatus(): Promise<VodPlayerStatus> {
    if (!this.config.enabled) return disabledStatus();
    return this.request({ type: "status" }, VOD_PLAYER_BROKER_CONNECT_TIMEOUT_MS);
  }

  async command(command: VodPlayerCommand): Promise<VodPlayerStatus> {
    if (!this.config.enabled) {
      throw new VodPlayerRuntimeError("VOD Player is disabled", 503, "VOD_PLAYER_DISABLED");
    }
    return this.request(command, commandTimeout(this.config, command));
  }

  private request(command: VodPlayerCommand | { type: "status" }, timeoutMs: number): Promise<VodPlayerStatus> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.config.socketPath });
      let buffer = "";
      let settled = false;
      const requestTimeout = setTimeout(() => {
        finish(new VodPlayerRuntimeError("VOD Player request timed out", 504, "COMMAND_TIMEOUT"));
      }, timeoutMs);
      requestTimeout.unref?.();

      const finish = (error?: Error, status?: VodPlayerStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(requestTimeout);
        socket.destroy();
        if (error) reject(error);
        else if (status) resolve(status);
        else reject(new VodPlayerRuntimeError("VOD Player returned no status", 502, "PROTOCOL_ERROR"));
      };

      socket.setEncoding("utf8");
      socket.once("connect", () => {
        socket.write(encodeVodPlayerBrokerMessage({ version: VOD_PLAYER_PROTOCOL_VERSION, id, command }));
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > VOD_PLAYER_BROKER_MAX_FRAME_BYTES) {
          finish(new VodPlayerRuntimeError("VOD Player response is too large", 502, "PROTOCOL_ERROR"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const response = parseVodPlayerBrokerResponse(buffer.slice(0, newline));
        if (!response || response.id !== id || buffer.slice(newline + 1).trim()) {
          finish(new VodPlayerRuntimeError("Invalid response from VOD Player", 502, "PROTOCOL_ERROR"));
        } else if (!response.ok) {
          finish(new VodPlayerRuntimeError(response.error, response.statusCode, response.code));
        } else {
          finish(undefined, response.status);
        }
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        finish(socketError(error));
      });
      socket.once("close", () => {
        if (!settled) finish(new VodPlayerRuntimeError("VOD Player is unavailable"));
      });
    });
  }
}

function commandTimeout(config: VodPlayerConfig, command: VodPlayerCommand): number {
  const processStopBudgetMs = 12_000;
  const responseBudgetMs = 2_000;
  if (command.type === "play" || command.type === "retry") {
    const capabilityProbeBudgetMs = 5_000;
    const propertyObservationBudgetMs = config.commandTimeoutMs * 5;
    return Math.max(
      VOD_PLAYER_BROKER_CONNECT_TIMEOUT_MS,
      config.startupTimeoutMs + propertyObservationBudgetMs +
        processStopBudgetMs * 2 + capabilityProbeBudgetMs + responseBudgetMs
    );
  }
  return Math.max(
    VOD_PLAYER_BROKER_CONNECT_TIMEOUT_MS,
    config.commandTimeoutMs + processStopBudgetMs + responseBudgetMs
  );
}

function disabledStatus(): VodPlayerStatus {
  return {
    state: "idle",
    sessionId: null,
    serviceInstanceId: "disabled",
    revision: 0,
    rootId: null,
    storagePoolId: null,
    relativePath: null,
    fileName: null,
    positionSeconds: 0,
    durationSeconds: null,
    volume: 100,
    retryCount: 0,
    nextRetryAt: null,
    audioDeviceId: null,
    effectiveAudioDeviceId: null,
    audioFallbackReason: null,
    capabilities: {
      mpvAvailable: false,
      drmAvailable: false,
      audioAvailable: false,
      hardwareDecode: "unknown",
      error: "VOD Player is disabled"
    },
    error: "VOD Player is disabled",
    errorCode: "VOD_PLAYER_DISABLED",
    updatedAt: new Date().toISOString()
  };
}

function socketError(error: NodeJS.ErrnoException): VodPlayerRuntimeError {
  if (error.code === "EACCES" || error.code === "EPERM") {
    return new VodPlayerRuntimeError("VOD Player socket access was denied", 403, "PERMISSION_DENIED");
  }
  if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
    return new VodPlayerRuntimeError("VOD Player is unavailable");
  }
  return new VodPlayerRuntimeError(error.message || "VOD Player connection failed");
}
