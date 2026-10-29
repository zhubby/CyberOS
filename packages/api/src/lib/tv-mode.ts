import { HostdClient } from "./hostd-client.js";

const TV_MODE_TIMEOUT_MS = 120_000;

export interface TvModeRuntime {
  apply(enabled: boolean): Promise<void>;
}

export class HostdTvModeRuntime implements TvModeRuntime {
  private readonly client: HostdClient;

  constructor(socketPath: string) {
    this.client = new HostdClient(socketPath);
  }

  async apply(enabled: boolean): Promise<void> {
    await this.client.request(
      "system.tv",
      { enabled, confirmed: true },
      TV_MODE_TIMEOUT_MS
    );
  }
}
