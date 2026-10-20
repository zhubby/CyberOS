import type {
  AgentCapabilityId,
  AgentCapabilityPolicySettingsRecord,
  DlnaMediaType,
  PiDangerousToolPolicyMode,
  PiToolName,
  PiToolPolicyMode,
  PiToolPolicySettingsRecord
} from "@zos/shared";

export const AGENT_CAPABILITY_IDS = [
  "zos.files.list",
  "zos.files.read",
  "zos.files.search",
  "zos.files.grep",
  "zos.files.find",
  "zos.files.mutate",
  "zos.files.edit",
  "zos.files.write",
  "zos.shell.run"
] as const satisfies readonly AgentCapabilityId[];

export const DEFAULT_AGENT_CAPABILITY_POLICY_SETTINGS: Omit<AgentCapabilityPolicySettingsRecord, "updatedAt"> = {
  policies: {
    "zos.files.list": "auto",
    "zos.files.read": "auto",
    "zos.files.search": "auto",
    "zos.files.grep": "auto",
    "zos.files.find": "auto",
    "zos.files.mutate": "approve",
    "zos.files.edit": "approve",
    "zos.files.write": "approve",
    "zos.shell.run": "confirm"
  }
};

export const READ_ONLY_PI_TOOLS = ["read", "grep", "find", "ls"] as const satisfies PiToolName[];
export const DANGEROUS_PI_TOOLS = ["bash", "edit", "write"] as const satisfies PiToolName[];
export const PI_TOOL_POLICY_MODES = ["auto", "approve", "confirm", "disabled"] as const satisfies PiToolPolicyMode[];
export const DANGEROUS_PI_TOOL_POLICY_MODES = PI_TOOL_POLICY_MODES satisfies readonly PiDangerousToolPolicyMode[];
export const DLNA_MEDIA_TYPES = ["audio", "video", "pictures"] as const satisfies DlnaMediaType[];

export const DEFAULT_PI_TOOL_POLICY_SETTINGS: Omit<PiToolPolicySettingsRecord, "updatedAt"> = {
  read: "auto",
  grep: "auto",
  find: "auto",
  ls: "auto",
  bash: "confirm",
  edit: "approve",
  write: "approve"
};
