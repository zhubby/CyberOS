import type {
  TerminalClosePayload as GeneratedTerminalClosePayload,
  TerminalCommandContract,
  TerminalDestroyPayload as GeneratedTerminalDestroyPayload,
  TerminalErrorCode as GeneratedTerminalErrorCode,
  TerminalEventContract,
  TerminalExitPayload as GeneratedTerminalExitPayload,
  TerminalOpenPayload as GeneratedTerminalOpenPayload,
  TerminalRequestContract,
  TerminalResultContract
} from "./generated/terminal.js";

export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const TERMINAL_MAX_FRAME_BYTES = 256 * 1024;
export const TERMINAL_MAX_INPUT_BYTES = 64 * 1024;
export const TERMINAL_MAX_OUTPUT_BYTES = 24 * 1024;
export const TERMINAL_MAX_SESSIONS = 32;
export const TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS = 10 * 1000;
export const TERMINAL_MIN_COLS = 2;
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MIN_ROWS = 1;
export const TERMINAL_MAX_ROWS = 200;

export type TerminalErrorCode = GeneratedTerminalErrorCode;
export type TerminalOpenPayload = Omit<GeneratedTerminalOpenPayload, "sessionName" | "persistent"> & {
  sessionName?: string;
  persistent?: boolean;
};
export type TerminalClosePayload = Omit<GeneratedTerminalClosePayload, "destroy"> & { destroy?: boolean };
export type TerminalDestroyPayload = GeneratedTerminalDestroyPayload;

type PublicTerminalRequestPayload<Payload> = Payload extends GeneratedTerminalOpenPayload
  ? TerminalOpenPayload
  : Payload extends GeneratedTerminalClosePayload
    ? TerminalClosePayload
    : Payload;

type TerminalRequestFromContract<Contract extends TerminalRequestContract> =
  Contract extends { operation: infer Operation extends string; payload: infer Payload }
    ? TerminalRequestEnvelope<Operation, PublicTerminalRequestPayload<Payload>>
    : never;

export type TerminalRequest = TerminalRequestFromContract<TerminalRequestContract>;

type TerminalCommandFromContract<Contract extends TerminalCommandContract> =
  Contract extends { operation: infer Operation extends string; payload: infer Payload }
    ? TerminalCommandEnvelope<Operation, Payload>
    : never;

export type TerminalCommand = TerminalCommandFromContract<TerminalCommandContract>;

export type TerminalClientFrame = TerminalRequest | TerminalCommand;

export type TerminalServerFrame = TerminalResponse | TerminalEvent;

export type TerminalResponse =
  | {
      version: typeof TERMINAL_PROTOCOL_VERSION;
      kind: "response";
      id: string;
      ok: true;
      result: Record<string, unknown>;
    }
  | {
      version: typeof TERMINAL_PROTOCOL_VERSION;
      kind: "response";
      id: string;
      ok: false;
      error: TerminalProtocolError;
    };

type PublicTerminalEventPayload<Payload> = Payload extends GeneratedTerminalExitPayload
  ? Omit<Payload, "signal"> & { signal?: number }
  : Payload;

type TerminalEventFromContract<Contract extends TerminalEventContract> =
  Contract extends { event: infer Event extends string; payload: infer Payload }
    ? TerminalEventEnvelope<Event, PublicTerminalEventPayload<Payload>>
    : never;

export type TerminalEvent = TerminalEventFromContract<TerminalEventContract>;

export type TerminalResult<Operation extends TerminalResultContract["operation"]> =
  Extract<TerminalResultContract, { operation: Operation }>["result"];

export interface TerminalProtocolError {
  status: number;
  code: TerminalErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

interface TerminalRequestEnvelope<Operation extends string, Payload> {
  version: typeof TERMINAL_PROTOCOL_VERSION;
  kind: "request";
  id: string;
  operation: Operation;
  payload: Payload;
}

interface TerminalCommandEnvelope<Operation extends string, Payload> {
  version: typeof TERMINAL_PROTOCOL_VERSION;
  kind: "command";
  streamId: string;
  operation: Operation;
  payload: Payload;
}

interface TerminalEventEnvelope<Event extends string, Payload> {
  version: typeof TERMINAL_PROTOCOL_VERSION;
  kind: "event";
  streamId: string;
  event: Event;
  payload: Payload;
}

export function terminalRequest<Operation extends TerminalRequest["operation"]>(
  id: string,
  operation: Operation,
  payload: Extract<TerminalRequest, { operation: Operation }>["payload"]
): Extract<TerminalRequest, { operation: Operation }> {
  return {
    version: TERMINAL_PROTOCOL_VERSION,
    kind: "request",
    id,
    operation,
    payload
  } as Extract<TerminalRequest, { operation: Operation }>;
}

export function terminalCommand<Operation extends TerminalCommand["operation"]>(
  streamId: string,
  operation: Operation,
  payload: Extract<TerminalCommand, { operation: Operation }>["payload"]
): Extract<TerminalCommand, { operation: Operation }> {
  return {
    version: TERMINAL_PROTOCOL_VERSION,
    kind: "command",
    streamId,
    operation,
    payload
  } as Extract<TerminalCommand, { operation: Operation }>;
}

export function encodeTerminalFrame(frame: TerminalClientFrame | TerminalServerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function encodeTerminalData(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

export function decodeTerminalData(data: string): Buffer | null {
  if (!isCanonicalBase64(data)) return null;
  return Buffer.from(data, "base64");
}

export function parseTerminalClientFrame(raw: string): TerminalClientFrame | null {
  const value = parseRecord(raw);
  if (!value || value.version !== TERMINAL_PROTOCOL_VERSION || !isUuid(value.kind === "request" ? value.id : value.streamId)) {
    return null;
  }
  if (value.kind === "request") {
    if (!hasOnlyKeys(value, ["version", "kind", "id", "operation", "payload"]) || typeof value.operation !== "string" || !isRecord(value.payload)) {
      return null;
    }
    if (value.operation === "session.open") {
      const payload = parseOpenPayload(value.payload);
      return payload ? terminalRequest(value.id as string, "session.open", payload) : null;
    }
    if (value.operation === "session.close") {
      const payload = parseClosePayload(value.payload);
      return payload ? terminalRequest(value.id as string, "session.close", payload) : null;
    }
    if (value.operation === "session.destroy") {
      const payload = parseDestroyPayload(value.payload);
      return payload ? terminalRequest(value.id as string, "session.destroy", payload) : null;
    }
    return null;
  }
  if (value.kind === "command") {
    if (!hasOnlyKeys(value, ["version", "kind", "streamId", "operation", "payload"]) || typeof value.operation !== "string" || !isRecord(value.payload)) {
      return null;
    }
    if (value.operation === "terminal.input" && hasOnlyKeys(value.payload, ["data"]) && typeof value.payload.data === "string" && decodeTerminalData(value.payload.data)) {
      return terminalCommand(value.streamId as string, "terminal.input", { data: value.payload.data });
    }
    if (value.operation === "terminal.resize" && hasOnlyKeys(value.payload, ["cols", "rows"])) {
      const dimensions = parseDimensions(value.payload);
      return dimensions ? terminalCommand(value.streamId as string, "terminal.resize", dimensions) : null;
    }
  }
  return null;
}

export function parseTerminalServerFrame(raw: string): TerminalServerFrame | null {
  const value = parseRecord(raw);
  if (!value || value.version !== TERMINAL_PROTOCOL_VERSION) return null;
  if (value.kind === "response") {
    if (!isUuid(value.id) || typeof value.ok !== "boolean") return null;
    if (value.ok === true && hasOnlyKeys(value, ["version", "kind", "id", "ok", "result"]) && isRecord(value.result)) {
      return value as unknown as TerminalResponse;
    }
    if (value.ok === false && hasOnlyKeys(value, ["version", "kind", "id", "ok", "error"])) {
      const error = parseProtocolError(value.error);
      return error ? { version: TERMINAL_PROTOCOL_VERSION, kind: "response", id: value.id, ok: false, error } : null;
    }
    return null;
  }
  if (value.kind !== "event" || !hasOnlyKeys(value, ["version", "kind", "streamId", "event", "payload"]) || !isUuid(value.streamId) || !isRecord(value.payload)) {
    return null;
  }
  if (value.event === "terminal.output" && hasOnlyKeys(value.payload, ["data"]) && typeof value.payload.data === "string" && decodeTerminalData(value.payload.data)) {
    return value as unknown as TerminalEvent;
  }
  if (value.event === "terminal.exit" && hasOnlyKeys(value.payload, ["exitCode", "signal", "recoverable"], ["signal"]) && typeof value.payload.exitCode === "number" && Number.isInteger(value.payload.exitCode) && (value.payload.signal === undefined || (typeof value.payload.signal === "number" && Number.isInteger(value.payload.signal))) && typeof value.payload.recoverable === "boolean") {
    return value as unknown as TerminalEvent;
  }
  if (value.event === "terminal.error" && hasOnlyKeys(value.payload, ["code", "message", "retryable"]) && isErrorCode(value.payload.code) && typeof value.payload.message === "string" && typeof value.payload.retryable === "boolean") {
    return value as unknown as TerminalEvent;
  }
  return null;
}

export function parseTerminalOpenResult(result: Record<string, unknown>): TerminalResult<"session.open"> | null {
  if (!hasOnlyKeys(result, ["streamId", "user", "cwd", "shell"]) || !isUuid(result.streamId) || typeof result.user !== "string" || typeof result.cwd !== "string" || typeof result.shell !== "string") {
    return null;
  }
  return { streamId: result.streamId, user: result.user, cwd: result.cwd, shell: result.shell };
}

function parseOpenPayload(value: Record<string, unknown>): TerminalOpenPayload | null {
  if (!hasOnlyKeys(value, ["user", "cols", "rows", "sessionName", "persistent"], ["sessionName", "persistent"]) || typeof value.user !== "string") return null;
  const dimensions = parseDimensions(value);
  if (!dimensions || (value.sessionName !== undefined && value.sessionName !== null && !isSessionName(value.sessionName)) || (value.persistent !== undefined && typeof value.persistent !== "boolean")) return null;
  return {
    user: value.user,
    ...dimensions,
    ...(typeof value.sessionName === "string" ? { sessionName: value.sessionName } : {}),
    ...(value.persistent === true ? { persistent: true } : {})
  };
}

function parseClosePayload(value: Record<string, unknown>): TerminalClosePayload | null {
  if (!hasOnlyKeys(value, ["streamId", "destroy"], ["destroy"]) || !isUuid(value.streamId) || (value.destroy !== undefined && typeof value.destroy !== "boolean")) return null;
  return { streamId: value.streamId, ...(value.destroy === true ? { destroy: true } : {}) };
}

function parseDestroyPayload(value: Record<string, unknown>): TerminalDestroyPayload | null {
  if (!hasOnlyKeys(value, ["user", "sessionName"]) || typeof value.user !== "string" || !isSessionName(value.sessionName)) return null;
  return { user: value.user, sessionName: value.sessionName };
}

function parseDimensions(value: Record<string, unknown>): { cols: number; rows: number } | null {
  const cols = dimension(value.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS);
  const rows = dimension(value.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS);
  return cols === null || rows === null ? null : { cols, rows };
}

function parseProtocolError(value: unknown): TerminalProtocolError | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["status", "code", "message", "retryable", "details"], ["details"]) || typeof value.status !== "number" || !Number.isInteger(value.status) || !isErrorCode(value.code) || typeof value.message !== "string" || typeof value.retryable !== "boolean") return null;
  return {
    status: value.status,
    code: value.code,
    message: value.message,
    retryable: value.retryable,
    ...(value.details === undefined ? {} : { details: value.details })
  };
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function dimension(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[], optional: string[] = []): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key)) && keys.every((key) => optional.includes(key) || Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isSessionName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 96 && /^[a-zA-Z0-9_-]+$/u.test(value);
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length > Math.ceil(TERMINAL_MAX_INPUT_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function isErrorCode(value: unknown): value is TerminalErrorCode {
  return typeof value === "string" && [
    "protocol_error",
    "validation",
    "forbidden",
    "not_found",
    "conflict",
    "session_limit",
    "timeout",
    "output_too_large",
    "unavailable",
    "operation_failed",
    "internal"
  ].includes(value);
}
