import type {
  AgentCapabilityId,
  AgentCapabilityPolicySettingsRecord,
  DlnaMediaType,
  PiToolPolicyMode
} from "@cyberos/shared";

export const AGENT_CAPABILITY_IDS = [
  "cyberos.files.list",
  "cyberos.files.read",
  "cyberos.files.search",
  "cyberos.files.grep",
  "cyberos.files.find",
  "cyberos.files.mutate",
  "cyberos.files.edit",
  "cyberos.files.write",
  "cyberos.shell.run"
] as const satisfies readonly AgentCapabilityId[];

export const DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS: Omit<AgentCapabilityPolicySettingsRecord, "updatedAt"> = {
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
  }
};

export const PI_TOOL_POLICY_MODES = ["auto", "approve", "confirm", "disabled"] as const satisfies PiToolPolicyMode[];
export const DLNA_MEDIA_TYPES = ["audio", "video", "pictures"] as const satisfies DlnaMediaType[];
