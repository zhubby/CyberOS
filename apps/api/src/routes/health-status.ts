import type { FastifyInstance } from "fastify";
import { getDownloadWorkerHealth, getIndexerServiceStatus, getPhotostaffWorkerHealth, listHealthAlerts, listNasRoots, listRootReadiness, getIndexRootStatus, listBackupRuns } from "@sigmaos/db";
import type { SystemHealthSummary } from "@sigmaos/shared";
import type { ApiRouteContext } from "../context.js";
import { createVodPlayerRuntime } from "../lib/vod-player.js";

export function registerHealthStatusRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  server.get("/api/system/health", async (): Promise<SystemHealthSummary> => {
    const { db } = context;
    const checkedAt = new Date().toISOString();
    const roots = listNasRoots(db);
    const readinessById = new Map(listRootReadiness(db, roots.map((root) => root.id)).map((item) => [item.rootId, item]));
    const readiness = roots.map((root) => readinessById.get(root.id) ?? { rootId: root.id, status: "unknown" as const, checkedAt: null, reason: "never checked", source: null, uuid: null, fstype: null });
    const alerts = listHealthAlerts(db, { status: "active", limit: 100 });
    const issues = alerts.map((alert) => ({ code: alert.code, severity: alert.severity, ...(alert.rootId ? { rootId: alert.rootId } : {}), message: alert.details ?? alert.code }));
    const issueKeys = new Set(issues.map((issue) => `${issue.code}:${issue.rootId ?? "system"}`));
    for (const root of readiness) {
      if (root.status === "not_ready" || root.status === "config_invalid") {
        const key = `mount_not_ready:${root.rootId}`;
        if (!issueKeys.has(key)) issues.push({ code: "mount_not_ready", severity: "critical", rootId: root.rootId, message: root.reason ?? root.status });
      }
      else if (root.status === "unknown") {
        const configuredRoot = roots.find((item) => item.id === root.rootId);
        const key = `mount_not_ready:${root.rootId}`;
        if (!issueKeys.has(key)) issues.push({ code: "mount_not_ready", severity: configuredRoot?.mountPolicy === "required" ? "critical" : "warning", rootId: root.rootId, message: root.reason ?? "readiness unknown" });
      }
    }
    const indexerFreshness = roots.map((root) => getIndexRootStatus(db, root.id).metrics?.freshnessMs ?? null).filter((value): value is number => value !== null);
    const backup = listBackupRuns(db, 30).find((run) =>
      (run.kind === "daily" || run.kind === "weekly") && run.status === "completed"
    );
    const checkedAtMs = Date.parse(checkedAt);
    const backupFreshnessMs = backup?.finishedAt
      ? Math.max(0, checkedAtMs - Date.parse(backup.finishedAt))
      : null;
    const downloader = getDownloadWorkerHealth(db);
    if (downloader.status !== "ready") {
      issues.push({
        code: "downloader_unavailable",
        severity: downloader.activeTasks + downloader.queuedTasks > 0 ? "critical" : "warning",
        message: downloader.status === "stale" ? "Downloader heartbeat is stale" : "Downloader is unavailable"
      });
    }
    const indexer = getIndexerServiceStatus(db);
    if (indexer.service.status !== "ready") {
      issues.push({
        code: "indexer_unavailable",
        severity: indexer.queue.queued + indexer.queue.running + indexer.queue.retrying > 0 ? "critical" : "warning",
        message: indexer.service.status === "stale" ? "Indexer heartbeat is stale" : "Indexer is unavailable"
      });
    }
    if (indexer.queue.stalled) {
      issues.push({ code: "indexer_queue_stalled", severity: "critical", message: "Indexer queue has stopped making progress" });
    }
    if (indexer.watcher.status === "degraded") {
      issues.push({ code: "indexer_watcher_degraded", severity: "warning", message: indexer.watcher.reason ?? "Indexer watcher is degraded" });
    }
    const photostaff = getPhotostaffWorkerHealth(db);
    if (photostaff.status !== "ready") {
      issues.push({
        code: "photostaff_unavailable",
        severity: photostaff.activeJobs + photostaff.queuedJobs + photostaff.retryingJobs > 0 ? "critical" : "warning",
        message: photostaff.status === "stale" ? "Photostaff heartbeat is stale" : "Photostaff is unavailable"
      });
    }
    const vodPlayer = await getVodPlayerHealth(context, checkedAt);
    if (vodPlayer.status === "degraded") {
      issues.push({ code: "vod_player_recovering", severity: "warning", message: "VOD Player is recovering playback" });
    } else if (vodPlayer.status === "critical") {
      issues.push({ code: "vod_player_unavailable", severity: "critical", message: "VOD Player is unavailable" });
    }
    return { status: issues.some((issue) => issue.severity === "critical") ? "failed" : issues.length ? "degraded" : "ready", checkedAt, issues, roots: readiness, indexerFreshnessMs: indexerFreshness.length ? Math.max(...indexerFreshness) : null, backupFreshnessMs, downloader, indexer, photostaff, vodPlayer };
  });
}

async function getVodPlayerHealth(context: ApiRouteContext, checkedAt: string): Promise<SystemHealthSummary["vodPlayer"]> {
  if (!context.config.vodPlayer.enabled) {
    return { status: "disabled", state: null, errorCode: "VOD_PLAYER_DISABLED", checkedAt };
  }
  try {
    const status = await (context.vodPlayer ?? createVodPlayerRuntime(context.config.vodPlayer)).getStatus();
    return {
      status: status.state === "recovering" ? "degraded" : status.state === "error" ? "critical" : "ready",
      state: status.state,
      errorCode: status.errorCode,
      checkedAt
    };
  } catch {
    return { status: "critical", state: null, errorCode: "VOD_PLAYER_UNAVAILABLE", checkedAt };
  }
}
