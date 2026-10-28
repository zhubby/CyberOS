import type { FastifyInstance } from "fastify";
import { listNasRoots } from "@cyberos/db";
import type { ApiRouteContext } from "../context.js";
import { withHomePath } from "../lib/roots.js";

export function registerRootRoutes(server: FastifyInstance, { db }: ApiRouteContext): void {
  server.get("/api/roots", async () => ({
    roots: await Promise.all(listNasRoots(db).map(withHomePath))
  }));
}
