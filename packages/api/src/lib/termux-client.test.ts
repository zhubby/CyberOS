import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeTermuxData,
  encodeTermuxData,
  encodeTermuxFrame,
  parseTermuxClientFrame,
  TERMUX_MAX_INPUT_BYTES,
  type TermuxClientFrame,
  type TermuxServerFrame
} from "@zos/shared";
import { createTerminalRuntime } from "./termux-client.js";

const STREAM_ID = "550e8400-e29b-41d4-a716-446655440000";
const sockets: net.Server[] = [];
const clientSockets: net.Socket[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const socket of clientSockets.splice(0)) socket.destroy();
  await Promise.all(sockets.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Termux client", () => {
  it("preserves output sent with ready, partial frames, and split UTF-8 bytes", async () => {
    const requests: TermuxClientFrame[] = [];
    const server = await createServer((socket, request) => {
      requests.push(request);
      if (request.kind === "request" && request.operation === "session.open") {
        const chinese = Buffer.from("终端", "utf8");
        socket.write(
          serverFrame({
            version: 1,
            kind: "response",
            id: request.id,
            ok: true,
            result: { streamId: STREAM_ID, user: request.payload.user, cwd: "/home/zhubby", shell: "/bin/bash" }
          }) + serverFrame({
            version: 1,
            kind: "event",
            streamId: STREAM_ID,
            event: "terminal.output",
            payload: { data: encodeTermuxData(Buffer.from("boot> ")) }
          }) + serverFrame({
            version: 1,
            kind: "event",
            streamId: STREAM_ID,
            event: "terminal.output",
            payload: { data: encodeTermuxData(chinese.subarray(0, 2)) }
          })
        );
        const delayed = serverFrame({
          version: 1,
          kind: "event",
          streamId: STREAM_ID,
          event: "terminal.output",
          payload: { data: encodeTermuxData(chinese.subarray(2)) }
        });
        socket.write(delayed.slice(0, 7));
        setTimeout(() => socket.write(delayed.slice(7)), 0);
      }
    });

    const runtime = createTerminalRuntime({ user: "zhubby", termuxSocketPath: server.socketPath });
    const terminal = await runtime.spawn("", [], {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      sessionName: "zos-persisted",
      persistent: true,
      env: {}
    });
    const output: string[] = [];
    terminal.onData((data) => output.push(data));

    await waitFor(() => output.join("").includes("终端"));
    expect(output.join("")).toBe("boot> 终端");
    expect(terminal.cwd).toBe("/home/zhubby");
    expect(terminal.shell).toBe("/bin/bash");
    expect(requests[0]).toMatchObject({
      kind: "request",
      operation: "session.open",
      payload: {
        user: "zhubby",
        cols: 120,
        rows: 32,
        sessionName: "zos-persisted",
        persistent: true
      }
    });

    terminal.write("whoami\r");
    terminal.resize(90, 24);
    await waitFor(() => requests.some((request) => request.kind === "command" && request.operation === "terminal.resize"));
    const input = requests.find((request) => request.kind === "command" && request.operation === "terminal.input");
    expect(input?.kind).toBe("command");
    if (input?.kind !== "command" || input.operation !== "terminal.input") throw new Error("missing input");
    expect(decodeTermuxData(input.payload.data)?.toString("utf8")).toBe("whoami\r");
    expect(requests).toContainEqual({
      version: 1,
      kind: "command",
      streamId: STREAM_ID,
      operation: "terminal.resize",
      payload: { cols: 90, rows: 24 }
    });
    terminal.kill();
    await waitFor(() => requests.some((request) => request.kind === "request" && request.operation === "session.close"));
    expect(requests.at(-1)).toMatchObject({ operation: "session.close", payload: { streamId: STREAM_ID, destroy: true } });
  });

  it("preserves output that arrives immediately after the ready response", async () => {
    const server = await createServer((socket, request) => {
      if (request.kind !== "request" || request.operation !== "session.open") return;
      socket.write(serverFrame({
        version: 1,
        kind: "response",
        id: request.id,
        ok: true,
        result: { streamId: STREAM_ID, user: request.payload.user, cwd: "/home/zhubby", shell: "/bin/bash" }
      }));
      setImmediate(() => socket.write(serverFrame({
        version: 1,
        kind: "event",
        streamId: STREAM_ID,
        event: "terminal.output",
        payload: { data: encodeTermuxData(Buffer.from("ready-output")) }
      })));
    });

    const runtime = createTerminalRuntime({ user: "zhubby", termuxSocketPath: server.socketPath });
    const terminal = await runtime.spawn("", [], { name: "xterm-256color", cols: 120, rows: 32, env: {} });
    const output: string[] = [];
    terminal.onData((data) => output.push(data));

    await waitFor(() => output.join("") === "ready-output");
    terminal.disconnect();
  });

  it("splits large UTF-8 input into bounded binary commands", async () => {
    const requests: TermuxClientFrame[] = [];
    const server = await createReadyServer(requests);
    const runtime = createTerminalRuntime({ user: "zhubby", termuxSocketPath: server.socketPath });
    const terminal = await runtime.spawn("", [], { name: "xterm-256color", cols: 120, rows: 32, env: {} });
    const input = "界".repeat(50_000);
    terminal.write(input);
    await waitFor(() => requests.filter((request) => request.kind === "command" && request.operation === "terminal.input").length >= 3);
    const chunks = requests
      .filter((request): request is Extract<TermuxClientFrame, { kind: "command"; operation: "terminal.input" }> => request.kind === "command" && request.operation === "terminal.input")
      .map((request) => decodeTermuxData(request.payload.data)!);
    expect(chunks.every((chunk) => chunk.length <= TERMUX_MAX_INPUT_BYTES)).toBe(true);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(input);
    terminal.disconnect();
  });

  it("disconnects an attachment without destroying the tmux session", async () => {
    const requests: TermuxClientFrame[] = [];
    const server = await createReadyServer(requests);
    const runtime = createTerminalRuntime({ user: "zhubby", termuxSocketPath: server.socketPath });
    const terminal = await runtime.spawn("", [], { name: "xterm-256color", cols: 120, rows: 32, env: {} });
    terminal.disconnect();
    await waitFor(() => requests.some((request) => request.kind === "request" && request.operation === "session.close"));
    expect(requests.at(-1)).toMatchObject({ operation: "session.close", payload: { streamId: STREAM_ID } });
    expect(requests.at(-1)).not.toMatchObject({ payload: { destroy: true } });
  });

  it("waits for an acknowledged session.destroy response", async () => {
    const requests: TermuxClientFrame[] = [];
    const server = await createServer((socket, request) => {
      requests.push(request);
      if (request.kind === "request" && request.operation === "session.destroy") {
        socket.write(serverFrame({
          version: 1,
          kind: "response",
          id: request.id,
          ok: true,
          result: { sessionName: request.payload.sessionName }
        }));
      }
    });
    const runtime = createTerminalRuntime({ user: "zhubby", termuxSocketPath: server.socketPath });
    await runtime.destroySession("zos-persisted");
    expect(requests[0]).toMatchObject({ operation: "session.destroy", payload: { user: "zhubby", sessionName: "zos-persisted" } });
  });

  it("propagates structured destroy failures", async () => {
    const server = await createServer((socket, request) => {
      if (request.kind === "request") {
        socket.write(serverFrame({
          version: 1,
          kind: "response",
          id: request.id,
          ok: false,
          error: { status: 502, code: "operation_failed", message: "tmux kill failed", retryable: false }
        }));
      }
    });
    const runtime = createTerminalRuntime({ user: "zhubby", termuxSocketPath: server.socketPath });
    await expect(runtime.destroySession("zos-persisted")).rejects.toThrow("tmux kill failed");
  });

  it("uses explicit and implicit recoverable exit signals", async () => {
    const requests: TermuxClientFrame[] = [];
    const server = await createReadyServer(requests, (socket) => {
      socket.write(serverFrame({
        version: 1,
        kind: "event",
        streamId: STREAM_ID,
        event: "terminal.exit",
        payload: { exitCode: 0, recoverable: true }
      }));
    });
    const runtime = createTerminalRuntime({ user: "zhubby", termuxSocketPath: server.socketPath });
    const terminal = await runtime.spawn("", [], { name: "xterm-256color", cols: 120, rows: 32, env: {} });
    await expect(new Promise((resolve) => terminal.onExit(resolve))).resolves.toMatchObject({ exitCode: 0, recoverable: true });

    const droppedServer = await createReadyServer([], (socket) => socket.end());
    const droppedRuntime = createTerminalRuntime({ user: "zhubby", termuxSocketPath: droppedServer.socketPath });
    const droppedTerminal = await droppedRuntime.spawn("", [], { name: "xterm-256color", cols: 120, rows: 32, env: {} });
    await expect(new Promise((resolve) => droppedTerminal.onExit(resolve))).resolves.toMatchObject({ exitCode: -1, recoverable: true });
  });

  it("rejects connections closed before ready and missing users", async () => {
    const server = await createServer((socket) => socket.destroy());
    const runtime = createTerminalRuntime({ user: "zhubby", termuxSocketPath: server.socketPath });
    await expect(runtime.spawn("", [], { name: "xterm-256color", cols: 120, rows: 32, env: {} })).rejects.toBeInstanceOf(Error);

    const disabled = createTerminalRuntime({ user: null, termuxSocketPath: "/run/zos/termux.sock" });
    expect(() => disabled.spawn("", [], { name: "xterm-256color", cols: 120, rows: 32, env: {} })).toThrow("Terminal user is not configured");
    await expect(disabled.destroySession("zos-persisted")).rejects.toThrow("Terminal user is not configured");
  });
});

function serverFrame(frame: TermuxServerFrame): string {
  return encodeTermuxFrame(frame);
}

async function createReadyServer(
  requests: TermuxClientFrame[],
  afterReady?: (socket: net.Socket) => void
): Promise<{ socketPath: string }> {
  return createServer((socket, request) => {
    requests.push(request);
    if (request.kind === "request" && request.operation === "session.open") {
      socket.write(serverFrame({
        version: 1,
        kind: "response",
        id: request.id,
        ok: true,
        result: { streamId: STREAM_ID, user: request.payload.user, cwd: "/home/zhubby", shell: "/bin/bash" }
      }));
      afterReady?.(socket);
    }
  });
}

async function createServer(
  onFrame: (socket: net.Socket, request: TermuxClientFrame) => void
): Promise<{ socketPath: string }> {
  const socketPath = await createSocketPath();
  const server = net.createServer((socket) => {
    clientSockets.push(socket);
    socket.setEncoding("utf8");
    let frameBuffer = "";
    socket.on("data", (chunk: string) => {
      frameBuffer += chunk;
      let newline = frameBuffer.indexOf("\n");
      while (newline >= 0) {
        const request = parseTermuxClientFrame(frameBuffer.slice(0, newline));
        frameBuffer = frameBuffer.slice(newline + 1);
        if (request) onFrame(socket, request);
        newline = frameBuffer.indexOf("\n");
      }
    });
  });
  sockets.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath };
}

async function createSocketPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zos-termux-client-"));
  tempDirs.push(directory);
  return path.join(directory, "termux.sock");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Termux update");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
