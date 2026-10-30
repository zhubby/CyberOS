import type { FastifyInstance } from "fastify";
import {
  enqueueIndexTask,
  getIndexerServiceStatus,
  getIndexStoragePoolStatus,
  listHealthAlerts,
  listIndexRunHistory,
  listIndexStoragePoolStatuses
} from "@cyberos/db";
import { type IndexReindexRequest, type SystemStoragePool } from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { collectStoragePools } from "../lib/system-management.js";
import {
  resolveScopedExistingPath,
  resolveScopedTargetPath,
  resolveStoragePoolScope
} from "../lib/storage-scope.js";

export function registerIndexerRoutes(server: FastifyInstance, { db, config, system }: ApiRouteContext): void {
  const dataRoot = config.paths.dataRoot;
  server.get<{
    Querystring: { storagePoolId?: string };
  }>("/api/indexer/status", async (request, reply) => {
    const storage = system ? await collectStoragePools(system) : null;
    if (request.query.storagePoolId) {
      const pool = storage?.pools.find((candidate) => candidate.id === request.query.storagePoolId);
      if (!pool) {
        reply.status(404).send({ error: "Storage pool not found" });
        return;
      }
      reply.send({
        storagePools: [serializeStatus(getIndexStoragePoolStatus(db, pool.id), db, pool)],
        ...getIndexerServiceStatus(db)
      });
      return;
    }

    const pools = storage?.pools ?? [];
    reply.send({
      storagePools: listIndexStoragePoolStatuses(db, pools.map((pool) => pool.id)).map((status) =>
        serializeStatus(status, db, pools.find((pool) => pool.id === status.storagePoolId))
      ),
      ...getIndexerServiceStatus(db)
    });
  });

  server.post<{ Body: Partial<IndexReindexRequest> }>("/api/indexer/reindex", async (request, reply) => {
    const requestedPath = request.body?.path?.trim() || ".";
    try {
      const scope = await resolveStoragePoolScope(dataRoot, system, request.body?.storagePoolId);
      const safe = requestedPath === "."
        ? await resolveScopedExistingPath(scope, ".")
        : await resolveScopedTargetPath(scope, requestedPath);
      const task = enqueueIndexTask(db, {
        storagePoolId: scope.pool.id,
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

function serializeStatus(
  status: ReturnType<typeof getIndexStoragePoolStatus>,
  db: ApiRouteContext["db"],
  pool?: SystemStoragePool
): ReturnType<typeof getIndexStoragePoolStatus> {
  return {
    ...status,
    history: listIndexRunHistory(db, status.storagePoolId, 30),
    readiness: pool ? {
      storagePoolId: pool.id,
      status: pool.status === "ready" ? "ready" : "not_ready",
      checkedAt: new Date().toISOString(),
      reason: pool.status === "ready" ? null : `storage pool status is ${pool.status}`,
      source: pool.raidPath,
      uuid: null,
      fstype: pool.filesystem
    } : {
      storagePoolId: status.storagePoolId,
      status: "unknown",
      checkedAt: null,
      reason: "storage inventory unavailable",
      source: null,
      uuid: null,
      fstype: null
    },
    alerts: listHealthAlerts(db, { limit: 100 }).filter((alert) =>
      alert.storagePoolId === status.storagePoolId || alert.storagePoolId === null
    )
  };
}
