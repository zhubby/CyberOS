import type { FastifyInstance } from "fastify";
import { getBackupSettings } from "@cyberos/db";
import type { SystemHealthSummary } from "@cyberos/shared";
import { evaluateSystemHealth } from "@cyberos/system-health";
import type { ApiRouteContext } from "../context.js";
import { resolveVodPlayerRuntime } from "../lib/vod-player.js";
import { effectiveBackupConfig } from "../lib/settings.js";

export function registerHealthStatusRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  server.get("/api/system/health", async (): Promise<SystemHealthSummary> => {
    return evaluateSystemHealth({
      db: context.db,
      config: effectiveBackupConfig(context.config, getBackupSettings(context.db)),
      vodPlayer: resolveVodPlayerRuntime(context)
    });
  });
}
