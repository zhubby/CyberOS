import { randomUUID } from "node:crypto";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  decodeTermuxData,
  encodeTermuxData,
  encodeTermuxFrame,
  parseTermuxOpenResult,
  parseTermuxServerFrame,
  termuxCommand,
  termuxRequest,
  TERMUX_MAX_FRAME_BYTES,
  TERMUX_MAX_INPUT_BYTES,
  TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS,
  type TerminalConfig,
  type TermuxEvent,
  type TermuxServerFrame
} from "@zos/shared";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  type TerminalPty,
  type TerminalRuntime
} from "./terminal.js";

export function createTerminalRuntime(config: TerminalConfig): TerminalRuntime {
  return {
    async destroySession(sessionName) {
      if (!config.user) {
        throw new Error("Terminal user is not configured");
      }
      const timeoutMs = config.connectTimeoutMs ?? TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS;
      const socket = await connectSocket(config.termuxSocketPath, timeoutMs);
      const requestId = randomUUID();
      socket.write(encodeTermuxFrame(termuxRequest(requestId, "session.destroy", {
        user: config.user,
        sessionName
      })));
      const response = await waitForResponse(socket, requestId, timeoutMs, "destroying terminal session");
      socket.end();
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      if (response.result.sessionName !== sessionName) {
        throw new Error("Termux returned an unexpected destroy response");
      }
    },
    spawn(_shell, _args, options) {
      if (!config.user) {
        throw new Error("Terminal user is not configured");
      }
      return TermuxTerminalPty.connect(
        config.termuxSocketPath,
        config.user,
        options.cols,
        options.rows,
        options.sessionName,
        options.persistent,
        config.connectTimeoutMs ?? TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS
      );
    }
  };
}

class TermuxTerminalPty implements TerminalPty {
  readonly cwd: string;
  readonly shell: string;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(
    event: { exitCode: number; signal?: number; recoverable?: boolean }
  ) => void>();
  private readonly utf8Decoder = new StringDecoder("utf8");
  private frameBuffer: string;
  private pendingData: string[] = [];
  private exitEvent: { exitCode: number; signal?: number; recoverable?: boolean } | null = null;
  private exited = false;
  private closed = false;

  private constructor(
    private readonly socket: net.Socket,
    private readonly streamId: string,
    ready: { cwd: string; shell: string },
    initialBuffer: string,
    initialFrames: TermuxServerFrame[]
  ) {
    this.cwd = ready.cwd;
    this.shell = ready.shell;
    this.frameBuffer = initialBuffer;
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", () => this.finish(-1, undefined, true));
    socket.on("close", () => this.finish(-1, undefined, true));
    for (const frame of initialFrames) {
      this.handleFrame(frame);
    }
    socket.resume();
  }

  static async connect(
    socketPath: string,
    user: string,
    cols = DEFAULT_TERMINAL_COLS,
    rows = DEFAULT_TERMINAL_ROWS,
    sessionName?: string,
    persistent = false,
    timeoutMs = TERMINAL_SESSION_DEFAULT_CONNECT_TIMEOUT_MS
  ): Promise<TermuxTerminalPty> {
    const socket = await connectSocket(socketPath, timeoutMs);
    const requestId = randomUUID();
    socket.write(encodeTermuxFrame(termuxRequest(requestId, "session.open", {
      user,
      cols,
      rows,
      ...(sessionName ? { sessionName } : {}),
      ...(persistent ? { persistent: true } : {})
    })));
    const handshake = await waitForResponseWithPending(socket, requestId, timeoutMs, "connecting to Termux");
    if (!handshake.response.ok) {
      socket.destroy();
      throw new Error(handshake.response.error.message);
    }
    const ready = parseTermuxOpenResult(handshake.response.result);
    if (!ready || ready.user !== user) {
      socket.destroy();
      throw new Error("Termux returned an invalid session.open result");
    }
    return new TermuxTerminalPty(
      socket,
      ready.streamId,
      ready,
      handshake.pendingBuffer,
      handshake.pendingFrames
    );
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    for (const data of this.pendingData.splice(0)) {
      listener(data);
    }
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (
    event: { exitCode: number; signal?: number; recoverable?: boolean }
  ) => void): { dispose(): void } {
    if (this.exitEvent) {
      listener(this.exitEvent);
      return { dispose() {} };
    }
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    const bytes = Buffer.from(data, "utf8");
    for (let offset = 0; offset < bytes.length; offset += TERMUX_MAX_INPUT_BYTES) {
      this.send(termuxCommand(this.streamId, "terminal.input", {
        data: encodeTermuxData(bytes.subarray(offset, offset + TERMUX_MAX_INPUT_BYTES))
      }));
    }
  }

  resize(columns: number, rows: number): void {
    this.send(termuxCommand(this.streamId, "terminal.resize", { cols: columns, rows }));
  }

  kill(): void {
    this.close(true);
  }

  disconnect(): void {
    this.close(false);
  }

  private close(destroy: boolean): void {
    if (this.closed) return;
    this.send(termuxRequest(randomUUID(), "session.close", {
      streamId: this.streamId,
      ...(destroy ? { destroy: true } : {})
    }));
    this.closed = true;
    this.exited = true;
    this.socket.end();
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.frameBuffer += chunk;
    if (Buffer.byteLength(this.frameBuffer, "utf8") > TERMUX_MAX_FRAME_BYTES && !this.frameBuffer.includes("\n")) {
      this.fail("Termux frame is too large");
      return;
    }
    let newlineIndex = this.frameBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const frame = this.frameBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.frameBuffer = this.frameBuffer.slice(newlineIndex + 1);
      if (Buffer.byteLength(frame, "utf8") > TERMUX_MAX_FRAME_BYTES) {
        this.fail("Termux frame is too large");
        return;
      }
      const parsed = parseTermuxServerFrame(frame);
      if (!parsed) {
        this.fail("Invalid Termux response");
        return;
      }
      this.handleFrame(parsed);
      newlineIndex = this.frameBuffer.indexOf("\n");
    }
  }

  private handleFrame(frame: TermuxServerFrame): void {
    if (frame.kind !== "event") {
      this.fail("Termux sent an unexpected response");
      return;
    }
    if (frame.streamId !== this.streamId) {
      this.fail("Termux stream id does not match");
      return;
    }
    this.handleEvent(frame);
  }

  private handleEvent(event: TermuxEvent): void {
    switch (event.event) {
      case "terminal.output": {
        const bytes = decodeTermuxData(event.payload.data);
        if (!bytes) {
          this.fail("Termux sent invalid terminal output");
          return;
        }
        const data = this.utf8Decoder.write(bytes);
        if (!data) return;
        if (this.dataListeners.size) {
          for (const listener of this.dataListeners) listener(data);
        } else {
          this.pendingData.push(data);
        }
        break;
      }
      case "terminal.exit":
        this.flushDecoder();
        this.finish(event.payload.exitCode, event.payload.signal, event.payload.recoverable);
        break;
      case "terminal.error":
        this.fail(event.payload.message, event.payload.retryable);
        break;
    }
  }

  private flushDecoder(): void {
    const data = this.utf8Decoder.end();
    if (!data) return;
    if (this.dataListeners.size) {
      for (const listener of this.dataListeners) listener(data);
    } else {
      this.pendingData.push(data);
    }
  }

  private send(frame: Parameters<typeof encodeTermuxFrame>[0]): void {
    if (!this.closed && !this.socket.destroyed) {
      this.socket.write(encodeTermuxFrame(frame));
    }
  }

  private fail(_message: string, recoverable = true): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.finish(-1, undefined, recoverable);
  }

  private finish(exitCode: number, signal?: number, recoverable = false): void {
    if (this.exited) return;
    this.exited = true;
    this.closed = true;
    this.exitEvent = {
      exitCode,
      ...(signal === undefined ? {} : { signal }),
      ...(recoverable ? { recoverable: true } : {})
    };
    for (const listener of this.exitListeners) {
      listener(this.exitEvent);
    }
  }
}

async function waitForResponse(
  socket: net.Socket,
  requestId: string,
  timeoutMs: number,
  action: string
): Promise<Extract<TermuxServerFrame, { kind: "response" }>> {
  const { response } = await waitForResponseWithPending(socket, requestId, timeoutMs, action);
  socket.resume();
  return response;
}

function waitForResponseWithPending(
  socket: net.Socket,
  requestId: string,
  timeoutMs: number,
  action: string
): Promise<{
  response: Extract<TermuxServerFrame, { kind: "response" }>;
  pendingFrames: TermuxServerFrame[];
  pendingBuffer: string;
}> {
  return new Promise((resolve, reject) => {
    let frameBuffer = "";
    let response: Extract<TermuxServerFrame, { kind: "response" }> | null = null;
    const pendingFrames: TermuxServerFrame[] = [];
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`Timed out ${action}`)), timeoutMs);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      clearTimeout(timer);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error(`Termux connection closed while ${action}`));
    const onData = (chunk: string) => {
      frameBuffer += chunk;
      if (Buffer.byteLength(frameBuffer, "utf8") > TERMUX_MAX_FRAME_BYTES && !frameBuffer.includes("\n")) {
        fail(new Error("Termux frame is too large"));
        return;
      }
      let newlineIndex = frameBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const raw = frameBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
        frameBuffer = frameBuffer.slice(newlineIndex + 1);
        const frame = parseTermuxServerFrame(raw);
        if (!frame) {
          fail(new Error("Invalid Termux response"));
          return;
        }
        if (!response) {
          if (frame.kind !== "response" || frame.id !== requestId) {
            fail(new Error("Termux sent a frame before the matching response"));
            return;
          }
          response = frame;
        } else {
          pendingFrames.push(frame);
        }
        newlineIndex = frameBuffer.indexOf("\n");
      }
      if (response) {
        settled = true;
        socket.pause();
        cleanup();
        resolve({ response, pendingFrames, pendingBuffer: frameBuffer });
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out connecting to Termux"));
    }, timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(socket);
    });
  });
}
