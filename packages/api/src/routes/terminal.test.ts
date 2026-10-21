import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureNasRoots, openZosDb, type ZosDatabase } from "@zos/db";
import type { ZosConfig } from "@zos/shared";
import { buildServer } from "../server.js";
import { type TerminalPty, type TerminalRuntime } from "../lib/terminal.js";

let tempDir: string;
let rootDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-terminal-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir);
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: rootDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("terminal WebSocket", () => {
  it("starts in the user's home directory and forwards terminal traffic", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const socket = await connect(server);
    const homeDir = os.homedir();

    expect(await nextMessage(socket)).toMatchObject({ type: "ready", cwd: homeDir });
    expect(runtime.shell).toBe("");
    expect(runtime.options).toMatchObject({
      cols: 120,
      rows: 32,
      name: "xterm-256color"
    });

    runtime.terminal.emitData("zos$ ");
    expect(await nextMessage(socket)).toEqual({ type: "output", data: "zos$ " });

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
    const socket = await connect(server);
    const ready = await nextMessage(socket);
    const sessionId = ready.sessionId;

    socket.close();
    await socketEvent(socket, "close");
    await waitFor(() => runtime.terminals[0]!.disconnected);
    expect(runtime.terminals[0]!.killed).toBe(false);

    const reconnect = await connect(server, "local", String(sessionId));
    expect(await nextMessage(reconnect)).toEqual({ type: "ready", cwd: os.homedir(), sessionId });
    expect(runtime.spawnCount).toBe(2);
    expect(runtime.optionsHistory[0]!.sessionName).toBe(runtime.optionsHistory[1]!.sessionName);

    reconnect.send(JSON.stringify({ type: "close" }));
    await socketEvent(reconnect, "close");
    expect(runtime.terminals[1]!.killed).toBe(true);
    await server.close();
  });

  it("resets the previous session when a new session id is requested", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const firstSocket = await connect(server);
    const previousSessionId = String((await nextMessage(firstSocket)).sessionId);
    const nextSessionId = "22222222-2222-4222-8222-222222222222";

    const resetSocket = await connect(server, "local", nextSessionId, [
      `zos-reset.${previousSessionId}`,
      `zos-next.${nextSessionId}`
    ]);
    expect(await nextMessage(resetSocket)).toMatchObject({ type: "ready", sessionId: nextSessionId });
    expect(runtime.spawnCount).toBe(2);
    expect(runtime.terminals[0]!.killed).toBe(true);

    resetSocket.close();
    await socketEvent(resetSocket, "close");
    await server.close();
  });

  it("closes unknown-root sessions without spawning a shell", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const socket = await connect(server, "missing");

    expect(await nextMessage(socket)).toEqual({ type: "error", error: "NAS root not found" });
    await socketEvent(socket, "close");
    expect(runtime.spawned).toBe(false);
    await server.close();
  });

  it("terminates sessions that send invalid messages", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const socket = await connect(server);
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
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const initialized = await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize",
      payload: { rootId: "local", legacySessionId: sessionId }
    });
    expect(initialized.statusCode).toBe(200);

    const firstSocket = await connect(server, "local", sessionId);
    await nextMessage(firstSocket);
    const secondSocket = await connect(server, "local", sessionId);

    expect(await nextMessage(firstSocket)).toEqual({ type: "taken_over" });
    expect(await nextMessage(secondSocket)).toMatchObject({ type: "ready", sessionId });
    expect(runtime.optionsHistory[0]?.persistent).toBe(true);

    secondSocket.close();
    await socketEvent(secondSocket, "close");
    await server.close();
  });

  it("rejects a registered tab through a different root without spawning a shell", async () => {
    const otherRootDir = path.join(tempDir, "other-root");
    await mkdir(otherRootDir);
    ensureNasRoots(db, [
      { id: "local", name: "Local", path: rootDir },
      { id: "other", name: "Other", path: otherRootDir }
    ]);
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const initialized = await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize",
      payload: { rootId: "local", legacySessionId: sessionId }
    });
    expect(initialized.statusCode).toBe(200);

    const socket = await connect(server, "other", sessionId);

    expect(await nextMessage(socket)).toEqual({ type: "error", error: "Terminal session is not available" });
    await socketEvent(socket, "close");
    expect(runtime.spawned).toBe(false);
    await server.close();
  });
});

describe("terminal tab routes", () => {
  it("initializes, creates, renames, activates, and deletes persistent tabs", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const legacySessionId = "11111111-1111-4111-8111-111111111111";

    const empty = await server.inject({ method: "GET", url: "/api/terminal/tabs?rootId=local" });
    expect(empty.json()).toMatchObject({ initialized: false, tabs: [], activeTabId: null, maxSessions: 4 });

    const initialized = await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize",
      payload: { rootId: "local", legacySessionId }
    });
    expect(initialized.json()).toMatchObject({
      initialized: true,
      activeTabId: legacySessionId,
      tabs: [{ id: legacySessionId, ordinal: 1, customTitle: null }]
    });

    const created = await server.inject({ method: "POST", url: "/api/terminal/tabs", payload: { rootId: "local" } });
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

    const activated = await server.inject({ method: "POST", url: `/api/terminal/tabs/${legacySessionId}/activate` });
    expect(activated.json().activeTabId).toBe(legacySessionId);

    const deleted = await server.inject({ method: "DELETE", url: `/api/terminal/tabs/${secondId}` });
    expect(deleted.json()).toMatchObject({ activeTabId: legacySessionId });
    expect(deleted.json().tabs).toHaveLength(1);
    expect(runtime.destroyedSessionNames).toEqual([expect.stringMatching(/^zos-/u)]);
    await server.close();
  });

  it("validates roots, ids, names, and the global tab limit", async () => {
    const server = await buildServer({ config: testConfig(), db, terminal: new FakeTerminalRuntime() });

    expect((await server.inject({ method: "GET", url: "/api/terminal/tabs" })).statusCode).toBe(400);
    expect((await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize",
      payload: { rootId: "missing" }
    })).statusCode).toBe(404);
    expect((await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize",
      payload: { rootId: "local", legacySessionId: "invalid" }
    })).statusCode).toBe(400);

    const initialized = await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize",
      payload: { rootId: "local" }
    });
    const id = String(initialized.json().activeTabId);
    expect((await server.inject({
      method: "PATCH",
      url: `/api/terminal/tabs/${id}`,
      payload: { customTitle: "  " }
    })).statusCode).toBe(400);

    await server.inject({ method: "POST", url: "/api/terminal/tabs", payload: { rootId: "local" } });
    await server.inject({ method: "POST", url: "/api/terminal/tabs", payload: { rootId: "local" } });
    await server.inject({ method: "POST", url: "/api/terminal/tabs", payload: { rootId: "local" } });
    const limited = await server.inject({ method: "POST", url: "/api/terminal/tabs", payload: { rootId: "local" } });
    expect(limited.statusCode).toBe(409);
    expect(limited.json()).toEqual({ error: "Terminal session limit reached" });
    await server.close();
  });

  it("keeps tab metadata when helper destruction fails", async () => {
    const runtime = new FakeTerminalRuntime();
    const server = await buildServer({ config: testConfig(), db, terminal: runtime });
    const initialized = await server.inject({
      method: "POST",
      url: "/api/terminal/tabs/initialize",
      payload: { rootId: "local" }
    });
    const id = String(initialized.json().activeTabId);
    runtime.destroyError = new Error("tmux kill failed");

    const response = await server.inject({ method: "DELETE", url: `/api/terminal/tabs/${id}` });

    expect(response.statusCode).toBe(503);
    expect((await server.inject({ method: "GET", url: "/api/terminal/tabs?rootId=local" })).json()).toMatchObject({
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
      url: "/api/terminal/tabs/initialize",
      payload: { rootId: "local" }
    });
    const id = String(initialized.json().activeTabId);

    const restarted = await server.inject({ method: "POST", url: `/api/terminal/tabs/${id}/restart` });
    expect(restarted.statusCode).toBe(200);
    expect(restarted.json()).toMatchObject({ activeTabId: id, tabs: [{ id }] });
    expect(runtime.destroyedSessionNames).toHaveLength(1);

    runtime.destroyError = new Error("tmux kill failed");
    const failed = await server.inject({ method: "POST", url: `/api/terminal/tabs/${id}/restart` });
    expect(failed.statusCode).toBe(503);
    expect((await server.inject({ method: "GET", url: "/api/terminal/tabs?rootId=local" })).json()).toMatchObject({
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

function testConfig(): ZosConfig {
  return {
    dataDir: tempDir,
    databasePath: path.join(tempDir, "zos.sqlite"),
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50 },
    admin: { displayName: "Test Admin", authMode: "local-only" },
    model: { provider: "pi", piCommand: "pi", localEndpoint: null },
    docker: {
      enabled: false,
      socketPath: "/var/run/docker.sock",
      composeCommand: "docker",
      operationTimeoutMs: 120_000,
      consoleShells: ["/bin/sh"],
    },
    shares: {
      enabled: false,
      account: { username: "zos-share", password: null },
      shares: []
    },
    hostd: { socketPath: "/tmp/hostd.sock" },
    terminal: { user: "test-user", termuxSocketPath: "/tmp/termux.sock", maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: "/tmp/vod-player.sock", statePath: "/tmp/vod-player-session.json", commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "zos" },
    nasRoots: [{ id: "local", name: "Local", path: rootDir }]
  };
}

async function connect(
  server: Awaited<ReturnType<typeof buildServer>>,
  rootId = "local",
  sessionId?: string,
  extraProtocols: string[] = []
): Promise<WebSocket> {
  if (!server.server.listening) {
    await server.listen({ host: "127.0.0.1", port: 0 });
  }
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
  }
  const query = new URLSearchParams({ rootId, ...(sessionId ? { sessionId } : {}) });
  const protocols = sessionId
    ? ["zos-terminal-v1", `zos-session.${sessionId}`, ...extraProtocols]
    : ["zos-terminal-v1", ...extraProtocols];
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal?${query.toString()}`, protocols);
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
