import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { TvComponentHealth, TvModeStatus, VodPlayerStatus } from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { resolveVodPlayerRuntime } from "../lib/vod-player.js";

const DEFAULT_STATUS_DIRECTORY = "/run/cyberos-tv/status";
const DEFAULT_ENABLED_MARKER = "/cyberos/state/tv/enabled";
const HEARTBEAT_STALE_MS = 20_000;

interface TvStatusDependencies {
  statusDirectory?: string;
  enabledMarker?: string;
  now?: () => Date;
}

export function registerTvRoutes(
  server: FastifyInstance,
  context: ApiRouteContext,
  dependencies: TvStatusDependencies = {}
): void {
  server.get("/api/tv/status", async () => {
    const now = (dependencies.now ?? (() => new Date()))();
    const statusDirectory = dependencies.statusDirectory ?? DEFAULT_STATUS_DIRECTORY;
    const enabledMarker = dependencies.enabledMarker ?? DEFAULT_ENABLED_MARKER;
    const enabled = await fileExists(enabledMarker);
    const [weston, chromium, cec, gamepad, vodResult] = await Promise.all([
      readComponentHealth(statusDirectory, "weston", now),
      readComponentHealth(statusDirectory, "chromium", now),
      readComponentHealth(statusDirectory, "cec", now),
      readComponentHealth(statusDirectory, "gamepad", now),
      Promise.resolve()
        .then(() => resolveVodPlayerRuntime(context, { transitionEnabled: enabled }).getStatus())
        .then(vodHealth)
        .catch(() => unavailable("VOD Player is unavailable"))
    ]);
    return {
      status: buildTvModeStatus({ enabled, weston, chromium, cec, gamepad, vodPlayer: vodResult, now })
    };
  });
}

function buildTvModeStatus(input: {
  enabled: boolean;
  weston: TvComponentHealth;
  chromium: TvComponentHealth;
  cec: TvComponentHealth;
  gamepad: TvComponentHealth;
  vodPlayer: TvComponentHealth;
  now: Date;
}): TvModeStatus {
  const required = [input.weston, input.chromium, input.vodPlayer];
  const state: TvModeStatus["state"] = !input.enabled
    ? "disabled"
    : required.every((component) => component.state === "ready")
      ? "ready"
      : required.some((component) => component.state === "unavailable")
        ? "degraded"
        : "starting";
  return { ...input, state, updatedAt: input.now.toISOString() };
}

async function readComponentHealth(directory: string, component: string, now: Date): Promise<TvComponentHealth> {
  try {
    const raw = JSON.parse(await readFile(path.join(directory, `${component}.json`), "utf8")) as Record<string, unknown>;
    if (
      (raw.state !== "ready" && raw.state !== "degraded" && raw.state !== "unavailable") ||
      (typeof raw.detail !== "string" && raw.detail !== null) ||
      typeof raw.updatedAt !== "string"
    ) return unavailable(`${component} status is invalid`);
    const updated = Date.parse(raw.updatedAt);
    if (!Number.isFinite(updated) || now.getTime() - updated > HEARTBEAT_STALE_MS) {
      return { state: "unavailable", detail: `${component} heartbeat is stale`, updatedAt: raw.updatedAt };
    }
    return { state: raw.state, detail: raw.detail, updatedAt: raw.updatedAt };
  } catch {
    return unavailable(`${component} status is unavailable`);
  }
}

function vodHealth(status: VodPlayerStatus): TvComponentHealth {
  const ready = status.capabilities.mpvAvailable && status.videoOutput === "wayland";
  return {
    state: ready ? "ready" : "degraded",
    detail: ready ? status.state : status.capabilities.error ?? "VOD Player is not using Wayland output",
    updatedAt: status.updatedAt
  };
}

function unavailable(detail: string): TvComponentHealth {
  return { state: "unavailable", detail, updatedAt: null };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
