import type { FastifyInstance } from "fastify";
import { getNasRoot, getRootReadiness, listNasRoots, listRootReadiness } from "@cyberos/db";
import type { ApiRouteContext } from "../context.js";

export function registerReadinessRoutes(server: FastifyInstance, { db }: ApiRouteContext): void {
  server.get<{ Querystring: { rootId?: string } }>("/api/roots/readiness", async (request, reply) => {
    if (request.query.rootId) {
      const root = getNasRoot(db, request.query.rootId);
      if (!root) return reply.status(404).send({ error: "NAS root not found" });
      return reply.send({ roots: [getRootReadiness(db, root.id) ?? { rootId: root.id, status: "unknown", checkedAt: null, reason: "never checked", source: null, uuid: null, fstype: null }] });
    }
    const configured = listNasRoots(db);
    const byId = new Map(listRootReadiness(db, configured.map((root) => root.id)).map((item) => [item.rootId, item]));
    return reply.send({ roots: configured.map((root) => byId.get(root.id) ?? { rootId: root.id, status: "unknown", checkedAt: null, reason: "never checked", source: null, uuid: null, fstype: null }) });
  });
}
