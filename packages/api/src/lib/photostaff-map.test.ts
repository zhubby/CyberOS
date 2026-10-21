import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultPhotostaffMapSource,
  PhotostaffMapArchiveError,
  PhotostaffMapArchiveManager,
  type PhotostaffMapArchiveSource
} from "./photostaff-map.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PhotostaffMapArchiveManager", () => {
  it("uses the fixed managed path independently of the release asset name", async () => {
    const dataDir = await temporaryDirectory();
    const manager = new PhotostaffMapArchiveManager({ dataDir });

    expect(defaultPhotostaffMapSource().url).toContain("natural-earth-ii-3.2.0-raster.pmtiles");
    expect(manager.archivePath).toBe(path.join(
      dataDir,
      "photostaff",
      "maps",
      "natural-earth-ii-3.2.0.pmtiles"
    ));
  });

  it("downloads, verifies, publishes, and reloads a managed raster archive", async () => {
    const fixture = pmtilesFixture(3);
    const dataDir = await temporaryDirectory();
    const source = mapSource(fixture);
    const manager = new PhotostaffMapArchiveManager({
      dataDir,
      source,
      fetchImpl: async () => new Response(new Uint8Array(fixture), {
        headers: { "content-length": String(fixture.length) }
      })
    });

    expect(await manager.getStatus()).toMatchObject({
      settings: null,
      download: { state: "not_downloaded", receivedBytes: 0, totalBytes: fixture.length, error: null }
    });
    expect((await manager.startDownload()).download.state).toBe("downloading");
    await manager.waitForIdle();
    expect(await manager.getStatus()).toMatchObject({
      settings: { name: "Test map", version: "1", tileType: "jpeg", minZoom: 0, maxZoom: 4 },
      download: { state: "ready", receivedBytes: fixture.length, totalBytes: fixture.length, error: null }
    });
    expect((await manager.getArchive()).filePath).toBe(manager.archivePath);

    const restarted = new PhotostaffMapArchiveManager({ dataDir, source });
    expect((await restarted.getStatus()).download.state).toBe("ready");
  });

  it("coalesces concurrent starts into one download", async () => {
    const fixture = pmtilesFixture(2);
    let requests = 0;
    const manager = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(fixture),
      fetchImpl: async () => {
        requests += 1;
        return new Response(new Uint8Array(fixture));
      }
    });

    await Promise.all([manager.startDownload(), manager.startDownload(), manager.startDownload()]);
    await manager.waitForIdle();
    expect(requests).toBe(1);
    expect((await manager.getStatus()).download.state).toBe("ready");
  });

  it("coalesces initial inspection and does not redownload an existing archive", async () => {
    const fixture = pmtilesFixture(2);
    const dataDir = await temporaryDirectory();
    const source = mapSource(fixture);
    const initial = new PhotostaffMapArchiveManager({
      dataDir,
      source,
      fetchImpl: async () => new Response(new Uint8Array(fixture))
    });
    await initial.startDownload();
    await initial.waitForIdle();

    let requests = 0;
    const restarted = new PhotostaffMapArchiveManager({
      dataDir,
      source,
      fetchImpl: async () => {
        requests += 1;
        return new Response(new Uint8Array(fixture));
      }
    });
    const statuses = await Promise.all([
      restarted.startDownload(),
      restarted.startDownload(),
      restarted.startDownload()
    ]);

    expect(requests).toBe(0);
    expect(statuses.every((status) => status.download.state === "ready")).toBe(true);
  });

  it("reports streamed download progress before publishing", async () => {
    const fixture = pmtilesFixture(2);
    let finishDownload: () => void = () => undefined;
    const finishSignal = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    const manager = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(fixture),
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(fixture.subarray(0, 8)));
        },
        async pull(controller) {
          await finishSignal;
          controller.enqueue(new Uint8Array(fixture.subarray(8)));
          controller.close();
        }
      }))
    });

    await manager.startDownload();
    await waitForProgress(manager, 8);
    expect(await manager.getStatus()).toMatchObject({
      settings: null,
      download: { state: "downloading", receivedBytes: 8, totalBytes: fixture.length }
    });

    finishDownload();
    await manager.waitForIdle();
    expect((await manager.getStatus()).download.state).toBe("ready");
  });

  it("rejects checksum mismatches without publishing a partial archive and allows retry", async () => {
    const fixture = pmtilesFixture(2);
    let requests = 0;
    const source = mapSource(fixture);
    const manager = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source,
      fetchImpl: async () => new Response(new Uint8Array(requests++ === 0 ? Buffer.alloc(fixture.length, 1) : fixture))
    });

    await manager.startDownload();
    await manager.waitForIdle();
    expect(await manager.getStatus()).toMatchObject({
      settings: null,
      download: { state: "failed", error: "Offline map download checksum verification failed" }
    });
    await expect(access(manager.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(manager.partialPath)).rejects.toMatchObject({ code: "ENOENT" });

    await manager.startDownload();
    await manager.waitForIdle();
    expect((await manager.getStatus()).download.state).toBe("ready");
  });

  it("rejects insufficient space, wrong content length, and vector archives", async () => {
    const raster = pmtilesFixture(2);
    const noSpace = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(raster),
      availableBytes: async () => 0,
      fetchImpl: async () => new Response(new Uint8Array(raster))
    });
    await noSpace.startDownload();
    await noSpace.waitForIdle();
    expect((await noSpace.getStatus()).download.error).toContain("free space");

    const wrongLength = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(raster),
      fetchImpl: async () => new Response(new Uint8Array(raster), { headers: { "content-length": String(raster.length + 1) } })
    });
    await wrongLength.startDownload();
    await wrongLength.waitForIdle();
    expect((await wrongLength.getStatus()).download.error).toContain("size does not match");

    const vector = pmtilesFixture(1);
    const vectorManager = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(vector),
      fetchImpl: async () => new Response(new Uint8Array(vector))
    });
    await vectorManager.startDownload();
    await vectorManager.waitForIdle();
    expect((await vectorManager.getStatus()).download.error).toContain("Only raster");
  });

  it("returns a typed 404 until the managed archive is ready", async () => {
    const fixture = pmtilesFixture(2);
    const manager = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(fixture),
      fetchImpl: async () => new Response(new Uint8Array(fixture))
    });

    await expect(manager.getArchive()).rejects.toEqual(
      expect.objectContaining<Partial<PhotostaffMapArchiveError>>({ statusCode: 404 })
    );
  });

  it("rejects HTTP failures, oversized bodies, and damaged PMTiles archives", async () => {
    const fixture = pmtilesFixture(2);
    const networkFailure = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(fixture),
      fetchImpl: async () => {
        throw new Error("network unavailable");
      }
    });
    await networkFailure.startDownload();
    await networkFailure.waitForIdle();
    expect((await networkFailure.getStatus()).download.error).toBe("network unavailable");

    const httpFailure = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(fixture),
      fetchImpl: async () => new Response(null, { status: 503 })
    });
    await httpFailure.startDownload();
    await httpFailure.waitForIdle();
    expect((await httpFailure.getStatus()).download.error).toContain("HTTP 503");

    const oversized = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(fixture),
      fetchImpl: async () => new Response(new Uint8Array(Buffer.concat([fixture, Buffer.from([0])])))
    });
    await oversized.startDownload();
    await oversized.waitForIdle();
    expect((await oversized.getStatus()).download.error).toContain("exceeded the expected size");

    const damaged = Buffer.alloc(fixture.length, 7);
    const damagedManager = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(damaged),
      fetchImpl: async () => new Response(new Uint8Array(damaged))
    });
    await damagedManager.startDownload();
    await damagedManager.waitForIdle();
    expect((await damagedManager.getStatus()).download.error).toContain("damaged or unsupported");
  });

  it("aborts and removes the partial archive when the runtime closes", async () => {
    const fixture = pmtilesFixture(2);
    const manager = new PhotostaffMapArchiveManager({
      dataDir: await temporaryDirectory(),
      source: mapSource(fixture),
      fetchImpl: async (_url, init) => {
        const signal = init.signal as AbortSignal;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(fixture.subarray(0, 8)));
            const abort = () => controller.error(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          }
        }));
      }
    });

    await manager.startDownload();
    await manager.close();
    expect((await manager.getStatus()).download.state).toBe("failed");
    await expect(access(manager.archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(manager.partialPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zos-map-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForProgress(manager: PhotostaffMapArchiveManager, receivedBytes: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while ((await manager.getStatus()).download.receivedBytes !== receivedBytes) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for map download progress");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function mapSource(body: Buffer): PhotostaffMapArchiveSource {
  return {
    name: "Test map",
    version: "1",
    fileName: "test.pmtiles",
    url: "https://example.test/test.pmtiles",
    sha256: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.length,
    attribution: "Test"
  };
}

function pmtilesFixture(tileType: 1 | 2 | 3): Buffer {
  const buffer = Buffer.alloc(133);
  buffer.write("PMTiles", 0, "ascii");
  buffer.writeUInt8(3, 7);
  buffer.writeBigUInt64LE(127n, 8);
  buffer.writeBigUInt64LE(5n, 16);
  buffer.writeBigUInt64LE(132n, 24);
  buffer.writeBigUInt64LE(0n, 32);
  buffer.writeBigUInt64LE(132n, 40);
  buffer.writeBigUInt64LE(0n, 48);
  buffer.writeBigUInt64LE(132n, 56);
  buffer.writeBigUInt64LE(1n, 64);
  buffer.writeBigUInt64LE(1n, 72);
  buffer.writeBigUInt64LE(1n, 80);
  buffer.writeBigUInt64LE(1n, 88);
  buffer.writeUInt8(1, 96);
  buffer.writeUInt8(1, 97);
  buffer.writeUInt8(1, 98);
  buffer.writeUInt8(tileType, 99);
  buffer.writeUInt8(0, 100);
  buffer.writeUInt8(4, 101);
  buffer.writeInt32LE(-1800000000, 102);
  buffer.writeInt32LE(-850000000, 106);
  buffer.writeInt32LE(1800000000, 110);
  buffer.writeInt32LE(850000000, 114);
  buffer.writeUInt8(2, 118);
  buffer.set([1, 0, 1, 1, 1], 127);
  buffer.writeUInt8(0, 132);
  return buffer;
}
