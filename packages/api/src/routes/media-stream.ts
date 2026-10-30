import { request as httpRequest } from "node:http";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createMediaStreamRuntime,
  MediaStreamError,
  mediaStreamerSocketPath,
  type StreamSession,
} from "@cyberos/shared";
import { getMediaFile, saveMediaProgress } from "@cyberos/db";
import type { ApiRouteContext } from "../context.js";

export function registerMediaStreamRoutes(
  server: FastifyInstance,
  context: ApiRouteContext,
) {
  const runtime =
    context.mediaStreamer ?? createMediaStreamRuntime(context.config);
  const rememberTechnical = (session: StreamSession | undefined) => {
    if (!session || session.state !== "ready") return;
    const file = getMediaFile(context.db, session.fileId);
    if (!file) return;
    const identity = `${file.sizeBytes}:${file.mtimeMs}`;
    const previous = context.db
      .prepare("SELECT identity FROM media_file_technical WHERE file_id=?")
      .get(file.id) as { identity: string } | undefined;
    if (previous?.identity === identity) return;
    context.db.transaction(() => {
      context.db
        .prepare(
          "INSERT INTO media_file_technical(file_id,identity,probe_json) VALUES(?,?,?) ON CONFLICT(file_id) DO UPDATE SET identity=excluded.identity,probe_json=excluded.probe_json",
        )
        .run(
          file.id,
          identity,
          JSON.stringify({
            container: session.container,
            tracks: session.tracks,
            durationSeconds: session.durationSeconds,
          }),
        );
      context.db
        .prepare(
          "UPDATE media_files SET duration_seconds=?,container=?,video_codec=?,audio_codec=? WHERE id=? AND size_bytes=? AND mtime_ms=?",
        )
        .run(
          session.durationSeconds,
          session.container ?? null,
          session.tracks.find((t) => t.type === "video")?.codec ?? null,
          session.tracks.find((t) => t.type === "audio")?.codec ?? null,
          file.id,
          file.sizeBytes,
          file.mtimeMs,
        );
    })();
  };
  const failure = (reply: FastifyReply, error: unknown) =>
    reply
      .status(error instanceof MediaStreamError ? error.statusCode : 503)
      .send({
        error:
          error instanceof MediaStreamError
            ? error.message
            : "Media streaming service unavailable",
      });
  server.post<{ Body: unknown }>(
    "/api/media/playback-sessions",
    async (request, reply) => {
      try {
        return reply
          .status(201)
          .send(await runtime.command("POST", "/sessions", request.body));
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
  server.get<{ Params: { id: string } }>(
    "/api/media/playback-sessions/:id",
    async (request, reply) => {
      try {
        const result = await runtime.command(
          "GET",
          `/sessions/${encodeURIComponent(request.params.id)}`,
        );
        rememberTechnical(result.session);
        return result;
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
  server.delete<{ Params: { id: string } }>(
    "/api/media/playback-sessions/:id",
    async (request, reply) => {
      try {
        await runtime.command(
          "DELETE",
          `/sessions/${encodeURIComponent(request.params.id)}`,
        );
        return reply.status(204).send();
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
  server.post<{ Params: { id: string }; Body: { positionSeconds?: number } }>(
    "/api/media/playback-sessions/:id/progress",
    async (request, reply) => {
      const position = request.body?.positionSeconds;
      if (
        typeof position !== "number" ||
        !Number.isFinite(position) ||
        position < 0
      )
        return reply.status(400).send({ error: "Invalid media position" });
      try {
        const { session } = await runtime.command(
          "GET",
          `/sessions/${encodeURIComponent(request.params.id)}`,
        );
        if (
          !session ||
          session.state === "error" ||
          !getMediaFile(context.db, session.fileId)
        )
          return reply
            .status(409)
            .send({ error: "Media session is no longer available" });
        if (session.state !== "ready") return reply.send({ saved: false });
        return {
          progress: saveMediaProgress(context.db, {
            fileId: session.fileId,
            positionSeconds: session.durationSeconds
              ? Math.min(position, session.durationSeconds)
              : position,
            durationSeconds: session.durationSeconds,
          }),
        };
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
  server.get<{ Params: { id: string; name: string } }>(
    "/api/media/playback-sessions/:id/assets/:name",
    async (request, reply) => {
      const { id, name } = request.params;
      if (
        !/^[a-f0-9-]{36}$/.test(id) ||
        !/^(direct|index\.m3u8|segment-\d{6,}\.ts)$/.test(name)
      )
        return reply.status(404).send({ error: "Stream asset not found" });
      return await new Promise((resolve) => {
        const upstream = httpRequest(
          {
            socketPath: mediaStreamerSocketPath(context.config),
            path: `/sessions/${id}/assets/${name}`,
            headers: request.headers.range
              ? { range: request.headers.range }
              : {},
          },
          (response) => {
            reply.code(response.statusCode ?? 503);
            for (const key of [
              "content-type",
              "content-length",
              "content-range",
              "accept-ranges",
              "cache-control",
            ])
              if (response.headers[key])
                reply.header(key, response.headers[key]!);
            resolve(reply.send(response));
          },
        );
        upstream.setTimeout(15000, () => upstream.destroy());
        upstream.once("error", () => {
          if (!reply.sent)
            resolve(
              reply
                .status(503)
                .send({ error: "Media streaming service unavailable" }),
            );
        });
        reply.raw.once("close", () => upstream.destroy());
        upstream.end();
      });
    },
  );
}
