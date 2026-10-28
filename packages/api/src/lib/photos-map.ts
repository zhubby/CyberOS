import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { PMTiles, TileType, type Source } from "pmtiles";
import {
  PHOTOS_BASE_MAP_ATTRIBUTION,
  PHOTOS_BASE_MAP_DIRECTORY_NAME,
  PHOTOS_BASE_MAP_FILE_NAME,
  PHOTOS_BASE_MAP_NAME,
  PHOTOS_BASE_MAP_RELEASE_URL,
  PHOTOS_BASE_MAP_SHA256,
  PHOTOS_BASE_MAP_SIZE_BYTES,
  PHOTOS_BASE_MAP_VERSION,
  PHOTOS_DATA_DIRECTORY_NAME,
  type PhotosManagedMapSettings,
  type PhotosMapSettingsResponse
} from "@cyberos/shared";

const DOWNLOAD_DISK_HEADROOM_BYTES = 64 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface PhotosMapArchiveSource {
  name: string;
  version: string;
  fileName: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  attribution: string | null;
}

export interface PhotosMapArchiveRuntime {
  getStatus(): Promise<PhotosMapSettingsResponse>;
  startDownload(): Promise<PhotosMapSettingsResponse>;
  getArchive(): Promise<{ filePath: string; settings: PhotosManagedMapSettings }>;
  close(): Promise<void>;
}

interface ActiveDownload {
  controller: AbortController;
  promise: Promise<void>;
}

interface PhotosMapArchiveManagerOptions {
  dataDir: string;
  source?: PhotosMapArchiveSource;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  availableBytes?: (targetPath: string) => Promise<number>;
  idleTimeoutMs?: number;
}

export class PhotosMapArchiveError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export class PhotosMapArchiveManager implements PhotosMapArchiveRuntime {
  readonly archivePath: string;
  readonly partialPath: string;

  private readonly source: PhotosMapArchiveSource;
  private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  private readonly availableBytes: (targetPath: string) => Promise<number>;
  private readonly idleTimeoutMs: number;
  private active: ActiveDownload | null = null;
  private settings: PhotosManagedMapSettings | null = null;
  private inspection: Promise<void> | null = null;
  private inspected = false;
  private receivedBytes = 0;
  private lastError: string | null = null;

  constructor(options: PhotosMapArchiveManagerOptions) {
    this.source = options.source ?? defaultPhotosMapSource();
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.availableBytes = options.availableBytes ?? diskAvailableBytes;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const archiveDirectory = path.join(
      options.dataDir,
      PHOTOS_DATA_DIRECTORY_NAME,
      PHOTOS_BASE_MAP_DIRECTORY_NAME
    );
    this.archivePath = path.join(archiveDirectory, this.source.fileName);
    this.partialPath = path.join(archiveDirectory, `.${this.source.fileName}.part`);
    validateSource(this.source);
  }

  async getStatus(): Promise<PhotosMapSettingsResponse> {
    if (!this.inspected && !this.active) {
      await this.ensureInspected();
    }
    return this.snapshot();
  }

  async startDownload(): Promise<PhotosMapSettingsResponse> {
    const current = await this.getStatus();
    if (current.download.state === "ready" || this.active) return this.snapshot();

    this.settings = null;
    this.lastError = null;
    this.receivedBytes = 0;
    const controller = new AbortController();
    const promise = this.download(controller.signal)
      .catch((error) => {
        this.settings = null;
        this.lastError = errorMessage(error);
      })
      .finally(() => {
        this.active = null;
      });
    this.active = { controller, promise };
    void promise;
    return this.snapshot();
  }

  async getArchive(): Promise<{ filePath: string; settings: PhotosManagedMapSettings }> {
    const status = await this.getStatus();
    if (!status.settings || status.download.state !== "ready") {
      throw new PhotosMapArchiveError(
        status.download.state === "failed" ? "Offline map archive is invalid" : "Offline map has not been downloaded",
        status.download.state === "failed" ? 503 : 404
      );
    }
    return { filePath: this.archivePath, settings: status.settings };
  }

  async close(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort(new Error("Offline map download was interrupted"));
    await active.promise;
  }

  async waitForIdle(): Promise<void> {
    await this.active?.promise;
  }

  private async ensureInspected(): Promise<void> {
    if (this.inspected) return;
    this.inspection ??= this.inspectExistingArchive()
      .then((settings) => {
        this.settings = settings;
        this.lastError = null;
      })
      .catch((error) => {
        this.settings = null;
        this.lastError = errorMessage(error);
      })
      .finally(() => {
        this.inspected = true;
        this.inspection = null;
      });
    await this.inspection;
  }

  private snapshot(): PhotosMapSettingsResponse {
    const state = this.active
      ? "downloading"
      : this.settings
        ? "ready"
        : this.lastError
          ? "failed"
          : "not_downloaded";
    return {
      map: {
        name: this.source.name,
        version: this.source.version,
        attribution: this.source.attribution,
        sizeBytes: this.source.sizeBytes
      },
      settings: this.settings,
      download: {
        state,
        receivedBytes: state === "ready" ? this.source.sizeBytes : this.receivedBytes,
        totalBytes: this.source.sizeBytes,
        error: state === "failed" ? this.lastError : null
      }
    };
  }

  private async inspectExistingArchive(): Promise<PhotosManagedMapSettings | null> {
    let fileStat;
    try {
      fileStat = await lstat(this.archivePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error("Offline map archive is not a regular file");
    }
    if (fileStat.size !== this.source.sizeBytes) {
      throw new Error("Offline map archive size does not match the managed asset");
    }
    if (await sha256File(this.archivePath) !== this.source.sha256) {
      throw new Error("Offline map archive checksum does not match the managed asset");
    }
    return await readManagedMapSettings(this.archivePath, this.source, fileStat.mtime.toISOString());
  }

  private async download(signal: AbortSignal): Promise<void> {
    await mkdir(path.dirname(this.archivePath), { recursive: true, mode: 0o750 });
    await Promise.all([
      rm(this.partialPath, { force: true }),
      rm(this.archivePath, { force: true })
    ]);
    const available = await this.availableBytes(path.dirname(this.archivePath));
    if (available < this.source.sizeBytes + DOWNLOAD_DISK_HEADROOM_BYTES) {
      throw new Error("Not enough free space to download the offline map");
    }

    let idleTimer: NodeJS.Timeout | null = null;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", abortFromParent, { once: true });
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error("Offline map download timed out")), this.idleTimeoutMs);
      idleTimer.unref();
    };

    try {
      resetIdleTimer();
      const response = await this.fetchImpl(this.source.url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { accept: "application/vnd.pmtiles, application/octet-stream" }
      });
      if (!response.ok || !response.body) {
        throw new Error(`Offline map download failed with HTTP ${response.status}`);
      }
      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength !== null && contentLength !== this.source.sizeBytes) {
        throw new Error("Offline map download size does not match the managed asset");
      }

      const hash = createHash("sha256");
      const progress = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          this.receivedBytes += chunk.length;
          if (this.receivedBytes > this.source.sizeBytes) {
            callback(new Error("Offline map download exceeded the expected size"));
            return;
          }
          hash.update(chunk);
          resetIdleTimer();
          callback(null, chunk);
        }
      });
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
        progress,
        createWriteStream(this.partialPath, { flags: "wx", mode: 0o600 })
      );
      if (this.receivedBytes !== this.source.sizeBytes) {
        throw new Error("Offline map download ended before the expected size");
      }
      if (hash.digest("hex") !== this.source.sha256) {
        throw new Error("Offline map download checksum verification failed");
      }
      const temporarySettings = await readManagedMapSettings(
        this.partialPath,
        this.source,
        new Date().toISOString()
      );
      const handle = await open(this.partialPath, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(this.partialPath, this.archivePath);
      const fileStat = await lstat(this.archivePath);
      this.settings = { ...temporarySettings, updatedAt: fileStat.mtime.toISOString() };
      this.lastError = null;
    } catch (error) {
      await rm(this.partialPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal.removeEventListener("abort", abortFromParent);
    }
  }
}

export function defaultPhotosMapSource(url = PHOTOS_BASE_MAP_RELEASE_URL): PhotosMapArchiveSource {
  return {
    name: PHOTOS_BASE_MAP_NAME,
    version: PHOTOS_BASE_MAP_VERSION,
    fileName: PHOTOS_BASE_MAP_FILE_NAME,
    url,
    sha256: PHOTOS_BASE_MAP_SHA256,
    sizeBytes: PHOTOS_BASE_MAP_SIZE_BYTES,
    attribution: PHOTOS_BASE_MAP_ATTRIBUTION
  };
}

async function readManagedMapSettings(
  filePath: string,
  source: PhotosMapArchiveSource,
  updatedAt: string
): Promise<PhotosManagedMapSettings> {
  try {
    const archive = new PMTiles(new NodeFileRangeSource(filePath));
    const header = await archive.getHeader();
    const tileType = header.tileType === TileType.Png ? "png"
      : header.tileType === TileType.Jpeg ? "jpeg"
        : header.tileType === TileType.Webp ? "webp"
          : null;
    if (!tileType) throw new Error("Only raster PNG, JPEG, or WebP PMTiles archives are supported");
    return {
      name: source.name,
      version: source.version,
      tileType,
      minZoom: header.minZoom,
      maxZoom: header.maxZoom,
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
      attribution: source.attribution,
      sizeBytes: source.sizeBytes,
      updatedAt
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Only raster")) throw error;
    throw new Error("Offline map archive is damaged or unsupported");
  }
}

class NodeFileRangeSource implements Source {
  constructor(private readonly filePath: string) {}

  getKey(): string {
    return this.filePath;
  }

  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      throw new Error("Invalid PMTiles byte range");
    }
    const handle = await open(this.filePath, "r");
    try {
      const fileStat = await handle.stat();
      if (offset >= fileStat.size && length > 0) throw new Error("PMTiles byte range exceeds archive size");
      const readLength = Math.min(length, Math.max(0, fileStat.size - offset));
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
      if (bytesRead !== readLength) throw new Error("PMTiles archive ended unexpectedly");
      return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
    } finally {
      await handle.close();
    }
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function diskAvailableBytes(targetPath: string): Promise<number> {
  const fileSystem = await statfs(targetPath);
  return fileSystem.bavail * fileSystem.bsize;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function validateSource(source: PhotosMapArchiveSource): void {
  const url = new URL(source.url);
  if (url.protocol !== "https:") throw new Error("Photos base map URL must use HTTPS");
  if (!source.fileName.endsWith(".pmtiles") || path.basename(source.fileName) !== source.fileName) {
    throw new Error("Photos base map file name is invalid");
  }
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0) {
    throw new Error("Photos base map size is invalid");
  }
  if (!/^[0-9a-f]{64}$/u.test(source.sha256)) {
    throw new Error("Photos base map checksum is invalid");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Offline map download failed";
}
