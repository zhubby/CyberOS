import type { TFunction } from "i18next";
import type {
  BuildInfo,
  DockerSettings,
  DownloadSettings,
  IndexerSettings,
  ModelProviderSettings,
  ModelProviderName,
  VmSettings,
  PhotoLibraryStatus,
  AgentCapabilityPolicyMode,
  AgentCapabilityPolicySettings
} from "../api.js";

export type SettingsSectionId =
  | "overview"
  | "system-profile"
  | "version"
  | "model-providers"
  | "agents"
  | "wireless"
  | "bluetooth"
  | "docker"
  | "virtual-machines"
  | "files"
  | "indexer"
  | "operations"
  | "monitoring"
  | "backup"
  | "alerts"
  | "photos"
  | "media"
  | "downloads"
  | "appearance"
  | "advanced";

export type SettingsGroupId = "cyberos" | "devices" | "ai" | "workspace" | "administration";
export type SettingsState = "ready" | "missing" | "loading";

type Translate = TFunction<"translation">;

export interface ModelProviderFormState {
  providerName: ModelProviderName;
  baseUrl: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
}

export interface DockerSettingsFormState {
  enabled: boolean;
  updatedAt: string;
}

export interface VmSettingsFormState {
  enabled: boolean;
  updatedAt: string;
}

export interface SettingsSection {
  id: SettingsSectionId;
  group: SettingsGroupId;
}

export type ToolPolicyFormState = AgentCapabilityPolicySettings;

export const AGENT_CAPABILITY_POLICY_OPTIONS: AgentCapabilityPolicyMode[] = ["auto", "approve", "confirm", "disabled"];

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "overview",
    group: "cyberos"
  },
  {
    id: "system-profile",
    group: "cyberos"
  },
  {
    id: "version",
    group: "cyberos"
  },
  {
    id: "model-providers",
    group: "ai"
  },
  {
    id: "agents",
    group: "ai"
  },
  {
    id: "wireless",
    group: "devices"
  },
  {
    id: "bluetooth",
    group: "devices"
  },
  {
    id: "docker",
    group: "administration"
  },
  {
    id: "virtual-machines",
    group: "administration"
  },
  {
    id: "operations",
    group: "administration"
  },
  {
    id: "monitoring",
    group: "administration"
  },
  {
    id: "backup",
    group: "administration"
  },
  {
    id: "alerts",
    group: "administration"
  },
  {
    id: "files",
    group: "workspace"
  },
  {
    id: "indexer",
    group: "workspace"
  },
  {
    id: "photos",
    group: "workspace"
  },
  {
    id: "media",
    group: "workspace"
  },
  {
    id: "downloads",
    group: "workspace"
  },
  {
    id: "appearance",
    group: "cyberos"
  },
  {
    id: "advanced",
    group: "administration"
  }
];

const SECTION_TITLE_KEYS = {
  overview: "settings.sections.overview.title",
  "system-profile": "settings.sections.systemProfile.title",
  version: "settings.sections.version.title",
  "model-providers": "settings.sections.modelProviders.title",
  agents: "settings.sections.agents.title",
  wireless: "settings.sections.wireless.title",
  bluetooth: "settings.sections.bluetooth.title",
  docker: "settings.sections.docker.title",
  "virtual-machines": "settings.sections.virtualMachines.title",
  files: "settings.sections.files.title",
  indexer: "settings.sections.indexer.title",
  operations: "settings.sections.operations.title",
  monitoring: "settings.sections.monitoring.title",
  backup: "settings.sections.backup.title",
  alerts: "settings.sections.alerts.title",
  photos: "settings.sections.photos.title",
  media: "settings.sections.media.title",
  downloads: "settings.sections.downloads.title",
  appearance: "settings.sections.appearance.title",
  advanced: "settings.sections.advanced.title"
} as const satisfies Record<SettingsSectionId, string>;

const SECTION_DESCRIPTION_KEYS = {
  overview: "settings.sections.overview.description",
  "system-profile": "settings.sections.systemProfile.description",
  version: "settings.sections.version.description",
  "model-providers": "settings.sections.modelProviders.description",
  agents: "settings.sections.agents.description",
  wireless: "settings.sections.wireless.description",
  bluetooth: "settings.sections.bluetooth.description",
  docker: "settings.sections.docker.description",
  "virtual-machines": "settings.sections.virtualMachines.description",
  files: "settings.sections.files.description",
  indexer: "settings.sections.indexer.description",
  operations: "settings.sections.operations.description",
  monitoring: "settings.sections.monitoring.description",
  backup: "settings.sections.backup.description",
  alerts: "settings.sections.alerts.description",
  photos: "settings.sections.photos.description",
  media: "settings.sections.media.description",
  downloads: "settings.sections.downloads.description",
  appearance: "settings.sections.appearance.description",
  advanced: "settings.sections.advanced.description"
} as const satisfies Record<SettingsSectionId, string>;

const GROUP_LABEL_KEYS = {
  cyberos: "settings.groups.cyberos",
  ai: "settings.groups.ai",
  devices: "settings.groups.devices",
  workspace: "settings.groups.workspace",
  administration: "settings.groups.administration"
} as const satisfies Record<SettingsGroupId, string>;

export function modelSettingsToForm(settings: ModelProviderSettings | null): ModelProviderFormState {
  return {
    providerName: settings?.providerName ?? "openai",
    baseUrl: settings?.baseUrl ?? "",
    model: settings?.model ?? "",
    apiKey: "",
    clearApiKey: false
  };
}

export function dockerSettingsToForm(settings: DockerSettings | null): DockerSettingsFormState {
  return {
    enabled: settings?.enabled ?? false,
    updatedAt: settings?.updatedAt ?? new Date(0).toISOString()
  };
}

export function vmSettingsToForm(settings: VmSettings | null): VmSettingsFormState {
  return {
    enabled: settings?.enabled ?? false,
    updatedAt: settings?.updatedAt ?? new Date(0).toISOString()
  };
}

export function settingsGroupLabel(group: SettingsGroupId, t: Translate): string {
  return t(GROUP_LABEL_KEYS[group]);
}

export function settingsSectionTitle(section: SettingsSection, t: Translate): string {
  return t(SECTION_TITLE_KEYS[section.id]);
}

export function settingsSectionDescription(section: SettingsSection, t: Translate): string {
  return t(SECTION_DESCRIPTION_KEYS[section.id]);
}

export function settingsSectionState(
  section: SettingsSection,
  settings: ModelProviderSettings | null,
  dockerSettings: DockerSettings | null,
  buildInfo: BuildInfo | null = null,
  downloadSettings: DownloadSettings | null = null,
  photoStatus: PhotoLibraryStatus | null = null,
  indexerSettings: IndexerSettings | null = null,
  vmSettings: VmSettings | null = null
): SettingsState {
  if (section.id === "model-providers") {
    return settings?.apiKeyConfigured ? "ready" : "missing";
  }
  if (section.id === "docker") {
    return dockerSettings ? "ready" : "missing";
  }
  if (section.id === "virtual-machines") {
    return vmSettings ? "ready" : "missing";
  }
  if (section.id === "version") {
    return buildInfo && buildInfo.version !== "unknown" ? "ready" : "missing";
  }
  if (section.id === "downloads") {
    return downloadSettings ? "ready" : "missing";
  }
  if (section.id === "indexer") {
    return indexerSettings ? "ready" : "missing";
  }
  if (section.id === "photos") {
    if (
      photoStatus?.state === "queued" ||
      photoStatus?.state === "discovering" ||
      photoStatus?.state === "processing" ||
      photoStatus?.state === "retrying"
    ) {
      return "loading";
    }
    if (photoStatus?.state === "degraded" || photoStatus?.state === "offline" || photoStatus?.state === "unconfigured") {
      return "missing";
    }
    return photoStatus?.state === "ready" ? "ready" : "missing";
  }
  return "ready";
}

export function providerLabel(providerName: ModelProviderName, t: Translate): string {
  switch (providerName) {
    case "openai":
      return t("settings.modelProvider.providers.openai");
    case "anthropic":
      return t("settings.modelProvider.providers.anthropic");
    default:
      return providerName;
  }
}

export function defaultToolPolicyForm(): ToolPolicyFormState {
  return {
    policies: {
      "cyberos.files.list": "auto",
      "cyberos.files.read": "auto",
      "cyberos.files.search": "auto",
      "cyberos.files.grep": "auto",
      "cyberos.files.find": "auto",
      "cyberos.files.mutate": "approve",
      "cyberos.files.edit": "approve",
      "cyberos.files.write": "approve",
      "cyberos.shell.run": "confirm"
    },
    updatedAt: new Date(0).toISOString()
  };
}
