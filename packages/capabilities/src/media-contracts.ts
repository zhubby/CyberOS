import type { JsonSchema } from "./contracts.js";
import type { MusicPlayerRequest, MusicQuery, VideoQuery, VodPlayerCommand } from "@cyberos/shared";
import { strictObject } from "./schemas.js";

export interface MediaPlaybackGuard {
  serviceInstanceId: string;
  playbackSessionId: string | null;
}
type AsOperation<Command> = Command extends { type: infer Name extends string }
  ? Omit<Command, "type" | "expectedSessionId"> & { operation: Name } & MediaPlaybackGuard
  : never;
export type MusicControlCapabilityRequest = AsOperation<MusicPlayerRequest>;
export type PlaybackControlCapabilityRequest = AsOperation<Exclude<VodPlayerCommand, { type: "status" | "play" | "music" | "guarded" }>>;
type Proposal<Request> = { request: Request; idempotencyKey?: string };
type SourceRequest =
  | { operation: "source_create"; name: string; storagePoolId: string; path: string }
  | { operation: "source_update"; id: string; name?: string; enabled?: boolean }
  | { operation: "source_delete" | "scan"; id: string };
export type MusicManageCapabilityRequest = SourceRequest
  | { operation: "favorite"; kind: "track" | "album" | "artist"; id: string; favorite: boolean }
  | { operation: "playlist_create"; name: string; trackIds?: string[] }
  | { operation: "playlist_update"; id: string; name?: string; trackIds?: string[] }
  | { operation: "playlist_delete"; id: string };
export type MediaManageCapabilityRequest = Exclude<SourceRequest, { operation: "source_create" }>
  | { operation: "source_create"; name: string; storagePoolId: string; path: string; kind: "movie" | "series" }
  | { operation: "title_state"; id: string; favorite?: boolean; watchlist?: boolean; watched?: boolean | null }
  | { operation: "episode_state"; id: string; watched: boolean }
  | { operation: "progress"; id: string; positionSeconds: number; durationSeconds?: number | null }
  | { operation: "collection_create"; name: string }
  | { operation: "collection_update"; id: string; name?: string; titleIds?: string[] }
  | { operation: "collection_delete"; id: string }
  | { operation: "match"; id: string; tmdbId?: number | null; excluded?: boolean }
  | { operation: "settings"; language?: string; region?: string | null };

export interface MediaCapabilityRequestMap {
  "cyberos.music.query": MusicQuery & { entity: "tracks" | "albums" | "artists" | "playlists" };
  "cyberos.music.get": { entity: "tracks" | "albums" | "artists" | "playlists" | "lyrics"; id: string; limit?: number };
  "cyberos.music.status": { view?: "home" | "sources" | "scans" | "library"; limit?: number };
  "cyberos.music.manage-propose": Proposal<MusicManageCapabilityRequest>;
  "cyberos.music.control-propose": Proposal<MusicControlCapabilityRequest>;
  "cyberos.media.query": VideoQuery & { matchStatus?: "pending" | "matched" | "unmatched" | "excluded" };
  "cyberos.media.get": { entity: "titles" | "next" | "match-candidates"; id: string; query?: string; limit?: number };
  "cyberos.media.status": { view?: "home" | "sources" | "scans" | "library" | "collections" | "settings"; sourceId?: string; limit?: number };
  "cyberos.media.manage-propose": Proposal<MediaManageCapabilityRequest>;
  "cyberos.media.play-propose": Proposal<MediaPlaybackGuard & { operation: "play"; fileId: string; startPositionSeconds?: number }>;
  "cyberos.playback.status": { limit?: number };
  "cyberos.playback.outputs": Record<string, never>;
  "cyberos.playback.control-propose": Proposal<PlaybackControlCapabilityRequest>;
}

const identifier: JsonSchema = { type: "string", minLength: 1, maxLength: 256 };
const text: JsonSchema = { type: "string", maxLength: 512 };
const flag: JsonSchema = { type: "boolean" };
const nullableId: JsonSchema = { type: ["string", "null"], minLength: 1, maxLength: 256 };
const integer = (maximum: number, minimum = 0): JsonSchema => ({ type: "integer", minimum, maximum });
const seconds: JsonSchema = { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const enumeration = (values: string[]): JsonSchema => ({ type: "string", enum: values });
const identifiers: JsonSchema = { type: "array", items: identifier, maxItems: 1000 };
const page = { cursor: { type: "string", maxLength: 4096 } as JsonSchema, limit: { ...integer(100, 1), default: 40 } };
const bound = { limit: page.limit };
const guard = { serviceInstanceId: identifier, playbackSessionId: nullableId };
const guardKeys = Object.keys(guard);
const operation = (name: string, properties: Record<string, JsonSchema> = {}, required: string[] = []) => strictObject({ operation: { const: name }, ...properties }, ["operation", ...required]);
const proposal = (operations: JsonSchema[]) => strictObject({ request: { oneOf: operations }, idempotencyKey: { type: "string", minLength: 8, maxLength: 200 } }, ["request"]);
const sourceOperations = [
  operation("source_create", { name: identifier, storagePoolId: identifier, path: { type: "string", minLength: 1, maxLength: 4096 } }, ["name", "storagePoolId", "path"]),
  operation("source_update", { id: identifier, name: identifier, enabled: flag }, ["id"]),
  operation("source_delete", { id: identifier }, ["id"]),
  operation("scan", { id: identifier }, ["id"])
];
const musicControl = (name: string, properties: Record<string, JsonSchema> = {}, required: string[] = []) => operation(name, { ...guard, expectedQueueVersion: integer(Number.MAX_SAFE_INTEGER), ...properties }, [...guardKeys, "expectedQueueVersion", ...required]);
const playbackControl = (name: string, properties: Record<string, JsonSchema> = {}, required: string[] = []) => operation(name, { ...guard, sessionId: identifier, ...properties }, [...guardKeys, "sessionId", ...required]);

export const MEDIA_CAPABILITY_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  "cyberos.music.query": strictObject({ entity: enumeration(["tracks", "albums", "artists", "playlists"]), query: text, sourceId: identifier, albumId: identifier, artistId: identifier, year: integer(9999), genre: text, favorite: flag, sort: enumeration(["name", "year", "added"]), ...page }, ["entity"]),
  "cyberos.music.get": strictObject({ entity: enumeration(["tracks", "albums", "artists", "playlists", "lyrics"]), id: identifier, ...bound }, ["entity", "id"]),
  "cyberos.music.status": strictObject({ view: enumeration(["home", "sources", "scans", "library"]), ...bound }),
  "cyberos.music.manage-propose": proposal([
    ...sourceOperations,
    operation("favorite", { kind: enumeration(["track", "album", "artist"]), id: identifier, favorite: flag }, ["kind", "id", "favorite"]),
    operation("playlist_create", { name: identifier, trackIds: identifiers }, ["name"]),
    operation("playlist_update", { id: identifier, name: identifier, trackIds: identifiers }, ["id"]),
    operation("playlist_delete", { id: identifier }, ["id"])
  ]),
  "cyberos.music.control-propose": proposal([
    ...["replace", "append", "insert-next"].map((name) => musicControl(name, { trackIds: { ...identifiers, minItems: 1 } }, ["trackIds"])),
    ...["remove", "jump"].map((name) => musicControl(name, { itemId: identifier }, ["itemId"])),
    musicControl("reorder", { itemIds: { ...identifiers, uniqueItems: true } }, ["itemIds"]),
    ...["clear", "next", "previous", "pause", "resume"].map((name) => musicControl(name)),
    musicControl("seek", { seconds }, ["seconds"]),
    musicControl("volume", { volume: { type: "number", minimum: 0, maximum: 100 } }, ["volume"]),
    musicControl("mode", { repeat: enumeration(["off", "one", "all"]), shuffle: flag }, ["repeat", "shuffle"]),
    musicControl("output", { audioDeviceId: nullableId }, ["audioDeviceId"])
  ]),
  "cyberos.media.query": strictObject({ kind: enumeration(["movie", "series"]), query: text, sourceId: identifier, genre: text, year: integer(9999), favorite: flag, watchlist: flag, watched: flag, collectionId: identifier, matchStatus: enumeration(["pending", "matched", "unmatched", "excluded"]), sort: enumeration(["title", "year", "added", "rating", "recent"]), ...page }),
  "cyberos.media.get": strictObject({ entity: enumeration(["titles", "next", "match-candidates"]), id: identifier, query: text, ...bound }, ["entity", "id"]),
  "cyberos.media.status": strictObject({ view: enumeration(["home", "sources", "scans", "library", "collections", "settings"]), sourceId: identifier, ...bound }),
  "cyberos.media.manage-propose": proposal([
    ...sourceOperations.map((schema) => schema.properties?.operation?.const === "source_create" ? operation("source_create", { ...schema.properties, kind: enumeration(["movie", "series"]) }, ["name", "storagePoolId", "path", "kind"]) : schema),
    operation("title_state", { id: identifier, favorite: flag, watchlist: flag, watched: { type: ["boolean", "null"] } }, ["id"]),
    operation("episode_state", { id: identifier, watched: flag }, ["id", "watched"]),
    operation("progress", { id: identifier, positionSeconds: seconds, durationSeconds: { type: ["number", "null"], minimum: 0 } }, ["id", "positionSeconds"]),
    operation("collection_create", { name: identifier }, ["name"]),
    operation("collection_update", { id: identifier, name: identifier, titleIds: identifiers }, ["id"]),
    operation("collection_delete", { id: identifier }, ["id"]),
    operation("match", { id: identifier, tmdbId: { type: ["integer", "null"], minimum: 1 }, excluded: flag }, ["id"]),
    operation("settings", { language: identifier, region: nullableId })
  ]),
  "cyberos.media.play-propose": proposal([operation("play", { ...guard, fileId: identifier, startPositionSeconds: seconds }, [...guardKeys, "fileId"])]),
  "cyberos.playback.status": strictObject(bound),
  "cyberos.playback.outputs": strictObject({}),
  "cyberos.playback.control-propose": proposal([
    ...["pause", "resume", "toggle-pause", "stop", "stop-video", "retry", "cycle-audio-track", "cycle-subtitle-track"].map((name) => playbackControl(name)),
    playbackControl("seek", { seconds }, ["seconds"]),
    playbackControl("seek-relative", { seconds: { type: "number", minimum: -3600, maximum: 3600 } }, ["seconds"]),
    playbackControl("set-volume", { volume: { type: "number", minimum: 0, maximum: 100 } }, ["volume"]),
    playbackControl("set-output", { audioDeviceId: nullableId }, ["audioDeviceId"]),
    playbackControl("set-muted", { muted: flag }, ["muted"]),
    playbackControl("set-audio-delay", { milliseconds: { type: "number", minimum: -5000, maximum: 5000 } }, ["milliseconds"]),
    playbackControl("set-audio-track", { trackId: integer(1_000_000, 1) }, ["trackId"]),
    playbackControl("set-subtitle-track", { trackId: { type: ["integer", "null"], minimum: 1, maximum: 1_000_000 } }, ["trackId"])
  ])
};
