import type { DockerDaemonStatus } from "@zos/shared";

export type DockerDaemonTone = "ready" | "warning" | "offline" | "neutral";

export interface DockerDaemonJsonValidation {
  valid: boolean;
  reason: "syntax" | "object" | null;
}

export function validateDockerDaemonJson(content: string): DockerDaemonJsonValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { valid: false, reason: "syntax" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { valid: false, reason: "object" };
  }
  return { valid: true, reason: null };
}

export function dockerDaemonTone(state: DockerDaemonStatus["state"]): DockerDaemonTone {
  switch (state) {
    case "running":
      return "ready";
    case "starting":
    case "stopping":
    case "reconnecting":
      return "warning";
    case "failed":
      return "warning";
    case "stopped":
    case "not_installed":
      return "offline";
  }
}

export function parseDockerDaemonEvent(data: string): DockerDaemonStatus | null {
  try {
    const value = JSON.parse(data) as unknown;
    if (!isRecord(value) || !isDaemonState(value.state) || typeof value.collectedAt !== "string") {
      return null;
    }
    const loadState = value.loadState;
    const activeState = value.activeState;
    const subState = value.subState;
    const result = value.result;
    if (
      !isNullableString(loadState) ||
      !isNullableString(activeState) ||
      !isNullableString(subState) ||
      !isNullableString(result)
    ) {
      return null;
    }
    return {
      state: value.state,
      loadState,
      activeState,
      subState,
      result,
      collectedAt: value.collectedAt
    };
  } catch {
    return null;
  }
}

export function reconnectingDockerDaemonStatus(): DockerDaemonStatus {
  return {
    state: "reconnecting",
    loadState: null,
    activeState: null,
    subState: null,
    result: null,
    collectedAt: new Date().toISOString()
  };
}

function isDaemonState(value: unknown): value is DockerDaemonStatus["state"] {
  return (
    value === "running" ||
    value === "starting" ||
    value === "stopping" ||
    value === "stopped" ||
    value === "failed" ||
    value === "not_installed" ||
    value === "reconnecting"
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
