import { getNasRoot, type CyberOsDatabase } from "@cyberos/db";
import type { NasRootRecord, SystemStoragePool } from "@cyberos/shared";
import {
  StorageScopeSafetyError,
  assertNoSymlinkPathSegments,
  assertPathInsideStorageScope,
  createSafeStorageScope,
  resolveStorageScopeExistingPath,
  resolveStorageScopeTargetPath,
  type SafeStorageScope,
  type SafePathResult
} from "@cyberos/nas-tools";
import type { SystemManagementDependencies } from "./system-management.js";
import { collectSystemStorage } from "./system-management.js";

const storageSummaryCache = new WeakMap<
  object,
  Promise<Awaited<ReturnType<typeof collectSystemStorage>>>
>();

export class StorageScopeError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "StorageScopeError";
  }
}

export interface StoragePoolScope {
  root: NasRootRecord;
  pool: SystemStoragePool;
  rootRealPath: string;
  mountpointRealPath: string;
  mountpointPath: string;
  nestedMountpointRealPaths: string[];
}

export async function resolveStoragePoolScope(
  db: CyberOsDatabase,
  system: SystemManagementDependencies | undefined,
  rootId: string | undefined,
  storagePoolId: string | undefined
): Promise<StoragePoolScope> {
  if (typeof storagePoolId !== "string" || !storagePoolId.trim()) {
    throw new StorageScopeError("Storage pool selection is required", 400);
  }

  const root = rootId ? getNasRoot(db, rootId) : null;
  if (!root) {
    throw new StorageScopeError("NAS root not found", 404);
  }
  if (!system) {
    throw new StorageScopeError("Storage pool inventory is unavailable", 503);
  }

  const summary = await getStorageSummary(system);
  const pool = summary.pools.find((candidate) => candidate.id === storagePoolId);
  if (!pool || !pool.mountpoint) {
    throw new StorageScopeError("Storage pool is not mounted", 404);
  }
  const mountpointPath = pool.mountpoint;

  const safeScope = await withStorageScopeError(() =>
    createSafeStorageScope({
      rootPath: root.path,
      mountpointPath,
      siblingMountpointPaths: summary.pools
        .filter((candidate) => candidate.id !== pool.id)
        .map((candidate) => candidate.mountpoint)
        .filter((candidate): candidate is string => Boolean(candidate))
    })
  );

  return {
    root,
    pool,
    rootRealPath: safeScope.rootRealPath,
    mountpointRealPath: safeScope.mountpointRealPath,
    mountpointPath: safeScope.mountpointPath,
    nestedMountpointRealPaths: safeScope.nestedMountpointRealPaths
  };
}

async function getStorageSummary(system: SystemManagementDependencies): Promise<Awaited<ReturnType<typeof collectSystemStorage>>> {
  const cached = storageSummaryCache.get(system);
  if (cached) {
    return await cached;
  }

  const promise = collectSystemStorage(system);
  storageSummaryCache.set(system, promise);
  try {
    return await promise;
  } finally {
    if (storageSummaryCache.get(system) === promise) {
      storageSummaryCache.delete(system);
    }
  }
}

export async function resolveScopedExistingPath(
  scope: StoragePoolScope,
  requestedPath: string
): Promise<SafePathResult> {
  return await withStorageScopeError(() => resolveStorageScopeExistingPath(toSafeScope(scope), requestedPath));
}

export async function resolveScopedTargetPath(
  scope: StoragePoolScope,
  requestedPath: string
): Promise<Awaited<ReturnType<typeof resolveStorageScopeTargetPath>>> {
  return await withStorageScopeError(() => resolveStorageScopeTargetPath(toSafeScope(scope), requestedPath));
}

export function assertPathInsideStoragePool(scope: StoragePoolScope, absolutePath: string): void {
  try {
    assertPathInsideStorageScope(toSafeScope(scope), absolutePath);
  } catch (error) {
    if (error instanceof StorageScopeSafetyError) {
      throw new StorageScopeError(error.message, error.statusCode);
    }
    throw error;
  }
}

export async function validateStoragePoolProposal(
  scope: StoragePoolScope,
  proposal: { sourcePath?: string; targetPath?: string }
): Promise<void> {
  for (const candidatePath of [proposal.sourcePath, proposal.targetPath]) {
    if (!candidatePath) {
      continue;
    }
    const target = await resolveScopedTargetPath(scope, candidatePath);
    try {
      await resolveScopedExistingPath(scope, candidatePath);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }
    await withStorageScopeError(() => assertNoSymlinkPathSegments(scope.rootRealPath, target.absolutePath));
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function toSafeScope(scope: StoragePoolScope): SafeStorageScope {
  return {
    rootPath: scope.root.path,
    rootRealPath: scope.rootRealPath,
    mountpointRealPath: scope.mountpointRealPath,
    mountpointPath: scope.mountpointPath,
    nestedMountpointRealPaths: scope.nestedMountpointRealPaths
  };
}

async function withStorageScopeError<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof StorageScopeSafetyError) {
      throw new StorageScopeError(error.message, error.statusCode);
    }
    throw error;
  }
}
