import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  createSession,
  createUserMessageAndJob,
  deleteSession,
  getNasRoot,
  getSession,
  hasActiveJobsForSession,
  listEvents,
  listMessages,
  listNasRoots,
  listSessions,
  listTranscriptItems,
  updateSessionPath
} from "@zos/db";
import { resolveSafeExistingPath } from "@zos/nas-tools";
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
        lastMessage: messages.at(-1)?.content ?? null
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
    Body: { path?: string };
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

    const updated = updateSessionPath(db, {
      sessionId: session.id,
      currentPath: safePath.relativePath
    });
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
    Body: { content?: string };
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

    const result = createUserMessageAndJob(db, {
      sessionId: session.id,
      content
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
      }
    });
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
