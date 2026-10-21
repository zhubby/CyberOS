import type { SystemPowerAction, SystemPowerResult } from "@zos/shared";
import { HostdClient, HostdRequestError } from "./hostd-client.js";

const HOSTD_POWER_TIMEOUT_MS = 5_000;

export interface SystemPowerRuntime {
  request(action: SystemPowerAction): Promise<SystemPowerResult>;
}

export class SystemPowerRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "SystemPowerRequestError";
  }
}

export class HostdSystemPowerRuntime implements SystemPowerRuntime {
  private readonly client: HostdClient;

  constructor(socketPath: string) {
    this.client = new HostdClient(socketPath);
  }

  async request(action: SystemPowerAction): Promise<SystemPowerResult> {
    try {
      const result = await this.client.request(
        "system.power",
        { action, confirmed: true },
        HOSTD_POWER_TIMEOUT_MS
      );
      if (result?.accepted !== true || result.action !== action) {
        throw new SystemPowerRequestError("Invalid response from hostd", 502);
      }
      return result;
    } catch (error) {
      if (error instanceof SystemPowerRequestError) throw error;
      if (error instanceof HostdRequestError) {
        throw new SystemPowerRequestError(safeSystemPowerMessage(error), error.statusCode);
      }
      throw new SystemPowerRequestError("System power service is unavailable", 503);
    }
  }
}

export function isSystemPowerAction(value: unknown): value is SystemPowerAction {
  return value === "reboot" || value === "shutdown";
}

export function safeSystemPowerMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "System power request failed";
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/(psk|password|secret|token)\s*[:=]\s*[^\s,;}]+/giu, "$1=[redacted]")
    .slice(0, 500);
}
