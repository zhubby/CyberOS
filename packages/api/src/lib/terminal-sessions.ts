import { createHash } from "node:crypto";
import { TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS } from "@cyberos/shared";
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  type TerminalPty,
  type TerminalRuntime
} from "./terminal.js";

export const TERMINAL_SESSION_IDLE_TIMEOUT_MS = TERMINAL_SESSION_DEFAULT_IDLE_TIMEOUT_MS;
const TERMINAL_SESSION_PENDING_OUTPUT_BYTES = 256 * 1024;
const TERMINAL_SESSION_OUTPUT_GAP = "\r\n[terminal output omitted while disconnected]\r\n";

interface TerminalSocket {
  close(): void;
  send(data: string): void;
}

interface TerminalSessionOptions {
  workspaceKey: string;
  idleTimeoutMs: number;
  onExit: (sessionId: string, terminal: TerminalPty) => void;
}

interface PendingCreation {
  readonly key: string;
  readonly workspaceKey: string;
  readonly sessionId: string;
  promise: Promise<TerminalSession>;
  waiters: number;
  session: TerminalSession | null;
  cancelled: boolean;
}

export interface TerminalSession {
  readonly id: string;
  readonly workspaceKey: string;
  readonly terminal: TerminalPty;
  readonly lastDetachedAt: number;
  attach(socket: TerminalSocket, send: TerminalSend): boolean;
  detach(socket: TerminalSocket): void;
  hasActiveSocket(): boolean;
  close(): void;
  disconnect(): void;
}

export type TerminalSend = (socket: TerminalSocket, payload: Record<string, unknown>) => boolean;

export interface TerminalSessionLease {
  readonly session: TerminalSession;
  release(keepAlive?: boolean): void;
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly pendingByKey = new Map<string, PendingCreation>();
  private closed = false;

  constructor(
    private readonly runtime: TerminalRuntime,
    private readonly idleTimeoutMs = TERMINAL_SESSION_IDLE_TIMEOUT_MS,
    private readonly maxSessions = 32
  ) {}

  async acquire(workspaceKey: string, requestedSessionId: string): Promise<TerminalSessionLease> {
    if (this.closed) {
      throw new Error("Terminal session manager is closed");
    }

    const sessionId = normalizeSessionId(requestedSessionId);
    if (!sessionId) throw new Error("Terminal session id is invalid");
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.workspaceKey !== workspaceKey) {
        throw new Error("Terminal session is not available");
      }
      return { session: existing, release: () => undefined };
    }

    const key = terminalSessionKey(workspaceKey, sessionId);
    let pending = this.pendingByKey.get(key);
    if (!pending) {
      this.ensureCapacity();
      pending = {
        key,
        workspaceKey,
        sessionId,
        promise: Promise.resolve(undefined as never),
        waiters: 0,
        session: null,
        cancelled: false
      };
      const creation = this.createSession(workspaceKey, sessionId);
      pending.promise = creation
        .then((session) => {
          pending!.session = session;
          if (this.closed) {
            session.disconnect();
          } else if (pending!.cancelled || pending!.waiters === 0) {
            session.close();
          } else {
            this.sessions.set(session.id, session);
          }
          return session;
        })
        .finally(() => {
          if (this.pendingByKey.get(key) === pending) {
            this.pendingByKey.delete(key);
          }
        });
      this.pendingByKey.set(key, pending);
    }

    pending.waiters += 1;
    let released = false;
    const release = (keepAlive = false) => {
      if (released) {
        return;
      }
      released = true;
      pending!.waiters = Math.max(0, pending!.waiters - 1);
      if (
        !keepAlive &&
        pending!.waiters === 0 &&
        pending!.session &&
        !pending!.session.hasActiveSocket()
      ) {
        pending!.session.close();
      }
    };

    try {
      return { session: await pending.promise, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  async destroy(workspaceKey: string, sessionId: string): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.workspaceKey !== workspaceKey) {
        throw new Error("Terminal session is not available");
      }
      existing.disconnect();
      this.sessions.delete(sessionId);
    }
    const key = terminalSessionKey(workspaceKey, sessionId);
    const pending = this.pendingByKey.get(key);
    if (pending) {
      pending.cancelled = true;
      this.pendingByKey.delete(key);
      await pending.promise.catch(() => undefined);
    }
    await this.runtime.destroySession(terminalSessionName(workspaceKey, sessionId));
  }

  detach(sessionId: string, socket: TerminalSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.detach(socket);
    if (!session.hasActiveSocket()) {
      session.disconnect();
    }
  }

  close(sessionId: string, workspaceKey?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (workspaceKey && session.workspaceKey !== workspaceKey) {
        return false;
      }
      session.close();
      this.sessions.delete(sessionId);
      return true;
    }

    let cancelled = false;
    for (const pending of this.pendingByKey.values()) {
      if (pending.sessionId === sessionId && (!workspaceKey || pending.workspaceKey === workspaceKey)) {
        pending.cancelled = true;
        cancelled = true;
      }
    }
    return cancelled;
  }

  disconnectAll(): void {
    this.closed = true;
    for (const session of this.sessions.values()) {
      session.disconnect();
    }
    this.sessions.clear();
    for (const pending of this.pendingByKey.values()) {
      pending.cancelled = true;
    }
    this.pendingByKey.clear();
  }

  private async createSession(workspaceKey: string, sessionId: string): Promise<TerminalSession> {
    const terminal = await this.runtime.spawn("", [], {
      name: "xterm-256color",
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
      sessionName: terminalSessionName(workspaceKey, sessionId),
      persistent: true,
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });
    return createTerminalSession({
      workspaceKey,
      idleTimeoutMs: this.idleTimeoutMs,
      onExit: (exitedSessionId, exitedTerminal) => {
        const current = this.sessions.get(exitedSessionId);
        if (current?.terminal === exitedTerminal) {
          this.sessions.delete(exitedSessionId);
        }
      }
    }, sessionId, terminal);
  }

  private ensureCapacity(): void {
    if (this.sessions.size + this.pendingByKey.size < this.maxSessions) {
      return;
    }
    const oldestDetached = [...this.sessions.values()]
      .filter((session) => !session.hasActiveSocket())
      .sort((left, right) => left.lastDetachedAt - right.lastDetachedAt)[0];
    if (oldestDetached) {
      oldestDetached.close();
      this.sessions.delete(oldestDetached.id);
    }
    if (this.sessions.size + this.pendingByKey.size >= this.maxSessions) {
      throw new Error("Terminal session limit reached");
    }
  }

}

function createTerminalSession(
  options: TerminalSessionOptions,
  id: string,
  terminal: TerminalPty
): TerminalSession {
  let activeSocket: TerminalSocket | null = null;
  let activeSend: TerminalSend | null = null;
  let pendingOutput: string[] = [];
  let pendingOutputBytes = 0;
  let pendingOutputTruncated = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let detachedAt = Date.now();
  let closed = false;

  const appendPendingOutput = (data: string) => {
    pendingOutput.push(data);
    pendingOutputBytes += Buffer.byteLength(data, "utf8");
    while (pendingOutputBytes > TERMINAL_SESSION_PENDING_OUTPUT_BYTES && pendingOutput.length > 0) {
      const removed = pendingOutput.shift()!;
      pendingOutputBytes -= Buffer.byteLength(removed, "utf8");
      pendingOutputTruncated = true;
    }
  };

  const scheduleIdleClose = () => {
    if (idleTimer || closed) {
      return;
    }
    idleTimer = setTimeout(() => session.close(), options.idleTimeoutMs);
    idleTimer.unref?.();
  };

  const dataSubscription = terminal.onData((data) => {
    if (closed) {
      return;
    }
    if (activeSocket && activeSend) {
      if (activeSend(activeSocket, { type: "output", data })) {
        return;
      }
      const failedSocket = activeSocket;
      activeSocket = null;
      activeSend = null;
      detachedAt = Date.now();
      try {
        failedSocket.close();
      } catch {
        // The browser may already have disconnected.
      }
      scheduleIdleClose();
    }
    appendPendingOutput(data);
  });

  let exitSubscription: { dispose(): void } | null = null;
  const session: TerminalSession = {
    id,
    workspaceKey: options.workspaceKey,
    terminal,
    get lastDetachedAt() {
      return detachedAt;
    },
    attach(socket, send) {
      if (closed) {
        return false;
      }
      if (activeSocket && activeSocket !== socket) {
        activeSend?.(activeSocket, { type: "taken_over" });
        try {
          activeSocket.close();
        } catch {
          // The previous browser connection may already be closed.
        }
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      activeSocket = socket;
      activeSend = send;
      if (!send(socket, { type: "ready", cwd: terminal.cwd, sessionId: id })) {
        activeSocket = null;
        activeSend = null;
        detachedAt = Date.now();
        scheduleIdleClose();
        return false;
      }
      if (pendingOutputTruncated) {
        if (!send(socket, { type: "output", data: TERMINAL_SESSION_OUTPUT_GAP, truncated: true })) {
          activeSocket = null;
          activeSend = null;
          detachedAt = Date.now();
          scheduleIdleClose();
          return false;
        }
      }
      for (let index = 0; index < pendingOutput.length; index += 1) {
        if (!send(socket, { type: "output", data: pendingOutput[index] })) {
          pendingOutput = pendingOutput.slice(index);
          pendingOutputBytes = pendingOutput.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0);
          activeSocket = null;
          activeSend = null;
          detachedAt = Date.now();
          scheduleIdleClose();
          return false;
        }
      }
      pendingOutput = [];
      pendingOutputBytes = 0;
      pendingOutputTruncated = false;
      detachedAt = 0;
      return true;
    },
    detach(socket) {
      if (closed || activeSocket !== socket) {
        return;
      }
      activeSocket = null;
      activeSend = null;
      detachedAt = Date.now();
      scheduleIdleClose();
    },
    hasActiveSocket() {
      return activeSocket !== null;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      dataSubscription.dispose();
      exitSubscription?.dispose();
      exitSubscription = null;
      const socket = activeSocket;
      activeSocket = null;
      activeSend = null;
      try {
        terminal.kill();
      } catch {
        // The process may already have exited.
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          // The browser may already have disconnected.
        }
      }
      options.onExit(id, terminal);
    },
    disconnect() {
      if (closed) {
        return;
      }
      closed = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      dataSubscription.dispose();
      exitSubscription?.dispose();
      exitSubscription = null;
      const socket = activeSocket;
      activeSocket = null;
      activeSend = null;
      try {
        terminal.disconnect();
      } catch {
        // The broker connection may already be closed.
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          // The browser may already have disconnected.
        }
      }
      options.onExit(id, terminal);
    }
  };

  exitSubscription = terminal.onExit(({ exitCode, signal, recoverable }) => {
    if (closed) {
      return;
    }
    const socket = activeSocket;
    if (socket && !recoverable) {
      optionsSend(socket, { type: "exit", exitCode, ...(signal === undefined ? {} : { signal }) });
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        // The browser may already have disconnected.
      }
    }
    closed = true;
    dataSubscription.dispose();
    exitSubscription?.dispose();
    exitSubscription = null;
    activeSocket = null;
    activeSend = null;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    options.onExit(id, terminal);
  });

  return session;
}

export function terminalSessionName(workspaceKey: string, sessionId: string): string {
  const digest = createHash("sha256").update(workspaceKey).update("\0").update(sessionId).digest("hex");
  return `cyberos-${digest.slice(0, 48)}`;
}

function terminalSessionKey(workspaceKey: string, sessionId: string): string {
  return `${workspaceKey}\0${sessionId}`;
}

function normalizeSessionId(value: string): string | null {
  const trimmed = value?.trim();
  return trimmed && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(trimmed)
    ? trimmed.toLowerCase()
    : null;
}

function optionsSend(socket: TerminalSocket, payload: Record<string, unknown>): boolean {
  return sendSocket(socket, payload);
}

function sendSocket(socket: TerminalSocket, payload: Record<string, unknown>): boolean {
  const readyState = (socket as TerminalSocket & { readyState?: unknown }).readyState;
  if (typeof readyState === "number" && readyState !== 1) {
    return false;
  }
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
