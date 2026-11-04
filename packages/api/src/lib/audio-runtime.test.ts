import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UnixAudioRuntime } from "./audio-runtime.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function daemon() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "audio-ipc-"));
  const socketPath = path.join(directory, "audiod.sock");
  let received!: (socket: net.Socket) => void;
  const request = new Promise<net.Socket>((resolve) => { received = resolve; });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => { sockets.add(socket); socket.once("data", () => received(socket)); });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => { sockets.forEach((socket) => socket.destroy()); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return { runtime: new UnixAudioRuntime(socketPath), request };
}

it("keeps BLE requests alive for transfer plus actual device playback", async () => {
  const { runtime, request } = await daemon();
  const operation = runtime.play(Buffer.from("wav"), "ble-playback:/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF", 5, 1);
  const reply = await request;
  let finished = false;
  void operation.then(() => { finished = true; }, () => { finished = true; });
  await vi.advanceTimersByTimeAsync(269_999);
  expect(finished).toBe(false);
  reply.end(`${JSON.stringify({ ok: true, result: null })}\n`);
  await expect(operation).resolves.toBeUndefined();
});

it.each([["alsa/hdmi", 135_000], ["ble-playback:/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF", 270_000]])("bounds the %s IPC wait without changing ALSA", async (device, timeout) => {
  const { runtime, request } = await daemon();
  const operation = runtime.play(Buffer.from("wav"), device, 5, 1);
  const result = expect(operation).rejects.toThrow("Audio daemon timed out");
  await request;
  await vi.advanceTimersByTimeAsync(timeout);
  await result;
});
