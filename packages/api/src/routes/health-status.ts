import type { FastifyInstance } from "fastify";
import type { SystemHealthSummary } from "@zos/shared";
import { evaluateSystemHealth } from "@zos/system-health";
import type { ApiRouteContext } from "../context.js";

export function registerHealthStatusRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  server.get("/api/system/health", async (): Promise<SystemHealthSummary> => {
    return evaluateSystemHealth({
      db: context.db,
      config: context.config,
      ...(context.vodPlayer ? { vodPlayer: context.vodPlayer } : {})
    });
  });
}
