import type { HostdRequest, TailscaleStatus } from "@cyberos/shared";
import { HostdClient } from "./hostd-client.js";

export interface TailscaleManagerRuntime {
  request(payload: HostdRequest<"tailscale.manager">): Promise<TailscaleStatus>;
}
export class HostdTailscaleManager implements TailscaleManagerRuntime {
  private readonly client: HostdClient;
  constructor(socketPath: string) { this.client = new HostdClient(socketPath); }
  request(payload: HostdRequest<"tailscale.manager">): Promise<TailscaleStatus> {
    return this.client.request("tailscale.manager", payload, 35_000);
  }
}
