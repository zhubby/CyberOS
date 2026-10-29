import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  getDownloadWorkerHealth,
  getIndexerServiceStatus,
  getIndexStoragePoolStatus,
  getOpsTaskOverview,
  getPhotosWorkerHealth,
  listBackupRuns,
  listHealthAlerts,
  listIndexRunHistory,
  reconcileHealthAlerts,
  type CyberOsDatabase
} from "@cyberos/db";
import { readMonitoringHealth } from "@cyberos/monitoring";
import {
  createVodPlayerRuntime,
  type StoragePoolReadiness,
  type CyberOsRuntime,
  type SystemHealthSummary,
  type VodPlayerRuntime
} from "@cyberos/shared";

export const HEALTH_OWNED_ALERT_CODES = [
  "storage_pool_not_ready",
  "indexer_failed",
  "stale_index",
  "indexer_stalled",
  "indexer_unavailable",
  "indexer_queue_stalled",
  "indexer_watcher_degraded",
  "downloader_unavailable",
  "photos_unavailable",
  "vod_player_recovering",
  "vod_player_unavailable",
  "backup_target_not_ready",
  "backup_failed",
  "backup_stale",
  "repo_check_failed",
  "ops_health_unhealthy",
  "ops_maintenance_unhealthy",
  "monitoring_unavailable"
] as const;

const HEALTH_OWNED_ALERT_SET = new Set<string>(HEALTH_OWNED_ALERT_CODES);

export interface SystemHealthEvaluationInput {
  db: CyberOsDatabase;
  config: CyberOsRuntime;
  now?: Date;
  vodPlayer?: VodPlayerRuntime;
  backupTargetReadiness?: StoragePoolReadiness | null;
}

export async function evaluateSystemHealth(
  input: SystemHealthEvaluationInput
): Promise<SystemHealthSummary> {
  const now = input.now ?? new Date();
  const readiness = await inspectStoragePools(input.config, now);
  const issues: SystemHealthSummary["issues"] = [];
  const issueKeys = new Set<string>();
  const addIssue = (issue: SystemHealthSummary["issues"][number]): void => {
    const key = `${issue.code}:${issue.storagePoolId ?? "system"}`;
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
      ...(alert.storagePoolId ? { storagePoolId: alert.storagePoolId } : {}),
      message: alert.details ?? alert.code
    });
  }

  const indexFreshness: number[] = [];
  for (const storagePool of readiness) {
    if (storagePool.status !== "ready") {
      addIssue({
        code: "storage_pool_not_ready",
        severity: "critical",
        storagePoolId: storagePool.storagePoolId,
        message: storagePool.reason ?? "storage pool is not ready"
      });
    }

    const status = getIndexStoragePoolStatus(input.db, storagePool.storagePoolId, now);
    const freshness = status.metrics?.freshnessMs ?? null;
    if (freshness !== null) indexFreshness.push(freshness);
    const history = listIndexRunHistory(input.db, storagePool.storagePoolId, 30);
    let consecutiveFailures = 0;
    for (const run of history) {
      if (run.status !== "failed") break;
      consecutiveFailures += 1;
    }
    const failureThreshold = input.config.health.consecutiveFailureThreshold;
    if (consecutiveFailures >= failureThreshold) {
      addIssue({
        code: "indexer_failed",
        severity: "critical",
        storagePoolId: storagePool.storagePoolId,
        message: `${consecutiveFailures} consecutive failed runs`
      });
    }

    if (freshness !== null) {
      if (freshness >= input.config.health.staleIndexCriticalMs) {
        addIssue({ code: "stale_index", severity: "critical", storagePoolId: storagePool.storagePoolId, message: "index is stale" });
      } else if (freshness >= input.config.health.staleIndexWarningMs) {
        addIssue({ code: "stale_index", severity: "warning", storagePoolId: storagePool.storagePoolId, message: "index is stale" });
      }
    }
    if (
      status.status === "running"
      && status.progress?.lastProgressAt
      && now.getTime() - Date.parse(status.progress.lastProgressAt) > input.config.health.stalledRunMs
    ) {
      addIssue({
        code: "indexer_stalled",
        severity: "critical",
        storagePoolId: storagePool.storagePoolId,
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
  if (input.config.backup.enabled) {
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
      || (latestBackup.finishedAt
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
  const photos = getPhotosWorkerHealth(input.db, now);
  if (photos.status !== "ready") {
    addIssue({
      code: "photos_unavailable",
      severity: photos.activeJobs + photos.queuedJobs + photos.retryingJobs > 0 ? "critical" : "warning",
      message: photos.status === "stale" ? "Photos heartbeat is stale" : "Photos is unavailable"
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

  const monitoring = readMonitoringHealth(
    input.config.paths.metricsDatabasePath,
    input.config.monitoring,
    now
  );
  if (monitoring.status === "unavailable") {
    addIssue({
      code: "monitoring_unavailable",
      severity: "warning",
      message: "Monitoring has not produced a recent sample"
    });
  }

  return {
    status: issues.some((issue) => issue.severity === "critical")
      ? "failed"
      : issues.length > 0 ? "degraded" : "ready",
    checkedAt: now.toISOString(),
    issues,
    storagePools: readiness,
    indexerFreshnessMs: indexFreshness.length > 0 ? Math.max(...indexFreshness) : null,
    backupFreshnessMs: latestBackup?.finishedAt
      ? Math.max(0, now.getTime() - Date.parse(latestBackup.finishedAt))
      : null,
    downloader,
    indexer,
    photos,
    vodPlayer,
    operations,
    monitoring
  };
}

export async function runScheduledHealthEvaluation(
  input: SystemHealthEvaluationInput
): Promise<SystemHealthSummary> {
  const now = input.now ?? new Date();
  const backupTargetReadiness = await inspectBackupTarget(input.config, now);
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

export async function inspectStoragePools(
  config: CyberOsRuntime,
  now = new Date()
): Promise<StoragePoolReadiness[]> {
  const dataRoot = config.paths.dataRoot;
  let entries;
  try {
    entries = await readdir(dataRoot, { withFileTypes: true });
  } catch (error) {
    return [{
      storagePoolId: "data",
      status: "config_invalid",
      checkedAt: now.toISOString(),
      reason: error instanceof Error ? error.message : "data root is unavailable",
      source: null,
      uuid: null,
      fstype: null
    }];
  }
  const mounted = config.environment === "production" ? await mountedPaths() : null;
  const pools = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const poolPath = path.join(dataRoot, entry.name);
    const metadata = await lstat(poolPath);
    const realPath = await realpath(poolPath);
    const isReady = !metadata.isSymbolicLink() && (!mounted || mounted.has(realPath));
    return {
      storagePoolId: entry.name,
      status: isReady ? "ready" as const : "not_ready" as const,
      checkedAt: now.toISOString(),
      reason: isReady ? null : "storage pool is not mounted",
      source: realPath,
      uuid: null,
      fstype: null
    };
  }));
  return pools.sort((left, right) => left.storagePoolId.localeCompare(right.storagePoolId));
}

async function inspectBackupTarget(
  config: CyberOsRuntime,
  now: Date
): Promise<StoragePoolReadiness | null> {
  if (!config.backup.enabled) return null;
  try {
    await access(config.backup.repositoryPath ?? "", fsConstants.R_OK | fsConstants.W_OK);
    return {
      storagePoolId: "backup",
      status: "ready",
      checkedAt: now.toISOString(),
      reason: null,
      source: config.backup.repositoryPath,
      uuid: null,
      fstype: null
    };
  } catch (error) {
    return {
      storagePoolId: "backup",
      status: "not_ready",
      checkedAt: now.toISOString(),
      reason: error instanceof Error ? error.message : "backup repository is unavailable",
      source: config.backup.repositoryPath,
      uuid: null,
      fstype: null
    };
  }
}

async function mountedPaths(): Promise<Set<string>> {
  try {
    const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
    const paths = await Promise.all(mountInfo.split("\n").flatMap((line) => {
      const mountpoint = line.split(" ")[4];
      if (!mountpoint) return [];
      return [realpath(unescapeMountInfo(mountpoint)).catch(() => null)];
    }));
    return new Set(paths.filter((candidate): candidate is string => candidate !== null));
  } catch {
    return new Set();
  }
}

function unescapeMountInfo(value: string): string {
  return value.replace(/\\(040|011|012|134)/gu, (_match, code: string) => ({
    "040": " ",
    "011": "\t",
    "012": "\n",
    "134": "\\"
  })[code]!);
}

async function collectVodPlayerHealth(
  config: CyberOsRuntime,
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
