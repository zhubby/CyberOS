export const CAPABILITY_SCHEMA_VERSION = "1.0" as const;

export const CAPABILITY_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "FORBIDDEN",
  "NOT_READY",
  "CONFLICT",
  "APPROVAL_REJECTED",
  "APPROVAL_EXPIRED",
  "CANCELLED",
  "RATE_LIMITED",
  "INTERNAL"
] as const;

export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];
export type CapabilityRisk = "read" | "low" | "medium" | "high" | "critical";
export type CapabilityApprovalPolicy = "none" | "owner_control" | "first_party" | "first_party_confirm";
export type CapabilityIdempotency = "none" | "optional" | "required";
export type CapabilityRunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema {
  $id?: string;
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  enum?: JsonPrimitive[];
  const?: JsonPrimitive;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minProperties?: number;
  maxProperties?: number;
  default?: JsonValue;
}

export interface CapabilityAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface CapabilityDescriptor<TInput extends JsonValue = JsonValue, TOutput extends JsonValue = JsonValue> {
  id: `zos.${string}.${string}`;
  domain: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  risk: CapabilityRisk;
  requiredScopes: readonly string[];
  approval: CapabilityApprovalPolicy;
  idempotency: CapabilityIdempotency;
  maxOutputBytes: number;
  annotations: CapabilityAnnotations;
  availability?: (context: CapabilityContext) => CapabilityAvailability | Promise<CapabilityAvailability>;
  execute?: CapabilityExecutor<TInput, TOutput>;
}

export interface CapabilityAvailability {
  available: boolean;
  reason?: string;
}

export interface CapabilitySubject {
  id: string;
  kind: "pi" | "local" | "lan" | "system";
  clientId: string;
  scopes: ReadonlySet<string>;
}

export interface CapabilityContext {
  subject: CapabilitySubject;
  traceId: string;
  signal?: AbortSignal;
  services: Readonly<Record<string, unknown>>;
}

export type CapabilityExecutor<TInput extends JsonValue, TOutput extends JsonValue> = (
  input: TInput,
  context: CapabilityContext
) => Promise<CapabilityExecution<TOutput>>;

export interface CapabilityPage {
  nextCursor: string | null;
  limit: number;
}

export interface CapabilityExecution<TData extends JsonValue = JsonValue> {
  data: TData;
  warnings?: string[];
  page?: CapabilityPage;
  runId?: string;
}

export interface CapabilityResult<TData extends JsonValue = JsonValue> {
  schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  data: TData;
  warnings: string[];
  page: CapabilityPage | null;
  runId: string | null;
  traceId: string;
}

export interface CapabilityErrorShape {
  schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  code: CapabilityErrorCode;
  message: string;
  retryable: boolean;
  runId: string | null;
  traceId: string;
}

export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode;
  readonly retryable: boolean;
  readonly runId: string | null;

  constructor(code: CapabilityErrorCode, message: string, options: { retryable?: boolean; runId?: string | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CapabilityError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.runId = options.runId ?? null;
  }
}

export function capabilityResult<TData extends JsonValue>(
  execution: CapabilityExecution<TData>,
  traceId: string
): CapabilityResult<TData> {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    data: execution.data,
    warnings: execution.warnings ?? [],
    page: execution.page ?? null,
    runId: execution.runId ?? null,
    traceId
  };
}

export function capabilityErrorShape(error: CapabilityError, traceId: string): CapabilityErrorShape {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    runId: error.runId,
    traceId
  };
}
