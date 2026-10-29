import { createHash, randomUUID } from "node:crypto";
import { access, constants as fsConstants, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acquireExecutionLock,
  defaultBackupSettings,
  finishBackupRun,
  heartbeatExecutionLock,
  getBackupSettings,
  isExecutionLockOwner,
  listBackupRuns,
  recordBackupFailure,
  releaseExecutionLock,
  startBackupRun,
  type CyberOsDatabase
} from "@cyberos/db";
import {
  type BackupConfig,
  type BackupSettingsRecord,
  type BackupRunKind,
  type BackupRunSummary,
  type CyberOsRuntime
} from "@cyberos/shared";
import { summarizeResticOutput, SystemResticRunner, type ResticCommandRunner } from "./restic.js";

export interface BackupDependencies {
  db: CyberOsDatabase;
  config: CyberOsRuntime;
  restic?: ResticCommandRunner;
  mountInfo?: string;
}

export interface DisasterRestoreDependencies {
  config: CyberOsRuntime;
  repositoryPath: string;
  passwordFile: string;
  snapshot: string;
  restic?: ResticCommandRunner;
}

const BACKUP_LOCK_NAME = "backup";

export function backupRuntimeFromSettings(
  config: CyberOsRuntime,
  settings: BackupSettingsRecord
): CyberOsRuntime {
  return {
    ...config,
    backup: {
      ...config.backup,
      enabled: settings.enabled,
      repositoryPath: settings.repositoryPath,
      passwordFile: config.paths.backupPasswordPath,
      requireMount: settings.requireMount,
      keepDaily: settings.keepDaily,
      keepWeekly: settings.keepWeekly
    }
  };
}

export function loadBackupRuntime(db: CyberOsDatabase, config: CyberOsRuntime): CyberOsRuntime {
  const settings = getBackupSettings(db) ?? defaultBackupSettings(
    config.paths.backupRoot,
    config.environment === "production"
  );
  return backupRuntimeFromSettings(config, settings);
}

export function shouldSkipScheduledBackup(config: CyberOsRuntime, command: string | undefined): boolean {
  return command === "run" && !config.backup.enabled;
}

export async function validateBackup(input: BackupDependencies): Promise<{ ok: boolean; issues: string[] }> {
  const config = input.config.backup;
  if (!config.enabled) return { ok: true, issues: [] };
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
    await assertBackupMountsReady(input).catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : "backup mounts are unavailable");
    });
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
  await assertBackupMountsReady(input, false);
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
  const failures: Array<{ storagePoolId: string; reason: string }> = [];
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
    const dataRoot = input.config.paths.dataRoot;
    await assertBackupMountsReady(input);
    const dataRootStat = await stat(dataRoot);
    if (!dataRootStat.isDirectory()) throw new Error("CyberOS data root is not a directory");
    await mkdir(config.stagingPath, { recursive: true });
    const runStaging = await mkdtemp(path.join(config.stagingPath, `run-${run.id}-`));
    staging = runStaging;
    await createSqliteSnapshot(input.db, path.join(runStaging, "cyberos.sqlite"));
    const trashPath = path.join(input.config.paths.stateDir, "trash");
    await access(trashPath).then(() => copyTreeNoSymlinks(trashPath, path.join(runStaging, "trash"))).catch(() => undefined);
    const manifest = await createManifest(run.id, dataRoot, runStaging);
    await writeFile(path.join(runStaging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const snapshotIds: string[] = [];
    let backupStats = { files: 0, bytes: 0 };
    ensureLease();
    const dataResult = await runResticWithRetry(
      runner,
      ["backup", "--json", "--repo", config.repositoryPath!, "--tag", kind, "--exclude", "*/.cyberos/iscsi", dataRoot],
      config
    );
    if (dataResult.code !== 0) {
      const reason = summarizeResticOutput(dataResult.stderr || dataResult.stdout) || "restic data backup failed";
      recordBackupFailure(input.db, { runId: run.id, path: dataRoot, code: "RESTIC_BACKUP_FAILED", reason });
      throw new Error(reason);
    }
    const dataSnapshotIds = parseSnapshotIds(dataResult.stdout);
    if (!dataSnapshotIds.length) {
      const reason = "restic data backup did not return a snapshot id";
      recordBackupFailure(input.db, { runId: run.id, path: dataRoot, code: "SNAPSHOT_ID_MISSING", reason });
      throw new Error(reason);
    }
    snapshotIds.push(...dataSnapshotIds);
    const dataStats = parseBackupStats(dataResult.stdout);
    backupStats = { files: dataStats.files, bytes: dataStats.bytes };
    ensureLease();
    const stateResult = await runResticWithRetry(runner, ["backup", "--json", "--repo", config.repositoryPath!, "--tag", kind, runStaging], config);
    if (stateResult.code !== 0) {
      const reason = `restic state backup failed: ${summarizeResticOutput(stateResult.stderr || stateResult.stdout)}`;
      recordBackupFailure(input.db, { runId: run.id, path: "cyberos-state", code: "STATE_SNAPSHOT_FAILED", reason });
      throw new Error(reason);
    }
    const stateSnapshotIds = parseSnapshotIds(stateResult.stdout);
    if (!stateSnapshotIds.length) {
      const reason = "restic state backup did not return a snapshot id";
      recordBackupFailure(input.db, { runId: run.id, path: "cyberos-state", code: "SNAPSHOT_ID_MISSING", reason });
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
    await assertBackupMountsReady(input, false);
    await access(config.repositoryPath ?? "", fsConstants.R_OK | fsConstants.W_OK);
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

export async function restoreBackup(input: DisasterRestoreDependencies): Promise<{ stagingPath: string; verified: boolean }> {
  if (!path.isAbsolute(input.passwordFile)) throw new Error("Restore password file must be an absolute path");
  if (!input.repositoryPath.trim()) throw new Error("Restore repository is required");
  if (!input.snapshot.trim()) throw new Error("Restore snapshot is required");
  const passwordMetadata = await stat(input.passwordFile);
  if (!passwordMetadata.isFile()) throw new Error("Restore password file must be a regular file");
  await access(input.passwordFile, fsConstants.R_OK);
  const runtime: CyberOsRuntime = {
    ...input.config,
    backup: {
      ...input.config.backup,
      enabled: true,
      repositoryPath: input.repositoryPath,
      passwordFile: input.passwordFile,
      requireMount: false
    }
  };
  const config = requireBackupConfig(runtime);
  const pathIssues = validateBackupPaths(runtime);
  if (pathIssues.length) throw new Error(pathIssues.join("; "));
  const runner = input.restic ?? new SystemResticRunner();
  let stagingPath = "";
  try {
    const check = await runResticWithRetry(runner, ["check", "--repo", config.repositoryPath ?? ""], config);
    if (check.code !== 0) {
      const reason = `repository check failed: ${summarizeResticOutput(check.stderr || check.stdout)}`;
      throw new Error(reason);
    }
    await mkdir(config.stagingPath, { recursive: true });
    stagingPath = await mkdtemp(path.join(config.stagingPath, "restore-"));
    const dryRun = await runResticWithRetry(runner, ["restore", input.snapshot, "--dry-run", "--repo", config.repositoryPath ?? "", "--target", stagingPath], config);
    if (dryRun.code !== 0) {
      const reason = `restore dry-run failed: ${summarizeResticOutput(dryRun.stderr || dryRun.stdout)}`;
      throw new Error(reason);
    }
    const result = await runResticWithRetry(runner, ["restore", input.snapshot, "--repo", config.repositoryPath ?? "", "--target", stagingPath], config);
    if (result.code !== 0) {
      const reason = `restore failed: ${summarizeResticOutput(result.stderr || result.stdout)}`;
      throw new Error(reason);
    }
    const manifestPath = await findManifest(stagingPath);
    if (!manifestPath) throw new Error("restore manifest not found");
    const manifestRoot = path.dirname(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
    await validateManifest(manifest, manifestRoot, runtime);
    return { stagingPath, verified: true };
  } catch (error) {
    if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

export function listBackups(db: CyberOsDatabase): BackupRunSummary[] { return listBackupRuns(db, 30); }

function requireBackupConfig(config: CyberOsRuntime): BackupConfig {
  if (!config.backup.enabled) throw new Error("Backup is disabled");
  return config.backup;
}

function validateBackupPaths(config: CyberOsRuntime): string[] {
  const backup = config.backup;
  if (!backup.enabled) return [];
  if (!backup.repositoryPath) return ["repository not configured"];
  const repositoryPath = path.resolve(backup.repositoryPath);
  const stagingPath = path.resolve(backup.stagingPath);
  const dataDir = path.resolve(config.paths.stateDir);
  const dataRoot = path.resolve(config.paths.dataRoot);
  const overlaps = (first: string, second: string): boolean =>
    first === second || first.startsWith(`${second}${path.sep}`) || second.startsWith(`${first}${path.sep}`);
  const issues: string[] = [];
  if (overlaps(repositoryPath, dataDir)) issues.push("backup repository must not overlap dataDir");
  if (overlaps(repositoryPath, stagingPath)) issues.push("backup repository must not overlap staging path");
  if (overlaps(repositoryPath, dataRoot)) issues.push("backup repository must not overlap data root");
  if (overlaps(stagingPath, dataRoot)) issues.push("backup staging path must not overlap data root");
  return issues;
}

async function assertBackupMountsReady(
  input: BackupDependencies,
  includeStoragePools = true
): Promise<void> {
  const backup = requireBackupConfig(input.config);
  if (!backup.requireMount) return;
  if (!backup.repositoryPath) throw new Error("Backup repository is not configured");

  const mountInfo = input.mountInfo ?? await readLinuxMountInfo();
  const mounted = parseMountedPaths(mountInfo);
  await assertExactMount(backup.repositoryPath, mounted, "Backup repository");
  if (!includeStoragePools) return;

  const dataRoot = input.config.paths.dataRoot;
  const entries = await readdir(dataRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Storage pool must be a real directory: ${entry.name}`);
    }
    if (!entry.isDirectory()) continue;
    await assertExactMount(path.join(dataRoot, entry.name), mounted, `Storage pool ${entry.name}`);
  }
}

async function readLinuxMountInfo(): Promise<string> {
  if (process.platform !== "linux") {
    throw new Error("Production backup mount verification requires Linux");
  }
  return readFile("/proc/self/mountinfo", "utf8");
}

function parseMountedPaths(mountInfo: string): Set<string> {
  return new Set(mountInfo.split("\n").flatMap((line) => {
    const mountpoint = line.split(" ")[4];
    return mountpoint ? [path.resolve(unescapeMountInfo(mountpoint))] : [];
  }));
}

async function assertExactMount(
  target: string,
  mounted: ReadonlySet<string>,
  label: string
): Promise<void> {
  const metadata = await lstat(target).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const resolved = await realpath(target);
  if (!mounted.has(resolved) && !mounted.has(path.resolve(target))) {
    throw new Error(`${label} is not mounted`);
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

interface BackupManifest {
  version: 2;
  runId: string;
  createdAt: string;
  dataRoot: string;
  database: "cyberos.sqlite";
  checksums: Record<string, string>;
}

async function createManifest(
  runId: string,
  dataRoot: string,
  stagingPath: string
): Promise<BackupManifest> {
  return {
    version: 2,
    runId,
    createdAt: new Date().toISOString(),
    dataRoot: path.resolve(dataRoot),
    database: "cyberos.sqlite",
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
          const value = JSON.parse(await readFile(absolutePath, "utf8")) as { version?: number; dataRoot?: string; database?: string };
          if (typeof value.version === "number" && value.database === "cyberos.sqlite") {
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

async function validateManifest(manifest: BackupManifest, manifestRoot: string, config: CyberOsRuntime): Promise<void> {
  if (manifest.version !== 2 || !manifest.runId || typeof manifest.dataRoot !== "string" || manifest.database !== "cyberos.sqlite") {
    throw new Error("restore manifest validation failed");
  }
  if (path.resolve(manifest.dataRoot) !== path.resolve(config.paths.dataRoot)) {
    throw new Error("restore manifest data root mismatch");
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
async function createSqliteSnapshot(db: CyberOsDatabase, destination: string): Promise<void> {
  const backup = (db as CyberOsDatabase & { backup?: (destination: string) => Promise<void> }).backup;
  if (typeof backup === "function") { await backup.call(db, destination); return; }
  throw new Error("SQLite online backup is unavailable");
}
