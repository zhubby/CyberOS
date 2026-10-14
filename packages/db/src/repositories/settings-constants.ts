import type {
  DlnaMediaType,
  PiDangerousToolPolicyMode,
  PiToolName,
  PiToolPolicyMode,
  PiToolPolicySettingsRecord
} from "@zos/shared";

export const READ_ONLY_PI_TOOLS = ["read", "grep", "find", "ls"] as const satisfies PiToolName[];
export const DANGEROUS_PI_TOOLS = ["bash", "edit", "write"] as const satisfies PiToolName[];
export const PI_TOOL_POLICY_MODES = ["auto", "ask", "disabled"] as const satisfies PiToolPolicyMode[];
export const DANGEROUS_PI_TOOL_POLICY_MODES = ["ask", "disabled"] as const satisfies PiDangerousToolPolicyMode[];
export const DLNA_MEDIA_TYPES = ["audio", "video", "pictures"] as const satisfies DlnaMediaType[];

export const DEFAULT_PI_TOOL_POLICY_SETTINGS: Omit<PiToolPolicySettingsRecord, "updatedAt"> = {
  read: "auto",
  grep: "auto",
  find: "auto",
  ls: "auto",
  bash: "ask",
  edit: "ask",
  write: "ask"
};
