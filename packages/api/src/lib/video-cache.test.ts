import { mkdtemp, readdir, readFile, stat, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoCache, type VideoCacheSource } from "./video-cache.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function source(name: string): VideoCacheSource {
  return {
    rootId: "local",
    relativePath: name,
    realPath: path.join(tempDir ?? "", name),
    sizeBytes: 10,
    modifiedAtMs: 1
  };
}

describe("video cache", () => {
  it("deduplicates concurrent transcodes and publishes an atomic result", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-video-cache-"));
    const transcode = vi.fn(async (_inputPath: string, outputPath: string) => {
      await writeFile(outputPath, "converted");
    });
    const cache = new VideoCache({ dataDir: tempDir, transcoder: { transcode } });
    const input = source("clip.mkv");

    const [first, second] = await Promise.all([cache.ensure(input), cache.ensure(input)]);

    expect(first).toBe(second);
    expect(transcode).toHaveBeenCalledTimes(1);
    await expect(readFile(first, "utf8")).resolves.toBe("converted");
    await expect(readdir(path.dirname(first))).resolves.toEqual([path.basename(first)]);
  });

  it("keeps active files during capacity pruning and removes them later", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-video-cache-"));
    const transcode = vi.fn(async (_inputPath: string, outputPath: string) => {
      await writeFile(outputPath, "12345678");
    });
    const cache = new VideoCache({ dataDir: tempDir, transcoder: { transcode }, maxBytes: 10 });

    const first = await cache.ensure(source("first.mkv"));
    const release = cache.acquire(first);
    const second = await cache.ensure(source("second.mkv"));
    await expect(stat(first)).resolves.toBeTruthy();
    await expect(stat(second)).resolves.toBeTruthy();

    release();
    await utimes(first, new Date(0), new Date(0));
    const third = await cache.ensure(source("third.mkv"));
    await expect(stat(third)).resolves.toBeTruthy();
    await expect(stat(first)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not leave a final cache file when transcoding fails", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-video-cache-"));
    const cache = new VideoCache({
      dataDir: tempDir,
      transcoder: {
        transcode: async () => {
          throw new Error("failed");
        }
      }
    });

    await expect(cache.ensure(source("broken.avi"))).rejects.toThrow("Video transcoding failed");
    await expect(readdir(path.join(tempDir, "media-cache", "videos"))).resolves.toEqual([]);
  });
});
