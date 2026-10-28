import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  parseHostdResult,
  type HostdOperation,
  type HostdRequest,
  type HostdResult
} from "@cyberos/shared";

const HOSTD_PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;

interface HostdSuccessResponse {
  version: number;
  id: string;
  ok: true;
  result: unknown;
}

interface HostdErrorResponse {
  version: number;
  id: string;
  ok: false;
  error: {
    status: number;
    code: string;
    message: string;
    [key: string]: unknown;
  };
}

type HostdResponse = HostdSuccessResponse | HostdErrorResponse;

export class HostdRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
    readonly socketCode: string | null = null
  ) {
    super(message);
    this.name = "HostdRequestError";
  }
}

export class HostdClient {
  constructor(private readonly socketPath: string) {}

  request<Operation extends HostdOperation, Request extends HostdRequest<Operation>>(
    operation: Operation,
    payload: Request,
    timeoutMs: number
  ): Promise<HostdResult<Operation, Request>> {
    const id = randomUUID();
    const frame = `${JSON.stringify({
      version: HOSTD_PROTOCOL_VERSION,
      id,
      operation,
      payload
    })}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      return Promise.reject(new HostdRequestError("hostd request is too large", 413, "protocol_error"));
    }

    return new Promise<HostdResult<Operation, Request>>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error instanceof HostdRequestError) {
          reject(error);
          return;
        }
        const socketCode = nodeErrorCode(error);
        reject(new HostdRequestError("hostd is unavailable", 503, "unavailable", {}, socketCode));
      };

      socket.setTimeout(timeoutMs, () => {
        fail(new HostdRequestError("hostd request timed out", 504, "timeout"));
      });
      socket.on("error", fail);
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_FRAME_BYTES + 1) {
          fail(new HostdRequestError("hostd response is too large", 502, "output_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      socket.on("end", () => {
        if (settled) return;
        try {
          const response = parseResponse(Buffer.concat(chunks), id);
          if (!response.ok) {
            const { status, code, message, ...details } = response.error;
            settled = true;
            reject(new HostdRequestError(message, status, code, details));
            return;
          }
          const result = parseHostdResult(operation, payload, response.result);
          if (result === null) {
            throw new HostdRequestError("Invalid response from hostd", 502, "protocol_error");
          }
          settled = true;
          resolve(result);
        } catch (error) {
          fail(error);
        }
      });
      socket.end(frame);
    });
  }
}

function parseResponse(buffer: Buffer, requestId: string): HostdResponse {
  if (!buffer.length || !buffer.toString("utf8").endsWith("\n")) {
    throw new HostdRequestError("Invalid response from hostd", 502, "protocol_error");
  }
  const raw = buffer.toString("utf8").replace(/\r?\n$/u, "");
  if (!raw || raw.includes("\n")) {
    throw new HostdRequestError("Invalid response from hostd", 502, "protocol_error");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new HostdRequestError("Invalid response from hostd", 502, "protocol_error");
  }
  if (!isRecord(value) || value.version !== HOSTD_PROTOCOL_VERSION || value.id !== requestId) {
    throw new HostdRequestError("Invalid response from hostd", 502, "protocol_error");
  }
  if (value.ok === true && "result" in value) {
    return value as unknown as HostdSuccessResponse;
  }
  if (
    value.ok === false &&
    isRecord(value.error) &&
    typeof value.error.status === "number" &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  ) {
    return value as unknown as HostdErrorResponse;
  }
  throw new HostdRequestError("Invalid response from hostd", 502, "protocol_error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}
