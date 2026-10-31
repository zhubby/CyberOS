import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { capabilityInputSchema, CapabilityError, type JsonValue } from "@cyberos/capabilities";
import type { CapabilityAdapterContext, CapabilityDomainAdapter, PreparedCapabilityAction } from "@cyberos/capability-runtime";
import { getMediaFile, getMusicTrack } from "@cyberos/db";
import { resolveScopedExistingPath, resolveStoragePoolScope, type StoragePoolScope } from "./storage-scope.js";
import type { SystemManagementDependencies } from "./system-management.js";
import { HostdBluetoothManagerClient } from "./bluetooth-manager.js";
import { bluetoothAudioDevices } from "../routes/bluetooth-transfers.js";

type Input = Record<string, JsonValue>;
type ReadAdapter = (input: JsonValue) => Promise<JsonValue>;
type Request = { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; url: string; payload?: JsonValue };
const mutations = ["cyberos.music.manage-propose", "cyberos.music.control-propose", "cyberos.media.manage-propose", "cyberos.media.play-propose", "cyberos.playback.control-propose"];

function record(value: JsonValue | undefined): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CapabilityError("INVALID_ARGUMENT", "An object is required");
  return value;
}

function validate(capabilityId: string, input: JsonValue): Input {
  const schema = z.fromJSONSchema(capabilityInputSchema(capabilityId) as Parameters<typeof z.fromJSONSchema>[0]);
  if (!schema.safeParse(input).success) throw new CapabilityError("INVALID_ARGUMENT", "Invalid media capability arguments");
  return record(input);
}

async function inject(server: FastifyInstance, request: Request): Promise<JsonValue> {
  const response = await server.inject({ method: request.method, url: request.url, ...(request.payload === undefined ? {} : { payload: JSON.stringify(request.payload), headers: { "content-type": "application/json" } }) });
  if (response.statusCode >= 400) {
    const code = response.statusCode === 409 ? "CONFLICT" : response.statusCode === 403 ? "FORBIDDEN" : response.statusCode < 500 ? "INVALID_ARGUMENT" : "NOT_READY";
    throw new CapabilityError(code, `Media operation could not complete (HTTP ${response.statusCode})`, { retryable: response.statusCode >= 500 });
  }
  return response.statusCode === 204 ? { saved: true } : response.json<JsonValue>();
}

function encoded(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !value) throw new CapabilityError("INVALID_ARGUMENT", "A media identifier is required");
  return encodeURIComponent(value);
}

function queryUrl(base: string, input: Input, omitted: string[] = []): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (!omitted.includes(key) && value !== null) query.set(key, String(value));
  return `${base}?${query}`;
}

export function boundMediaResult(value: JsonValue, input: Input = {}): JsonValue {
  const maximum = typeof input.limit === "number" ? input.limit : 40;
  const truncation: JsonValue[] = [];
  let remaining = 160_000;
  const walk = (item: JsonValue, location: string, depth: number): JsonValue => {
    if (remaining < 128 || depth > 16) {
      truncation.push({ path: location, reason: "output_budget" });
      return null;
    }
    if (typeof item === "string") {
      const shortened = item.slice(0, Math.min(16_000, Math.floor(remaining / 6)));
      remaining -= Buffer.byteLength(JSON.stringify(shortened));
      if (shortened.length < item.length) truncation.push({ path: location, totalCharacters: item.length, returnedCharacters: shortened.length });
      return shortened;
    }
    if (Array.isArray(item)) {
      const selected: JsonValue[] = [];
      for (const entry of item.slice(0, maximum)) {
        if (remaining < 128) break;
        selected.push(walk(entry, `${location}[${selected.length}]`, depth + 1));
      }
      if (selected.length < item.length) truncation.push({ path: location, total: item.length, returned: selected.length });
      return selected;
    }
    if (item && typeof item === "object") {
      const result: Input = {};
      for (const [key, child] of Object.entries(item)) {
        if (remaining < 128) { truncation.push({ path: location, reason: "output_budget" }); break; }
        remaining -= Buffer.byteLength(JSON.stringify(key)) + 4;
        result[key] = walk(child, location ? `${location}.${key}` : key, depth + 1);
      }
      return result;
    }
    remaining -= 24;
    return item;
  };
  const result = walk(value, "", 0);
  return { ...record(result), ...(truncation.length ? { truncation: truncation.slice(0, 100), truncated: true } : {}) };
}

export function createMediaReadAdapters(server: FastifyInstance, system?: SystemManagementDependencies, hostdSocketPath?: string): Record<string, ReadAdapter> {
  const read = (capabilityId: string, request: (input: Input) => Request): ReadAdapter => async (value) => {
    const input = validate(capabilityId, value);
    return boundMediaResult(await inject(server, request(input)), input);
  };
  return {
    "cyberos.music.query": read("cyberos.music.query", (input) => ({ method: "GET", url: queryUrl(`/api/music/${input.entity}`, { limit: 40, ...input }, ["entity"]) })),
    "cyberos.music.get": read("cyberos.music.get", (input) => ({ method: "GET", url: input.entity === "lyrics" ? `/api/music/tracks/${encoded(input.id)}/lyrics` : `/api/music/${input.entity}/${encoded(input.id)}` })),
    "cyberos.music.status": read("cyberos.music.status", (input) => ({ method: "GET", url: `/api/music/${input.view === "library" ? "status" : input.view ?? "status"}` })),
    "cyberos.media.query": read("cyberos.media.query", (input) => ({ method: "GET", url: queryUrl("/api/media/titles", { limit: 40, ...input }) })),
    "cyberos.media.get": read("cyberos.media.get", (input) => ({ method: "GET", url: input.entity === "next" ? `/api/media/files/${encoded(input.id)}/next` : `/api/media/titles/${encoded(input.id)}${input.entity === "match-candidates" ? `/${input.entity}?${new URLSearchParams(typeof input.query === "string" ? { query: input.query } : {})}` : ""}` })),
    "cyberos.media.status": read("cyberos.media.status", (input) => ({ method: "GET", url: queryUrl(`/api/media/${input.view === "library" ? "status" : input.view ?? "status"}`, { limit: input.limit ?? 40, ...(input.sourceId ? { sourceId: input.sourceId } : {}) }) })),
    "cyberos.playback.status": read("cyberos.playback.status", () => ({ method: "GET", url: "/api/playback/status" })),
    "cyberos.playback.outputs": async (value) => {
      validate("cyberos.playback.outputs", value);
      const manager = system?.bluetoothManager ?? (hostdSocketPath ? new HostdBluetoothManagerClient(hostdSocketPath) : null);
      try {
        const devices = manager ? bluetoothAudioDevices(await manager.getStatus()) : [];
        return boundMediaResult({ outputs: [{ id: null, name: "System default", kind: "default" }, ...devices.map((device) => ({ id: device.id, name: device.name, kind: "bluetooth" }))] });
      } catch {
        return { outputs: [{ id: null, name: "System default", kind: "default" }], warnings: ["Bluetooth output discovery unavailable"] };
      }
    }
  };
}

function mutationRequest(capabilityId: string, input: Input): Request {
  const { operation, id, serviceInstanceId, playbackSessionId, ...body } = input;
  if (capabilityId === "cyberos.media.play-propose") {
    const { fileId, ...options } = body;
    return { method: "POST", url: `/api/media/files/${encoded(fileId)}/play`, payload: { ...options, serviceInstanceId: serviceInstanceId ?? null, playbackSessionId: playbackSessionId ?? null, ...(typeof playbackSessionId === "string" ? { expectedSessionId: playbackSessionId } : {}) } };
  }
  if (capabilityId === "cyberos.music.control-propose") return { method: "POST", url: "/api/music/player/command", payload: { type: operation ?? null, ...body, serviceInstanceId: serviceInstanceId ?? null, playbackSessionId: playbackSessionId ?? null, ...(["replace", "resume", "jump"].includes(String(operation)) && typeof playbackSessionId === "string" ? { expectedSessionId: playbackSessionId } : {}) } };
  if (capabilityId === "cyberos.playback.control-propose") return { method: "POST", url: "/api/playback/command", payload: { type: "guarded", serviceInstanceId: serviceInstanceId ?? null, expectedSessionId: playbackSessionId ?? null, command: { type: operation ?? null, ...body } } };
  const domain = capabilityId === "cyberos.music.manage-propose" ? "music" : "media";
  const base = `/api/${domain}`;
  switch (operation) {
    case "source_create": return { method: "POST", url: `${base}/sources`, payload: body };
    case "source_update": return { method: "PATCH", url: `${base}/sources/${encoded(id)}`, payload: body };
    case "source_delete": return { method: "DELETE", url: `${base}/sources/${encoded(id)}` };
    case "scan": return { method: "POST", url: `${base}/sources/${encoded(id)}/scan` };
    case "favorite": return { method: "POST", url: `${base}/favorites`, payload: { ...body, id: id ?? null } };
    case "playlist_create": return { method: "POST", url: `${base}/playlists`, payload: body };
    case "playlist_update": return { method: "PATCH", url: `${base}/playlists/${encoded(id)}`, payload: body };
    case "playlist_delete": return { method: "DELETE", url: `${base}/playlists/${encoded(id)}` };
    case "title_state": return { method: "PATCH", url: `${base}/titles/${encoded(id)}/state`, payload: body };
    case "episode_state": return { method: "PATCH", url: `${base}/episodes/${encoded(id)}/state`, payload: body };
    case "progress": return { method: "POST", url: `${base}/files/${encoded(id)}/progress`, payload: body };
    case "collection_create": return { method: "POST", url: `${base}/collections`, payload: body };
    case "collection_update": return { method: "PATCH", url: `${base}/collections/${encoded(id)}`, payload: body };
    case "collection_delete": return { method: "DELETE", url: `${base}/collections/${encoded(id)}` };
    case "match": return { method: "PUT", url: `${base}/titles/${encoded(id)}/match`, payload: body };
    case "settings": return { method: "PATCH", url: `${base}/settings`, payload: body };
    default: throw new CapabilityError("INVALID_ARGUMENT", "Unsupported media operation");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function playbackState(server: FastifyInstance, request: Input): Promise<Input> {
  const status = record(record(await inject(server, { method: "GET", url: "/api/playback/status" })).status);
  if (status.serviceInstanceId !== request.serviceInstanceId || status.sessionId !== request.playbackSessionId) throw new CapabilityError("CONFLICT", "NAS playback instance or session changed; read playback status and request approval again");
  if (request.expectedQueueVersion !== undefined && record(status.music).queueVersion !== request.expectedQueueVersion) throw new CapabilityError("CONFLICT", "Music queue changed; read playback status and request approval again");
  if (request.sessionId !== undefined && request.sessionId !== status.sessionId) throw new CapabilityError("CONFLICT", "Playback command targets a different session");
  return status;
}

async function fileState(file: { storagePoolId: string; relativePath: string; missing?: boolean }, scope: StoragePoolScope): Promise<JsonValue> {
  if (file.missing) throw new CapabilityError("CONFLICT", "Media file is missing");
  try {
    const safe = await resolveScopedExistingPath(scope, file.relativePath);
    const info = await stat(safe.realPath);
    if (!info.isFile()) throw new CapabilityError("CONFLICT", "Media source is not a regular file");
    return { storagePoolId: file.storagePoolId, path: safe.relativePath, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev };
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("CONFLICT", "Media file or storage pool is unavailable");
  }
}

async function targetState(server: FastifyInstance, context: CapabilityAdapterContext, request: Input, system?: SystemManagementDependencies): Promise<{ revision: string; label: string; target: JsonValue }> {
  const capabilityId = context.capabilityId;
  const domain = capabilityId.startsWith("cyberos.music.") ? "music" : "media";
  const operation = String(request.operation);
  const states: unknown[] = [];
  const labels: string[] = [];
  const scopes = new Map<string, Promise<StoragePoolScope>>();
  const inspectFile = async (file: { storagePoolId: string; relativePath: string; missing?: boolean }) => {
    let scope = scopes.get(file.storagePoolId);
    if (!scope) {
      scope = resolveStoragePoolScope(context.config.paths.dataRoot, system, file.storagePoolId);
      scopes.set(file.storagePoolId, scope);
    }
    try {
      return await fileState(file, await scope);
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      throw new CapabilityError("CONFLICT", "Media storage pool is unavailable");
    }
  };
  const add = (value: unknown, required = true) => {
    if ((value === null || value === undefined) && required) throw new CapabilityError("CONFLICT", "Media target no longer exists");
    states.push(value ?? null);
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object.name === "string") labels.push(object.name);
      else if (typeof object.title === "string") labels.push(object.title);
    }
  };
  const row = (table: string, key: string, value: JsonValue | undefined, required = true) => add(context.db.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(typeof value === "string" ? value : ""), required);
  if (request.serviceInstanceId !== undefined) {
    const status = await playbackState(server, request);
    states.push({ serviceInstanceId: status.serviceInstanceId, sessionId: status.sessionId, owner: status.owner, ...(request.expectedQueueVersion === undefined ? {} : { queueVersion: record(status.music).queueVersion }) });
    const music = record(status.music);
    const queue = Array.isArray(music.queue) ? music.queue : [];
    const current = queue.find((entry) => record(entry).id === music.currentItemId);
    if (status.owner === "music" && current) labels.push(`current music: ${String(record(current).title)}`);
    if (status.owner === "video") {
      const video = record(status.video);
      labels.push(`current video: ${String(video.relativePath ?? video.mediaFileId ?? "video")}`);
    }
    if (typeof request.itemId === "string") {
      const item = queue.find((entry) => record(entry).id === request.itemId);
      if (!item) throw new CapabilityError("CONFLICT", "Music queue item no longer exists");
      labels.push(String(record(item).title));
      if (operation === "jump") {
        const track = getMusicTrack(context.db, String(record(item).trackId));
        if (!track) throw new CapabilityError("CONFLICT", "Music track no longer exists");
        states.push(await inspectFile(track));
      }
    }
    if (typeof request.audioDeviceId === "string") {
      const manager = system?.bluetoothManager ?? new HostdBluetoothManagerClient(context.config.hostd.socketPath);
      const device = bluetoothAudioDevices(await manager.getStatus()).find((entry) => entry.id === request.audioDeviceId);
      if (!device) throw new CapabilityError("CONFLICT", "Audio output is unavailable");
      labels.push(device.name);
      states.push({ audioDeviceId: device.id });
    } else if (request.audioDeviceId === null) labels.push("System default output");
  }
  if (capabilityId === "cyberos.media.play-propose") {
    const file = getMediaFile(context.db, String(request.fileId));
    if (!file) throw new CapabilityError("CONFLICT", "Media file no longer exists");
    row("media_titles", "id", file.titleId);
    labels.push(file.relativePath);
    states.push(await inspectFile(file));
  }
  if (Array.isArray(request.trackIds)) {
    for (const trackId of request.trackIds) {
      const track = getMusicTrack(context.db, String(trackId));
      if (!track) throw new CapabilityError("CONFLICT", "Music track no longer exists");
      labels.push(track.title);
      states.push({ id: track.id, path: track.relativePath, title: track.title });
      if (capabilityId === "cyberos.music.control-propose") states.push(await inspectFile(track));
    }
  }
  if (operation.startsWith("source_") || operation === "scan") {
    if (request.id) row(`${domain}_sources`, "id", request.id);
    else {
      const sources = context.db.prepare(`SELECT * FROM ${domain}_sources WHERE storage_pool_id = ? ORDER BY id`).all(String(request.storagePoolId)) as Array<{ path: string }>;
      add(sources.filter((source) => source.path === request.path || source.path.startsWith(`${request.path}/`) || String(request.path).startsWith(`${source.path}/`)));
    }
    const source = typeof request.id === "string" ? context.db.prepare(`SELECT * FROM ${domain}_sources WHERE id = ?`).get(request.id) as { storage_pool_id: string; path: string } | undefined : undefined;
    const poolId = source?.storage_pool_id ?? request.storagePoolId;
    const sourcePath = source?.path ?? request.path;
    if ((operation === "source_create" || operation === "scan") && typeof poolId === "string" && typeof sourcePath === "string") {
      const scope = await resolveStoragePoolScope(context.config.paths.dataRoot, system, poolId);
      const safe = await resolveScopedExistingPath(scope, sourcePath);
      const info = await stat(safe.realPath);
      if (!info.isDirectory()) throw new CapabilityError("INVALID_ARGUMENT", "Media source must be a directory");
      states.push({ poolId, path: safe.relativePath, dev: info.dev, ino: info.ino });
    }
  }
  if (operation.startsWith("playlist_") && request.id) {
    const detail = record(await inject(server, { method: "GET", url: `/api/music/playlists/${encoded(request.id)}` }));
    add(detail.playlist);
    add(detail.tracks);
  }
  if (operation === "favorite") {
    const plural = request.kind === "track" ? "tracks" : request.kind === "album" ? "albums" : "artists";
    const detail = record(await inject(server, { method: "GET", url: `/api/music/${plural}/${encoded(request.id)}` }));
    add(detail.track ?? detail.album ?? detail.artist);
    add(context.db.prepare("SELECT * FROM music_favorites WHERE kind = ? AND entity_id = ?").get(String(request.kind), String(request.id)), false);
  }
  if (operation === "title_state" || operation === "match") {
    row("media_titles", "id", request.id);
    row(operation === "match" ? "media_match_overrides" : "media_personal_state", "title_id", request.id, false);
  }
  if (operation === "episode_state") {
    row("media_episodes", "id", request.id);
    row("media_episode_state", "episode_id", request.id, false);
    const episode = context.db.prepare("SELECT t.title, s.season_number, e.episode_number FROM media_episodes e JOIN media_titles t ON t.id=e.title_id JOIN media_seasons s ON s.id=e.season_id WHERE e.id=?").get(String(request.id)) as { title: string; season_number: number; episode_number: number } | undefined;
    if (episode) labels.push(`${episode.title} S${episode.season_number}E${episode.episode_number}`);
  }
  if (operation === "progress") { row("media_files", "id", request.id); row("media_progress", "file_id", request.id, false); }
  if (operation.startsWith("collection_") && request.id) {
    row("media_collections", "id", request.id);
    add(context.db.prepare("SELECT * FROM media_collection_members WHERE collection_id = ? ORDER BY position").all(String(request.id)));
  }
  if (Array.isArray(request.titleIds)) for (const titleId of request.titleIds) row("media_titles", "id", titleId);
  if (operation === "settings") add(await inject(server, { method: "GET", url: "/api/media/settings" }));
  if (typeof request.name === "string") labels.push(request.name);
  const label = labels.slice(0, 8).map((value) => value.slice(0, 160)).join("; ") || `${domain} ${operation}`;
  return { revision: digest(states), label, target: { label, ...(request.id ? { id: request.id } : {}), ...(request.fileId ? { fileId: request.fileId } : {}) } };
}

export function createMediaCapabilityAdapters(server: FastifyInstance, system?: SystemManagementDependencies): Record<string, CapabilityDomainAdapter> {
  return Object.fromEntries(mutations.map((capabilityId) => {
    const parsed = (value: JsonValue, context: CapabilityAdapterContext) => {
      if (context.subject.kind !== "pi") throw new CapabilityError("FORBIDDEN", "Only the built-in Pi agent may propose media changes");
      return record(validate(capabilityId, { request: value }).request);
    };
    const revalidate = async (prepared: PreparedCapabilityAction, context: CapabilityAdapterContext) => {
      const request = parsed(record(prepared.privatePayload).request ?? null, context);
      const current = await targetState(server, { ...context, capabilityId }, request, system);
      if (current.revision !== prepared.revision) throw new CapabilityError("CONFLICT", "Media target changed after approval was requested");
    };
    const adapter: CapabilityDomainAdapter = {
      availability: async () => {
        if (capabilityId.endsWith("manage-propose")) return { available: true };
        try {
          await inject(server, { method: "GET", url: "/api/playback/status" });
          return { available: true };
        } catch {
          return { available: false, reason: "NAS playback service unavailable" };
        }
      },
      prepare: async (value, context) => {
        const request = parsed(value, context);
        const state = await targetState(server, { ...context, capabilityId }, request, system);
        const playback = request.serviceInstanceId !== undefined;
        return { summary: `${String(request.operation)}: ${state.label}${playback ? "; NAS playback only; takeover may interrupt current playback; music queue is retained" : ""}`, target: state.target, changes: request, revision: state.revision, privatePayload: { request } };
      },
      revalidate,
      execute: async (prepared, context) => {
        await revalidate(prepared, context);
        const request = parsed(record(prepared.privatePayload).request ?? null, context);
        return { data: boundMediaResult(await inject(server, mutationRequest(capabilityId, request))) };
      }
    };
    return [capabilityId, adapter];
  }));
}
