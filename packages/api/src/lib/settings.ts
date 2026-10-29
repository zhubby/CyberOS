import type {
  BackupSettingsRecord,
  DockerConfig,
  DockerSettingsRecord,
  ModelProviderSettingsRecord,
  PublicShareSettings,
  ShareConfig,
  ShareSettingsRecord,
  CyberOsRuntime,
  VmSettingsRecord
} from "@cyberos/shared";
import { isModelProviderName as sharedIsModelProviderName } from "@cyberos/shared";
import { defaultAgentCapabilityPolicySettings } from "@cyberos/db";

export function defaultModelProviderSettings(): ModelProviderSettingsRecord {
  return {
    generation: 1,
    providerName: "openai",
    baseUrl: null,
    model: "",
    apiKey: null,
    updatedAt: new Date(0).toISOString()
  };
}

export function toPublicModelProviderSettings(settings: ModelProviderSettingsRecord) {
  return {
    generation: settings.generation,
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

export function toPublicAgentCapabilityPolicySettings(settings = defaultAgentCapabilityPolicySettings()) {
  return settings;
}

export function defaultDockerSettings(config: CyberOsRuntime): DockerSettingsRecord {
  return {
    enabled: config.docker.enabled,
    updatedAt: new Date(0).toISOString()
  };
}

export function toPublicDockerSettings(settings: DockerSettingsRecord): DockerSettingsRecord {
  return settings;
}

export function defaultVmSettings(config: CyberOsRuntime): VmSettingsRecord {
  return {
    enabled: config.vm.enabled,
    updatedAt: new Date(0).toISOString()
  };
}

export function defaultShareSettings(config: CyberOsRuntime): ShareSettingsRecord {
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
    socketPath: "/var/run/docker.sock",
    composeCommand: "docker",
    operationTimeoutMs: 120_000,
    consoleShells: ["/bin/sh", "/bin/bash"]
  };
}

export function effectiveDockerConfig(config: CyberOsRuntime, settings: DockerSettingsRecord | null): CyberOsRuntime {
  return {
    ...config,
    docker: settings ? dockerSettingsToConfig(settings) : config.docker
  };
}

export function effectiveVmConfig(config: CyberOsRuntime, settings: VmSettingsRecord | null): CyberOsRuntime {
  return {
    ...config,
    vm: {
      ...config.vm,
      enabled: settings?.enabled ?? config.vm.enabled
    }
  };
}

export function effectiveBackupConfig(
  config: CyberOsRuntime,
  settings: BackupSettingsRecord | null
): CyberOsRuntime {
  return {
    ...config,
    backup: settings
      ? {
          ...config.backup,
          enabled: settings.enabled,
          repositoryPath: settings.repositoryPath,
          passwordFile: config.paths.backupPasswordPath,
          requireMount: settings.requireMount,
          keepDaily: settings.keepDaily,
          keepWeekly: settings.keepWeekly
        }
      : config.backup
  };
}

export function effectiveShareConfig(config: CyberOsRuntime, settings: ShareSettingsRecord | null): CyberOsRuntime {
  return {
    ...config,
    shares: settings ? shareSettingsToConfig(settings) : config.shares
  };
}
