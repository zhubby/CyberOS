#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MIGRATION_DIRECTORY_PATTERN = /^legacy-sigmaos-[0-9]{8}T[0-9]{6}Z\.[A-Za-z0-9]+$/u;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;

export function findRolledBackMigration(root, requiredUid = 0) {
  const candidates = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !MIGRATION_DIRECTORY_PATTERN.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== requiredUid ||
          (directoryStat.mode & 0o777) !== 0o700) continue;
      const statePath = path.join(directory, "state.env");
      const statusPath = path.join(directory, "status.json");
      const stateStat = fs.lstatSync(statePath);
      const statusStat = fs.lstatSync(statusPath);
      if (!stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.uid !== requiredUid ||
          !statusStat.isFile() || statusStat.isSymbolicLink() || statusStat.uid !== requiredUid) continue;
      const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      if (status.status !== "rolled_back" || status.backupPath !== directory) continue;
      const backup = status.coldBackup;
      const backupPath = backup?.legacyPath;
      if (typeof backupPath !== "string" || typeof backup?.sizeBytes !== "number" ||
          !Number.isSafeInteger(backup.sizeBytes) || backup.sizeBytes < 1 ||
          typeof backup.sha256 !== "string" || !CHECKSUM_PATTERN.test(backup.sha256)) continue;
      const allowed = backupPath === `${directory}/state.tar` ||
        /^\/(?:srv|zos\/data)\/.+\/\.zos\/system-backups\/legacy-sigmaos-[^/]+\/state\.tar$/u.test(backupPath);
      if (!allowed) continue;
      const backupStat = fs.lstatSync(backupPath);
      if (!backupStat.isFile() || backupStat.isSymbolicLink() || backupStat.size !== backup.sizeBytes) continue;
      candidates.push({ directory, updatedAt: Date.parse(status.updatedAt ?? "") || statusStat.mtimeMs });
    } catch {
      // Incomplete attempts remain available for diagnosis but cannot become active state.
    }
  }
  candidates.sort((left, right) => right.updatedAt - left.updatedAt || right.directory.localeCompare(left.directory));
  return candidates[0]?.directory;
}

export function activeMountedBackupPath(serializedPayload) {
  const payload = JSON.parse(serializedPayload || "{}");
  const backup = payload.coldBackup;
  if (!backup || backup.storage !== "mounted" ||
      !["pending", "committed", "rolled_back"].includes(payload.status)) return undefined;
  const activePath = payload.status === "rolled_back" ? backup.legacyPath : backup.migratedPath;
  if (typeof activePath !== "string") throw new Error("mounted migration backup path is invalid");
  return activePath;
}

function run() {
  const [action, value] = process.argv.slice(2);
  if (action === "find-rolled-back") {
    const candidate = findRolledBackMigration(value);
    if (candidate) process.stdout.write(candidate);
    return;
  }
  if (action === "active-mounted-backup") {
    const activePath = activeMountedBackupPath(value);
    if (activePath) process.stdout.write(activePath);
    return;
  }
  throw new Error("usage: zos-migration-recovery.mjs <find-rolled-back|active-mounted-backup> <value>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) run();
