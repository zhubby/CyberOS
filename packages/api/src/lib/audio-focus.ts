import { randomUUID } from "node:crypto";
import type { VodPlayerRuntime } from "./vod-player.js";

export interface AudioFocusRuntime {
  acquire(): Promise<string>;
  renew(leaseId: string): Promise<void>;
  release(leaseId: string): Promise<void>;
}
export class MediaAudioFocus implements AudioFocusRuntime {
  constructor(private readonly player: VodPlayerRuntime) {}
  async acquire(): Promise<string> {
    const leaseId = randomUUID();
    await this.player.command({ type: "audio-focus", leaseId, action: "acquire" });
    return leaseId;
  }
  async renew(leaseId: string): Promise<void> { await this.player.command({ type: "audio-focus", leaseId, action: "renew" }); }
  async release(leaseId: string): Promise<void> { await this.player.command({ type: "audio-focus", leaseId, action: "release" }); }
}
