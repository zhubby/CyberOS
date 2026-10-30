import { request } from "node:http";
import { startStreamServer } from "./server.js";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createMediaSource,
  openCyberOsDb,
  upsertMediaCatalogEntry,
  type CyberOsDatabase,
} from "@cyberos/db";
import { loadCyberOsRuntime } from "@cyberos/shared";
import { StreamManager, validateOptions } from "./manager.js";

let closeHttp: (() => Promise<void>) | undefined;
let root: string;
let db: CyberOsDatabase;
let manager: StreamManager;
let sourceId: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyb-stream-"));
  await mkdir(path.join(root, "data/pool/Movies"), { recursive: true });
  await mkdir(path.join(root, "state"));
  const config = loadCyberOsRuntime({
    CYBEROS_ROOT: root,
    CYBEROS_ENVIRONMENT: "development",
  });
  db = openCyberOsDb(config.paths.databasePath);
  sourceId = createMediaSource(db, {
    name: "Movies",
    kind: "movie",
    storagePoolId: "pool",
    path: "Movies",
  }).id;
  manager = new StreamManager(db, config);
  await manager.initialize();
});
afterEach(async () => {
  await closeHttp?.();
  closeHttp = undefined;
  await manager.shutdown();
  db.close();
  await rm(root, { recursive: true, force: true });
});
async function add(name: string) {
  const s = await stat(path.join(root, "data/pool/Movies", name));
  return upsertMediaCatalogEntry(db, {
    sourceId,
    generation: "one",
    title: {
      title: name,
      kind: "movie",
      sourcePath: `Movies/${name}`,
      metadataSource: "filename",
      matchStatus: "unmatched",
    },
    file: {
      relativePath: `Movies/${name}`,
      name,
      mimeType: "video/mp4",
      sizeBytes: s.size,
      mtimeMs: Math.floor(s.mtimeMs),
    },
  }).file;
}
async function ready(id: string) {
  for (let n = 0; n < 120; n++) {
    const s = await manager.get(id);
    if (s.state === "error") throw new Error(s.error!);
    if (s.state === "ready") return s;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Stream did not become ready");
}
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
it("validates options before opening a file", () => {
  expect(() =>
    validateOptions({ fileId: "a", startPositionSeconds: NaN }),
  ).toThrow();
  expect(() => validateOptions({ fileId: "a", audioTrack: -1 })).toThrow();
  expect(() =>
    validateOptions({ fileId: "a", codecs: ["injected"] }),
  ).toThrow();
});
it("rejects a symlink escape without exposing its contents", async () => {
  await writeFile(path.join(root, "outside.mp4"), "secret");
  await symlink(
    path.join(root, "outside.mp4"),
    path.join(root, "data/pool/Movies/escape.mp4"),
  );
  const file = await add("escape.mp4");
  const session = manager.create({ fileId: file.id });
  await expect(ready(session.id)).rejects.toThrow();
  expect((await manager.get(session.id)).state).toBe("error");
});
it.skipIf(!ffmpeg)(
  "plays a real MP4, remuxes MKV, queues and cancels encoders, and rejects changed sources",
  async () => {
    const mp4 = path.join(root, "data/pool/Movies/sample.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=size=160x90:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      "6",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "24",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      mp4,
    ]);
    const file = await add("sample.mp4");
    const direct = manager.create({ fileId: file.id });
    expect((await ready(direct.id)).mode).toBe("direct");
    expect((await manager.asset(direct.id, "direct")).size).toBeGreaterThan(0);
    const socketPath = path.join(root, "state/http.sock");
    closeHttp = await startStreamServer(manager, socketPath);
    const readRange = (start: number, end: number) =>
      new Promise<{
        status: number;
        bytes: Buffer;
        range: string | undefined;
      }>((resolve, reject) => {
        const req = request(
          {
            socketPath,
            path: `/sessions/${direct.id}/assets/direct`,
            headers: { range: `bytes=${start}-${end}` },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.once("error", reject);
            res.on("data", (chunk) => chunks.push(chunk as Buffer));
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                bytes: Buffer.concat(chunks),
                range: res.headers["content-range"],
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    const response = await readRange(0, 31);
    expect(response.status).toBe(206);
    expect(response.bytes.length).toBe(32);
    expect(response.range).toMatch(/^bytes 0-31\//);
    expect((await manager.get(direct.id)).state).toBe("ready");

    const original = await readFile(mp4);
    for (const [start, end] of [[32, 63], [64, 95]] as const) {
      const next = await readRange(start, end);
      expect(next.status).toBe(206);
      expect(next.bytes).toEqual(original.subarray(start, end + 1));
      expect((await manager.get(direct.id)).state).toBe("ready");
    }
    const concurrent = await Promise.all([readRange(96, 127), readRange(128, 159)]);
    expect(concurrent.map((part) => part.status)).toEqual([206, 206]);
    expect(concurrent[0]!.bytes).toEqual(original.subarray(96, 128));
    expect(concurrent[1]!.bytes).toEqual(original.subarray(128, 160));
    expect((await manager.get(direct.id)).state).toBe("ready");

    await new Promise<void>((resolve, reject) => {
      const req = request(
        { socketPath, path: `/sessions/${direct.id}/assets/direct` },
        (res) => {
          res.once("close", resolve);
          res.destroy();
        },
      );
      req.once("error", reject);
      req.end();
    });
    const afterCancel = await readRange(160, 191);
    expect(afterCancel.status).toBe(206);
    expect(afterCancel.bytes).toEqual(original.subarray(160, 192));
    expect((await manager.get(direct.id)).state).toBe("ready");
    const whole = await readRange(0, original.length - 1);
    expect(whole.bytes).toEqual(original);
    expect((await manager.get(direct.id)).state).toBe("ready");

    const mkv = path.join(root, "data/pool/Movies/sample.mkv");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      mp4,
      "-c",
      "copy",
      mkv,
    ]);
    const second = await add("sample.mkv");
    const remux = manager.create({ fileId: second.id });
    expect((await ready(remux.id)).mode).toBe("remux");
    const queued = manager.create({ fileId: file.id, quality: "480" });
    for (
      let n = 0;
      n < 100 && (await manager.get(queued.id)).state !== "queued";
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await manager.get(queued.id)).state).toBe("queued");
    const parallelDirect = manager.create({ fileId: file.id });
    expect((await ready(parallelDirect.id)).mode).toBe("direct");
    await manager.remove(parallelDirect.id);
    await manager.remove(queued.id);
    await expect(manager.get(queued.id)).rejects.toThrow("expired");
    await manager.remove(remux.id);
    const encoded = manager.create({ fileId: file.id, quality: "480" });
    expect((await ready(encoded.id)).mode).toBe("transcode");
    await manager.remove(encoded.id);
    const subtitlePath = path.join(root, "captions.srt");
    await writeFile(
      subtitlePath,
      "1\n00:00:01,000 --> 00:00:03,000\nCaption sample\n",
    );
    const subtitleMkv = path.join(root, "data/pool/Movies/captions.mkv");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      mp4,
      "-i",
      subtitlePath,
      "-map",
      "0",
      "-map",
      "1",
      "-c",
      "copy",
      subtitleMkv,
    ]);
    const subtitleFile = await add("captions.mkv");
    const captions = manager.create({
      fileId: subtitleFile.id,
      subtitleTrack: 2,
      startPositionSeconds: 1,
    });
    const filters = spawnSync("ffmpeg", [
      "-hide_banner",
      "-filters",
    ]).stdout.toString();
    if (filters.includes(" subtitles "))
      expect((await ready(captions.id)).mode).toBe("transcode");
    else await expect(ready(captions.id)).rejects.toThrow("filter unavailable");
    await manager.remove(captions.id);
    await writeFile(mp4, "changed");
    expect((await manager.get(direct.id)).state).toBe("error");
  },
  30000,
);
