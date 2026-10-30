import type { FastifyInstance } from "fastify";
import {
  createPlaybackRuntime,
  parseVodPlayerBrokerRequest,
  VOD_PLAYER_PROTOCOL_VERSION,
  VodPlayerRuntimeError,
} from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";

export function playbackRuntime(context: ApiRouteContext) {
  return context.playback ?? createPlaybackRuntime(context.config.vodPlayer);
}
export function registerPlaybackRoutes(
  server: FastifyInstance,
  context: ApiRouteContext,
): void {
  const clients = new Set<() => void>();
  server.addHook("preClose", async () => {
    for (const close of clients) close();
  });
  server.get("/api/playback/status", async (_request, reply) => {
    try {
      return { status: await playbackRuntime(context).getStatus() };
    } catch {
      return reply
        .status(503)
        .send({ error: "NAS playback service unavailable" });
    }
  });
  server.post<{ Body: unknown }>(
    "/api/playback/command",
    async (request, reply) => {
      const parsed = parseVodPlayerBrokerRequest(
        JSON.stringify({
          version: VOD_PLAYER_PROTOCOL_VERSION,
          id: "public-control",
          command: request.body,
        }),
      );
      if (
        !parsed ||
        parsed.command.type !== "guarded" ||
        ["play", "music", "status", "guarded"].includes(
          parsed.command.command.type,
        )
      )
        return reply
          .status(400)
          .send({ error: "A guarded playback control is required" });
      try {
        return {
          status: await playbackRuntime(context).command(parsed.command),
        };
      } catch (error) {
        return reply
          .status(
            error instanceof VodPlayerRuntimeError ? error.statusCode : 503,
          )
          .send({
            error:
              error instanceof Error
                ? error.message
                : "Playback command failed",
          });
      }
    },
  );
  server.get("/api/playback/events", async (_request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.write(": connected\n\n");
    let closed = false;
    let busy = false;
    let previous = "";
    const flush = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const next = JSON.stringify(await playbackRuntime(context).getStatus());
        if (!closed && next !== previous) {
          previous = next;
          raw.write(`event: snapshot\ndata: ${next}\n\n`);
        }
      } catch {
        if (!closed) raw.write("event: unavailable\ndata: {}\n\n");
      } finally {
        busy = false;
      }
    };
    void flush();
    const timer = setInterval(() => void flush(), 1000);
    timer.unref();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clients.delete(cleanup);
      raw.end();
    };
    clients.add(cleanup);
    raw.once("close", cleanup);
  });
}
