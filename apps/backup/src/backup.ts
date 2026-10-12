import { createHash, randomUUID } from "node:crypto";
import { access, constants as fsConstants, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acquireExecutionLock,
  finishBackupRun,
  heartbeatExecutionLock,
  isExecutionLockOwner,
  listBackupRuns,
  recordBackupFailure,
  releaseExecutionLock,
  startBackupRun,
  upsertRootReadiness,
  type SigmaDatabase
} from "@sigmaos/db";
import type { BackupConfig, BackupRunKind, BackupRunSummary, SigmaConfig } from "@sigmaos/shared";
import { checkMountReadiness, type MountCommandRunner } from "@sigmaos/nas-tools";
import { summarizeResticOutput, SystemResticRunner, type ResticCommandRunner } from "./restic.js";

export interface BackupDependencies {
  db: SigmaDatabase;
  config: SigmaConfig;
  restic?: ResticCommandRunner;
  mountCommandRunner?: MountCommandRunner;
}

const BACKUP_LOCK_NAME = "backup";

export function shouldSkipScheduledBackup(config: SigmaConfig, command: string | undefined): boolean {
  return command === "run" && !config.backup?.enabled;
}

export async function validateBackup(input: BackupDependencies): Promise<{ ok: boolean; issues: string[] }> {
  const config = input.config.backup;
  if (!config?.enabled) return { ok: true, issues: [] };
  const issues: string[] = [];
  issues.push(...validateBackupPaths(input.config));
  if (!config.repositoryPath) issues.push("repository not configured");
  if (!config.passwordFile) issues.push("password file not configured");
  if (config.passwordFile) {
    await stat(config.passwordFile).then(async (value) => {
      if (!value.isFile()) {
        issues.push("password file is not a regular file");
        return;
      }
      await access(config.passwordFile!, fsConstants.R_OK).catch(() => issues.push("password file not readable"));
    }).catch(() => issues.push("password file not readable"));
  }
  if (config.repositoryPath) {
    await access(config.repositoryPath, fsConstants.R_OK | fsConstants.W_OK).catch(() => issues.push("repository not accessible or writable"));
    const readiness = await checkMountReadiness({ id: "backup-target", name: "Backup target", path: config.repositoryPath, mountPolicy: config.requireMount ? "required" : "optional" }, input.mountCommandRunner ? { commandRunner: input.mountCommandRunner } : {});
    if (readiness.status !== "ready") issues.push(`backup target ${readiness.reason ?? readiness.status}`);
  }
  if (issues.length > 0) return { ok: false, issues };
  const runner = input.restic ?? new SystemResticRunner();
  const result = await runResticWithRetry(runner, ["snapshots", "--repo", config.repositoryPath ?? ""], config);
  if (result.code !== 0 && !/no snapshots found/iu.test(result.stderr)) issues.push(`restic unavailable (${summarizeResticOutput(result.stderr || result.stdout)})`);
  return { ok: issues.length === 0, issues };
}

export async function initBackup(input: BackupDependencies): Promise<void> {
  const config = requireBackupConfig(input.config);
  const pathIssues = validateBackupPaths(input.config);
  if (pathIssues.length) throw new Error(pathIssues.join("; "));
  if (!config.repositoryPath) throw new Error("Backup repository is not configured");
  if (!config.passwordFile) throw new Error("Backup password file is not configured");
  const passwordStat = await stat(config.passwordFile);
  if (!passwordStat.isFile()) throw new Error("Backup password file is not a regular file");
  await access(config.passwordFile, fsConstants.R_OK);
  const repositoryExists = await stat(config.repositoryPath).then(() => true).catch(() => false);
  const repositoryParent = path.dirname(config.repositoryPath);
  await access(repositoryExists ? config.repositoryPath : repositoryParent, fsConstants.R_OK | fsConstants.W_OK);
  const readiness = await checkMountReadiness(
    {
      id: "backup-target",
      name: "Backup target",
      path: repositoryExists ? config.repositoryPath : repositoryParent,
      mountPolicy: config.requireMount ? "required" : "optional"
    },
    input.mountCommandRunner ? { commandRunner: input.mountCommandRunner } : {}
  );
  if (readiness.status !== "ready") throw new Error(`Backup target is not ready: ${readiness.reason ?? readiness.status}`);
  const runner = input.restic ?? new SystemResticRunner();
  const owner = randomUUID();
  if (!acquireExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner })) throw new Error("backup already running");
  const heartbeat = setInterval(() => {
    heartbeatExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner });
  }, 5_000);
  heartbeat.unref?.();
  try {
    if (!isExecutionLockOwner(input.db, { name: BACKUP_LOCK_NAME, owner })) {
      throw new Error("backup execution lease lost");
    }
    const result = await runResticWithRetry(runner, ["init", "--repo", config.repositoryPath], config);
    if (!isExecutionLockOwner(input.db, { name: BACKUP_LOCK_NAME, owner })) {
      throw new Error("backup execution lease lost");
    }
    if (result.code !== 0) throw new Error(`restic init failed: ${summarizeResticOutput(result.stderr || result.stdout)}`);
  } finally {
    clearInterval(heartbeat);
    releaseExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner });
  }
}

export async function runBackup(input: BackupDependencies & { kind?: Exclude<BackupRunKind, "check" | "restore">; now?: Date }): Promise<BackupRunSummary> {
  const config = requireBackupConfig(input.config);
  const pathIssues = validateBackupPaths(input.config);
  if (pathIssues.length) throw new Error(pathIssues.join("; "));
  const kind = input.kind ?? "daily";
  const owner = randomUUID();
  if (!acquireExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner })) throw new Error("backup already running");
  const run = startBackupRun(input.db, input.now ? { kind, now: input.now } : { kind });
  console.log(JSON.stringify({ event: "backup.run.started", runId: run.id, kind }));
  const failures: Array<{ rootId: string; reason: string }> = [];
  const runner = input.restic ?? new SystemResticRunner();
  let staging: string | null = null;
  const heartbeat = setInterval(() => {
    heartbeatExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner });
  }, 5_000);
  heartbeat.unref?.();
  const ensureLease = (): void => {
    if (!isExecutionLockOwner(input.db, { name: BACKUP_LOCK_NAME, owner })) {
      throw new Error("backup execution lease lost");
    }
  };
  try {
    ensureLease();
    const roots = input.config.nasRoots;
    const readyRoots = [] as typeof roots;
    const backupTarget = await checkMountReadiness(
      {
        id: "backup-target",
        name: "Backup target",
        path: config.repositoryPath ?? "",
        mountPolicy: config.requireMount ? "required" : "optional"
      },
      input.mountCommandRunner ? { commandRunner: input.mountCommandRunner } : {}
    );
    if (backupTarget.status !== "ready") {
      const reason = backupTarget.reason ?? backupTarget.status;
      recordBackupFailure(input.db, { runId: run.id, path: "repository", code: "BACKUP_TARGET_NOT_READY", reason });
      throw new Error(`Backup target is not ready: ${reason}`);
    }
    for (const root of roots) {
      const readiness = await checkMountReadiness(root, input.mountCommandRunner ? { commandRunner: input.mountCommandRunner } : {});
      upsertRootReadiness(input.db, readiness);
      if (readiness.status !== "ready") {
        const reason = readiness.reason ?? readiness.status;
        failures.push({ rootId: root.id, reason });
        recordBackupFailure(input.db, { runId: run.id, rootId: root.id, path: ".", reason, code: "ROOT_NOT_READY" });
      } else {
        readyRoots.push(root);
      }
    }
    await mkdir(config.stagingPath, { recursive: true });
    const runStaging = await mkdtemp(path.join(config.stagingPath, `run-${run.id}-`));
    staging = runStaging;
    await createSqliteSnapshot(input.db, path.join(runStaging, "sigmaos.sqlite"));
    const trashPath = path.join(input.config.dataDir, "trash");
    await access(trashPath).then(() => copyTreeNoSymlinks(trashPath, path.join(runStaging, "trash"))).catch(() => undefined);
    const manifest = await createManifest(run.id, input.config.nasRoots, runStaging);
    await writeFile(path.join(runStaging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const snapshotIds: string[] = [];
    let backupStats = { files: 0, bytes: 0 };
    for (const root of readyRoots) {
      ensureLease();
      const result = await runResticWithRetry(runner, ["backup", "--json", "--repo", config.repositoryPath!, "--tag", kind, root.path], config);
      if (result.code !== 0) {
        const reason = summarizeResticOutput(result.stderr || result.stdout) || "restic backup failed";
        failures.push({ rootId: root.id, reason });
        recordBackupFailure(input.db, { runId: run.id, rootId: root.id, path: ".", code: "RESTIC_BACKUP_FAILED", reason });
        continue;
      }
      const rootSnapshotIds = parseSnapshotIds(result.stdout);
      if (!rootSnapshotIds.length) {
        const reason = "restic backup did not return a snapshot id";
        failures.push({ rootId: root.id, reason });
        recordBackupFailure(input.db, { runId: run.id, rootId: root.id, path: ".", code: "SNAPSHOT_ID_MISSING", reason });
        continue;
      }
      snapshotIds.push(...rootSnapshotIds);
      const stats = parseBackupStats(result.stdout);
      backupStats = { files: backupStats.files + stats.files, bytes: backupStats.bytes + stats.bytes };
    }
    ensureLease();
    const stateResult = await runResticWithRetry(runner, ["backup", "--json", "--repo", config.repositoryPath!, "--tag", kind, runStaging], config);
    if (stateResult.code !== 0) {
      const reason = `restic state backup failed: ${summarizeResticOutput(stateResult.stderr || stateResult.stdout)}`;
      recordBackupFailure(input.db, { runId: run.id, path: "sigmaos-state", code: "STATE_SNAPSHOT_FAILED", reason });
      throw new Error(reason);
    }
    const stateSnapshotIds = parseSnapshotIds(stateResult.stdout);
    if (!stateSnapshotIds.length) {
      const reason = "restic state backup did not return a snapshot id";
      recordBackupFailure(input.db, { runId: run.id, path: "sigmaos-state", code: "SNAPSHOT_ID_MISSING", reason });
      throw new Error(reason);
    }
    snapshotIds.push(...stateSnapshotIds);
    const uniqueSnapshotIds = [...new Set(snapshotIds)];
    const stateStats = parseBackupStats(stateResult.stdout);
    backupStats = { files: backupStats.files + stateStats.files, bytes: backupStats.bytes + stateStats.bytes };
    if (!uniqueSnapshotIds.length) throw new Error("restic backup did not return a snapshot id");
    ensureLease();
    const visible = await runResticWithRetry(runner, ["snapshots", "--json", "--repo", config.repositoryPath!], config);
    if (visible.code !== 0 || !snapshotVisible(visible.stdout, uniqueSnapshotIds)) throw new Error("restic snapshot is not visible after backup");
    if (failures.length > 0) {
      const failed = finishBackupRun(input.db, { runId: run.id, status: "failed", snapshotIds: uniqueSnapshotIds, files: backupStats.files, bytes: backupStats.bytes, error: "one or more roots failed" });
      const summary = failed ?? { ...run, status: "failed" as const, finishedAt: new Date().toISOString(), snapshotIds: uniqueSnapshotIds, error: "one or more roots failed", failures };
      console.log(JSON.stringify({ event: "backup.run.failed", runId: run.id, kind, error: summary.error }));
      return summary;
    }
    if (kind === "weekly") {
      ensureLease();
      const checked = await runResticWithRetry(runner, ["check", "--repo", config.repositoryPath!], config);
      if (checked.code !== 0) {
        const reason = `restic check failed: ${summarizeResticOutput(checked.stderr || checked.stdout)}`;
        recordBackupFailure(input.db, { runId: run.id, path: "repository", code: "REPO_CHECK_FAILED", reason });
        throw new Error(reason);
      }
      ensureLease();
      const pruned = await runResticWithRetry(runner, ["forget", "--repo", config.repositoryPath!, "--keep-daily", String(config.keepDaily), "--keep-weekly", String(config.keepWeekly), "--prune"], config);
      if (pruned.code !== 0) {
        const reason = `restic prune failed: ${summarizeResticOutput(pruned.stderr || pruned.stdout)}`;
        recordBackupFailure(input.db, { runId: run.id, path: "repository", code: "REPO_PRUNE_FAILED", reason });
        throw new Error(reason);
      }
    }
    const finished = finishBackupRun(input.db, { runId: run.id, status: "completed", snapshotIds: uniqueSnapshotIds, files: backupStats.files, bytes: backupStats.bytes, verified: true, ...(input.now ? { finishedAt: input.now } : {}) });
    if (!finished) throw new Error("backup run was interrupted");
    console.log(JSON.stringify({ event: "backup.run.completed", runId: run.id, kind, snapshots: finished.snapshotIds.length, files: finished.files, bytes: finished.bytes }));
    return finished;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "backup failed";
    const finished = finishBackupRun(input.db, { runId: run.id, status: "failed", error: reason, ...(input.now ? { finishedAt: input.now } : {}) });
    const summary = finished ?? { ...run, status: "failed" as const, finishedAt: new Date().toISOString(), error: reason, failures };
    console.log(JSON.stringify({ event: "backup.run.failed", runId: run.id, kind, error: reason }));
    return summary;
  } finally {
    clearInterval(heartbeat);
    if (staging) await rm(staging, { recursive: true, force: true });
    releaseExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner });
  }
}

export async function checkBackup(input: BackupDependencies): Promise<BackupRunSummary | null> {
  const config = requireBackupConfig(input.config);
  const pathIssues = validateBackupPaths(input.config);
  if (pathIssues.length) throw new Error(pathIssues.join("; "));
  const runner = input.restic ?? new SystemResticRunner();
  const owner = randomUUID();
  if (!acquireExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner })) throw new Error("backup already running");
  const run = startBackupRun(input.db, { kind: "check" });
  const heartbeat = setInterval(() => {
    heartbeatExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner });
  }, 5_000);
  heartbeat.unref?.();
  const ensureLease = (): void => {
    if (!isExecutionLockOwner(input.db, { name: BACKUP_LOCK_NAME, owner })) {
      throw new Error("backup execution lease lost");
    }
  };
  try {
    ensureLease();
    const backupTarget = await checkMountReadiness(
      {
        id: "backup-target",
        name: "Backup target",
        path: config.repositoryPath ?? "",
        mountPolicy: config.requireMount ? "required" : "optional"
      },
      input.mountCommandRunner ? { commandRunner: input.mountCommandRunner } : {}
    );
    if (backupTarget.status !== "ready") {
      const reason = backupTarget.reason ?? backupTarget.status;
      recordBackupFailure(input.db, { runId: run.id, path: "repository", code: "BACKUP_TARGET_NOT_READY", reason });
      const finished = finishBackupRun(input.db, { runId: run.id, status: "failed", error: `Backup target is not ready: ${reason}` });
      return finished;
    }
    ensureLease();
    const result = await runResticWithRetry(runner, ["check", "--repo", config.repositoryPath ?? ""], config);
    if (result.code !== 0) {
      const reason = summarizeResticOutput(result.stderr || result.stdout) || "repository check failed";
      recordBackupFailure(input.db, { runId: run.id, path: "repository", code: "REPO_CHECK_FAILED", reason });
      return finishBackupRun(input.db, { runId: run.id, status: "failed", verified: false, error: reason });
    }
    return finishBackupRun(input.db, { runId: run.id, status: "completed", verified: true, error: null });
  } finally {
    clearInterval(heartbeat);
    releaseExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner });
  }
}

export async function restoreBackup(input: BackupDependencies & { snapshot: string }): Promise<{ stagingPath: string; verified: boolean }> {
  const config = requireBackupConfig(input.config);
  const pathIssues = validateBackupPaths(input.config);
  if (pathIssues.length) throw new Error(pathIssues.join("; "));
  const runner = input.restic ?? new SystemResticRunner();
  const owner = randomUUID();
  if (!acquireExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner })) throw new Error("backup already running");
  const run = startBackupRun(input.db, { kind: "restore" });
  let stagingPath = "";
  const heartbeat = setInterval(() => {
    heartbeatExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner });
  }, 5_000);
  heartbeat.unref?.();
  const ensureLease = (): void => {
    if (!isExecutionLockOwner(input.db, { name: BACKUP_LOCK_NAME, owner })) {
      throw new Error("backup execution lease lost");
    }
  };
  try {
    ensureLease();
    const check = await runResticWithRetry(runner, ["check", "--repo", config.repositoryPath ?? ""], config);
    if (check.code !== 0) {
      const reason = `repository check failed: ${summarizeResticOutput(check.stderr || check.stdout)}`;
      recordBackupFailure(input.db, { runId: run.id, path: "repository", code: "REPO_CHECK_FAILED", reason });
      throw new Error(reason);
    }
    await mkdir(config.stagingPath, { recursive: true });
    stagingPath = await mkdtemp(path.join(config.stagingPath, "restore-"));
    ensureLease();
    const dryRun = await runResticWithRetry(runner, ["restore", input.snapshot, "--dry-run", "--repo", config.repositoryPath ?? "", "--target", stagingPath], config);
    if (dryRun.code !== 0) {
      const reason = `restore dry-run failed: ${summarizeResticOutput(dryRun.stderr || dryRun.stdout)}`;
      recordBackupFailure(input.db, { runId: run.id, path: "restore", code: "RESTORE_DRY_RUN_FAILED", reason });
      throw new Error(reason);
    }
    ensureLease();
    const result = await runResticWithRetry(runner, ["restore", input.snapshot, "--repo", config.repositoryPath ?? "", "--target", stagingPath], config);
    if (result.code !== 0) {
      const reason = `restore failed: ${summarizeResticOutput(result.stderr || result.stdout)}`;
      recordBackupFailure(input.db, { runId: run.id, path: "restore", code: "RESTORE_FAILED", reason });
      throw new Error(reason);
    }
    const manifestPath = await findManifest(stagingPath);
    if (!manifestPath) throw new Error("restore manifest not found");
    const manifestRoot = path.dirname(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
    await validateManifest(manifest, manifestRoot, input.config);
    finishBackupRun(input.db, { runId: run.id, status: "completed", snapshotIds: [input.snapshot], verified: true });
    return { stagingPath, verified: true };
  } catch (error) {
    finishBackupRun(input.db, { runId: run.id, status: "failed", snapshotIds: [input.snapshot], error: error instanceof Error ? error.message : "restore failed" });
    throw error;
  } finally {
    clearInterval(heartbeat);
    releaseExecutionLock(input.db, { name: BACKUP_LOCK_NAME, owner });
  }
}

export function listBackups(db: SigmaDatabase): BackupRunSummary[] { return listBackupRuns(db, 30); }

function requireBackupConfig(config: SigmaConfig): BackupConfig {
  if (!config.backup?.enabled) throw new Error("Backup is disabled");
  return config.backup;
}

function validateBackupPaths(config: SigmaConfig): string[] {
  const backup = config.backup;
  if (!backup?.enabled) return [];
  if (!backup.repositoryPath) return ["repository not configured"];
  const repositoryPath = path.resolve(backup.repositoryPath);
  const stagingPath = path.resolve(backup.stagingPath);
  const dataDir = path.resolve(config.dataDir);
  const overlaps = (first: string, second: string): boolean =>
    first === second || first.startsWith(`${second}${path.sep}`) || second.startsWith(`${first}${path.sep}`);
  const issues: string[] = [];
  if (overlaps(repositoryPath, dataDir)) issues.push("backup repository must not overlap dataDir");
  if (overlaps(repositoryPath, stagingPath)) issues.push("backup repository must not overlap staging path");
  for (const root of config.nasRoots) {
    const rootPath = path.resolve(root.path);
    if (overlaps(repositoryPath, rootPath)) issues.push(`backup repository must not overlap NAS root ${root.id}`);
    if (overlaps(stagingPath, rootPath)) issues.push(`backup staging path must not overlap NAS root ${root.id}`);
  }
  return issues;
}

interface BackupManifest {
  version: 1;
  runId: string;
  createdAt: string;
  roots: Array<{ rootId: string; path: string }>;
  database: "sigmaos.sqlite";
  checksums: Record<string, string>;
}

async function createManifest(
  runId: string,
  roots: SigmaConfig["nasRoots"],
  stagingPath: string
): Promise<BackupManifest> {
  return {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    roots: roots.map((root) => ({ rootId: root.id, path: root.path })),
    database: "sigmaos.sqlite",
    checksums: await collectChecksums(stagingPath)
  };
}

async function collectChecksums(rootPath: string): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  async function walk(directoryPath: string, relativeDirectory: string): Promise<void> {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      if (relativeDirectory === "" && entry.name === "manifest.json") continue;
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entryStat.isFile()) {
        checksums[relativePath] = await hashFile(absolutePath);
      }
    }
  }
  await walk(rootPath, "");
  return checksums;
}

async function copyTreeNoSymlinks(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) return;
  if (sourceStat.isDirectory()) {
    await mkdir(destinationPath, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      await copyTreeNoSymlinks(path.join(sourcePath, entry.name), path.join(destinationPath, entry.name));
    }
    return;
  }
  if (sourceStat.isFile()) {
    await copyFile(sourcePath, destinationPath);
  }
}

async function findManifest(rootPath: string): Promise<string | null> {
  const matches: string[] = [];
  async function walk(directoryPath: string, depth: number): Promise<void> {
    if (depth > 12 || matches.length > 1) return;
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const absolutePath = path.join(directoryPath, entry.name);
      if (entry.name === "manifest.json" && entry.isFile()) {
        try {
          const value = JSON.parse(await readFile(absolutePath, "utf8")) as { version?: number; roots?: unknown[]; database?: string };
          if (value.version === 1 && Array.isArray(value.roots) && value.database === "sigmaos.sqlite") {
            matches.push(absolutePath);
            if (matches.length > 1) return;
          }
        } catch {
          // Ignore unrelated or malformed manifest files while looking for the backup manifest.
        }
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(absolutePath, depth + 1);
        if (matches.length > 1) return;
      }
    }
  }
  await walk(rootPath, 0);
  return matches.length === 1 ? matches[0] ?? null : null;
}

async function validateManifest(manifest: BackupManifest, manifestRoot: string, config: SigmaConfig): Promise<void> {
  if (manifest.version !== 1 || !manifest.runId || !Array.isArray(manifest.roots) || manifest.database !== "sigmaos.sqlite") {
    throw new Error("restore manifest validation failed");
  }
  for (const root of manifest.roots) {
    if (!root || typeof root.rootId !== "string" || typeof root.path !== "string") {
      throw new Error("restore manifest root validation failed");
    }
    const configuredRoot = config.nasRoots.find((item) => item.id === root.rootId);
    if (!configuredRoot) {
      throw new Error(`restore manifest references unknown root: ${root.rootId}`);
    }
    if (path.resolve(configuredRoot.path) !== path.resolve(root.path)) {
      throw new Error(`restore manifest root path mismatch: ${root.rootId}`);
    }
  }
  if (!manifest.checksums || typeof manifest.checksums !== "object") {
    throw new Error("restore manifest checksums missing");
  }
  const entries = Object.entries(manifest.checksums);
  if (!entries.some(([relativePath]) => relativePath === manifest.database)) {
    throw new Error("restore manifest database checksum missing");
  }
  for (const [relativePath, expectedHash] of entries) {
    if (!/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw new Error("restore manifest checksum is invalid");
    }
    const absolutePath = resolveManifestPath(manifestRoot, relativePath);
    const entryStat = await lstat(absolutePath).catch(() => null);
    if (!entryStat?.isFile() || entryStat.isSymbolicLink()) {
      throw new Error(`restore manifest file missing: ${relativePath}`);
    }
    const actualHash = await hashFile(absolutePath);
    if (actualHash !== expectedHash) {
      throw new Error(`restore manifest checksum mismatch: ${relativePath}`);
    }
  }
}

function resolveManifestPath(rootPath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("restore manifest path must be relative");
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("restore manifest path escapes staging");
  }
  const absolutePath = path.resolve(rootPath, normalized);
  const resolvedRoot = path.resolve(rootPath);
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("restore manifest path escapes staging");
  }
  return absolutePath;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const contents = await readFile(filePath);
  hash.update(contents);
  return hash.digest("hex");
}

function resticEnv(config: BackupConfig): NodeJS.ProcessEnv { return config.passwordFile ? { RESTIC_PASSWORD_FILE: config.passwordFile } : {}; }
async function runResticWithRetry(runner: ResticCommandRunner, args: string[], config: BackupConfig): Promise<{ stdout: string; stderr: string; code: number }> {
  let result = await runner.run(args, { env: resticEnv(config), timeoutMs: config.timeoutMs });
  for (let attempt = 0; result.code !== 0 && attempt < config.retryCount; attempt += 1) {
    result = await runner.run(args, { env: resticEnv(config), timeoutMs: config.timeoutMs });
  }
  return result;
}
function parseSnapshotIds(output: string): string[] {
  return output.split(/\r?\n/u).flatMap((line) => { try { const value = JSON.parse(line) as {id?: string; snapshot_id?: string}; const id = value.id ?? value.snapshot_id; return id ? [id] : []; } catch { return []; } });
}
function parseBackupStats(output: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const line of output.split(/\r?\n/u)) {
    try {
      const value = JSON.parse(line) as { message_type?: string; files_total?: number; total_files_processed?: number; total_bytes?: number; total_bytes_processed?: number };
      if (value.message_type === "summary") {
        files = value.files_total ?? value.total_files_processed ?? files;
        bytes = value.total_bytes ?? value.total_bytes_processed ?? bytes;
      }
    } catch {
      // Ignore non-JSON restic output; the run remains valid when a snapshot id is present.
    }
  }
  return { files, bytes };
}
function snapshotVisible(output: string, expected: string[]): boolean {
  try {
    const values = JSON.parse(output) as Array<{ id?: string }>;
    return expected.every((id) => values.some((value) => value.id === id));
  } catch {
    const text = output;
    return expected.every((id) => text.includes(id));
  }
}
async function createSqliteSnapshot(db: SigmaDatabase, destination: string): Promise<void> {
  const backup = (db as SigmaDatabase & { backup?: (destination: string) => Promise<void> }).backup;
  if (typeof backup === "function") { await backup.call(db, destination); return; }
  throw new Error("SQLite online backup is unavailable");
}
