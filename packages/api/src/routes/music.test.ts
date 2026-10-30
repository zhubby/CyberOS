import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMusicSource,
  openCyberOsDb,
  upsertMusicTrack,
  type CyberOsDatabase
} from "@cyberos/db";
import {
  loadCyberOsRuntime,
  type MusicPlayerCommand,
  type MusicPlayerStatus,
  type BluetoothStatus
} from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { registerMusicRoutes } from "./music.js";
let temp: string;
let pool: string;
let db: CyberOsDatabase;
let server: FastifyInstance;
let commands: MusicPlayerCommand[];
let bluetoothDevices: BluetoothStatus["devices"];
const status: MusicPlayerStatus = {
  owner: null,
  state: "idle",
  sessionId: null,
  serviceInstanceId: "test",
  revision: 1,
  queueVersion: 0,
  queue: [],
  currentItemId: null,
  repeat: "off",
  shuffle: false,
  positionSeconds: 0,
  durationSeconds: null,
  volume: 50,
  audioDeviceId: null,
  effectiveAudioDeviceId: null,
  error: null,
  errorCode: null,
  updatedAt: "2026-10-30T01:00:00Z"
};
beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "cyberos-music-api-"));
  pool = path.join(temp, "data", "pool-1");
  await mkdir(path.join(pool, "Music"), { recursive: true });
  db = openCyberOsDb(path.join(temp, "db.sqlite"));
  commands = [];
  bluetoothDevices = [];
  server = Fastify();
  const config = loadCyberOsRuntime(
    { CYBEROS_ROOT: temp, CYBEROS_ENVIRONMENT: "development" },
    temp
  );
  registerMusicRoutes(server, {
    config,
    db,
    system: {
      bluetoothManager: {
        getStatus: async (): Promise<BluetoothStatus> => ({
          collectedAt: status.updatedAt,
          backend: "BlueZ",
          available: true,
          adapters: [],
          devices: bluetoothDevices,
          scan: {
            active: false,
            adapterId: null,
            startedAt: null,
            endsAt: null
          },
          challenge: null,
          error: null
        })
      },
      commandRunner: {
        async run(command: string) {
          if (command === "findmnt")
            return JSON.stringify({
              filesystems: [
                {
                  source: "/dev/md/pool-1",
                  target: pool,
                  fstype: "ext4",
                  size: 1000,
                  used: 100,
                  avail: 900,
                  "use%": "10%"
                }
              ]
            });
          if (command === "mdadm")
            return "ARRAY /dev/md/pool-1 name=pool-1 UUID=test";
          if (command === "smartctl") return JSON.stringify({ devices: [] });
          return JSON.stringify({ blockdevices: [] });
        }
      }
    },
    musicPlayer: {
      getStatus: async () => status,
      command: async (command: MusicPlayerCommand) => {
        commands.push(command);
        return status;
      }
    }
  } as unknown as ApiRouteContext);
});
afterEach(async () => {
  await server.close();
  db.close();
  await rm(temp, { recursive: true, force: true });
});
function seed() {
  const source = createMusicSource(db, {
    name: "Music",
    storagePoolId: "pool-1",
    path: "Music"
  });
  return upsertMusicTrack(db, {
    sourceId: source.id,
    storagePoolId: "pool-1",
    relativePath: "Music/a.flac",
    title: "Song",
    albumId: "album",
    album: "Album",
    artists: ["Artist"],
    albumArtists: ["Artist"],
    generation: "first"
  });
}
describe("Music API", () => {
  it("validates sources against real storage scopes and enqueues the initial scan", async () => {
    const unsafe = await server.inject({
      method: "POST",
      url: "/api/music/sources",
      payload: { name: "Bad", storagePoolId: "pool-1", path: "../outside" }
    });
    expect(unsafe.statusCode).toBeGreaterThanOrEqual(400);
    const created = await server.inject({
      method: "POST",
      url: "/api/music/sources",
      payload: { name: "Music", storagePoolId: "pool-1", path: "Music" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().scan.status).toBe("queued");
    expect(
      (await server.inject("/api/music/sources")).json().sources
    ).toHaveLength(1);
  });
  it("resolves track ids to trusted queue entries and rejects injected paths", async () => {
    const t = seed();
    const play = await server.inject({
      method: "POST",
      url: "/api/music/player/command",
      payload: { type: "replace", trackIds: [t.id], expectedQueueVersion: 0 }
    });
    expect(play.statusCode).toBe(200);
    expect(commands[0]).toMatchObject({
      type: "replace",
      entries: [
        { trackId: t.id, relativePath: "Music/a.flac", storagePoolId: "pool-1" }
      ]
    });
    const bad = await server.inject({
      method: "POST",
      url: "/api/music/player/command",
      payload: {
        type: "replace",
        entries: [{ relativePath: "/etc/passwd" }],
        expectedQueueVersion: 0
      }
    });
    expect(bad.statusCode).toBe(400);
    expect(commands).toHaveLength(1);
  });
  it("rejects unversioned commands, unavailable songs and arbitrary audio outputs", async () => {
    const t = seed();
    for (const payload of [
      { type: "pause" },
      { type: "volume", volume: 101, expectedQueueVersion: 0 },
      {
        type: "output",
        audioDeviceId: "alsa/arbitrary",
        expectedQueueVersion: 0
      },
      { type: "replace", trackIds: ["not-found"], expectedQueueVersion: 0 }
    ])
      expect(
        (
          await server.inject({
            method: "POST",
            url: "/api/music/player/command",
            payload
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
    db.prepare("UPDATE music_tracks SET missing=1 WHERE id=?").run(t.id);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/music/player/command",
          payload: {
            type: "replace",
            trackIds: [t.id],
            expectedQueueVersion: 0
          }
        })
      ).statusCode
    ).toBe(409);
    expect(commands).toHaveLength(0);
  });
  it("returns typed catalog pages, rejects invalid filters and supports playlist duplicates", async () => {
    const t = seed();
    expect((await server.inject(`/api/music/tracks/${t.id}`)).json()).toMatchObject({track: {id: t.id, favorite: false}});
    expect((await server.inject("/api/music/tracks/not-found")).statusCode).toBe(404);
    expect(
      (await server.inject("/api/music/tracks?limit=1")).json()
    ).toMatchObject({ items: [{ id: t.id }], nextCursor: null });
    expect(
      (await server.inject("/api/music/tracks?year=wrong")).statusCode
    ).toBe(400);
    const playlist = await server.inject({
      method: "POST",
      url: "/api/music/playlists",
      payload: { name: "Mix", trackIds: [t.id, t.id] }
    });
    expect(playlist.statusCode).toBe(201);
    expect(
      (
        await server.inject(
          `/api/music/playlists/${playlist.json().playlist.id}`
        )
      ).json().tracks
    ).toHaveLength(2);
  });
  it("accepts only paired audio devices and keeps output changes versioned", async () => {
    bluetoothDevices = [
      {
        adapterId: "adapter-hci0",
        address: "AA:BB:CC:DD:EE:FF",
        name: "Speaker",
        alias: null,
        type: "speaker",
        rssi: null,
        paired: true,
        trusted: true,
        connected: true,
        servicesResolved: true,
        lastSeenAt: null
      }
    ];
    const output = {
      type: "output",
      audioDeviceId: "bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF",
      expectedQueueVersion: 0
    };
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/music/player/command",
          payload: output
        })
      ).statusCode
    ).toBe(200);
    expect(commands[0]).toEqual(output);
    bluetoothDevices[0]!.paired = false;
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/music/player/command",
          payload: output
        })
      ).statusCode
    ).toBe(400);
    expect(commands).toHaveLength(1);
  });
  it("streams an initial library/player snapshot and closes the sampling timer", async () => {
    seed();
    const clear = vi.spyOn(globalThis, "clearInterval");
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/music/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    let buffer = "";
    while (
      !buffer.includes("event: snapshot") ||
      !/data: [^\n]+\n\n/u.test(buffer)
    ) {
      const chunk = await reader.read();
      if (chunk.done)
        throw new Error("Music SSE closed before the initial snapshot");
      buffer += new TextDecoder().decode(chunk.value);
    }
    const frame = /data: ([^\n]+)\n\n/u.exec(buffer);
    expect(JSON.parse(frame![1]!)).toMatchObject({
      status: { trackCount: 1 },
      player: { queueVersion: 0, serviceInstanceId: "test" }
    });
    await reader.cancel();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await server.close();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
  it("does not follow cache symlinks or accept arbitrary artwork paths", async () => {
    const t = seed();
    const key = `${"a".repeat(64)}.jpg`;
    db.prepare("UPDATE music_tracks SET artwork_key=? WHERE id=?").run(
      key,
      t.id
    );
    const cache = path.join(temp, "state", "music", "artwork");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(temp, "secret"), "secret");
    await symlink(path.join(temp, "secret"), path.join(cache, key));
    expect(
      (await server.inject(`/api/music/artwork/${key}`)).statusCode
    ).toBeGreaterThanOrEqual(400);
    expect((await server.inject("/api/music/artwork/bad.jpg")).statusCode).toBe(
      400
    );
  });
});
