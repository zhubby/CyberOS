import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { BackupDirectoryListing, CyberOsRuntime } from "@cyberos/shared";
import { isPathInside, PathSafetyError, resolveSafeExistingPath } from "@cyberos/storage-tools";

const BACKUP_FILESYSTEMS = new Set(["ext4", "ext3", "ext2", "btrfs", "xfs", "zfs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "nfs", "nfs4", "cifs"]);
const SYSTEM_DIRECTORIES = ["/boot", "/dev", "/etc", "/proc", "/sys", "/usr", "/var", "/home"];
const unescapeMountPath = (value: string) => value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

export async function listBackupDirectories(
  config: CyberOsRuntime,
  repositoryPath: string,
  query: { root?: string; path?: string } = {},
  mountInfo?: string
): Promise<BackupDirectoryListing> {
  const mounts = mountInfo ?? (process.platform === "linux" ? await readFile("/proc/self/mountinfo", "utf8") : "");
  const mountedPaths = mounts.split("\n").flatMap((line) => {
    const [fields, filesystemFields] = line.split(" - ");
    const [, , device, root, target] = fields?.split(" ") ?? [];
    const filesystem = filesystemFields?.split(" ")[0];
    return device && root && target && filesystem
      ? [{ device, root: unescapeMountPath(root), target: unescapeMountPath(target), filesystem }] : [];
  });
  const candidates = new Map<string, string | null>([
    [config.paths.backupRoot, null],
    [repositoryPath, null]
  ]);
  for (const { target, filesystem } of mountedPaths) {
    if (!BACKUP_FILESYSTEMS.has(filesystem) || target === "/") continue;
    if (SYSTEM_DIRECTORIES.some((directory) => isPathInside(directory, target))) continue;
    candidates.set(target, filesystem);
  }

  const protectedPaths = await Promise.all([
    config.paths.dataRoot, config.paths.stateDir, config.backup.stagingPath,
    config.paths.appsRoot, config.paths.systemBackupsDir, config.paths.deployRoot
  ].map(async (directory) => realpath(directory).catch(() => path.resolve(directory))));
  const filesystemLocation = (directory: string) => {
    const mount = mountedPaths.filter((entry) => isPathInside(entry.target, directory))
      .sort((first, second) => second.target.length - first.target.length)[0];
    return mount ? { device: mount.device, path: path.resolve(mount.root, path.relative(mount.target, directory)) } : null;
  };
  // Bind mounts and a filesystem mounted twice must not make NAS/state paths
  // appear to be independent backup destinations.
  const protectedLocations = [
    ...protectedPaths,
    ...mountedPaths.filter((entry) => protectedPaths.some((directory) => isPathInside(directory, entry.target))).map((entry) => entry.target)
  ].map(filesystemLocation).filter((location) => location !== null);
  const allowed = (directory: string) => {
    if (directory === path.parse(directory).root || protectedPaths.some((protectedPath) => isPathInside(protectedPath, directory) || isPathInside(directory, protectedPath))) return false;
    const location = filesystemLocation(directory);
    return !location || !protectedLocations.some((protectedLocation) => protectedLocation.device === location.device
      && (isPathInside(protectedLocation.path, location.path) || isPathInside(location.path, protectedLocation.path)));
  };
  const roots = new Map<string, BackupDirectoryListing["roots"][number]>();
  for (const [candidate, filesystem] of candidates) {
    if (!path.isAbsolute(candidate) || !allowed(path.resolve(candidate))) continue;
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
      const root = await realpath(candidate);
      if (!allowed(root)) continue;
      await access(root, constants.R_OK | constants.X_OK);
      roots.set(root, { id: root, name: path.basename(root), path: root, filesystem });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  const result: BackupDirectoryListing = { roots: [...roots.values()], entries: [] };
  if (query.root === undefined && query.path === undefined) return result;
  const root = typeof query.root === "string" ? roots.get(query.root) : undefined;
  if (!root || typeof query.path !== "string" || !path.isAbsolute(query.path) || query.path.includes("\0")) {
    throw new PathSafetyError("Choose a directory inside an available backup location");
  }
  const requestedPath = path.resolve(query.path);
  if (!isPathInside(root.path, requestedPath) || !allowed(requestedPath)) {
    throw new PathSafetyError("Backup directory is outside the selected location");
  }
  const safe = await resolveSafeExistingPath(root.path, path.relative(root.path, requestedPath));
  if (safe.realPath !== requestedPath || !allowed(safe.realPath)) {
    throw new PathSafetyError("Backup directories must not use symbolic links or protected paths");
  }
  const entries = await readdir(safe.realPath, { withFileTypes: true });
  for (const entry of entries) {
    const directory = path.join(safe.realPath, entry.name);
    if (!entry.isDirectory() || !allowed(directory)) continue;
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    result.entries.push({ name: entry.name, path: directory, kind: "directory", sizeBytes: 0, modifiedAt: metadata.mtime.toISOString(), isSafe: true });
  }
  result.entries.sort((first, second) => first.name.localeCompare(second.name));
  return result;
}
