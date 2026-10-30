import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createMusicPlaylist,
  createMusicSource,
  deleteMusicPlaylist,
  enqueueMusicScan,
  getMusicAlbum,
  getMusicArtist,
  getMusicHome,
  getMusicLibraryStatus,
  getMusicLyrics,
  getMusicPlaylist,
  getMusicSource,
  getMusicTrack,
  listMusicAlbums,
  listMusicArtists,
  listMusicPlaylists,
  listMusicScans,
  listMusicSources,
  listMusicTracks,
  removeMusicSource,
  setMusicFavorite,
  updateMusicPlaylist,
  updateMusicSource
} from "@cyberos/db";
import {
  type MusicFavoriteKind,
  type MusicPlayerCommand,
  type MusicPlayerStatus,
  type MusicQuery,
  VodPlayerRuntimeError
} from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { resolveMusicPlayerRuntime } from "../lib/music-player.js";
import { HostdBluetoothManagerClient } from "../lib/bluetooth-manager.js";
import { bluetoothAudioDevices } from "./bluetooth-transfers.js";
import {
  StorageScopeError,
  resolveScopedExistingPath,
  resolveStoragePoolScope
} from "../lib/storage-scope.js";
class MusicRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}
type Input = Record<string, unknown>;
function object(value: unknown): Input {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new MusicRequestError("A music request object is required");
  return value as Input;
}
function only(input: Input, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new MusicRequestError("Music request contains unsupported fields");
}
function text(value: unknown, label: string, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw new MusicRequestError(`${label} is invalid`);
  return value.trim();
}
function numeric(
  value: unknown,
  label: string,
  min: number,
  max: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new MusicRequestError(`${label} is invalid`);
  return value;
}
function ids(value: unknown, max = 10000): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new MusicRequestError("Music track list is invalid or too large");
  return value.map((v) => text(v, "Track id"));
}
function sendError(reply: FastifyReply, error: unknown): unknown {
  const status =
    error instanceof MusicRequestError ||
    error instanceof StorageScopeError ||
    error instanceof VodPlayerRuntimeError
      ? error.statusCode
      : error instanceof Error && /not found/iu.test(error.message)
        ? 404
        : error instanceof Error &&
            /invalid|required|overlap|disabled|cursor|too large|traversal/iu.test(
              error.message
            )
          ? 400
          : 500;
  return reply
    .status(status)
    .send({
      error:
        status < 500 && error instanceof Error
          ? error.message
          : error instanceof VodPlayerRuntimeError
            ? error.message
            : "Music request failed",
      ...(error instanceof VodPlayerRuntimeError ? { code: error.code } : {})
    });
}
async function guarded(
  reply: FastifyReply,
  callback: () => unknown | Promise<unknown>
): Promise<unknown> {
  try {
    return await callback();
  } catch (error) {
    return sendError(reply, error);
  }
}
function query(input: Input): MusicQuery {
  only(input, [
    "query",
    "sourceId",
    "albumId",
    "artistId",
    "year",
    "genre",
    "favorite",
    "sort",
    "cursor",
    "limit"
  ]);
  const result: MusicQuery = {};
  for (const name of [
    "query",
    "sourceId",
    "albumId",
    "artistId",
    "genre",
    "cursor"
  ] as const)
    if (input[name] !== undefined)
      result[name] = text(input[name], name, name === "cursor" ? 2048 : 512);
  for (const name of ["year", "limit"] as const)
    if (input[name] !== undefined) {
      if (typeof input[name] !== "string" || !/^\d+$/u.test(input[name]))
        throw new MusicRequestError(`${name} is invalid`);
      const value = Number(input[name]);
      if (
        !Number.isSafeInteger(value) ||
        value < (name === "limit" ? 1 : 0) ||
        value > (name === "limit" ? 100 : 9999)
      )
        throw new MusicRequestError(`${name} is invalid`);
      result[name] = value;
    }
  if (input.favorite !== undefined) {
    if (input.favorite !== "true" && input.favorite !== "false")
      throw new MusicRequestError("Favorite filter is invalid");
    result.favorite = input.favorite === "true";
  }
  if (input.sort !== undefined) {
    if (
      input.sort !== "name" &&
      input.sort !== "year" &&
      input.sort !== "added"
    )
      throw new MusicRequestError("Music sort is invalid");
    result.sort = input.sort;
  }
  return result;
}
export function registerMusicRoutes(
  server: FastifyInstance,
  context: ApiRouteContext
): void {
  const { db } = context;
  server.get("/api/music/sources", async () => ({
    sources: listMusicSources(db)
  }));
  server.post<{
    Body: unknown;
  }>("/api/music/sources", async (request, reply) =>
    guarded(reply, async () => {
      const b = object(request.body);
      only(b, ["name", "storagePoolId", "path"]);
      const scope = await resolveStoragePoolScope(
        context.config.paths.dataRoot,
        context.system,
        text(b.storagePoolId, "Storage pool")
      );
      const safe = await resolveScopedExistingPath(
        scope,
        text(b.path, "Source path", 4096)
      );
      if (!(await stat(safe.realPath)).isDirectory())
        throw new MusicRequestError("Music source must be a directory");
      const source = createMusicSource(db, {
        name: text(b.name, "Source name"),
        storagePoolId: scope.pool.id,
        path: safe.relativePath
      });
      const scan = enqueueMusicScan(db, source.id);
      return reply.status(201).send({ source, scan });
    })
  );
  server.patch<{
    Params: {
      id: string;
    };
    Body: unknown;
  }>("/api/music/sources/:id", async (request, reply) =>
    guarded(reply, () => {
      const b = object(request.body);
      only(b, ["name", "enabled"]);
      const source = updateMusicSource(db, request.params.id, {
        ...(b.name === undefined ? {} : { name: text(b.name, "Source name") }),
        ...(b.enabled === undefined
          ? {}
          : {
              enabled:
                typeof b.enabled === "boolean"
                  ? b.enabled
                  : (() => {
                      throw new MusicRequestError("Enabled must be boolean");
                    })()
            })
      });
      if (!source) throw new MusicRequestError("Music source not found", 404);
      return { source };
    })
  );
  server.delete<{
    Params: {
      id: string;
    };
  }>("/api/music/sources/:id", async (request, reply) =>
    guarded(reply, () => {
      if (!removeMusicSource(db, request.params.id))
        throw new MusicRequestError("Music source not found", 404);
      return reply.status(204).send();
    })
  );
  server.post<{
    Params: {
      id: string;
    };
  }>("/api/music/sources/:id/scan", async (request, reply) =>
    guarded(reply, () => {
      if (!getMusicSource(db, request.params.id))
        throw new MusicRequestError("Music source not found", 404);
      return reply
        .status(202)
        .send({ scan: enqueueMusicScan(db, request.params.id) });
    })
  );
  server.get("/api/music/scans", async () => ({ scans: listMusicScans(db) }));
  server.get("/api/music/status", async () => ({
    status: getMusicLibraryStatus(db)
  }));
  server.get("/api/music/home", async () => getMusicHome(db));
  server.get<{
    Querystring: Input;
  }>("/api/music/tracks", async (request, reply) =>
    guarded(reply, () => listMusicTracks(db, query(request.query)))
  );
  server.get<{
    Querystring: Input;
  }>("/api/music/albums", async (request, reply) =>
    guarded(reply, () => listMusicAlbums(db, query(request.query)))
  );
  server.get<{
    Querystring: Input;
  }>("/api/music/artists", async (request, reply) =>
    guarded(reply, () => listMusicArtists(db, query(request.query)))
  );
  server.get<{
    Params: {
      id: string;
    };
  }>("/api/music/albums/:id", async (request, reply) =>
    guarded(reply, () => {
      const detail = getMusicAlbum(db, request.params.id);
      if (!detail) throw new MusicRequestError("Music album not found", 404);
      return detail;
    })
  );
  server.get<{
    Params: {
      id: string;
    };
  }>("/api/music/artists/:id", async (request, reply) =>
    guarded(reply, () => {
      const detail = getMusicArtist(db, request.params.id);
      if (!detail) throw new MusicRequestError("Music artist not found", 404);
      return detail;
    })
  );
  server.get<{
    Params: {
      id: string;
    };
  }>("/api/music/tracks/:id", async (request, reply) =>
    guarded(reply, () => {
      const track = getMusicTrack(db, request.params.id);
      if (!track) throw new MusicRequestError("Music track not found", 404);
      return { track };
    })
  );
  server.get<{
    Params: {
      id: string;
    };
  }>("/api/music/tracks/:id/lyrics", async (request, reply) =>
    guarded(reply, () => {
      const lyrics = getMusicLyrics(db, request.params.id);
      if (!lyrics) throw new MusicRequestError("Music track not found", 404);
      return lyrics;
    })
  );
  server.post<{
    Body: unknown;
  }>("/api/music/favorites", async (request, reply) =>
    guarded(reply, () => {
      const b = object(request.body);
      only(b, ["kind", "id", "favorite"]);
      if (b.kind !== "track" && b.kind !== "album" && b.kind !== "artist")
        throw new MusicRequestError("Favorite kind is invalid");
      if (typeof b.favorite !== "boolean")
        throw new MusicRequestError("Favorite must be boolean");
      setMusicFavorite(
        db,
        b.kind as MusicFavoriteKind,
        text(b.id, "Favorite id", 512),
        b.favorite
      );
      return { ok: true };
    })
  );
  server.get<{
    Querystring: Input;
  }>("/api/music/playlists", async (request, reply) =>
    guarded(reply, () => listMusicPlaylists(db, query(request.query)))
  );
  server.post<{
    Body: unknown;
  }>("/api/music/playlists", async (request, reply) =>
    guarded(reply, () => {
      const b = object(request.body);
      only(b, ["name", "trackIds"]);
      const playlist = createMusicPlaylist(
        db,
        text(b.name, "Playlist name"),
        b.trackIds === undefined ? [] : ids(b.trackIds)
      );
      return reply.status(201).send({ playlist });
    })
  );
  server.get<{
    Params: {
      id: string;
    };
  }>("/api/music/playlists/:id", async (request, reply) =>
    guarded(reply, () => {
      const detail = getMusicPlaylist(db, request.params.id);
      if (!detail) throw new MusicRequestError("Music playlist not found", 404);
      return detail;
    })
  );
  server.patch<{
    Params: {
      id: string;
    };
    Body: unknown;
  }>("/api/music/playlists/:id", async (request, reply) =>
    guarded(reply, () => {
      const b = object(request.body);
      only(b, ["name", "trackIds"]);
      const playlist = updateMusicPlaylist(db, request.params.id, {
        ...(b.name === undefined
          ? {}
          : { name: text(b.name, "Playlist name") }),
        ...(b.trackIds === undefined ? {} : { trackIds: ids(b.trackIds) })
      });
      if (!playlist)
        throw new MusicRequestError("Music playlist not found", 404);
      return { playlist };
    })
  );
  server.delete<{
    Params: {
      id: string;
    };
  }>("/api/music/playlists/:id", async (request, reply) =>
    guarded(reply, () => {
      if (!deleteMusicPlaylist(db, request.params.id))
        throw new MusicRequestError("Music playlist not found", 404);
      return reply.status(204).send();
    })
  );
  server.get<{
    Params: {
      key: string;
    };
  }>("/api/music/artwork/:key", async (request, reply) =>
    guarded(reply, async () => {
      const key = request.params.key;
      if (!/^[a-f0-9]{64}\.(jpg|png|webp)$/u.test(key))
        throw new MusicRequestError("Artwork key is invalid");
      if (
        !db
          .prepare("SELECT 1 FROM music_tracks WHERE artwork_key=? LIMIT 1")
          .get(key)
      )
        throw new MusicRequestError("Music artwork not found", 404);
      let file;
      try {
        file = await open(
          path.join(context.config.paths.stateDir, "music", "artwork", key),
          constants.O_RDONLY | constants.O_NOFOLLOW
        );
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > 15 * 1024 * 1024)
          throw new MusicRequestError("Music artwork is invalid");
        const image = await file.readFile();
        reply
          .type(
            key.endsWith(".png")
              ? "image/png"
              : key.endsWith(".webp")
                ? "image/webp"
                : "image/jpeg"
          )
          .header("Cache-Control", "private, max-age=3600");
        return reply.send(image);
      } catch (error) {
        if (error instanceof MusicRequestError) throw error;
        throw new MusicRequestError("Music artwork is unavailable", 404);
      } finally {
        await file?.close();
      }
    })
  );
  server.get("/api/music/player", async (_request, reply) =>
    guarded(reply, async () => ({
      status: await resolveMusicPlayerRuntime(context).getStatus()
    }))
  );
  server.post<{
    Body: unknown;
  }>("/api/music/player/command", async (request, reply) =>
    guarded(reply, async () => {
      const command = await buildMusicCommand(request.body, context);
      return {
        status: await resolveMusicPlayerRuntime(context).command(command)
      };
    })
  );
  const clients = new Set<() => void>();
  server.addHook("onClose", async () => {
    for (const close of clients) close();
  });
  server.get("/api/music/events", async (_request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    raw.write(": connected\n\n");
    let previous = "";
    let closed = false;
    let pending = false;
    const flush = async () => {
      if (closed || pending) return;
      pending = true;
      try {
        let player: MusicPlayerStatus | null = null;
        try {
          player = await resolveMusicPlayerRuntime(context).getStatus();
        } catch {
          /* Library remains usable when the audio engine is offline. */
        }
        if (closed) return;
        const snapshot = JSON.stringify({
          status: getMusicLibraryStatus(db),
          player
        });
        if (snapshot !== previous) {
          previous = snapshot;
          raw.write(`event: snapshot\ndata: ${snapshot}\n\n`);
        } else raw.write(": heartbeat\n\n");
      } catch {
        if (!closed) raw.write("event: unavailable\ndata: {}\n\n");
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => {
      void flush();
    }, 1000);
    timer.unref();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clients.delete(close);
      raw.end();
    };
    clients.add(close);
    raw.once("close", close);
    void flush();
  });
}
async function buildMusicCommand(
  value: unknown,
  context: ApiRouteContext
): Promise<MusicPlayerCommand> {
  const b = object(value);
  const type = text(b.type, "Command type");
  const version = numeric(
    b.expectedQueueVersion,
    "Queue version",
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (!Number.isSafeInteger(version))
    throw new MusicRequestError("Queue version is invalid");
  const base = { expectedQueueVersion: version };
  const takeover =
    b.expectedSessionId === undefined
      ? {}
      : { expectedSessionId: text(b.expectedSessionId, "Session id") };
  if (type === "replace" || type === "append" || type === "insert-next") {
    only(b, [
      "type",
      "trackIds",
      "expectedQueueVersion",
      ...(type === "replace" ? ["expectedSessionId"] : [])
    ]);
    const trackIds = ids(b.trackIds, 1000);
    if (!trackIds.length)
      throw new MusicRequestError("At least one music track is required");
    const entries = trackIds.map((id) => {
      const track = getMusicTrack(context.db, id);
      if (!track) throw new MusicRequestError("Music track not found", 404);
      if (track.missing)
        throw new MusicRequestError("Music track is unavailable", 409);
      return {
        id: randomUUID(),
        trackId: track.id,
        storagePoolId: track.storagePoolId,
        relativePath: track.relativePath,
        title: track.title,
        artist: track.artists.join(" / "),
        album: track.album,
        durationSeconds: track.durationSeconds,
        coverKey: track.coverKey
      };
    });
    return { type, ...base, entries, ...takeover };
  }
  if (type === "remove" || type === "jump") {
    only(b, [
      "type",
      "itemId",
      "expectedQueueVersion",
      ...(type === "jump" ? ["expectedSessionId"] : [])
    ]);
    return {
      type,
      ...base,
      itemId: text(b.itemId, "Queue item id"),
      ...takeover
    };
  }
  if (type === "reorder") {
    only(b, ["type", "itemIds", "expectedQueueVersion"]);
    const itemIds = ids(b.itemIds, 1000);
    if (new Set(itemIds).size !== itemIds.length)
      throw new MusicRequestError("Queue item ids must be unique");
    return { type, ...base, itemIds };
  }
  if (
    type === "clear" ||
    type === "next" ||
    type === "previous" ||
    type === "pause" ||
    type === "resume"
  ) {
    only(b, [
      "type",
      "expectedQueueVersion",
      ...(type === "resume" ? ["expectedSessionId"] : [])
    ]);
    return { type, ...base, ...takeover };
  }
  if (type === "seek") {
    only(b, ["type", "seconds", "expectedQueueVersion"]);
    return {
      type,
      ...base,
      seconds: numeric(b.seconds, "Seek position", 0, Number.MAX_SAFE_INTEGER)
    };
  }
  if (type === "volume") {
    only(b, ["type", "volume", "expectedQueueVersion"]);
    return { type, ...base, volume: numeric(b.volume, "Volume", 0, 100) };
  }
  if (type === "mode") {
    only(b, ["type", "repeat", "shuffle", "expectedQueueVersion"]);
    if (
      (b.repeat !== "off" && b.repeat !== "one" && b.repeat !== "all") ||
      typeof b.shuffle !== "boolean"
    )
      throw new MusicRequestError("Playback mode is invalid");
    return { type, ...base, repeat: b.repeat, shuffle: b.shuffle };
  }
  if (type === "output") {
    only(b, ["type", "audioDeviceId", "expectedQueueVersion"]);
    if (b.audioDeviceId === null) return { type, ...base, audioDeviceId: null };
    const audioDeviceId = text(b.audioDeviceId, "Audio output", 256);
    const manager =
      context.system?.bluetoothManager ??
      new HostdBluetoothManagerClient(context.config.hostd.socketPath);
    const status = await manager.getStatus();
    if (
      !bluetoothAudioDevices(status).some(
        (device) => device.id === audioDeviceId
      )
    )
      throw new MusicRequestError(
        "Audio output must be an available paired speaker or headset"
      );
    return { type, ...base, audioDeviceId };
  }
  throw new MusicRequestError("Unsupported music command");
}
