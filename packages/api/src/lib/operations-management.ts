import type { OpsTask } from "@cyberos/shared";
import { HostdClient, HostdRequestError } from "./hostd-client.js";

const HOSTD_OPS_TIMEOUT_MS = 5_000;

export interface SystemOperationsRunResult {
  task: OpsTask;
  accepted: true;
}

export interface SystemOperationsRuntime {
  run(task: OpsTask, confirmed: boolean): Promise<SystemOperationsRunResult>;
}

export class SystemOperationsRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "SystemOperationsRequestError";
  }
}

export class HostdSystemOperationsRuntime implements SystemOperationsRuntime {
  private readonly client: HostdClient;

  constructor(socketPath: string) {
    this.client = new HostdClient(socketPath);
  }

  async run(task: OpsTask, confirmed: boolean): Promise<SystemOperationsRunResult> {
    try {
      const result = await this.client.request(
        "system.ops",
        { task, confirmed: confirmed ? true : null },
        HOSTD_OPS_TIMEOUT_MS
      );
      if (result.accepted !== true || result.task !== task) {
        throw new SystemOperationsRequestError("Invalid response from hostd", 502);
      }
      return result;
    } catch (error) {
      if (error instanceof SystemOperationsRequestError) throw error;
      if (error instanceof HostdRequestError) {
        const statusCode = error.statusCode === 503 || error.statusCode === 504
          ? error.statusCode
          : 502;
        throw new SystemOperationsRequestError(safeOperationsMessage(error), statusCode);
      }
      throw new SystemOperationsRequestError("Operations service is unavailable", 503);
    }
  }
}

export function safeOperationsMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Operations request failed";
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/(psk|password|secret|token)\s*[:=]\s*[^\s,;}]+/giu, "$1=[redacted]")
    .replace(/\s+/gu, " ")
    .slice(0, 500);
}
