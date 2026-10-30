import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CyberOsDatabase } from "@cyberos/db";
import { getMediaFile, getMediaSource, getMediaTitle } from "@cyberos/db";
import type {
  CyberOsRuntime,
  StreamOptions,
  StreamSession,
} from "@cyberos/shared";
import {
  assertNoSymlinkPathSegments,
  isPathInside,
} from "@cyberos/storage-tools";
import { encodingArgs, planStream, type Probe } from "./planner.js";

interface Entry {
  session: StreamSession;
  options: StreamOptions;
  file: FileHandle | null;
  identity: string;
  directory: string;
  touched: number;
  child: ChildProcess | null;
  cancelled: boolean;
}
const identity = (s: Awaited<ReturnType<FileHandle["stat"]>>) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export class StreamError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
export function validateOptions(
  value: unknown,
): StreamOptions & { fileId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StreamError("A stream request is required");
  const v = value as Record<string, unknown>;
  if (typeof v.fileId !== "string" || !v.fileId || v.fileId.length > 256)
    throw new StreamError("Media file is required");
  if (
    v.startPositionSeconds !== undefined &&
    (typeof v.startPositionSeconds !== "number" ||
      !Number.isFinite(v.startPositionSeconds) ||
      v.startPositionSeconds < 0 ||
      v.startPositionSeconds > 604800)
  )
    throw new StreamError("Invalid start position");
  if (
    v.quality !== undefined &&
    !["original", "1080", "720", "480"].includes(String(v.quality))
  )
    throw new StreamError("Invalid quality");
  for (const key of ["audioTrack", "subtitleTrack"])
    if (
      v[key] !== undefined &&
      !(key === "subtitleTrack" && v[key] === null) &&
      (!Number.isSafeInteger(v[key]) ||
        Number(v[key]) < 0 ||
        Number(v[key]) > 1024)
    )
      throw new StreamError("Invalid track");
  if (
    v.codecs !== undefined &&
    (!Array.isArray(v.codecs) ||
      v.codecs.length > 8 ||
      v.codecs.some((c) => !["h264", "hevc"].includes(c)))
  )
    throw new StreamError("Invalid codec capabilities");
  const result: StreamOptions & { fileId: string } = { fileId: v.fileId };
  if (v.startPositionSeconds !== undefined)
    result.startPositionSeconds = v.startPositionSeconds as number;
  if (v.quality !== undefined)
    result.quality = v.quality as NonNullable<StreamOptions["quality"]>;
  if (v.audioTrack !== undefined) result.audioTrack = v.audioTrack as number;
  if (v.subtitleTrack !== undefined)
    result.subtitleTrack = v.subtitleTrack as number | null;
  if (v.codecs !== undefined) result.codecs = v.codecs as string[];
  return result;
}

export class StreamManager {
  private entries = new Map<string, Entry>();
  private probing = false;
  private closing = false;
  private filters: Promise<Set<string>> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  readonly cacheRoot: string;
  constructor(
    private db: CyberOsDatabase,
    private config: CyberOsRuntime,
  ) {
    this.cacheRoot = path.join(config.paths.stateDir, "media-streamer");
  }
  async initialize() {
    if (this.cleanupTimer) return;
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.cacheRoot))
      if (/^[a-f0-9-]{36}$/.test(name))
        await rm(path.join(this.cacheRoot, name), {
          recursive: true,
          force: true,
        });
    this.cleanupTimer = setInterval(() => {
      void this.sweep();
    }, 15000);
    this.cleanupTimer.unref();
  }
  create(input: unknown): StreamSession {
    if (this.closing)
      throw new StreamError("Streaming service is stopping", 503);
    const options = validateOptions(input);
    if (this.entries.size >= 8)
      throw new StreamError("Stream queue is full", 429);
    const file = getMediaFile(this.db, options.fileId);
    const source = file ? getMediaSource(this.db, file.sourceId) : null;
    if (
      !file ||
      !source?.enabled ||
      getMediaTitle(this.db, file.titleId)?.matchStatus === "excluded"
    )
      throw new StreamError("Media file unavailable", 404);
    const id = randomUUID();
    const session: StreamSession = {
      id,
      fileId: file.id,
      state: "queued",
      mode: "transcode",
      startPositionSeconds: options.startPositionSeconds ?? 0,
      durationSeconds: null,
      tracks: [],
      audioTrack: null,
      subtitleTrack: null,
      error: null,
      reason: null,
      url: `/api/media/playback-sessions/${id}/assets/index.m3u8`,
    };
    this.entries.set(id, {
      session,
      options,
      file: null,
      identity: "",
      directory: path.join(this.cacheRoot, id),
      touched: Date.now(),
      child: null,
      cancelled: false,
    });
    void this.pump();
    return { ...session };
  }
  async get(id: string): Promise<StreamSession> {
    const entry = this.entry(id);
    entry.touched = Date.now();
    if (entry.file && entry.session.state === "ready") {
      try {
        const current = await this.safeOpen(entry.session.fileId);
        try {
          if (
            identity(await current.stat()) !== entry.identity ||
            identity(await entry.file.stat()) !== entry.identity
          )
            await this.fail(entry, "Media file changed; start playback again");
        } finally {
          await current.close();
        }
      } catch {
        await this.fail(
          entry,
          "Media storage changed or is offline; start playback again",
        );
      }
    }
    if (entry.session.state === "preparing") {
      try {
        if ((await stat(path.join(entry.directory, "index.m3u8"))).size > 0)
          entry.session.state = "ready";
      } catch {
        /* Encoder has not written its first segment. */
      }
    }
    return { ...entry.session };
  }
  entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.cancelled)
      throw new StreamError("Stream session expired", 404);
    return entry;
  }
  async asset(
    id: string,
    name: string,
  ): Promise<{ file: FileHandle; size: number; mime: string; close: boolean }> {
    await this.get(id);
    const e = this.entry(id);
    if (e.session.state === "error")
      throw new StreamError(e.session.error ?? "Playback failed", 409);
    if (name === "direct" && e.session.mode === "direct" && e.file)
      return {
        file: e.file,
        size: Number((await e.file.stat()).size),
        mime: "video/mp4",
        close: false,
      };
    if (
      !/^(index\.m3u8|segment-\d{6,}\.ts)$/.test(name) ||
      e.session.mode === "direct"
    )
      throw new StreamError("Stream asset not found", 404);
    const file = await open(
      path.join(e.directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    return {
      file,
      size: Number((await file.stat()).size),
      mime: name.endsWith("m3u8")
        ? "application/vnd.apple.mpegurl"
        : "video/mp2t",
      close: true,
    };
  }
  async remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    e.cancelled = true;
    this.entries.delete(id);
    await this.stop(e);
    await rm(e.directory, { recursive: true, force: true });
    void this.pump();
  }
  async shutdown() {
    this.closing = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await Promise.all([...this.entries.keys()].map((id) => this.remove(id)));
  }
  private async safeOpen(fileId: string) {
    const record = getMediaFile(this.db, fileId);
    const source = record ? getMediaSource(this.db, record.sourceId) : null;
    if (
      !record ||
      !source?.enabled ||
      getMediaTitle(this.db, record.titleId)?.matchStatus === "excluded"
    )
      throw new StreamError("Media file unavailable", 404);
    if (
      !/^[\w-]+$/.test(record.storagePoolId) ||
      record.relativePath.includes("\0") ||
      record.relativePath.replaceAll("\\", "/").split("/").includes("..") ||
      path.isAbsolute(record.relativePath)
    )
      throw new StreamError("Invalid media path", 403);
    const pool = path.join(this.config.paths.dataRoot, record.storagePoolId);
    if ((await lstat(pool)).isSymbolicLink())
      throw new StreamError("Storage pool unavailable", 409);
    const root = await realpath(pool);
    if (this.config.environment === "production") {
      const mounted = (await readFile("/proc/self/mountinfo", "utf8"))
        .split("\n")
        .some(
          (line) =>
            line
              .split(" ")[4]
              ?.replaceAll("\\040", " ")
              .replaceAll("\\134", "\\") === root,
        );
      if (!mounted) throw new StreamError("Storage pool is not mounted", 409);
    }
    const candidate = path.resolve(root, record.relativePath);
    if (
      source.path !== "." &&
      !isPathInside(path.resolve(root, source.path), candidate)
    )
      throw new StreamError("Media outside source", 403);
    if (this.config.environment === "production") {
      const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
        .split("\n")
        .map((line) =>
          line
            .split(" ")[4]
            ?.replaceAll("\\040", " ")
            .replaceAll("\\134", "\\"),
        )
        .filter((mount): mount is string => !!mount);
      if (
        mounts.some(
          (mount) =>
            mount !== root &&
            isPathInside(root, mount) &&
            (mount === candidate || isPathInside(mount, candidate)),
        )
      )
        throw new StreamError("Nested storage mount unavailable", 409);
    }
    if (!isPathInside(root, candidate))
      throw new StreamError("Media outside storage pool", 403);
    await assertNoSymlinkPathSegments(root, candidate);
    const handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      // Validate the opened descriptor itself, including a parent renamed between validation and open.
      const openedPath = await realpath(
        process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : candidate,
      );
      if (!isPathInside(root, openedPath))
        throw new StreamError("Media outside storage pool", 403);
      const opened = await handle.stat();
      const current = await stat(candidate);
      if (
        !opened.isFile() ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino ||
        opened.size !== record.sizeBytes ||
        Math.abs(Number(opened.mtimeMs) - record.mtimeMs) > 1
      )
        throw new StreamError("Media changed; rescan the library", 409);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  private async pump() {
    if (this.probing || this.closing) return;
    this.probing = true;
    try {
      for (const e of this.entries.values()) {
        if (e.session.state !== "queued" || e.cancelled) continue;
        // Probe serially; only one FFmpeg encoder/remux process runs at a time.
        e.session.state = "preparing";
        try {
          e.file = await this.safeOpen(e.session.fileId);
          e.identity = identity(await e.file.stat());
          const probe = await this.probe(e);
          if (e.cancelled) {
            await e.file?.close().catch(() => {});
            continue;
          }
          const plan = planStream(probe, e.options);
          const duration = Number(probe.format?.duration);
          Object.assign(e.session, {
            mode: plan.mode,
            tracks: plan.tracks,
            container: probe.format?.format_name ?? null,
            durationSeconds:
              Number.isFinite(duration) && duration > 0 ? duration : null,
            audioTrack: plan.audio?.index ?? null,
            subtitleTrack: plan.subtitle?.index ?? null,
            reason:
              plan.mode === "transcode"
                ? "browser-compatibility"
                : plan.mode === "remux"
                  ? "container-or-audio"
                  : null,
          });
          if (duration > 0 && e.session.startPositionSeconds >= duration)
            throw new Error("Start position exceeds media duration");
          if (plan.mode === "direct") {
            e.session.state = "ready";
            e.session.url = `/api/media/playback-sessions/${e.session.id}/assets/direct`;
            continue;
          }
          if (
            [...this.entries.values()].some(
              (other) => other !== e && other.child,
            )
          ) {
            await e.file.close();
            e.file = null;
            e.session.state = "queued";
            continue;
          }
          const requiredFilters = [
            ...(plan.subtitle
              ? [
                  ["subrip", "ass", "ssa", "webvtt", "mov_text"].includes(
                    plan.subtitle.codec,
                  )
                    ? "subtitles"
                    : "overlay",
                ]
              : []),
            ...(plan.mode === "transcode" && plan.video.hdr
              ? ["zscale", "tonemap"]
              : []),
          ];
          if (requiredFilters.length) {
            const available = await this.availableFilters();
            if (requiredFilters.some((filter) => !available.has(filter)))
              throw new StreamError(
                "Required video/subtitle filter unavailable",
                422,
              );
          }
          if (e.cancelled) continue;
          await mkdir(e.directory, { mode: 0o700 });
          if (e.cancelled) {
            await rm(e.directory, { recursive: true, force: true });
            continue;
          }
          const child = spawn(
            "ffmpeg",
            encodingArgs(
              probe,
              e.options,
              process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3",
              e.directory,
            ),
            { stdio: ["ignore", "ignore", "pipe", e.file.fd] },
          );
          e.child = child;
          let stderr = "";
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-4096);
          });
          child.once("error", () => {
            void this.fail(e, "FFmpeg is unavailable").then(() => this.pump());
          });
          child.once("exit", (code) => {
            e.child = null;
            if (!e.cancelled && code !== 0)
              void this.fail(
                e,
                stderr.includes("No such filter")
                  ? "Required video/subtitle filter unavailable"
                  : "Video encoding failed; try another quality or track",
              );
            void this.pump();
          });
        } catch (error) {
          if (!e.cancelled)
            await this.fail(
              e,
              error instanceof StreamError
                ? error.message
                : "Could not prepare media playback",
            );
        }
      }
    } finally {
      this.probing = false;
    }
  }
  private probe(e: Entry): Promise<Probe> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe,crypto,data",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3",
        ],
        { stdio: ["ignore", "pipe", "ignore", e.file!.fd] },
      );
      e.child = child;
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Probe timeout"));
      }, 15000);
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 1024 * 1024) child.kill("SIGKILL");
      });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (e.child === child) e.child = null;
        if (code !== 0) reject(new Error("Probe failed"));
        else {
          try {
            resolve(JSON.parse(output) as Probe);
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  }
  private availableFilters(): Promise<Set<string>> {
    this.filters ??= new Promise((resolve, reject) => {
      const child = spawn("ffmpeg", ["-hide_banner", "-filters"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 1024 * 1024) child.kill("SIGKILL");
      });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          reject(new StreamError("FFmpeg capabilities unavailable", 503));
        else
          resolve(
            new Set(
              [...output.matchAll(/^\s*\S{3}\s+(\w+)\s/gm)].map(
                (match) => match[1]!,
              ),
            ),
          );
      });
    });
    return this.filters;
  }
  private async stop(e: Entry) {
    const child = e.child;
    e.child = null;
    if (child && child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    await e.file?.close().catch(() => {});
    e.file = null;
  }
  private async fail(e: Entry, message: string) {
    e.session.state = "error";
    e.session.error = message;
    await this.stop(e);
    await rm(e.directory, { recursive: true, force: true });
  }
  private async sweep() {
    for (const [id, e] of this.entries)
      if (Date.now() - e.touched > 90000) await this.remove(id);
    let bytes = 0;
    for (const e of this.entries.values()) {
      try {
        for (const name of await readdir(e.directory))
          bytes += (await stat(path.join(e.directory, name))).size;
      } catch {
        /* Direct/queued sessions have no cache. */
      }
    }
    if (bytes > 2 * 1024 ** 3)
      for (const e of this.entries.values())
        if (e.child)
          await this.fail(
            e,
            "Playback cache limit reached; start playback again",
          );
    void this.pump();
  }
}
