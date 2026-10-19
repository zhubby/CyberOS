import type { TFunction } from "i18next";
import type {
  BuildInfo,
  DockerSettings,
  DownloadSettings,
  IndexerSettings,
  ModelProviderSettings,
  ModelProviderName,
  PhotoLibraryStatus,
  PiDangerousToolPolicyMode,
  PiToolPolicyMode,
  PiToolPolicySettings
} from "../api.js";

export type SettingsSectionId =
  | "overview"
  | "version"
  | "model-providers"
  | "agents"
  | "docker"
  | "files"
  | "indexer"
  | "operations"
  | "alerts"
  | "photos"
  | "downloads"
  | "appearance"
  | "advanced";

export type SettingsGroupId = "zos" | "ai" | "workspace" | "administration";
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
  socketPath: string;
  composeCommand: string;
  operationTimeoutMs: string;
  consoleShells: string;
  updatedAt: string;
}

export interface SettingsSection {
  id: SettingsSectionId;
  group: SettingsGroupId;
}

export type ToolPolicyFormState = PiToolPolicySettings;

export const READ_ONLY_TOOL_POLICY_OPTIONS: PiToolPolicyMode[] = ["auto", "ask", "disabled"];
export const DANGEROUS_TOOL_POLICY_OPTIONS: PiDangerousToolPolicyMode[] = ["ask", "disabled"];

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "overview",
    group: "zos"
  },
  {
    id: "version",
    group: "zos"
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
    id: "docker",
    group: "administration"
  },
  {
    id: "operations",
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
    id: "downloads",
    group: "workspace"
  },
  {
    id: "appearance",
    group: "zos"
  },
  {
    id: "advanced",
    group: "administration"
  }
];

const SECTION_TITLE_KEYS = {
  overview: "settings.sections.overview.title",
  version: "settings.sections.version.title",
  "model-providers": "settings.sections.modelProviders.title",
  agents: "settings.sections.agents.title",
  docker: "settings.sections.docker.title",
  files: "settings.sections.files.title",
  indexer: "settings.sections.indexer.title",
  operations: "settings.sections.operations.title",
  alerts: "settings.sections.alerts.title",
  photos: "settings.sections.photos.title",
  downloads: "settings.sections.downloads.title",
  appearance: "settings.sections.appearance.title",
  advanced: "settings.sections.advanced.title"
} as const satisfies Record<SettingsSectionId, string>;

const SECTION_DESCRIPTION_KEYS = {
  overview: "settings.sections.overview.description",
  version: "settings.sections.version.description",
  "model-providers": "settings.sections.modelProviders.description",
  agents: "settings.sections.agents.description",
  docker: "settings.sections.docker.description",
  files: "settings.sections.files.description",
  indexer: "settings.sections.indexer.description",
  operations: "settings.sections.operations.description",
  alerts: "settings.sections.alerts.description",
  photos: "settings.sections.photos.description",
  downloads: "settings.sections.downloads.description",
  appearance: "settings.sections.appearance.description",
  advanced: "settings.sections.advanced.description"
} as const satisfies Record<SettingsSectionId, string>;

const GROUP_LABEL_KEYS = {
  zos: "settings.groups.zos",
  ai: "settings.groups.ai",
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
    socketPath: settings?.socketPath ?? "/var/run/docker.sock",
    composeCommand: settings?.composeCommand ?? "docker",
    operationTimeoutMs: String(settings?.operationTimeoutMs ?? 120_000),
    consoleShells: (settings?.consoleShells ?? ["/bin/sh", "/bin/bash"]).join(", "),
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
  indexerSettings: IndexerSettings | null = null
): SettingsState {
  if (section.id === "model-providers") {
    return settings?.apiKeyConfigured ? "ready" : "missing";
  }
  if (section.id === "docker") {
    return dockerSettings ? "ready" : "missing";
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
    read: "auto",
    grep: "auto",
    find: "auto",
    ls: "auto",
    bash: "ask",
    edit: "ask",
    write: "ask",
    updatedAt: new Date(0).toISOString()
  };
}
