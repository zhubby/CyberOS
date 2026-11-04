import net from "node:net";
import path from "node:path";
import type { AudioDaemonStatus, AudioDevice } from "@cyberos/shared";

export interface AudioDevices { inputs: AudioDevice[]; outputs: AudioDevice[] }
export interface AudioRuntime {
  status(): Promise<AudioDaemonStatus>;
  devices(): Promise<AudioDevices>;
  configure(config: { enabled: boolean; inputDeviceId: string | null; maxRecordingSeconds: number }): Promise<void>;
  recording(id: string): Promise<{ id: string; deviceId: string; wav: string }>;
  ack(id: string): Promise<void>;
  play(wav: Buffer, device: string, volume: number, generation: number): Promise<void>;
  stop(): Promise<void>;
}

export class UnixAudioRuntime implements AudioRuntime {
  constructor(private readonly socketPath: string) {}
  status(): Promise<AudioDaemonStatus> { return this.request({ type: "status" }); }
  devices(): Promise<AudioDevices> { return this.request({ type: "devices" }); }
  async configure(config: { enabled: boolean; inputDeviceId: string | null; maxRecordingSeconds: number }): Promise<void> { await this.request({ type: "configure", config }); }
  recording(id: string): Promise<{ id: string; deviceId: string; wav: string }> { return this.request({ type: "recording", id }); }
  async ack(id: string): Promise<void> { await this.request({ type: "ack", id }); }
  async play(wav: Buffer, device: string, volume: number, generation: number): Promise<void> { await this.request({ type: "play", wav: wav.toString("base64"), device, volume, generation }, device.startsWith("ble-playback:") ? 270_000 : 135_000); }
  async stop(): Promise<void> { await this.request({ type: "stop" }); }

  private request<Result>(request: Record<string, unknown>, timeout = 15_000): Promise<Result> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => finish(new Error("Audio daemon timed out")), timeout);
      timer.unref();
      const finish = (error?: Error, result?: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(result!);
      };
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 9 * 1024 * 1024) return finish(new Error("Audio daemon response too large"));
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as { ok?: boolean; result?: Result; error?: unknown };
          if (response.ok !== true || !("result" in response)) finish(new Error(typeof response.error === "string" ? response.error : "Audio daemon request failed"));
          else finish(undefined, response.result);
        } catch { finish(new Error("Invalid audio daemon response")); }
      });
      socket.once("error", () => finish(new Error("Audio daemon unavailable")));
      socket.once("close", () => { if (!settled) finish(new Error("Audio daemon disconnected")); });
    });
  }
}

export function audioSocketPath(runDir: string): string { return path.join(runDir, "audiod.sock"); }

export function validateBleAudioSelection(input: string | null, output: string | null): void {
  if (!output?.startsWith("ble-playback:")) return;
  const device = output.slice("ble-playback:".length);
  if (!/^\/org\/bluez\/hci\d+\/dev_(?:[\da-f]{2}_){5}[\da-f]{2}$/iu.test(device) || input !== `bluez:${device}`) {
    throw new Error("BLE playback must match the same selected StickS3 input");
  }
}

export function unavailableAudioStatus(): AudioDaemonStatus {
  return { available: false, protocol: "unavailable", connected: false, recordingId: null, generation: 0, recordings: [], playing: false, error: "Audio daemon unavailable" };
}
