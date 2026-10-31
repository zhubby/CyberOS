import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelOwnedCapabilityRun, createMcpClient, createMusicPlaylist, createMusicSource, createMediaSource, createSession, createUserMessageAndJob, decideCapabilityApproval, getCapabilityApprovalByRun, linkAgentJobToCapabilityRun, openCyberOsDb, upsertMusicTrack, upsertMediaCatalogEntry, type CyberOsDatabase } from "@cyberos/db";
import { executeApprovedCapabilityRun } from "@cyberos/capability-runtime";
import { createClientRuntime, invokeCapability } from "../../../mcp/src/runtime.js";
import { registerMcp } from "@cyberos/mcp";
import type { ApiRouteContext } from "../context.js";
import { registerMusicRoutes } from "../routes/music.js";
import { registerMediaRoutes } from "../routes/media.js";
import { registerPlaybackRoutes } from "../routes/playback.js";
import { loadCyberOsRuntime, parsePlaybackSnapshot, type VodPlayerCommand } from "@cyberos/shared";
import type { CapabilityAdapterContext } from "@cyberos/capability-runtime";
import fixtures from "../../../shared/fixtures/vod-player-protocol-v3.json" with { type: "json" };
import { boundMediaResult, createMediaCapabilityAdapters, createMediaReadAdapters } from "./media-capabilities.js";

let server: FastifyInstance;
let db: CyberOsDatabase;
let root: string;
let context: CapabilityAdapterContext;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "media-mcp-"));
  db = openCyberOsDb(path.join(root, "state.sqlite"));
  server = Fastify();
  context = { db, config: loadCyberOsRuntime({ CYBEROS_ROOT: root, CYBEROS_ENVIRONMENT: "development" }, root), capabilityId: "cyberos.music.manage-propose", subject: { id: "pi", clientId: "pi", kind: "pi", scopes: new Set() } };
});
afterEach(async () => { await server.close(); db.close(); await rm(root, { recursive: true, force: true }); });

describe("media capability adapters", () => {
  it("bounds nested queues and lyrics within the MCP output budget", () => {
    const result = boundMediaResult({ status: { queue: Array.from({ length: 1000 }, () => ({ title: "字".repeat(20000) })) }, text: "x".repeat(100000) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
    expect(result).toMatchObject({ truncated: true });
  });
  it("reads libraries without contacting the playback daemon and marks bounded results", async () => {
    server.get("/api/music/home", async () => ({ recent: Array.from({ length: 110 }, (_, index) => ({ id: String(index) })) }));
    const reads = createMediaReadAdapters(server);
    const result = await reads["cyberos.music.status"]!({ view: "home", limit: 2 });
    expect(result).toMatchObject({ recent: [{ id: "0" }, { id: "1" }], truncation: [{ path: "recent", total: 110 }] });
  });
  it("does not mutate before approval and only conflicts on the target playlist", async () => {
    const playlist = createMusicPlaylist(db, "Target");
    server.get("/api/music/playlists/:id", async () => ({ playlist: { id: playlist.id, name: "Target" }, tracks: [] }));
    let writes = 0;
    server.patch("/api/music/playlists/:id", async () => { writes += 1; return { saved: true }; });
    const adapter = createMediaCapabilityAdapters(server)[context.capabilityId]!;
    const prepared = await adapter.prepare({ operation: "playlist_update", id: playlist.id, name: "Changed" }, context);
    expect(prepared.summary).toContain("Target");
    expect(writes).toBe(0);
    createMusicPlaylist(db, "Unrelated");
    await adapter.revalidate(prepared, context);
    await adapter.execute(prepared, context, {});
    expect(writes).toBe(1);
  });
  it("rejects stale playback and queue guards but permits natural progress", async () => {
    const status = parsePlaybackSnapshot((JSON.parse(fixtures.responses[0]!) as { status: unknown }).status)!;
    server.get("/api/playback/status", async () => ({ status }));
    context.capabilityId = "cyberos.music.control-propose";
    const adapter = createMediaCapabilityAdapters(server)[context.capabilityId]!;
    const request = { operation: "pause", serviceInstanceId: status.serviceInstanceId, playbackSessionId: status.sessionId, expectedQueueVersion: status.music.queueVersion };
    const prepared = await adapter.prepare(request, context);
    status.music.positionSeconds += 5;
    status.revision += 1;
    await adapter.revalidate(prepared, context);
    status.music.queueVersion += 1;
    await expect(adapter.revalidate(prepared, context)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(adapter.prepare(request, context)).rejects.toMatchObject({ code: "CONFLICT" });
    status.music.queueVersion -= 1;
    status.serviceInstanceId = "restarted";
    await expect(adapter.revalidate(prepared, context)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("does not allow external callers or secret fields through the adapter", async () => {
    const adapter = createMediaCapabilityAdapters(server)["cyberos.media.manage-propose"]!;
    context.subject = { ...context.subject, kind: "local" };
    await expect(adapter.prepare({ operation: "settings", language: "en" }, context)).rejects.toMatchObject({ code: "FORBIDDEN" });
    context.subject = { ...context.subject, kind: "pi" };
    await expect(adapter.prepare({ operation: "settings", tmdbReadAccessToken: "secret" }, context)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("persists approval, enforces explicit playback confirmation and executes only once", async () => {
    const status = parsePlaybackSnapshot((JSON.parse(fixtures.responses[0]!) as { status: unknown }).status)!;
    server.get("/api/playback/status", async () => ({ status }));
    const calls: unknown[] = [];
    server.post("/api/playback/command", async (request) => { calls.push(request.body); return { status }; });
    const adapters = createMediaCapabilityAdapters(server);
    const dependencies = { db, config: context.config, adapters, readAdapters: createMediaReadAdapters(server) };
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["cyberos:playback:read", "cyberos:playback:propose"] });
    const runtime = createClientRuntime(dependencies, client);
    const input = { request: { operation: "pause", serviceInstanceId: status.serviceInstanceId, playbackSessionId: status.sessionId, sessionId: status.sessionId }, idempotencyKey: "pause-one-time" };
    const proposal = await invokeCapability(runtime, "cyberos.playback.control-propose", input);
    const session = createSession(db, {});
    const { job } = createUserMessageAndJob(db, { sessionId: session.id, content: "Pause NAS playback", status: "waiting_approval" });
    linkAgentJobToCapabilityRun(db, { jobId: job.id, runId: proposal.runId! });
    const repeated = await invokeCapability(runtime, "cyberos.playback.control-propose", input);
    expect(repeated.runId).toBe(proposal.runId);
    expect(calls).toHaveLength(0);
    const approval = getCapabilityApprovalByRun(db, proposal.runId!)!;
    expect(approval.requiresConfirmation).toBe(true);
    const decision = { approvalId: approval.id, expectedRevision: approval.revision, decision: "approved" as const, decidedBy: "local-admin" };
    expect(decideCapabilityApproval(db, decision)).toBeNull();
    expect(decideCapabilityApproval(db, { ...decision, confirmed: true })).not.toBeNull();
    expect(await executeApprovedCapabilityRun(dependencies, proposal.runId!)).toMatchObject({ state: "succeeded", errorCode: null, errorMessage: null });
    await executeApprovedCapabilityRun(dependencies, proposal.runId!);
    expect(calls).toEqual([{ type: "guarded", serviceInstanceId: status.serviceInstanceId, expectedSessionId: status.sessionId, command: { type: "pause", sessionId: status.sessionId } }]);
  });
  it("serves the real MCP discovery and calls with external read-only boundaries", async () => {
    server.get("/api/music/tracks", async () => ({ items: [{ id: "song", title: "Test song" }], nextCursor: null }));
    const dependencies = { db, config: context.config, adapters: createMediaCapabilityAdapters(server), readAdapters: createMediaReadAdapters(server) };
    const client = createMcpClient(db, { name: "External", kind: "local", scopes: ["cyberos:catalog:read", "cyberos:music:read", "cyberos:music:propose"] });
    registerMcp(server, dependencies, { enabled: true });
    const call = async (method: string, params: object) => {
      const response = await server.inject({ method: "POST", url: "/mcp", headers: { host: "127.0.0.1", authorization: `Bearer ${client.token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" }, payload: { jsonrpc: "2.0", id: 1, method, params } });
      expect(response.statusCode).toBe(200);
      const data = response.body.startsWith("event:") ? response.body.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : response.body;
      return JSON.parse(data) as { result: { tools?: Array<{ name: string }>; structuredContent?: unknown; isError?: boolean }; error?: unknown };
    };
    const listing = await call("tools/list", {});
    expect(listing.result.tools?.map((tool) => tool.name)).toContain("cyberos.music.query");
    expect(listing.result.tools?.map((tool) => tool.name)).not.toContain("cyberos.music.manage-propose");
    const query = await call("tools/call", { name: "cyberos.music.query", arguments: { entity: "tracks", query: "Test" } });
    expect(query.result.structuredContent).toMatchObject({ data: { items: [{ title: "Test song" }] } });
    const denied = await call("tools/call", { name: "cyberos.music.manage-propose", arguments: { request: { operation: "playlist_create", name: "Forbidden" } } });
    expect(denied.error || denied.result.isError).toBeTruthy();
    const noScopes = createClientRuntime(dependencies, { ...client, scopes: [] });
    await expect(invokeCapability(noScopes, "cyberos.music.query", { entity: "tracks" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each(["reject", "cancel"])("does not execute a %s media proposal", async (decision) => {
    let writes = 0;
    server.post("/api/music/playlists", async () => { writes += 1; return { saved: true }; });
    const dependencies = { db, config: context.config, adapters: createMediaCapabilityAdapters(server) };
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["cyberos:music:propose"] });
    const proposal = await invokeCapability(createClientRuntime(dependencies, client), "cyberos.music.manage-propose", { request: { operation: "playlist_create", name: "Rejected list" } });
    if (decision === "cancel") {
      expect(cancelOwnedCapabilityRun(db, client.id, proposal.runId!)).not.toBeNull();
    } else {
      const approval = getCapabilityApprovalByRun(db, proposal.runId!)!;
      expect(decideCapabilityApproval(db, { approvalId: approval.id, expectedRevision: approval.revision, decision: "rejected", decidedBy: "local-admin" })).not.toBeNull();
    }
    expect((await executeApprovedCapabilityRun(dependencies, proposal.runId!)).state).not.toBe("succeeded");
    expect(writes).toBe(0);
  });
  it("reuses real library routes for search, approved music playback and video takeover", async () => {
    const { adapters, dependencies, runtime, status, calls, track, file } = await realLibrary();
    expect(await invokeCapability(runtime, "cyberos.music.query", { entity: "tracks", query: "Song" })).toMatchObject({ data: { items: [{ id: track.id }] } });
    const approve = async (capabilityId: string, request: Record<string, string | number | null | string[]>) => {
      const proposed = await invokeCapability(runtime, capabilityId, { request });
      const session = createSession(db, {});
      const { job } = createUserMessageAndJob(db, { sessionId: session.id, content: "Play media", status: "waiting_approval" });
      linkAgentJobToCapabilityRun(db, { jobId: job.id, runId: proposed.runId! });
      const approval = getCapabilityApprovalByRun(db, proposed.runId!)!;
      expect(calls).toHaveLength(capabilityId === "cyberos.music.control-propose" ? 0 : 1);
      expect(decideCapabilityApproval(db, { approvalId: approval.id, expectedRevision: approval.revision, decision: "approved", decidedBy: "local-admin", confirmed: true })).not.toBeNull();
      expect(await executeApprovedCapabilityRun(dependencies, proposed.runId!)).toMatchObject({ state: "succeeded", errorCode: null, errorMessage: null });
    };
    const guard = { serviceInstanceId: status.serviceInstanceId, playbackSessionId: status.sessionId };
    await approve("cyberos.music.control-propose", { operation: "replace", trackIds: [track.id], expectedQueueVersion: status.music.queueVersion, ...guard });
    expect(calls[0]).toMatchObject({ type: "guarded", command: { type: "music", command: { type: "replace", entries: [{ trackId: track.id, relativePath: "Music/song.flac" }] } } });
    await approve("cyberos.media.play-propose", { operation: "play", fileId: file.id, startPositionSeconds: 12, ...guard });
    expect(calls[1]).toMatchObject({ type: "guarded", command: { type: "play", mediaFileId: file.id, relativePath: "Movies/movie.mkv", startPositionSeconds: 12 } });
    const favorite = await adapters["cyberos.music.manage-propose"]!.prepare({ operation: "favorite", kind: "track", id: track.id, favorite: true }, context);
    await adapters["cyberos.music.manage-propose"]!.execute(favorite, context, {});
    expect(await invokeCapability(runtime, "cyberos.music.get", { entity: "tracks", id: track.id })).toMatchObject({ data: { track: { favorite: true } } });
    const playlist = await adapters["cyberos.music.manage-propose"]!.prepare({ operation: "playlist_create", name: "Daily", trackIds: [track.id] }, context);
    expect(await adapters["cyberos.music.manage-propose"]!.execute(playlist, context, {})).toMatchObject({ data: { playlist: { name: "Daily" } } });
  });
  it("rejects file replacement and symlink escapes between preparation and execution", async () => {
    const { adapters, status, track } = await realLibrary();
    const adapter = adapters["cyberos.music.control-propose"]!;
    const request = { operation: "replace", trackIds: [track.id], expectedQueueVersion: status.music.queueVersion, serviceInstanceId: status.serviceInstanceId, playbackSessionId: status.sessionId };
    const prepared = await adapter.prepare(request, context);
    await writeFile(path.join(root, "data/pool-1/Music/song.flac"), "replacement with changed identity");
    await expect(adapter.revalidate(prepared, context)).rejects.toMatchObject({ code: "CONFLICT" });
    await rm(path.join(root, "data/pool-1/Music/song.flac"));
    await writeFile(path.join(root, "outside.flac"), "outside");
    await symlink(path.join(root, "outside.flac"), path.join(root, "data/pool-1/Music/song.flac"));
    await expect(adapter.prepare(request, context)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

async function realLibrary() {
  const pool = path.join(root, "data/pool-1");
  await mkdir(path.join(pool, "Music"), { recursive: true });
  await mkdir(path.join(pool, "Movies"), { recursive: true });
  await writeFile(path.join(pool, "Music/song.flac"), "audio");
  await writeFile(path.join(pool, "Movies/movie.mkv"), "video");
  const system = { commandRunner: { async run(command: string) {
    if (command === "findmnt") return JSON.stringify({ filesystems: [{ source: "/dev/md/pool-1", target: pool, fstype: "ext4", size: 1000, used: 100, avail: 900, "use%": "10%" }] });
    if (command === "mdadm") return "ARRAY /dev/md/pool-1 name=pool-1 UUID=test";
    if (command === "smartctl") return JSON.stringify({ devices: [] });
    return JSON.stringify({ blockdevices: [] });
  } } };
  const status = parsePlaybackSnapshot((JSON.parse(fixtures.responses[0]!) as { status: unknown }).status)!;
  const calls: VodPlayerCommand[] = [];
  const routeContext = { ...context, system, playback: { getStatus: async () => status, command: async (command: VodPlayerCommand) => { calls.push(command); return status; } } } as unknown as ApiRouteContext;
  registerMusicRoutes(server, routeContext);
  registerMediaRoutes(server, routeContext);
  registerPlaybackRoutes(server, routeContext);
  const source = createMusicSource(db, { name: "Music", storagePoolId: "pool-1", path: "Music" });
  const track = upsertMusicTrack(db, { sourceId: source.id, storagePoolId: "pool-1", relativePath: "Music/song.flac", title: "Song", albumId: "album", album: "Album", artists: ["Artist"], albumArtists: ["Artist"], generation: "one" });
  const movieSource = createMediaSource(db, { name: "Movies", storagePoolId: "pool-1", path: "Movies", kind: "movie" });
  const { file } = upsertMediaCatalogEntry(db, { sourceId: movieSource.id, generation: "one", title: { kind: "movie", sourcePath: "Movies/Movie", title: "Movie", metadataSource: "filename", matchStatus: "unmatched" }, file: { relativePath: "Movies/movie.mkv", name: "movie.mkv", mimeType: "video/x-matroska", sizeBytes: 5, mtimeMs: 1 } });
  const adapters = createMediaCapabilityAdapters(server, system);
  const dependencies = { db, config: context.config, adapters, readAdapters: createMediaReadAdapters(server) };
  const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["cyberos:music:read", "cyberos:music:propose", "cyberos:media:read", "cyberos:media:propose", "cyberos:playback:read"] });
  return { adapters, dependencies, runtime: createClientRuntime(dependencies, client), status, calls, track, file };
}
