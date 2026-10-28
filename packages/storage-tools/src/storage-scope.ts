import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  isPathInside,
  resolveSafeExistingPath,
  type SafePathResult
} from "./path-safety.js";
import { resolveSafeTargetPath } from "./mutation-tools.js";

export class StorageScopeSafetyError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "StorageScopeSafetyError";
  }
}

export interface SafeStorageScope {
  rootPath: string;
  rootRealPath: string;
  mountpointRealPath: string;
  mountpointPath: string;
  nestedMountpointRealPaths: string[];
}

export async function createSafeStorageScope(input: {
  rootPath: string;
  mountpointPath: string;
  siblingMountpointPaths?: string[];
}): Promise<SafeStorageScope> {
  let rootRealPath: string;
  let mountpointRealPath: string;
  try {
    const mountEntry = await lstat(input.mountpointPath);
    if (mountEntry.isSymbolicLink() || !mountEntry.isDirectory()) {
      throw new Error("not a real directory");
    }
    rootRealPath = await realpath(input.rootPath);
    mountpointRealPath = await realpath(input.mountpointPath);
  } catch {
    throw new StorageScopeSafetyError("Storage pool is not mounted", 404);
  }

  if (!isPathInside(rootRealPath, mountpointRealPath)) {
    throw new StorageScopeSafetyError("Storage pool is outside the CyberOS data namespace", 403);
  }

  try {
    const mountStat = await stat(mountpointRealPath);
    if (!mountStat.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new StorageScopeSafetyError("Storage pool is not mounted", 404);
  }

  const nestedMountpointRealPaths: string[] = [];
  for (const candidatePath of input.siblingMountpointPaths ?? []) {
    if (!candidatePath || candidatePath === input.mountpointPath) {
      continue;
    }
    try {
      const candidateRealPath = await realpath(candidatePath);
      if (isPathInside(mountpointRealPath, candidateRealPath) && candidateRealPath !== mountpointRealPath) {
        nestedMountpointRealPaths.push(candidateRealPath);
      }
    } catch {
      // Unavailable sibling pools are not accessible boundaries.
    }
  }

  return {
    rootPath: input.rootPath,
    rootRealPath,
    mountpointRealPath,
    mountpointPath: path.relative(rootRealPath, mountpointRealPath) || ".",
    nestedMountpointRealPaths
  };
}

export async function resolveStorageScopeExistingPath(
  scope: SafeStorageScope,
  requestedPath: string
): Promise<SafePathResult> {
  rejectStorageScopePathSyntax(requestedPath);
  const safe = await resolveSafeExistingPath(scope.rootPath, requestedPath);
  assertPathInsideStorageScope(scope, safe.realPath);
  return safe;
}

export async function resolveStorageScopeTargetPath(
  scope: SafeStorageScope,
  requestedPath: string
): Promise<Awaited<ReturnType<typeof resolveSafeTargetPath>>> {
  rejectStorageScopePathSyntax(requestedPath);
  const safe = await resolveSafeTargetPath(scope.rootPath, requestedPath);
  assertPathInsideStorageScope(scope, safe.absolutePath);
  await assertNoSymlinkPathSegments(scope.rootRealPath, safe.absolutePath);
  return safe;
}

export function assertPathInsideStorageScope(scope: SafeStorageScope, absolutePath: string): void {
  if (!isPathInside(scope.mountpointRealPath, absolutePath)) {
    throw new StorageScopeSafetyError("Path is outside the selected storage pool", 403);
  }
  if (scope.nestedMountpointRealPaths.some((nestedPath) => isPathInside(nestedPath, absolutePath))) {
    throw new StorageScopeSafetyError("Path belongs to another mounted storage pool", 403);
  }
}

export async function assertNoSymlinkPathSegments(rootRealPath: string, absolutePath: string): Promise<void> {
  const relativePath = path.relative(rootRealPath, absolutePath);
  let currentPath = rootRealPath;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    try {
      const entry = await lstat(currentPath);
      if (entry.isSymbolicLink()) {
        throw new StorageScopeSafetyError("Refusing to access through a symlink", 400);
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
  }
}

export function rejectStorageScopePathSyntax(requestedPath: string): void {
  const normalized = requestedPath.replaceAll("\\", "/");
  if (
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new StorageScopeSafetyError("Path must stay inside the selected storage pool", 400);
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
