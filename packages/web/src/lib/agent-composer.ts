import type { JobStatus } from "../api.js";

export function composeAgentMessage(message: string, composerPath: string | null): string {
  return [composerPath, message.trim()].filter(Boolean).join("\n");
}

export function hasActiveAgentTurn(activeJobId: string | null, activeJobStatus: JobStatus | null): boolean {
  return activeJobId !== null && activeJobStatus === "running";
}
