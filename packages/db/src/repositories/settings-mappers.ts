import type {
  AgentCapabilityPolicyMode,
  AgentCapabilityPolicySettingsRecord,
  DockerSettingsRecord,
  ModelProviderName,
  ModelProviderSettingsRecord,
  PiDangerousToolPolicyMode,
  PiToolName,
  PiToolPolicyMode,
  PiToolPolicySettingsRecord
} from "@zos/shared";
import { isModelProviderName } from "@zos/shared";
import {
  AGENT_CAPABILITY_IDS,
  DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS,
  DANGEROUS_PI_TOOL_POLICY_MODES,
  DANGEROUS_PI_TOOLS,
  DEFAULT_PI_TOOL_POLICY_SETTINGS,
  PI_TOOL_POLICY_MODES,
  READ_ONLY_PI_TOOLS
} from "./settings-constants.js";

export function mapAgentCapabilityPolicySettings(row: DbSystemSettingRow): AgentCapabilityPolicySettingsRecord {
  const parsed = JSON.parse(row.value_json) as Partial<AgentCapabilityPolicySettingsRecord>;
  return normalizeAgentCapabilityPolicySettings(parsed, parsed.updatedAt ?? row.updated_at);
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
      policies[capabilityId] = capabilityId === "zos.files.mutate" && mode === "auto" ? "approve" : mode;
    }
  }
  return { policies, updatedAt };
}
import type { DbSystemSettingRow } from "./repository-rows.js";

export function mapModelProviderSettings(row: DbSystemSettingRow): ModelProviderSettingsRecord {
  const parsed = JSON.parse(row.value_json) as Partial<ModelProviderSettingsRecord> & { provider?: string };
  const providerName = normalizeModelProviderName(parsed.providerName ?? parsed.provider);
  return {
    generation: typeof parsed.generation === "number" && Number.isInteger(parsed.generation) && parsed.generation > 0
      ? parsed.generation
      : 1,
    providerName,
    baseUrl: parsed.baseUrl ?? null,
    model: parsed.model ?? "",
    apiKey: parsed.apiKey ?? null,
    updatedAt: parsed.updatedAt ?? row.updated_at
  };
}

export function mapPiToolPolicySettings(row: DbSystemSettingRow): PiToolPolicySettingsRecord {
  const parsed = JSON.parse(row.value_json) as Partial<PiToolPolicySettingsRecord>;
  return normalizePiToolPolicySettings(parsed, parsed.updatedAt ?? row.updated_at);
}

export function mapDockerSettings(row: DbSystemSettingRow): DockerSettingsRecord {
  const parsed = JSON.parse(row.value_json) as Partial<DockerSettingsRecord>;
  return {
    enabled: Boolean(parsed.enabled),
    socketPath: normalizeString(parsed.socketPath) ?? "/var/run/docker.sock",
    composeCommand: normalizeString(parsed.composeCommand) ?? "docker",
    operationTimeoutMs: normalizePositiveInteger(parsed.operationTimeoutMs) ?? 120_000,
    consoleShells: normalizeDockerShells(parsed.consoleShells),
    updatedAt: normalizeString(parsed.updatedAt) ?? row.updated_at
  };
}

export function normalizePiToolPolicySettings(
  settings: Partial<PiToolPolicySettingsRecord>,
  updatedAt: string
): PiToolPolicySettingsRecord {
  const normalized: PiToolPolicySettingsRecord = {
    ...DEFAULT_PI_TOOL_POLICY_SETTINGS,
    updatedAt
  };

  for (const tool of READ_ONLY_PI_TOOLS) {
    const mode = migrateLegacyPolicyMode(settings[tool], tool) ?? DEFAULT_PI_TOOL_POLICY_SETTINGS[tool];
    if (!isPiToolPolicyMode(mode)) {
      throw new Error(`Invalid policy mode for ${tool}`);
    }
    normalized[tool] = mode;
  }

  for (const tool of DANGEROUS_PI_TOOLS) {
    const mode = migrateLegacyPolicyMode(settings[tool], tool) ?? DEFAULT_PI_TOOL_POLICY_SETTINGS[tool];
    if (!isDangerousPiToolPolicyMode(mode)) {
      throw new Error(`Dangerous tool ${tool} cannot use policy mode ${String(mode)}`);
    }
    normalized[tool] = mode;
  }

  return normalized;
}

function migrateLegacyPolicyMode(value: unknown, tool: PiToolName): unknown {
  if (value === "ask") return tool === "bash" ? "confirm" : "approve";
  return value;
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

function isPiToolPolicyMode(value: unknown): value is PiToolPolicyMode {
  return typeof value === "string" && PI_TOOL_POLICY_MODES.includes(value as PiToolPolicyMode);
}

function isAgentCapabilityPolicyMode(value: unknown): value is AgentCapabilityPolicyMode {
  return typeof value === "string" && PI_TOOL_POLICY_MODES.includes(value as AgentCapabilityPolicyMode);
}

function isDangerousPiToolPolicyMode(value: unknown): value is PiDangerousToolPolicyMode {
  return typeof value === "string" && DANGEROUS_PI_TOOL_POLICY_MODES.includes(value as PiDangerousToolPolicyMode);
}

export function normalizeModelProviderName(value: unknown): ModelProviderName {
  const providerName = legacyModelProviderName(normalizeString(value) ?? undefined);
  return isModelProviderName(providerName) ? providerName : "openai";
}

function legacyModelProviderName(provider: string | undefined): string | undefined {
  switch (provider) {
    case "openai-compatible":
      return "openai";
    case "anthropic-compatible":
      return "anthropic";
    case "local":
      return "openai";
    case "pi":
      return "openai";
    case "google":
      return "openai";
    case "openrouter":
      return "openai";
    default:
      return provider;
  }
}
