import { lstatSync, readFileSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import path from "node:path";
import { CapabilityError } from "@cyberos/capabilities";
import { isPathInside } from "@cyberos/storage-tools";
import { type CyberOsConfig, type StorageWorkspace } from "@cyberos/shared";

export interface ResolvedStoragePool extends StorageWorkspace {
  id: string;
}

export function listStoragePools(config: CyberOsConfig): ResolvedStoragePool[] {
  const dataRoot = config.paths.dataRoot;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dataRoot, { withFileTypes: true });
  } catch (error) {
    throw new CapabilityError("NOT_READY", "Storage namespace is unavailable", { cause: error, retryable: true });
  }
  const mounts = config.environment === "production" ? mountedPaths() : null;
  return entries.flatMap((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
    try {
      const pool = requireStoragePool(config, entry.name);
      return mounts && !mounts.has(pool.path) ? [] : [pool];
    } catch {
      return [];
    }
  }).sort((left, right) => left.id.localeCompare(right.id));
}

export function requireStoragePool(config: CyberOsConfig, storagePoolId: string): ResolvedStoragePool {
  const id = normalizeStoragePoolId(storagePoolId);
  const dataRoot = config.paths.dataRoot;
  const poolPath = path.join(dataRoot, id);
  let dataRootRealPath: string;
  let poolRealPath: string;
  try {
    const metadata = lstatSync(poolPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new CapabilityError("FORBIDDEN", "Storage pool must be a real directory");
    }
    dataRootRealPath = realpathSync(dataRoot);
    poolRealPath = realpathSync(poolPath);
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("NOT_READY", "Storage pool is unavailable", { cause: error, retryable: true });
  }
  const expectedPoolPath = path.join(dataRootRealPath, id);
  if (
    poolRealPath !== expectedPoolPath
    || !isPathInside(dataRootRealPath, poolRealPath)
    || poolRealPath === dataRootRealPath
  ) {
    throw new CapabilityError("FORBIDDEN", "Storage pool escapes the data namespace");
  }
  if (config.environment === "production" && !mountedPaths().has(poolRealPath)) {
    throw new CapabilityError("NOT_READY", "Storage pool is not mounted", { retryable: true });
  }
  return { id, path: poolRealPath };
}

function normalizeStoragePoolId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 128 || id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new CapabilityError("INVALID_ARGUMENT", "storagePoolId must be a direct child name of the data namespace");
  }
  return id;
}

function mountedPaths(): Set<string> {
  let mountInfo: string;
  try {
    mountInfo = readFileSync("/proc/self/mountinfo", "utf8");
  } catch (error) {
    throw new CapabilityError("NOT_READY", "Storage mount inventory is unavailable", { cause: error, retryable: true });
  }
  return new Set(mountInfo.split("\n").flatMap((line) => {
    const fields = line.split(" ");
    const mountpoint = fields[4];
    if (!mountpoint) return [];
    try {
      return [realpathSync(unescapeMountInfo(mountpoint))];
    } catch {
      return [];
    }
  }));
}

function unescapeMountInfo(value: string): string {
  return value.replace(/\\(040|011|012|134)/gu, (_match, code: string) => ({
    "040": " ",
    "011": "\t",
    "012": "\n",
    "134": "\\"
  })[code]!);
}
