import type { FastifyInstance } from "fastify";
import { resolveSafeExistingPath, resolveSafeTargetPath } from "@sigmaos/nas-tools";
import { enqueueIndexTask, getIndexerServiceStatus, getIndexRootStatus, getNasRoot, listIndexRootStatuses, listNasRoots, listHealthAlerts, listIndexRunHistory, listRootReadiness } from "@sigmaos/db";
import type { IndexReindexRequest } from "@sigmaos/shared";
import type { ApiRouteContext } from "../context.js";

export function registerIndexerRoutes(server: FastifyInstance, { db, config }: ApiRouteContext): void {
  server.get<{
    Querystring: { rootId?: string };
  }>("/api/indexer/status", async (request, reply) => {
    if (request.query.rootId) {
      const root = getNasRoot(db, request.query.rootId);
      if (!root) {
        reply.status(404).send({ error: "NAS root not found" });
        return;
      }
      reply.send({
        roots: [serializeStatus(getIndexRootStatus(db, root.id), config.environment !== undefined, db)],
        ...getIndexerServiceStatus(db)
      });
      return;
    }

    const roots = listNasRoots(db);
    reply.send({
      roots: listIndexRootStatuses(db, roots.map((root) => root.id)).map((status) => serializeStatus(status, config.environment !== undefined, db)),
      ...getIndexerServiceStatus(db)
    });
  });

  server.post<{ Body: Partial<IndexReindexRequest> }>("/api/indexer/reindex", async (request, reply) => {
    const root = getNasRoot(db, request.body?.rootId ?? "");
    if (!root) {
      reply.status(404).send({ error: "NAS root not found" });
      return;
    }
    const requestedPath = request.body?.path?.trim() || ".";
    try {
      const safe = requestedPath === "."
        ? await resolveSafeExistingPath(root.path, ".")
        : await resolveSafeTargetPath(root.path, requestedPath);
      const task = enqueueIndexTask(db, {
        rootId: root.id,
        path: safe.relativePath,
        recursive: request.body?.recursive ?? safe.relativePath === ".",
        kind: "manual"
      });
      reply.status(202).send({ task });
    } catch (error) {
      reply.status(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function serializeStatus(status: ReturnType<typeof getIndexRootStatus>, extended: boolean, db: ApiRouteContext["db"]): ReturnType<typeof getIndexRootStatus> {
  if (extended) {
    const readiness = listRootReadiness(db, [status.rootId])[0];
    return {
      ...status,
      history: listIndexRunHistory(db, status.rootId, 30),
      readiness: readiness ?? { rootId: status.rootId, status: "unknown", checkedAt: null, reason: "never checked", source: null, uuid: null, fstype: null },
      alerts: listHealthAlerts(db, { limit: 100 }).filter((alert) => alert.rootId === status.rootId || alert.rootId === null)
    };
  }
  const { progress: _progress, metrics: _metrics, readiness: _readiness, alerts: _alerts, history: _history, ...legacy } = status;
  return legacy;
}
