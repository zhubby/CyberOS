import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createMediaSource,
  openCyberOsDb,
  upsertMediaCatalogEntry,
} from "@cyberos/db";
import {
  loadCyberOsRuntime,
  MediaStreamError,
  type StreamSession,
} from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { registerMediaStreamRoutes } from "./media-stream.js";

it("isolates browser stream lifecycle and rejects expired or failed progress without NAS commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyb-stream-api-"));
  const db = openCyberOsDb(path.join(root, "db.sqlite"));
  const server = Fastify();
  try {
    const source = createMediaSource(db, {
      name: "Movies",
      kind: "movie",
      storagePoolId: "pool",
      path: "Movies",
    });
    const { file } = upsertMediaCatalogEntry(db, {
      sourceId: source.id,
      generation: "one",
      title: {
        kind: "movie",
        title: "Film",
        sourcePath: "Movies/Film",
        metadataSource: "filename",
        matchStatus: "unmatched",
      },
      file: {
        relativePath: "Movies/Film.mp4",
        name: "Film.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1,
        mtimeMs: 1,
      },
    });
    let session: StreamSession | undefined = {
      id: "browser-session",
      fileId: file.id,
      state: "ready",
      mode: "direct",
      startPositionSeconds: 0,
      durationSeconds: 600,
      tracks: [],
      audioTrack: null,
      subtitleTrack: null,
      error: null,
      reason: null,
      url: "",
    };
    const nasCommand = vi.fn(() => {
      throw new Error("Browser playback accessed NAS");
    });
    registerMediaStreamRoutes(server, {
      db,
      config: loadCyberOsRuntime({
        CYBEROS_ROOT: root,
        CYBEROS_ENVIRONMENT: "development",
      }),
      vodPlayer: { command: nasCommand },
      playback: { command: nasCommand },
      mediaStreamer: {
        command: async (method: string) => {
          if (!session) throw new MediaStreamError("Session expired", 404);
          if (method === "DELETE") {
            session = undefined;
            return {};
          }
          return { session };
        },
      },
    } as unknown as ApiRouteContext);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/media/playback-sessions",
          payload: { fileId: file.id },
        })
      ).statusCode,
    ).toBe(201);
    const progress = (positionSeconds: number) =>
      server.inject({
        method: "POST",
        url: "/api/media/playback-sessions/browser-session/progress",
        payload: { positionSeconds },
      });
    expect((await progress(120)).statusCode).toBe(200);
    expect(
      db
        .prepare("SELECT position_seconds FROM media_progress WHERE file_id=?")
        .get(file.id),
    ).toMatchObject({ position_seconds: 120 });
    session!.state = "error";
    expect((await progress(500)).statusCode).toBe(409);
    expect((await progress(-1)).statusCode).toBe(400);
    expect(
      (
        await server.inject({
          method: "DELETE",
          url: "/api/media/playback-sessions/browser-session",
        })
      ).statusCode,
    ).toBe(204);
    expect((await progress(600)).statusCode).toBe(404);
    expect(
      db
        .prepare("SELECT position_seconds FROM media_progress WHERE file_id=?")
        .get(file.id),
    ).toMatchObject({ position_seconds: 120 });
    expect(nasCommand).not.toHaveBeenCalled();
  } finally {
    await server.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
