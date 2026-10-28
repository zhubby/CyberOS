import type { FastifyInstance, FastifyReply } from "fastify";
import {
  activateTerminalTab,
  createTerminalTab,
  deleteTerminalTab,
  getTerminalTab,
  getTerminalTabState,
  initializeTerminalTabs,
  renameTerminalTab
} from "@cyberos/db";
import type { ApiRouteContext } from "../context.js";
import { terminalMessage } from "../lib/terminal.js";
import { createTerminalRuntime } from "../lib/terminal-client.js";
import {
  TerminalSessionManager,
  type TerminalSession,
  type TerminalSessionLease
} from "../lib/terminal-sessions.js";

export function registerTerminalRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const dataRoot = context.config.paths.dataRoot;
  const runtime = context.terminal ?? createTerminalRuntime(context.config.terminal);
  const maxSessions = context.config.terminal.maxSessions;
  const sessions = new TerminalSessionManager(
    runtime,
    context.config.terminal.sessionIdleTimeoutMs,
    maxSessions
  );
  server.addHook("onClose", async () => {
    sessions.disconnectAll();
  });

  server.get("/api/terminal/tabs", async (_request, reply) => {
    reply.send(getTerminalTabState(context.db, maxSessions));
  });

  server.post("/api/terminal/tabs/initialize", async (_request, reply) => {
    try {
      reply.send(initializeTerminalTabs(context.db, { maxSessions }));
    } catch (error) {
      sendTerminalTabMutationError(reply, error);
    }
  });

  server.post("/api/terminal/tabs", async (_request, reply) => {
    try {
      reply.status(201).send(createTerminalTab(context.db, { maxSessions }));
    } catch (error) {
      sendTerminalTabMutationError(reply, error);
    }
  });

  server.patch<{ Params: { id: string }; Body: { customTitle?: string | null } }>("/api/terminal/tabs/:id", async (request, reply) => {
    if (!isTerminalSessionId(request.params.id)) {
      reply.status(400).send({ error: "Invalid terminal session id" });
      return;
    }
    const title = normalizeTerminalTabTitle(request.body?.customTitle);
    if ("error" in title) {
      reply.status(400).send({ error: title.error });
      return;
    }
    const state = renameTerminalTab(context.db, {
      id: request.params.id,
      customTitle: title.value,
      maxSessions
    });
    if (!state) {
      reply.status(404).send({ error: "Terminal tab not found" });
      return;
    }
    reply.send(state);
  });

  server.post<{ Params: { id: string } }>("/api/terminal/tabs/:id/activate", async (request, reply) => {
    if (!isTerminalSessionId(request.params.id)) {
      reply.status(400).send({ error: "Invalid terminal session id" });
      return;
    }
    const state = activateTerminalTab(context.db, { id: request.params.id, maxSessions });
    if (!state) {
      reply.status(404).send({ error: "Terminal tab not found" });
      return;
    }
    reply.send(state);
  });

  server.post<{ Params: { id: string } }>("/api/terminal/tabs/:id/restart", async (request, reply) => {
    const tab = terminalTab(context, request.params.id, reply);
    if (!tab) return;
    try {
      await sessions.destroy(dataRoot, tab.id);
      reply.send(getTerminalTabState(context.db, maxSessions));
    } catch (error) {
      reply.status(503).send({ error: terminalErrorMessage(error) });
    }
  });

  server.delete<{ Params: { id: string } }>("/api/terminal/tabs/:id", async (request, reply) => {
    const tab = terminalTab(context, request.params.id, reply);
    if (!tab) return;
    try {
      await sessions.destroy(dataRoot, tab.id);
    } catch (error) {
      reply.status(503).send({ error: terminalErrorMessage(error) });
      return;
    }
    const state = deleteTerminalTab(context.db, { id: tab.id, maxSessions });
    if (!state) {
      reply.status(404).send({ error: "Terminal tab not found" });
      return;
    }
    reply.send(state);
  });

  server.get("/api/terminal", { websocket: true }, async (socket, request) => {
    const protocol = parseTerminalProtocol(request.headers["sec-websocket-protocol"]);
    if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host, context.config.api.allowedOrigins)) {
      closeWithError(socket, "Terminal origin is not allowed");
      return;
    }
    if (!protocol) {
      closeWithError(socket, "Terminal requires the current WebSocket protocol and a registered tab");
      return;
    }
    const requestedTab = getTerminalTab(context.db, protocol.sessionId);
    if (!requestedTab) {
      closeWithError(socket, "Terminal tab is not registered");
      return;
    }

    let closed = false;
    let sessionId: string | null = null;
    let attachedSession: TerminalSession | null = null;
    let lease: TerminalSessionLease | null = null;
    const detachConnection = () => {
      if (closed) {
        return;
      }
      closed = true;
      stopHeartbeat();
      if (attachedSession) {
        sessions.detach(attachedSession.id, socket);
      } else {
        lease?.release();
      }
    };
    const stopHeartbeat = startHeartbeat(socket, () => {
      detachConnection();
      terminateSocket(socket);
    });
    socket.on("close", detachConnection);
    socket.on("error", detachConnection);

    const fail = (message: string) => {
      if (closed) {
        return;
      }
      closed = true;
      stopHeartbeat();
      sendSocket(socket, { type: "error", error: message });
      if (sessionId) {
        sessions.close(sessionId);
      } else {
        lease?.release();
      }
      socket.close();
    };

    try {
      lease = await sessions.acquire(dataRoot, requestedTab.id);
      const session = lease.session;
      if (closed) {
        lease.release();
        return;
      }
      sessionId = session.id;
      attachedSession = session;
      if (!session.attach(socket, sendSocket)) {
        lease.release();
        closed = true;
        stopHeartbeat();
        socket.close();
        return;
      }
      lease.release(true);

      socket.on("message", (raw: unknown) => {
        if (closed) {
          return;
        }
        const message = terminalMessage(socketDataToString(raw));
        if (!message) {
          fail("Invalid terminal message");
          return;
        }
        try {
          if (message.type === "input") {
            session.terminal.write(message.data);
          } else if (message.type === "resize") {
            session.terminal.resize(message.cols, message.rows);
          } else {
            stopHeartbeat();
            closed = true;
            sessions.close(session.id);
            socket.close();
          }
        } catch {
          fail("Unable to update terminal session");
        }
      });
    } catch (error) {
      stopHeartbeat();
      if (sessionId) {
        sessions.close(sessionId);
      } else {
        lease?.release();
      }
      sendSocket(socket, { type: "error", error: terminalErrorMessage(error) });
      socket.close();
    }
  });
}

function terminalTab(context: ApiRouteContext, id: string, reply: FastifyReply) {
  if (!isTerminalSessionId(id)) {
    reply.status(400).send({ error: "Invalid terminal session id" });
    return null;
  }
  const tab = getTerminalTab(context.db, id);
  if (!tab) {
    reply.status(404).send({ error: "Terminal tab not found" });
    return null;
  }
  return tab;
}

function normalizeTerminalTabTitle(value: unknown): { value: string | null } | { error: string } {
  if (value === null) {
    return { value: null };
  }
  if (typeof value !== "string") {
    return { error: "Terminal tab title is required" };
  }
  const title = value.trim();
  return title.length >= 1 && title.length <= 64
    ? { value: title }
    : { error: "Terminal tab title must be between 1 and 64 characters" };
}

function isTerminalSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function sendTerminalTabMutationError(reply: FastifyReply, error: unknown): void {
  const message = terminalErrorMessage(error);
  if (message === "Terminal session limit reached" || message === "Terminal session is not available") {
    reply.status(409).send({ error: message });
    return;
  }
  throw error;
}

function closeWithError(socket: { send(data: string): void; close(): void }, error: string): void {
  sendSocket(socket, { type: "error", error });
  socket.close();
}

function sendSocket(socket: { send(data: string): void; readyState?: number }, payload: Record<string, unknown>): boolean {
  if (typeof socket.readyState === "number" && socket.readyState !== 1) {
    return false;
  }
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    // The client may already be closed.
    return false;
  }
}

function isAllowedWebSocketOrigin(origin: string | undefined, host: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) {
    return true;
  }
  if (allowedOrigins.includes(origin)) {
    return true;
  }
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function startHeartbeat(socket: unknown, onDead: () => void): () => void {
  const ws = socket as {
    ping?: () => void;
    terminate?: () => void;
    on?: (event: string, listener: () => void) => void;
    off?: (event: string, listener: () => void) => void;
  };
  let alive = true;
  const onPong = () => {
    alive = true;
  };
  ws.on?.("pong", onPong);
  const timer = setInterval(() => {
    if (!alive) {
      ws.terminate?.();
      onDead();
      return;
    }
    alive = false;
    ws.ping?.();
  }, 30_000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    ws.off?.("pong", onPong);
  };
}

function terminateSocket(socket: unknown): void {
  const ws = socket as { terminate?: () => void };
  ws.terminate?.();
}

function parseTerminalProtocol(value: string | string[] | undefined): { sessionId: string } | null {
  const protocols = Array.isArray(value) ? value : value ? value.split(",") : [];
  const normalized = protocols.map((item) => item.trim()).filter(Boolean);
  if (!normalized.includes("cyberos-terminal-v1")) return null;
  const sessionProtocols = normalized.filter((protocol) => protocol.startsWith("cyberos-session."));
  if (sessionProtocols.length !== 1 || normalized.some((protocol) =>
    protocol !== "cyberos-terminal-v1" && !protocol.startsWith("cyberos-session.")
  )) return null;
  const sessionId = sessionProtocols[0]!.slice("cyberos-session.".length);
  return isTerminalSessionId(sessionId) ? { sessionId: sessionId.toLowerCase() } : null;
}

function socketDataToString(raw: unknown): string {
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.filter(Buffer.isBuffer)).toString("utf8");
  }
  return String(raw);
}

function terminalErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unable to start terminal session";
}
