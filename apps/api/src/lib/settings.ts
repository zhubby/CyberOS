import type {
  DockerConfig,
  DockerSettingsRecord,
  ModelProviderSettingsRecord,
  PublicShareSettings,
  ShareConfig,
  ShareSettingsRecord,
  ZosConfig
} from "@zos/shared";
import { isModelProviderName as sharedIsModelProviderName } from "@zos/shared";
import { defaultPiToolPolicySettings } from "@zos/db";

export function defaultModelProviderSettings(config: ZosConfig): ModelProviderSettingsRecord {
  return {
    providerName: "openai",
    baseUrl: config.model.localEndpoint,
    model: "",
    apiKey: null,
    updatedAt: new Date(0).toISOString()
  };
}

export function toPublicModelProviderSettings(settings: ModelProviderSettingsRecord) {
  return {
    providerName: settings.providerName,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKeyConfigured: Boolean(settings.apiKey),
    updatedAt: settings.updatedAt
  };
}

export function isModelProviderName(value: unknown): value is ModelProviderSettingsRecord["providerName"] {
  return sharedIsModelProviderName(value);
}

export function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function toPublicPiToolPolicySettings(settings = defaultPiToolPolicySettings()) {
  return settings;
}

export function defaultDockerSettings(config: ZosConfig): DockerSettingsRecord {
  return {
    ...config.docker,
    updatedAt: new Date(0).toISOString()
  };
}

export function toPublicDockerSettings(settings: DockerSettingsRecord): DockerSettingsRecord {
  return settings;
}

export function defaultShareSettings(config: ZosConfig): ShareSettingsRecord {
  return {
    ...config.shares,
    updatedAt: new Date(0).toISOString()
  };
}

export function toPublicShareSettings(settings: ShareSettingsRecord): PublicShareSettings {
  return {
    enabled: settings.enabled,
    account: {
      username: settings.account.username,
      passwordConfigured: Boolean(settings.account.password)
    },
    shares: settings.shares,
    updatedAt: settings.updatedAt
  };
}

export function shareSettingsToConfig(settings: ShareSettingsRecord): ShareConfig {
  return {
    enabled: settings.enabled,
    account: settings.account,
    shares: settings.shares
  };
}

export function dockerSettingsToConfig(settings: DockerSettingsRecord): DockerConfig {
  return {
    enabled: settings.enabled,
    socketPath: settings.socketPath,
    composeCommand: settings.composeCommand,
    operationTimeoutMs: settings.operationTimeoutMs,
    consoleShells: settings.consoleShells
  };
}

export function effectiveDockerConfig(config: ZosConfig, settings: DockerSettingsRecord | null): ZosConfig {
  return {
    ...config,
    docker: settings ? dockerSettingsToConfig(settings) : config.docker
  };
}

export function effectiveShareConfig(config: ZosConfig, settings: ShareSettingsRecord | null): ZosConfig {
  return {
    ...config,
    shares: settings ? shareSettingsToConfig(settings) : config.shares
  };
}
