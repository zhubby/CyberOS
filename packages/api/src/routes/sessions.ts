import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  AgentSessionCommandStateError,
  appendEvent,
  createAgentSessionCommand,
  createSession,
  createUserMessageAndJob,
  deleteSession,
  expireCapabilityApprovals,
  getCurrentAgentJobForSession,
  getNasRoot,
  getSession,
  hasActiveJobsForSession,
  listEvents,
  listMessages,
  listNasRoots,
  listPendingAgentCapabilityApprovals,
  listAgentSessionCommands,
  listSessions,
  listTranscriptItems,
  updateSessionPath,
  updateSessionResourceTrust
} from "@cyberos/db";
import { resolveSafeExistingPath } from "@cyberos/nas-tools";
import type { ApiRouteContext } from "../context.js";
import { getAgentMessageContent, getAgentMessageRole, getFailedJobMessageContent, getInitialEventId } from "../lib/events.js";

export function registerSessionRoutes(server: FastifyInstance, { db }: ApiRouteContext): void {
  server.get<{
    Querystring: { rootId?: string };
  }>("/api/sessions", async (request, reply) => {
    if (request.query.rootId && !getNasRoot(db, request.query.rootId)) {
      reply.status(404).send({ error: "NAS root not found" });
      return;
    }

    expireCapabilityApprovals(db);
    const pendingApprovalCounts = new Map<string, number>();
    for (const approval of listPendingAgentCapabilityApprovals(db)) {
      pendingApprovalCounts.set(
        approval.sessionId,
        (pendingApprovalCounts.get(approval.sessionId) ?? 0) + 1
      );
    }

    const sessions = listSessions(db, {
      ...(request.query.rootId ? { rootId: request.query.rootId } : {}),
      limit: 50
    }).map((session) => {
      const messages = listMessages(db, {
        sessionId: session.id,
        limit: 100
      }).filter((message) => message.role === "user");
      return {
        ...session,
        firstMessage: messages[0]?.content ?? null,
        lastMessage: messages.at(-1)?.content ?? null,
        pendingApprovalCount: pendingApprovalCounts.get(session.id) ?? 0,
        activeJob: getCurrentAgentJobForSession(db, session.id)
      };
    });

    reply.send({ sessions });
  });

  server.post<{
    Body: {
      rootId?: string;
      path?: string;
    };
  }>("/api/sessions", async (request, reply) => {
    const roots = listNasRoots(db);
    const rootId = request.body?.rootId ?? roots[0]?.id;
    const root = rootId ? getNasRoot(db, rootId) : null;
    if (!rootId || !root) {
      reply.status(400).send({ error: "Unknown NAS root" });
      return;
    }

    const safePath = await resolveSafeExistingPath(root.path, request.body?.path ?? ".");
    const session = createSession(db, {
      rootId,
      currentPath: safePath.relativePath
    });
    reply.status(201).send({ session });
  });

  server.patch<{
    Params: { id: string };
    Body: { path?: string; piResourcesTrusted?: boolean };
  }>("/api/sessions/:id", async (request, reply) => {
    const session = getSession(db, request.params.id);
    if (!session) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }

    const root = getNasRoot(db, session.rootId);
    if (!root) {
      reply.status(404).send({ error: "NAS root not found" });
      return;
    }

    const safePath = await resolveSafeExistingPath(root.path, request.body?.path ?? session.currentPath);
    const safeStat = await stat(safePath.realPath);
    if (!safeStat.isDirectory()) {
      reply.status(400).send({ error: "Session path must be a directory" });
      return;
    }

    let updated = updateSessionPath(db, {
      sessionId: session.id,
      currentPath: safePath.relativePath
    });
    if (typeof request.body?.piResourcesTrusted === "boolean") {
      updated = updateSessionResourceTrust(db, {
        sessionId: session.id,
        trusted: request.body.piResourcesTrusted
      });
    }
    reply.send({ session: updated });
  });

  server.delete<{
    Params: { id: string };
  }>("/api/sessions/:id", async (request, reply) => {
    const session = getSession(db, request.params.id);
    if (!session) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }
    if (hasActiveJobsForSession(db, session.id)) {
      reply.status(409).send({ error: "Session has active work" });
      return;
    }

    deleteSession(db, session.id);
    reply.status(204).send();
  });

  server.get<{
    Params: { id: string };
  }>("/api/sessions/:id/transcript", async (request, reply) => {
    const session = getSession(db, request.params.id);
    if (!session) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }

    const transcript = listTranscriptItems(db, {
      sessionId: session.id,
      limit: 500
    })
      .map((item) => {
        if (item.message?.role === "user") {
          return {
            id: `message:${item.message.id}`,
            role: item.message.role,
            content: item.message.content,
            createdAt: item.message.createdAt,
            sequence: item.sequence
          };
        }
        if (item.event) {
          return {
            id: `event:${item.event.id}`,
            role: item.event.type === "job.failed" ? "assistant" : getAgentMessageRole(item.event.payload),
            content: item.event.type === "job.failed"
              ? getFailedJobMessageContent(item.event.payload)
              : getAgentMessageContent(item.event.payload),
            createdAt: item.event.createdAt,
            sequence: item.sequence
          };
        }
        return null;
      })
      .filter((message) => message !== null && message.content);

    reply.send({ session, transcript });
  });

  server.post<{
    Params: { id: string };
    Body: { content?: string; path?: string };
  }>("/api/sessions/:id/messages", async (request, reply) => {
    const session = getSession(db, request.params.id);
    if (!session) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }

    const content = request.body?.content?.trim();
    if (!content) {
      reply.status(400).send({ error: "Message content is required" });
      return;
    }

    const root = getNasRoot(db, session.rootId);
    if (!root) {
      reply.status(404).send({ error: "NAS root not found" });
      return;
    }
    const safePath = await resolveSafeExistingPath(root.path, request.body?.path ?? session.currentPath);
    const safeStat = await stat(safePath.realPath);
    if (!safeStat.isDirectory()) {
      reply.status(400).send({ error: "Session path must be a directory" });
      return;
    }

    const result = createUserMessageAndJob(db, {
      sessionId: session.id,
      content,
      workingPath: safePath.relativePath,
      commandIdempotencyKey: commandIdempotencyKey(request.headers["idempotency-key"])
    });
    reply.status(202).send({
      message: result.message,
      job: result.job,
      transcriptMessage: {
        id: `message:${result.message.id}`,
        role: "user",
        content: result.message.content,
        createdAt: result.message.createdAt,
        sequence: result.transcriptSequence
      },
      command: result.command
    });
  });

  server.get<{
    Params: { id: string };
  }>("/api/sessions/:id/commands", async (request, reply) => {
    if (!getSession(db, request.params.id)) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }
    reply.send({ commands: listAgentSessionCommands(db, { sessionId: request.params.id }) });
  });

  server.post<{
    Params: { id: string };
    Body: {
      type?: string;
      idempotencyKey?: string;
      payload?: Record<string, unknown>;
    };
  }>("/api/sessions/:id/commands", async (request, reply) => {
    const session = getSession(db, request.params.id);
    if (!session) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }
    const type = parseCommandType(request.body?.type);
    if (!type || type === "prompt") {
      reply.status(400).send({ error: "Use the messages endpoint for prompt commands" });
      return;
    }
    const idempotencyKey = commandIdempotencyKey(
      request.body?.idempotencyKey ?? request.headers["idempotency-key"]
    );
    const validationError = validateCommandPayload(type, request.body?.payload ?? {});
    if (validationError) {
      reply.status(400).send({ error: validationError });
      return;
    }
    let command;
    try {
      command = createAgentSessionCommand(db, {
        sessionId: session.id,
        idempotencyKey,
        type,
        payload: request.body?.payload ?? {}
      });
    } catch (error) {
      if (error instanceof AgentSessionCommandStateError) {
        reply.status(409).send({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
    appendEvent(db, {
      sessionId: session.id,
      type: "command.queued",
      runId: `command:${command.id}`,
      sourceId: `command:${command.id}:queued`,
      payload: { commandId: command.id, type: command.type }
    });
    reply.status(command.status === "queued" ? 202 : 200).send({ command });
  });

  server.get<{
    Params: { id: string };
    Querystring: { after?: string };
  }>("/api/sessions/:id/events", async (request, reply) => {
    const session = getSession(db, request.params.id);
    if (!session) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    raw.write(": connected\n\n");

    let lastId = getInitialEventId(request.headers["last-event-id"], request.query.after);
    const flush = () => {
      const events = listEvents(db, {
        sessionId: session.id,
        afterId: lastId,
        limit: 100
      });

      for (const event of events) {
        lastId = event.id;
        raw.write(`id: ${event.id}\n`);
        raw.write(`event: ${event.type}\n`);
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    flush();
    const timer = setInterval(flush, 500);
    request.raw.on("close", () => {
      clearInterval(timer);
    });
  });
}

const AGENT_COMMAND_TYPES = [
  "prompt", "steer", "follow_up", "abort", "compact",
  "set_model", "set_thinking_level", "stats"
] as const;

type SessionCommandType = (typeof AGENT_COMMAND_TYPES)[number];

function parseCommandType(value: unknown): SessionCommandType | null {
  return typeof value === "string" && (AGENT_COMMAND_TYPES as readonly string[]).includes(value)
    ? value as SessionCommandType
    : null;
}

function commandIdempotencyKey(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = candidate?.trim();
  return normalized && normalized.length <= 256 ? normalized : randomUUID();
}

function validateCommandPayload(type: Exclude<SessionCommandType, "prompt">, payload: Record<string, unknown>): string | null {
  if (type === "steer" || type === "follow_up") {
    return typeof payload.content === "string" && payload.content.trim() && payload.content.length <= 100_000
      ? null
      : "Command content is required";
  }
  if (type === "set_model") {
    return typeof payload.provider === "string" && typeof payload.model === "string" && payload.model.trim()
      ? null
      : "Provider and model are required";
  }
  if (type === "set_thinking_level") {
    return typeof payload.level === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(payload.level)
      ? null
      : "Unsupported thinking level";
  }
  return null;
}
