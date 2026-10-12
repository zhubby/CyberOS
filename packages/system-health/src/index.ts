import {
  getDownloadWorkerHealth,
  getIndexerServiceStatus,
  getIndexRootStatus,
  getOpsTaskOverview,
  getPhotostaffWorkerHealth,
  listBackupRuns,
  listHealthAlerts,
  listIndexRunHistory,
  listNasRoots,
  listRootReadiness,
  reconcileHealthAlerts,
  upsertRootReadiness,
  type SigmaDatabase
} from "@sigmaos/db";
import {
  createVodPlayerRuntime,
  type RootReadiness,
  type SigmaConfig,
  type SystemHealthSummary,
  type VodPlayerRuntime
} from "@sigmaos/shared";
import { checkMountReadiness, type MountCommandRunner } from "@sigmaos/nas-tools";

export const HEALTH_OWNED_ALERT_CODES = [
  "mount_not_ready",
  "indexer_failed",
  "stale_index",
  "indexer_stalled",
  "indexer_unavailable",
  "indexer_queue_stalled",
  "indexer_watcher_degraded",
  "downloader_unavailable",
  "photostaff_unavailable",
  "vod_player_recovering",
  "vod_player_unavailable",
  "backup_target_not_ready",
  "backup_failed",
  "backup_stale",
  "repo_check_failed",
  "ops_health_unhealthy",
  "ops_maintenance_unhealthy"
] as const;

const HEALTH_OWNED_ALERT_SET = new Set<string>(HEALTH_OWNED_ALERT_CODES);

export interface SystemHealthEvaluationInput {
  db: SigmaDatabase;
  config: SigmaConfig;
  now?: Date;
  vodPlayer?: VodPlayerRuntime;
  backupTargetReadiness?: RootReadiness | null;
}

export async function evaluateSystemHealth(
  input: SystemHealthEvaluationInput
): Promise<SystemHealthSummary> {
  const now = input.now ?? new Date();
  const roots = listNasRoots(input.db);
  const readinessById = new Map(
    listRootReadiness(input.db, roots.map((root) => root.id)).map((item) => [item.rootId, item])
  );
  const readiness = roots.map((root) => readinessById.get(root.id) ?? {
    rootId: root.id,
    status: "unknown" as const,
    checkedAt: null,
    reason: "readiness has not been checked",
    source: null,
    uuid: null,
    fstype: null
  });
  const issues: SystemHealthSummary["issues"] = [];
  const issueKeys = new Set<string>();
  const addIssue = (issue: SystemHealthSummary["issues"][number]): void => {
    const key = `${issue.code}:${issue.rootId ?? "system"}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(issue);
  };

  for (const alert of listHealthAlerts(input.db, { status: "active", limit: 200 })) {
    const cachedBackupTarget = alert.code === "backup_target_not_ready"
      && input.backupTargetReadiness === undefined;
    if (HEALTH_OWNED_ALERT_SET.has(alert.code) && !cachedBackupTarget) continue;
    addIssue({
      code: alert.code,
      severity: alert.severity,
      ...(alert.rootId ? { rootId: alert.rootId } : {}),
      message: alert.details ?? alert.code
    });
  }

  const indexFreshness: number[] = [];
  for (const root of roots) {
    const ready = readinessById.get(root.id);
    if (!ready || ready.status !== "ready") {
      const message = ready?.reason ?? "readiness has not been checked";
      const severity = !ready || ready.status === "unknown"
        ? root.mountPolicy === "required" ? "critical" : "warning"
        : "critical";
      addIssue({ code: "mount_not_ready", severity, rootId: root.id, message });
    }

    const status = getIndexRootStatus(input.db, root.id, now);
    const freshness = status.metrics?.freshnessMs ?? null;
    if (freshness !== null) indexFreshness.push(freshness);
    const history = listIndexRunHistory(input.db, root.id, 30);
    let consecutiveFailures = 0;
    for (const run of history) {
      if (run.status !== "failed") break;
      consecutiveFailures += 1;
    }
    const failureThreshold = input.config.health?.consecutiveFailureThreshold ?? 2;
    if (consecutiveFailures >= failureThreshold) {
      addIssue({
        code: "indexer_failed",
        severity: "critical",
        rootId: root.id,
        message: `${consecutiveFailures} consecutive failed runs`
      });
    }

    if (freshness !== null && input.config.health) {
      if (freshness >= input.config.health.staleIndexCriticalMs) {
        addIssue({ code: "stale_index", severity: "critical", rootId: root.id, message: "index is stale" });
      } else if (freshness >= input.config.health.staleIndexWarningMs) {
        addIssue({ code: "stale_index", severity: "warning", rootId: root.id, message: "index is stale" });
      }
    }
    if (
      status.status === "running"
      && status.progress?.lastProgressAt
      && input.config.health
      && now.getTime() - Date.parse(status.progress.lastProgressAt) > input.config.health.stalledRunMs
    ) {
      addIssue({
        code: "indexer_stalled",
        severity: "critical",
        rootId: root.id,
        message: "indexer progress has stalled"
      });
    }
  }

  const backupRuns = listBackupRuns(input.db, 30);
  const latestScheduledBackup = backupRuns.find((run) => run.kind === "daily" || run.kind === "weekly");
  const latestBackup = backupRuns.find((run) =>
    (run.kind === "daily" || run.kind === "weekly") && run.status === "completed"
  );
  const latestCheck = backupRuns.find((run) => run.kind === "check");
  if (input.config.backup?.enabled) {
    if (input.backupTargetReadiness && input.backupTargetReadiness.status !== "ready") {
      addIssue({
        code: "backup_target_not_ready",
        severity: "critical",
        message: input.backupTargetReadiness.reason ?? input.backupTargetReadiness.status
      });
    }
    if (latestScheduledBackup?.status === "failed" || latestScheduledBackup?.status === "interrupted") {
      addIssue({
        code: "backup_failed",
        severity: "critical",
        message: latestScheduledBackup.error ?? "latest backup failed"
      });
    }
    const repoCheckRun = [latestScheduledBackup, latestCheck]
      .filter((run): run is NonNullable<typeof run> => Boolean(run))
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))[0];
    const repoCheckFailure = repoCheckRun?.failures.find((failure) => failure.code === "REPO_CHECK_FAILED")
      ?? (repoCheckRun?.kind === "check" && (repoCheckRun.status === "failed" || repoCheckRun.status === "interrupted")
        ? { reason: repoCheckRun.error ?? "repository check failed" }
        : undefined);
    if (repoCheckFailure) {
      addIssue({ code: "repo_check_failed", severity: "critical", message: repoCheckFailure.reason });
    }
    if (
      !latestBackup
      || (input.config.health
        && latestBackup.finishedAt
        && now.getTime() - Date.parse(latestBackup.finishedAt) > input.config.health.backupStaleMs)
    ) {
      addIssue({ code: "backup_stale", severity: "critical", message: "no recent successful backup" });
    }
  }

  const downloader = getDownloadWorkerHealth(input.db, now);
  if (downloader.status !== "ready") {
    addIssue({
      code: "downloader_unavailable",
      severity: downloader.activeTasks + downloader.queuedTasks > 0 ? "critical" : "warning",
      message: downloader.status === "stale" ? "Downloader heartbeat is stale" : "Downloader is unavailable"
    });
  }
  const indexer = getIndexerServiceStatus(input.db, now);
  if (indexer.service.status !== "ready") {
    addIssue({
      code: "indexer_unavailable",
      severity: indexer.queue.queued + indexer.queue.running + indexer.queue.retrying > 0 ? "critical" : "warning",
      message: indexer.service.status === "stale" ? "Indexer heartbeat is stale" : "Indexer is unavailable"
    });
  }
  if (indexer.queue.stalled) {
    addIssue({ code: "indexer_queue_stalled", severity: "critical", message: "Indexer queue has stopped making progress" });
  }
  if (indexer.watcher.status === "degraded") {
    addIssue({
      code: "indexer_watcher_degraded",
      severity: "warning",
      message: indexer.watcher.reason ?? "Indexer watcher is degraded"
    });
  }
  const photostaff = getPhotostaffWorkerHealth(input.db, now);
  if (photostaff.status !== "ready") {
    addIssue({
      code: "photostaff_unavailable",
      severity: photostaff.activeJobs + photostaff.queuedJobs + photostaff.retryingJobs > 0 ? "critical" : "warning",
      message: photostaff.status === "stale" ? "Photostaff heartbeat is stale" : "Photostaff is unavailable"
    });
  }

  const vodPlayer = await collectVodPlayerHealth(input.config, now, input.vodPlayer);
  if (vodPlayer.status === "degraded") {
    addIssue({ code: "vod_player_recovering", severity: "warning", message: "VOD Player is recovering playback" });
  } else if (vodPlayer.status === "critical") {
    addIssue({ code: "vod_player_unavailable", severity: "critical", message: "VOD Player is unavailable" });
  }

  const operations = {
    health: getOpsTaskOverview(input.db, "health", now),
    maintenance: getOpsTaskOverview(input.db, "maintenance", now)
  };
  if (operations.health.status === "failed" || operations.health.status === "stale") {
    addIssue({
      code: "ops_health_unhealthy",
      severity: "critical",
      message: operations.health.error ?? `Health task is ${operations.health.status}`
    });
  }
  if (operations.maintenance.status === "failed" || operations.maintenance.status === "stale") {
    addIssue({
      code: "ops_maintenance_unhealthy",
      severity: "warning",
      message: operations.maintenance.error ?? `Maintenance task is ${operations.maintenance.status}`
    });
  }

  return {
    status: issues.some((issue) => issue.severity === "critical")
      ? "failed"
      : issues.length > 0 ? "degraded" : "ready",
    checkedAt: now.toISOString(),
    issues,
    roots: readiness,
    indexerFreshnessMs: indexFreshness.length > 0 ? Math.max(...indexFreshness) : null,
    backupFreshnessMs: latestBackup?.finishedAt
      ? Math.max(0, now.getTime() - Date.parse(latestBackup.finishedAt))
      : null,
    downloader,
    indexer,
    photostaff,
    vodPlayer,
    operations
  };
}

export async function runScheduledHealthEvaluation(
  input: SystemHealthEvaluationInput & { mountCommandRunner?: MountCommandRunner }
): Promise<SystemHealthSummary> {
  const now = input.now ?? new Date();
  await refreshRootReadiness(input.db, input.config, now, input.mountCommandRunner);
  const backupTargetReadiness = await inspectBackupTarget(input.config, now, input.mountCommandRunner);
  const summary = await evaluateSystemHealth({
    db: input.db,
    config: input.config,
    now,
    ...(input.vodPlayer ? { vodPlayer: input.vodPlayer } : {}),
    backupTargetReadiness
  });
  reconcileHealthAlerts(input.db, {
    ownedCodes: HEALTH_OWNED_ALERT_CODES,
    issues: summary.issues,
    now
  });
  return summary;
}

export async function refreshRootReadiness(
  db: SigmaDatabase,
  config: SigmaConfig,
  now = new Date(),
  commandRunner?: MountCommandRunner
): Promise<RootReadiness[]> {
  const roots = listNasRoots(db);
  const results = await mapWithConcurrency(roots, 4, async (root) => checkMountReadiness(
    root,
    { now, ...(commandRunner ? { commandRunner } : {}) }
  ));
  for (const readiness of results) upsertRootReadiness(db, readiness);
  return results;
}

async function inspectBackupTarget(
  config: SigmaConfig,
  now: Date,
  commandRunner?: MountCommandRunner
): Promise<RootReadiness | null> {
  if (!config.backup?.enabled) return null;
  return checkMountReadiness({
    id: "backup-target",
    name: "Backup target",
    path: config.backup.repositoryPath ?? "",
    mountPolicy: config.backup.requireMount ? "required" : "optional"
  }, { now, ...(commandRunner ? { commandRunner } : {}) });
}

async function collectVodPlayerHealth(
  config: SigmaConfig,
  now: Date,
  runtime = createVodPlayerRuntime(config.vodPlayer)
): Promise<SystemHealthSummary["vodPlayer"]> {
  const checkedAt = now.toISOString();
  if (!config.vodPlayer.enabled) {
    return { status: "disabled", state: null, errorCode: "VOD_PLAYER_DISABLED", checkedAt };
  }
  try {
    const status = await runtime.getStatus();
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

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]!);
    }
  }));
  return results;
}
