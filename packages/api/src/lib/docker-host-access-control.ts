import net from "node:net";
import type { DockerHostAccessCapabilityId } from "@cyberos/shared";
import type { DockerHostAccessControlRuntime } from "./docker-host-access.js";

const MAX_RESPONSE_BYTES = 64 * 1024;

export class DockerHostAccessControlError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "DockerHostAccessControlError";
  }
}

export class DockerHostAccessControlClient implements DockerHostAccessControlRuntime {
  constructor(
    private readonly socketPath = "/run/cyberos/host-access/control.sock",
    private readonly timeoutMs = 5_000
  ) {}

  async reconcile(input: {
    scopeId: string;
    service?: string;
    capabilities: DockerHostAccessCapabilityId[];
  }): Promise<void> {
    const response = await this.request({
      version: 1,
      action: "reconcile",
      scopeId: input.scopeId,
      service: input.service ?? "container",
      capabilities: [...new Set(input.capabilities)].sort()
    });
    if (response.ok !== true) {
      throw new DockerHostAccessControlError(
        typeof response.error === "string" ? response.error : "Docker Host Access reconciliation failed",
        typeof response.status === "number" ? response.status : 503
      );
    }
  }

  private request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        action();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new DockerHostAccessControlError("Docker Host Access control request timed out", 503)));
      }, this.timeoutMs);
      timer.unref();
      socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish(() => reject(new DockerHostAccessControlError("Docker Host Access control response is too large", 502)));
          return;
        }
        chunks.push(chunk);
      });
      socket.on("end", () => {
        finish(() => {
          try {
            const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            if (!response || typeof response !== "object" || Array.isArray(response)) {
              throw new Error("invalid response");
            }
            resolve(response as Record<string, unknown>);
          } catch {
            reject(new DockerHostAccessControlError("Docker Host Access returned an invalid response", 502));
          }
        });
      });
      socket.on("error", () => {
        finish(() => reject(new DockerHostAccessControlError("Docker Host Access daemon is unavailable", 503)));
      });
    });
  }
}
