import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNextTorrentPreview,
  completeTorrentPreview,
  openCyberOsDb,
  type CyberOsDatabase
} from "@cyberos/db";
import { loadCyberOsRuntime, type CyberOsRuntime } from "@cyberos/shared";
import { buildServer } from "../server.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    access: vi.fn((...args: Parameters<typeof fs.access>) => fs.access(...args))
  };
});

const poolId = "pool-1";
const poolDevice = "/dev/md/pool-1";
let tempDir: string | null = null;
let db: CyberOsDatabase | null = null;

afterEach(async () => {
  db?.close();
  db = null;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("download API", () => {
  it("creates, reads, consumes, and deletes Magnet previews", async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/downloads/torrent-previews",
      payload: {
        magnet: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789"
      }
    });
    expect(created.statusCode).toBe(202);
    const previewId = created.json().preview.id as string;

    const queued = await app.inject({
      method: "GET",
      url: `/api/downloads/torrent-previews/${previewId}`
    });
    expect(queued.statusCode).toBe(200);
    expect(queued.json().preview).toMatchObject({ sourceKind: "magnet", status: "queued" });

    const claimed = claimNextTorrentPreview(db!, {
      workerId: "torrent-worker",
      leaseMs: 30_000
    });
    completeTorrentPreview(db!, {
      id: claimed!.id,
      workerId: "torrent-worker",
      infoHash: "0123456789012345678901234567890123456789",
      name: "release",
      metainfo: Buffer.from("torrent fixture"),
      totalBytes: 42,
      isPrivate: false,
      files: [{ fileIndex: 0, path: "release/file.bin", sizeBytes: 42 }]
    });

    const customSeeding = await app.inject({
      method: "POST",
      url: "/api/downloads",
      payload: {
        torrentPreviewId: previewId,
        selectedFileIndices: [0],
        storagePoolId: poolId,
        targetDirectory: ".",
        fileName: "release",
        seedRatioLimit: 2,
        seedTimeLimitSeconds: 60
      }
    });
    expect(customSeeding.statusCode).toBe(400);

    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/downloads",
      payload: {
        torrentPreviewId: previewId,
        selectedFileIndices: [0],
        storagePoolId: poolId,
        targetDirectory: ".",
        fileName: "release"
      }
    });
    expect(taskResponse.statusCode).toBe(201);
    expect(taskResponse.json().task).toMatchObject({
      sourceKind: "magnet",
      torrentInfoHash: "0123456789012345678901234567890123456789",
      selectedFileCount: 1,
      totalBytes: 42
    });

    const second = await app.inject({
      method: "POST",
      url: "/api/downloads/torrent-previews",
      payload: {
        magnet: "magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefabcdefabcd"
      }
    });
    const secondId = second.json().preview.id as string;
    expect((await app.inject({
      method: "DELETE",
      url: `/api/downloads/torrent-previews/${secondId}`
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: `/api/downloads/torrent-previews/${secondId}`
    })).statusCode).toBe(404);
    await app.close();
  });

  it("cancels a Magnet preview while the downloader is resolving it", async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/downloads/torrent-previews",
      payload: {
        magnet: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789"
      }
    });
    const previewId = created.json().preview.id as string;
    expect(claimNextTorrentPreview(db!, {
      workerId: "torrent-worker",
      leaseMs: 30_000
    })).toMatchObject({ id: previewId, status: "resolving" });

    const cancelled = await app.inject({
      method: "DELETE",
      url: `/api/downloads/torrent-previews/${previewId}`
    });

    expect(cancelled.statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: `/api/downloads/torrent-previews/${previewId}`
    })).statusCode).toBe(404);
    await app.close();
  });

  it("queues an uploaded torrent file for metadata resolution", async () => {
    const { app } = await setup();
    const metainfo = Buffer.from("d4:infod4:name7:releaseee");
    const upload = torrentUpload("release.torrent", metainfo);

    const response = await app.inject({
      method: "POST",
      url: "/api/downloads/torrent-previews",
      headers: upload.headers,
      payload: upload.body
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().preview).toMatchObject({ sourceKind: "torrent", status: "queued" });
    const stored = db!.prepare("SELECT metainfo FROM torrent_previews WHERE id = ?")
      .get(response.json().preview.id) as { metainfo: Buffer };
    expect(stored.metainfo).toEqual(metainfo);
    await app.close();
  });

  it("rejects non-torrent upload names without creating a preview", async () => {
    const { app } = await setup();
    const upload = torrentUpload("release.txt", Buffer.from("not a torrent"));

    const response = await app.inject({
      method: "POST",
      url: "/api/downloads/torrent-previews",
      headers: upload.headers,
      payload: upload.body
    });

    expect(response.statusCode).toBe(400);
    expect(countTorrentPreviews()).toBe(0);
    await app.close();
  });

  it("enforces the upload size limit before rejecting a non-torrent file name", async () => {
    const { app } = await setup();
    const upload = torrentUpload("oversized.txt", Buffer.alloc(16 * 1024 * 1024 + 1, 1));

    const response = await app.inject({
      method: "POST",
      url: "/api/downloads/torrent-previews",
      headers: upload.headers,
      payload: upload.body
    });

    expect(response.statusCode).toBe(413);
    expect(countTorrentPreviews()).toBe(0);
    await app.close();
  });

  it("rejects torrent uploads larger than 16 MiB without creating a preview", async () => {
    const { app } = await setup();
    const upload = torrentUpload("oversized.torrent", Buffer.alloc(16 * 1024 * 1024 + 1, 1));

    const response = await app.inject({
      method: "POST",
      url: "/api/downloads/torrent-previews",
      headers: upload.headers,
      payload: upload.body
    });

    expect(response.statusCode).toBe(413);
    expect(countTorrentPreviews()).toBe(0);
    await app.close();
  });

  it("creates tasks, validates collisions, and transitions task state", async () => {
    const { app, root } = await setup();
    const create = await app.inject({
      method: "POST",
      url: "/api/downloads",
      payload: {
        url: "https://example.com/file.zip",
                storagePoolId: poolId,
        targetDirectory: ".",
        fileName: "file.zip"
      }
    });
    expect(create.statusCode).toBe(201);
    const taskId = create.json().task.id as string;

    const collision = await app.inject({
      method: "POST",
      url: "/api/downloads",
      payload: {
        url: "https://example.com/other.zip",
                storagePoolId: poolId,
        targetDirectory: ".",
        fileName: "file.zip"
      }
    });
    expect(collision.statusCode).toBe(409);

    const pause = await app.inject({ method: "POST", url: `/api/downloads/${taskId}/pause` });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().task.status).toBe("paused");

    const resume = await app.inject({ method: "POST", url: `/api/downloads/${taskId}/resume` });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().task.status).toBe("queued");

    const cancel = await app.inject({ method: "POST", url: `/api/downloads/${taskId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().task.status).toBe("cancelled");

    const retry = await app.inject({ method: "POST", url: `/api/downloads/${taskId}/retry` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().task.status).toBe("queued");

    await app.close();
    expect(root).toBeTruthy();
  });

  it("rejects unsafe URLs, names, and invalid task actions", async () => {
    const { app } = await setup();
    const unsafeUrl = await app.inject({
      method: "POST",
      url: "/api/downloads",
      payload: {
        url: "ftp://example.com/file.zip",
                storagePoolId: poolId,
        targetDirectory: ".",
        fileName: "file.zip"
      }
    });
    expect(unsafeUrl.statusCode).toBe(400);

    const unsafeName = await app.inject({
      method: "POST",
      url: "/api/downloads",
      payload: {
        url: "https://example.com/file.zip",
                storagePoolId: poolId,
        targetDirectory: ".",
        fileName: "../file.zip"
      }
    });
    expect(unsafeName.statusCode).toBe(400);

    const missing = await app.inject({ method: "POST", url: "/api/downloads/missing/pause" });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("normalizes optional SHA-256 values and rejects malformed checksums", async () => {
    const { app } = await setup();
    const checksum = "ABCDEF0123456789".repeat(4);
    const valid = await app.inject({
      method: "POST",
      url: "/api/downloads",
      payload: {
        url: "https://example.com/checked.bin",
                storagePoolId: poolId,
        targetDirectory: ".",
        fileName: "checked.bin",
        sha256: `  ${checksum}  `
      }
    });
    expect(valid.statusCode).toBe(201);
    expect(valid.json().task.expectedSha256).toBe(checksum.toLowerCase());

    const invalid = await app.inject({
      method: "POST",
      url: "/api/downloads",
      payload: {
        url: "https://example.com/invalid.bin",
                storagePoolId: poolId,
        targetDirectory: ".",
        fileName: "invalid.bin",
        sha256: "not-a-checksum"
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/64 hexadecimal/u);
    await app.close();
  });

  it("records cooperative pause and cancel requests without stealing running tasks", async () => {
    const { app } = await setup();
    const createRunningTask = async (fileName: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/downloads",
        payload: {
          url: `https://example.com/${fileName}`,
                    storagePoolId: poolId,
          targetDirectory: ".",
          fileName
        }
      });
      const id = response.json().task.id as string;
      db?.prepare(`
        UPDATE download_tasks
        SET status = 'running', worker_id = 'rust-worker', lease_expires_at = ?, phase = 'downloading'
        WHERE id = ?
      `).run(new Date(Date.now() + 30_000).toISOString(), id);
      return id;
    };

    const pauseId = await createRunningTask("pause.bin");
    const pause = await app.inject({ method: "POST", url: `/api/downloads/${pauseId}/pause` });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().task).toMatchObject({
      status: "running",
      workerId: "rust-worker",
      controlRequested: "pause"
    });

    const cancelId = await createRunningTask("cancel.bin");
    const cancel = await app.inject({ method: "POST", url: `/api/downloads/${cancelId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().task).toMatchObject({
      status: "running",
      workerId: "rust-worker",
      controlRequested: "cancel"
    });
    await app.close();
  });

  it("records pause and stop requests for seeding torrent tasks", async () => {
    const { app } = await setup();
    const createSeedingTask = async (fileName: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/downloads",
        payload: {
          url: `https://example.com/${fileName}`,
          storagePoolId: poolId,
          targetDirectory: ".",
          fileName
        }
      });
      const id = response.json().task.id as string;
      db?.prepare(`
        UPDATE download_tasks
        SET source_kind = 'torrent', status = 'seeding', worker_id = 'rust-worker',
            lease_expires_at = ?, phase = 'seeding', content_completed_at = ?, seed_started_at = ?
        WHERE id = ?
      `).run(
        new Date(Date.now() + 30_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
        id
      );
      return id;
    };

    const pauseId = await createSeedingTask("pause-seeding");
    const pause = await app.inject({ method: "POST", url: `/api/downloads/${pauseId}/pause` });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().task).toMatchObject({
      status: "seeding",
      workerId: "rust-worker",
      controlRequested: "pause"
    });

    const stopId = await createSeedingTask("stop-seeding");
    const stop = await app.inject({ method: "POST", url: `/api/downloads/${stopId}/stop-seeding` });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().task).toMatchObject({
      status: "seeding",
      workerId: "rust-worker",
      controlRequested: "stop_seeding"
    });
    await app.close();
  });

  it("removes a torrent staging directory when cancelling before publication", async () => {
    const { app, root } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/downloads",
      payload: {
        url: "https://example.com/release",
        storagePoolId: poolId,
        targetDirectory: ".",
        fileName: "release"
      }
    });
    const task = response.json().task as { id: string; partialPath: string };
    db?.prepare("UPDATE download_tasks SET source_kind = 'torrent' WHERE id = ?").run(task.id);
    const stagingPath = path.join(root, task.partialPath);
    await mkdir(stagingPath);
    await writeFile(path.join(stagingPath, "piece.bin"), "partial");

    const cancel = await app.inject({ method: "POST", url: `/api/downloads/${task.id}/cancel` });

    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().task.status).toBe("cancelled");
    await expect(access(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await app.close();
  });

  it("persists all reliability settings and validates bounds", async () => {
    const { app } = await setup();
    const initial = await app.inject({ method: "GET", url: "/api/settings/downloads" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings.concurrency).toBe(1);

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/settings/downloads",
      payload: { concurrency: 4 }
    });
    expect(invalid.statusCode).toBe(400);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/settings/downloads",
      payload: {
        concurrency: 3,
        parallelRequestsPerTask: 8,
        segmentedDownloadMinBytes: 128 * 1024 * 1024,
        maxAutoRetries: 9,
        retryBaseDelayMs: 3_000,
        retryMaxDelayMs: 600_000,
        retryAfterMaxDelayMs: 1_200_000,
        connectTimeoutMs: 20_000,
        responseHeaderTimeoutMs: 45_000,
        readIdleTimeoutMs: 90_000,
        minFreeSpaceBytes: 1024 * 1024 * 1024,
        maxFileSizeBytes: 4 * 1024 * 1024 * 1024
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings).toMatchObject({
      concurrency: 3,
      parallelRequestsPerTask: 8,
      segmentedDownloadMinBytes: 128 * 1024 * 1024,
      maxAutoRetries: 9,
      retryBaseDelayMs: 3_000,
      retryMaxDelayMs: 600_000,
      retryAfterMaxDelayMs: 1_200_000,
      connectTimeoutMs: 20_000,
      responseHeaderTimeoutMs: 45_000,
      readIdleTimeoutMs: 90_000,
      minFreeSpaceBytes: 1024 * 1024 * 1024,
      maxFileSizeBytes: 4 * 1024 * 1024 * 1024
    });

    await app.close();
  });

  it("returns downloader worker health with list snapshots", async () => {
    const { app } = await setup();
    const unavailable = await app.inject({ method: "GET", url: "/api/downloads" });
    expect(unavailable.json().health).toMatchObject({
      status: "unavailable",
      freshWorkers: 0,
      activeTasks: 0,
      queuedTasks: 0
    });

    const now = new Date().toISOString();
    db?.prepare(`
      INSERT INTO download_workers (worker_id, version, started_at, heartbeat_at)
      VALUES ('worker-health', 'test', ?, ?)
    `).run(now, now);
    const ready = await app.inject({ method: "GET", url: "/api/downloads" });
    expect(ready.json().health).toMatchObject({ status: "ready", freshWorkers: 1 });
    await app.close();
  });

  it("blocks an existing target before task creation", async () => {
    const { app, root } = await setup();
    await writeFile(path.join(root, "existing.bin"), "existing");
    const response = await app.inject({
      method: "POST",
      url: "/api/downloads",
      payload: {
        url: "https://example.com/file.zip",
                storagePoolId: poolId,
        targetDirectory: ".",
        fileName: "existing.bin"
      }
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("rejects a directory the downloader cannot write before queuing", async () => {
    const { app, root } = await setup();
    const directory = path.join(root, "Downloads");
    await mkdir(directory);
    vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { code: "EACCES" }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/downloads",
        payload: {
          url: "https://example.com/file.zip",
                    storagePoolId: poolId,
          targetDirectory: "Downloads",
          fileName: "file.zip"
        }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatch(/writ/i);
      const tasks = await app.inject({ method: "GET", url: "/api/downloads" });
      expect(tasks.json().tasks).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

async function setup(): Promise<{
  app: Awaited<ReturnType<typeof buildServer>>;
  root: string;
}> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-download-api-"));
  const root = path.join(tempDir, "data", poolId);
  await mkdir(root, { recursive: true });
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
  const app = await buildServer({ config: testConfig(root), db, system: storageSystem() });
  return { app, root };
}

function torrentUpload(filename: string, content: Buffer): {
  headers: { "content-type": string };
  body: Buffer;
} {
  const boundary = "cyberos-torrent-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="torrent"; filename="${filename}"\r\nContent-Type: application/x-bittorrent\r\n\r\n`
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

function countTorrentPreviews(): number {
  return (db!.prepare("SELECT COUNT(*) AS count FROM torrent_previews").get() as { count: number }).count;
}

function testConfig(root: string): CyberOsRuntime {
  const rootDir = tempDir!;
  const base = loadCyberOsRuntime({ CYBEROS_ROOT: rootDir }, rootDir);
  return {
    ...base,
    paths: { ...base.paths, dataRoot: path.dirname(root), databasePath: path.join(rootDir, "cyberos.sqlite") },
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50, concurrency: 1 },
    admin: { displayName: "Test", authMode: "local-only" },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1000, consoleShells: [] },
    hostd: { socketPath: "/tmp/hostd.sock" },
    shares: { enabled: false, account: { username: "share", password: null }, shares: [] },
    terminal: { user: "test-user", socketPath: "/tmp/terminald.sock", sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: "/tmp/vod-player.sock", statePath: "/tmp/vod-player-session.json", commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "cyberos" },
  };
}

function storageSystem() {
  return {
    commandRunner: {
      async run(command: string) {
        if (command === "findmnt") {
          return JSON.stringify({ filesystems: [{ source: poolDevice, target: tempDir ? path.join(tempDir, "data", poolId) : ".", fstype: "ext4", size: 1000, used: 100, avail: 900, "use%": "10%" }] });
        }
        if (command === "mdadm") return `ARRAY ${poolDevice} name=${poolId} UUID=test`;
        if (command === "smartctl") return JSON.stringify({ devices: [] });
        return JSON.stringify({ blockdevices: [] });
      }
    }
  };
}
