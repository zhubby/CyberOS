import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCyberOsDb, type CyberOsDatabase } from "@cyberos/db";
import { loadCyberOsRuntime, type CyberOsRuntime } from "@cyberos/shared";
import { buildServer } from "../server.js";
import { type TerminalPty, type TerminalRuntime } from "../lib/terminal.js";

let tempDir: string;
let rootDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-terminal-"));
  rootDir = path.join(tempDir, "data");
  await mkdir(rootDir, { recursive: true });
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("terminal WebSocket", () => {
  it("starts in the user's home directory and forwards terminal traffic", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const sessionId = await initializeTab(server);
    const socket = await connect(server, sessionId);
    const homeDir = os.homedir();

    expect(await nextMessage(socket)).toMatchObject({ type: "ready", cwd: homeDir });
    expect(runtime.shell).toBe("");
    expect(runtime.options).toMatchObject({
      cols: 120,
      rows: 32,
      name: "xterm-256color"
    });

    runtime.terminal.emitData("cyberos$ ");
    expect(await nextMessage(socket)).toEqual({ type: "output", data: "cyberos$ " });

    socket.send(JSON.stringify({ type: "input", data: "pwd\r" }));
    await waitFor(() => runtime.terminal.writes.includes("pwd\r"));
    socket.send(JSON.stringify({ type: "resize", cols: 90, rows: 24 }));
    await waitFor(() => runtime.terminal.resizes.some(([cols, rows]) => cols === 90 && rows === 24));

    socket.close();
    await socketEvent(socket, "close");
    await waitFor(() => runtime.terminal.disconnected);
    expect(runtime.terminal.killed).toBe(false);
    expect(runtime.terminal.disconnected).toBe(true);
    await server.close();
  });

  it("releases the broker attachment and reconnects the persistent tmux session", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const sessionId = await initializeTab(server);
    const socket = await connect(server, sessionId);
    const ready = await nextMessage(socket);
    expect(ready.sessionId).toBe(sessionId);

    socket.close();
    await socketEvent(socket, "close");
    await waitFor(() => runtime.terminals[0]!.disconnected);
    expect(runtime.terminals[0]!.killed).toBe(false);

    const reconnect = await connect(server, sessionId);
    expect(await nextMessage(reconnect)).toEqual({ type: "ready", cwd: os.homedir(), sessionId });
    expect(runtime.spawnCount).toBe(2);
    expect(runtime.optionsHistory[0]!.sessionName).toBe(runtime.optionsHistory[1]!.sessionName);

    reconnect.send(JSON.stringify({ type: "close" }));
    await socketEvent(reconnect, "close");
    expect(runtime.terminals[1]!.killed).toBe(true);
    await server.close();
  });

  it("rejects connections without a registered persistent tab", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const missingProtocol = await connect(server);
    expect(await nextMessage(missingProtocol)).toEqual({
      type: "error",
      error: "Terminal requires the current WebSocket protocol and a registered tab"
    });
    await socketEvent(missingProtocol, "close");

    const unknownTab = await connect(server, "22222222-2222-4222-8222-222222222222");
    expect(await nextMessage(unknownTab)).toEqual({ type: "error", error: "Terminal tab is not registered" });
    await socketEvent(unknownTab, "close");
    expect(runtime.spawnCount).toBe(0);
    await server.close();
  });

  it("uses the global terminal workspace without a storage-pool selection", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const sessionId = await initializeTab(server);
    const socket = await connect(server, sessionId);

    expect(await nextMessage(socket)).toMatchObject({ type: "ready" });
    expect(runtime.spawned).toBe(true);
    expect(runtime.options?.sessionName).toMatch(/^cyberos-/u);
    socket.close();
    await socketEvent(socket, "close");
    await server.close();
  });

  it("terminates sessions that send invalid messages", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const sessionId = await initializeTab(server);
    const socket = await connect(server, sessionId);
    await nextMessage(socket);

    socket.send(JSON.stringify({ type: "resize", cols: 1, rows: 32 }));
    expect(await nextMessage(socket)).toEqual({ type: "error", error: "Invalid terminal message" });
    await socketEvent(socket, "close");
    expect(runtime.terminal.killed).toBe(true);
    await server.close();
  });

  it("marks registered tabs persistent and notifies the previous controller on takeover", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const initialized = await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize"
    });
    expect(initialized.statusCode).toBe(200);
    const sessionId = String(initialized.json().activeTabId);

    const firstSocket = await connect(server, sessionId);
    await nextMessage(firstSocket);
    const secondSocket = await connect(server, sessionId);

    expect(await nextMessage(firstSocket)).toEqual({ type: "taken_over" });
    expect(await nextMessage(secondSocket)).toMatchObject({ type: "ready", sessionId });
    expect(runtime.optionsHistory[0]?.persistent).toBe(true);

    secondSocket.close();
    await socketEvent(secondSocket, "close");
    await server.close();
  });

});

describe("terminal tab routes", () => {
  it("initializes, creates, renames, activates, and deletes persistent tabs", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const empty = await server.inject({ method: "GET", url: "/api/terminal/tabs" });
    expect(empty.json()).toMatchObject({ initialized: false, tabs: [], activeTabId: null, maxSessions: 4 });

    const initialized = await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize"
    });
    const firstId = String(initialized.json().activeTabId);
    expect(initialized.json()).toMatchObject({
      initialized: true,
      activeTabId: firstId,
      tabs: [{ id: firstId, ordinal: 1, customTitle: null }]
    });

    const created = await server.inject({ method: "POST", url: "/api/terminal/tabs" });
    expect(created.statusCode).toBe(201);
    const createdState = created.json();
    const secondId = String(createdState.activeTabId);
    expect(createdState.tabs).toHaveLength(2);

    const renamed = await server.inject({
      method: "PATCH",
      url: `/api/terminal/tabs/${secondId}`,
      payload: { customTitle: " Build shell " }
    });
    expect(renamed.json().tabs[1].customTitle).toBe("Build shell");

    const activated = await server.inject({ method: "POST", url: `/api/terminal/tabs/${firstId}/activate` });
    expect(activated.json().activeTabId).toBe(firstId);

    const deleted = await server.inject({ method: "DELETE", url: `/api/terminal/tabs/${secondId}` });
    expect(deleted.json()).toMatchObject({ activeTabId: firstId });
    expect(deleted.json().tabs).toHaveLength(1);
    expect(runtime.destroyedSessionNames).toEqual([expect.stringMatching(/^cyberos-/u)]);
    await server.close();
  });

  it("validates ids, names, and the global tab limit", async () => {
    const server = await buildServer({ config: testConfig(), db, terminal: new FakeTerminalRuntime() });

    expect((await server.inject({ method: "GET", url: "/api/terminal/tabs" })).statusCode).toBe(200);
    const initialized = await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize"
    });
    const id = String(initialized.json().activeTabId);
    expect((await server.inject({
      method: "PATCH",
      url: `/api/terminal/tabs/${id}`,
      payload: { customTitle: "  " }
    })).statusCode).toBe(400);

    await server.inject({ method: "POST", url: "/api/terminal/tabs" });
    await server.inject({ method: "POST", url: "/api/terminal/tabs" });
    await server.inject({ method: "POST", url: "/api/terminal/tabs" });
    const limited = await server.inject({ method: "POST", url: "/api/terminal/tabs" });
    expect(limited.statusCode).toBe(409);
    expect(limited.json()).toEqual({ error: "Terminal session limit reached" });
    await server.close();
  });

  it("keeps tab metadata when helper destruction fails", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const initialized = await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize"
    });
    const id = String(initialized.json().activeTabId);
    runtime.destroyError = new Error("tmux kill failed");

    const response = await server.inject({ method: "DELETE", url: `/api/terminal/tabs/${id}` });

    expect(response.statusCode).toBe(503);
    expect((await server.inject({ method: "GET", url: "/api/terminal/tabs" })).json()).toMatchObject({
      activeTabId: id,
      tabs: [{ id }]
    });
    await server.close();
  });

  it("restarts a tab without deleting metadata and preserves it on destroy failure", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const initialized = await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize"
    });
    const id = String(initialized.json().activeTabId);

    const restarted = await server.inject({ method: "POST", url: `/api/terminal/tabs/${id}/restart` });
    expect(restarted.statusCode).toBe(200);
    expect(restarted.json()).toMatchObject({ activeTabId: id, tabs: [{ id }] });
    expect(runtime.destroyedSessionNames).toHaveLength(1);

    runtime.destroyError = new Error("tmux kill failed");
    const failed = await server.inject({ method: "POST", url: `/api/terminal/tabs/${id}/restart` });
    expect(failed.statusCode).toBe(503);
    expect((await server.inject({ method: "GET", url: "/api/terminal/tabs" })).json()).toMatchObject({
      activeTabId: id,
      tabs: [{ id }]
    });
    await server.close();
  });
});

class FakeTerminalRuntime implements TerminalRuntime {
  terminal = new FakeTerminal();
  terminals: FakeTerminal[] = [this.terminal];
  spawned = false;
  spawnCount = 0;
  shell = "";
  options: Parameters<TerminalRuntime["spawn"]>[2] | null = null;
  optionsHistory: Array<Parameters<TerminalRuntime["spawn"]>[2]> = [];
  destroyError: Error | null = null;
  destroyedSessionNames: string[] = [];

  async destroySession(sessionName: string): Promise<void> {
    if (this.destroyError) throw this.destroyError;
    this.destroyedSessionNames.push(sessionName);
  }

  spawn(shell: string, _args: string[], options: Parameters<TerminalRuntime["spawn"]>[2]): TerminalPty {
    this.spawned = true;
    this.spawnCount += 1;
    this.shell = shell;
    this.options = options;
    this.optionsHistory.push(options);
    if (this.spawnCount > 1) {
      this.terminal = new FakeTerminal();
      this.terminals.push(this.terminal);
    }
    return this.terminal;
  }
}

class FakeTerminal implements TerminalPty {
  readonly cwd = os.homedir();
  readonly shell = "/usr/bin/zsh";
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  disconnected = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  private readonly pendingData: string[] = [];

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    for (const data of this.pendingData.splice(0)) {
      listener(data);
    }
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(columns: number, rows: number): void {
    this.resizes.push([columns, rows]);
  }

  kill(): void {
    this.killed = true;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emitData(data: string): void {
    if (!this.dataListeners.size) {
      this.pendingData.push(data);
      return;
    }
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode = 0): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode });
    }
  }
}

function testConfig(): CyberOsRuntime {
  const base = loadCyberOsRuntime({ CYBEROS_ROOT: tempDir }, tempDir);
  return {
    ...base,
    paths: { ...base.paths, dataRoot: rootDir, databasePath: path.join(tempDir, "cyberos.sqlite") },
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50, concurrency: 1 },
    admin: { displayName: "Test Admin", authMode: "local-only" },
    docker: {
      enabled: false,
      socketPath: "/var/run/docker.sock",
      composeCommand: "docker",
      operationTimeoutMs: 120_000,
      consoleShells: ["/bin/sh"],
    },
    shares: {
      enabled: false,
      account: { username: "cyberos-share", password: null },
      shares: []
    },
    hostd: { socketPath: "/tmp/hostd.sock" },
    terminal: { user: "test-user", socketPath: "/tmp/terminald.sock", sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: "/tmp/vod-player.sock", statePath: "/tmp/vod-player-session.json", commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "cyberos" },
  };
}

async function connect(
  server: Awaited<ReturnType<typeof buildServer>>,
  sessionId?: string
): Promise<WebSocket> {
  if (!server.server.listening) {
    await server.listen({ host: "127.0.0.1", port: 0 });
  }
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
  }
  const protocols = sessionId
    ? ["cyberos-terminal-v1", `cyberos-session.${sessionId}`]
    : ["cyberos-terminal-v1"];
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal`, protocols);
  messageQueues.set(socket, { queue: [], waiter: null });
  socket.addEventListener("message", (event) => {
    const state = messageQueues.get(socket);
    if (!state) {
      return;
    }
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (state.waiter) {
      state.waiter(message);
      state.waiter = null;
    } else {
      state.queue.push(message);
    }
  });
  await socketEvent(socket, "open");
  return socket;
}

async function initializeTab(server: Awaited<ReturnType<typeof buildServer>>): Promise<string> {
  const response = await server.inject({ method: "POST", url: "/api/terminal/tabs/initialize" });
  expect(response.statusCode).toBe(200);
  return String(response.json().activeTabId);
}

const messageQueues = new WeakMap<WebSocket, {
  queue: Record<string, unknown>[];
  waiter: ((message: Record<string, unknown>) => void) | null;
}>();

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for terminal message")), 2_000);
    const state = messageQueues.get(socket);
    const queued = state?.queue.shift();
    if (queued) {
      clearTimeout(timer);
      resolve(queued);
      return;
    }
    if (state) {
      state.waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
    }
  });
}

function socketEvent(socket: WebSocket, eventName: "close" | "open"): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for WebSocket ${eventName}`)), 2_000);
    socket.addEventListener(eventName, (event) => {
      clearTimeout(timer);
      resolve(event);
    }, { once: true });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fake terminal update");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
