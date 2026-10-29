import type {
  CapabilityAvailability,
  CapabilityRisk,
  CapabilitySubject,
  JsonValue
} from "@cyberos/capabilities";
import type { CyberOsDatabase } from "@cyberos/db";
import type { CyberOsRuntime } from "@cyberos/shared";

export interface CapabilitySecretRequirement {
  name: string;
  label: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
}

export interface CapabilityAdapterContext {
  db: CyberOsDatabase;
  config: CyberOsRuntime;
  capabilityId: string;
  subject: CapabilitySubject;
}

export interface PreparedCapabilityAction {
  summary: string;
  target?: JsonValue;
  changes?: JsonValue;
  revision?: string | null;
  privatePayload: JsonValue;
  requiredSecrets?: CapabilitySecretRequirement[];
}

export interface CapabilityAdapterExecution {
  data: JsonValue;
  domainOperationType?: string;
  domainOperationId?: string;
}

export interface CapabilityDomainAdapter {
  availability(context: CapabilityAdapterContext): CapabilityAvailability | Promise<CapabilityAvailability>;
  prepare(request: JsonValue, context: CapabilityAdapterContext): PreparedCapabilityAction | Promise<PreparedCapabilityAction>;
  revalidate(prepared: PreparedCapabilityAction, context: CapabilityAdapterContext): void | Promise<void>;
  execute(
    prepared: PreparedCapabilityAction,
    context: CapabilityAdapterContext,
    secretInput: Readonly<Record<string, string>>
  ): CapabilityAdapterExecution | Promise<CapabilityAdapterExecution>;
}

export interface StoredCapabilityAdapterPayload {
  kind: "domain_adapter";
  version: 1;
  capabilityId: string;
  prepared: PreparedCapabilityAction;
}

export interface StoredCapabilityAdapterProposal {
  kind: "domain_adapter";
  version: 1;
  capabilityId: string;
  title?: string;
  summary: string;
  target: JsonValue | null;
  changes: JsonValue | null;
  revision: string | null;
  risk: Exclude<CapabilityRisk, "read">;
  requiredSecrets: CapabilitySecretRequirement[];
}

export function isStoredCapabilityAdapterPayload(value: JsonValue | null): value is JsonValue & StoredCapabilityAdapterPayload {
  if (!isRecord(value) || value.kind !== "domain_adapter" || value.version !== 1) return false;
  if (typeof value.capabilityId !== "string" || !isRecord(value.prepared)) return false;
  return typeof value.prepared.summary === "string" && "privatePayload" in value.prepared;
}

export function parseStoredCapabilityAdapterProposal(value: JsonValue): StoredCapabilityAdapterProposal {
  if (
    !isRecord(value) || value.kind !== "domain_adapter" || value.version !== 1 ||
    typeof value.capabilityId !== "string" || typeof value.summary !== "string" ||
    !["low", "medium", "high", "critical"].includes(String(value.risk)) ||
    !Array.isArray(value.requiredSecrets)
  ) {
    throw new Error("Stored capability adapter proposal is invalid");
  }
  const requiredSecrets = value.requiredSecrets.map((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.label !== "string") {
      throw new Error("Stored capability secret requirement is invalid");
    }
    return {
      name: item.name,
      label: item.label,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(typeof item.minLength === "number" ? { minLength: item.minLength } : {}),
      ...(typeof item.maxLength === "number" ? { maxLength: item.maxLength } : {})
    };
  });
  return {
    kind: "domain_adapter",
    version: 1,
    capabilityId: value.capabilityId,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    summary: value.summary,
    target: (value.target ?? null) as JsonValue,
    changes: (value.changes ?? null) as JsonValue,
    revision: typeof value.revision === "string" ? value.revision : null,
    risk: value.risk as StoredCapabilityAdapterProposal["risk"],
    requiredSecrets
  };
}

export function validateCapabilitySecretInput(
  requirements: readonly CapabilitySecretRequirement[],
  value: unknown
): Readonly<Record<string, string>> {
  if (requirements.length === 0) {
    if (value !== undefined && (!isRecord(value) || Object.keys(value).length > 0)) {
      throw new Error("This capability does not accept secret input");
    }
    return {};
  }
  if (!isRecord(value)) throw new Error("Required secret input is missing");
  const allowed = new Set(requirements.map((item) => item.name));
  if (Object.keys(value).some((name) => !allowed.has(name))) throw new Error("Secret input contains unsupported fields");
  const result: Record<string, string> = {};
  for (const requirement of requirements) {
    const secret = value[requirement.name];
    const minLength = requirement.minLength ?? 1;
    const maxLength = requirement.maxLength ?? 4096;
    if (typeof secret !== "string" || secret.length < minLength || secret.length > maxLength || secret.includes("\0")) {
      throw new Error(`${requirement.label} is required`);
    }
    result[requirement.name] = secret;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
