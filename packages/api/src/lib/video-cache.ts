import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";

export const VIDEO_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
export const VIDEO_TRANSCODE_VERSION = "h264-aac-v1";
export const VIDEO_TRANSCODE_TIMEOUT_MS = 120_000;

export interface VideoCacheSource {
  rootId: string;
  relativePath: string;
  realPath: string;
  sizeBytes: number;
  modifiedAtMs: number;
}

export interface VideoTranscoder {
  transcode(inputPath: string, outputPath: string): Promise<void>;
}

export interface VideoCacheOptions {
  dataDir: string;
  transcoder?: VideoTranscoder;
  maxBytes?: number;
}

export class VideoTranscodingError extends Error {
  readonly statusCode = 503;
  readonly expose = true;

  constructor(message = "Video transcoding failed") {
    super(message);
    this.name = "VideoTranscodingError";
  }
}

export class VideoCache {
  private readonly cacheDirectory: string;
  private readonly transcoder: VideoTranscoder;
  private readonly maxBytes: number;
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly activeFiles = new Map<string, number>();
  private queue = Promise.resolve();

  constructor({ dataDir, transcoder = ffmpegVideoTranscoder, maxBytes = VIDEO_CACHE_MAX_BYTES }: VideoCacheOptions) {
    this.cacheDirectory = path.join(dataDir, "media-cache", "videos");
    this.transcoder = transcoder;
    this.maxBytes = maxBytes;
  }

  async ensure(source: VideoCacheSource): Promise<string> {
    const cachePath = this.pathFor(source);
    if (await isUsableFile(cachePath)) {
      await touchFile(cachePath);
      return cachePath;
    }

    const key = path.basename(cachePath);
    const existingJob = this.inFlight.get(key);
    if (existingJob) {
      return existingJob;
    }

    const job = this.enqueue(async () => {
      if (await isUsableFile(cachePath)) {
        await touchFile(cachePath);
        return cachePath;
      }

      await mkdir(this.cacheDirectory, { recursive: true });
      const temporaryPath = path.join(this.cacheDirectory, `.${key}.${randomUUID()}.part`);
      try {
        await this.transcoder.transcode(source.realPath, temporaryPath);
        if (!(await isUsableFile(temporaryPath))) {
          throw new Error("Video transcoder produced no output");
        }
        await rename(temporaryPath, cachePath);
        await touchFile(cachePath);
        await this.prune(cachePath);
        return cachePath;
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        if (error instanceof VideoTranscodingError) {
          throw error;
        }
        throw new VideoTranscodingError();
      }
    });

    this.inFlight.set(key, job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(key);
    }
  }

  pathFor(source: VideoCacheSource): string {
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify({
          version: VIDEO_TRANSCODE_VERSION,
          rootId: source.rootId,
          path: source.relativePath,
          sizeBytes: source.sizeBytes,
          modifiedAtMs: source.modifiedAtMs
        })
      )
      .digest("hex");
    return path.join(this.cacheDirectory, `${cacheKey}.mp4`);
  }

  acquire(cachePath: string): () => void {
    this.activeFiles.set(cachePath, (this.activeFiles.get(cachePath) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const count = this.activeFiles.get(cachePath) ?? 0;
      if (count <= 1) {
        this.activeFiles.delete(cachePath);
      } else {
        this.activeFiles.set(cachePath, count - 1);
      }
    };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async prune(protectedPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.cacheDirectory);
    } catch {
      return;
    }

    const files = (
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".mp4"))
          .map(async (entry) => {
            const filePath = path.join(this.cacheDirectory, entry);
            try {
              const fileStat = await stat(filePath);
              return fileStat.isFile() ? { filePath, sizeBytes: fileStat.size, modifiedAtMs: fileStat.mtimeMs } : null;
            } catch {
              return null;
            }
          })
      )
    ).filter((file): file is { filePath: string; sizeBytes: number; modifiedAtMs: number } => file !== null);

    let totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    if (totalBytes <= this.maxBytes) {
      return;
    }

    files.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
    for (const file of files) {
      if (totalBytes <= this.maxBytes) {
        break;
      }
      if (file.filePath === protectedPath || this.activeFiles.has(file.filePath)) {
        continue;
      }
      await rm(file.filePath, { force: true }).catch(() => undefined);
      totalBytes -= file.sizeBytes;
    }
  }
}

export const ffmpegVideoTranscoder: VideoTranscoder = {
  transcode(inputPath, outputPath) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          inputPath,
          "-map",
          "0:v:0",
          "-map",
          "0:a?",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-movflags",
          "+faststart",
          "-f",
          "mp4",
          outputPath
        ],
        { stdio: ["ignore", "ignore", "ignore"] }
      );
      const timeout = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        settled = true;
        reject(new VideoTranscodingError("Video transcoding timed out"));
      }, VIDEO_TRANSCODE_TIMEOUT_MS);
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new VideoTranscodingError("Video transcoding is unavailable"));
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new VideoTranscodingError());
      });
    });
  }
};

async function isUsableFile(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() && fileStat.size > 0;
  } catch {
    return false;
  }
}

async function touchFile(filePath: string): Promise<void> {
  const now = new Date();
  await utimes(filePath, now, now).catch(() => undefined);
}
