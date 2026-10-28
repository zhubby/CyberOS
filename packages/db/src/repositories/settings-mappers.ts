import type {
  AgentCapabilityPolicyMode,
  AgentCapabilityPolicySettingsRecord,
  DockerSettingsRecord,
  ModelProviderName,
  ModelProviderSettingsRecord
} from "@cyberos/shared";
import { isModelProviderName } from "@cyberos/shared";
import {
  AGENT_CAPABILITY_IDS,
  DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS,
  PI_TOOL_POLICY_MODES
} from "./settings-constants.js";

export function mapAgentCapabilityPolicySettings(row: DbSystemSettingRow): AgentCapabilityPolicySettingsRecord {
  const parsed = currentRecord(JSON.parse(row.value_json), "Agent capability policy");
  const policies = currentRecord(parsed.policies, "Agent capability policy modes");
  if (AGENT_CAPABILITY_IDS.some((capabilityId) => !Object.hasOwn(policies, capabilityId))) {
    throw new Error("Agent capability policy does not match the CyberOS 2.0 format");
  }
  return normalizeAgentCapabilityPolicySettings(
    parsed as unknown as AgentCapabilityPolicySettingsRecord,
    currentTimestamp(parsed.updatedAt, "Agent capability policy")
  );
}

export function normalizeAgentCapabilityPolicySettings(
  settings: Partial<AgentCapabilityPolicySettingsRecord>,
  updatedAt: string
): AgentCapabilityPolicySettingsRecord {
  const policies = { ...DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS.policies };
  for (const capabilityId of AGENT_CAPABILITY_IDS) {
    const mode = settings.policies?.[capabilityId];
    if (mode !== undefined) {
      if (!isAgentCapabilityPolicyMode(mode)) throw new Error(`Invalid policy mode for ${capabilityId}`);
      policies[capabilityId] = capabilityId === "cyberos.files.mutate" && mode === "auto" ? "approve" : mode;
    }
  }
  return { policies, updatedAt };
}
import type { DbSystemSettingRow } from "./repository-rows.js";

export function mapModelProviderSettings(row: DbSystemSettingRow): ModelProviderSettingsRecord {
  const parsed = currentRecord(JSON.parse(row.value_json), "Model provider");
  const providerName = normalizeModelProviderName(parsed.providerName);
  if (
    !Number.isSafeInteger(parsed.generation)
    || Number(parsed.generation) < 1
    || !isNullableString(parsed.baseUrl)
    || typeof parsed.model !== "string"
    || !isNullableString(parsed.apiKey)
  ) {
    throw new Error("Model provider settings do not match the CyberOS 2.0 format");
  }
  return {
    generation: parsed.generation as number,
    providerName,
    baseUrl: parsed.baseUrl,
    model: parsed.model,
    apiKey: parsed.apiKey,
    updatedAt: currentTimestamp(parsed.updatedAt, "Model provider")
  };
}

export function mapDockerSettings(row: DbSystemSettingRow): DockerSettingsRecord {
  const parsed = currentRecord(JSON.parse(row.value_json), "Docker");
  if (
    typeof parsed.enabled !== "boolean"
    || normalizeString(parsed.socketPath) === null
    || normalizeString(parsed.composeCommand) === null
    || normalizePositiveInteger(parsed.operationTimeoutMs) === null
    || !Array.isArray(parsed.consoleShells)
    || parsed.consoleShells.length === 0
    || parsed.consoleShells.some((shell) => normalizeString(shell) === null)
  ) {
    throw new Error("Docker settings do not match the CyberOS 2.0 format");
  }
  return {
    enabled: parsed.enabled,
    socketPath: normalizeString(parsed.socketPath)!,
    composeCommand: normalizeString(parsed.composeCommand)!,
    operationTimeoutMs: normalizePositiveInteger(parsed.operationTimeoutMs)!,
    consoleShells: normalizeDockerShells(parsed.consoleShells),
    updatedAt: currentTimestamp(parsed.updatedAt, "Docker")
  };
}

function normalizeDockerShells(shells: unknown): string[] {
  if (!Array.isArray(shells)) {
    return ["/bin/sh", "/bin/bash"];
  }

  const normalized = shells.map(normalizeString).filter((shell): shell is string => shell !== null);
  return normalized.length ? normalized : ["/bin/sh", "/bin/bash"];
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function isAgentCapabilityPolicyMode(value: unknown): value is AgentCapabilityPolicyMode {
  return typeof value === "string" && PI_TOOL_POLICY_MODES.includes(value as AgentCapabilityPolicyMode);
}

export function normalizeModelProviderName(value: unknown): ModelProviderName {
  const providerName = normalizeString(value);
  if (!isModelProviderName(providerName)) {
    throw new Error("Invalid model provider name");
  }
  return providerName;
}

function currentRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} settings do not match the CyberOS 2.0 format`);
  }
  return value as Record<string, unknown>;
}

function currentTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} settings require a valid updatedAt timestamp`);
  }
  return value;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
