import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}

export interface SafePathResult {
  rootRealPath: string;
  absolutePath: string;
  realPath: string;
  relativePath: string;
}

export async function resolveSafeExistingPath(
  rootPath: string,
  requestedPath = "."
): Promise<SafePathResult> {
  if (path.isAbsolute(requestedPath)) {
    throw new PathSafetyError("Absolute paths are not allowed inside a storage pool");
  }

  const rootRealPath = await realpath(rootPath);
  const absolutePath = path.resolve(rootRealPath, requestedPath || ".");
  assertNotManagedIscsiPath(absolutePath);
  const realPath = await realpath(absolutePath);
  assertNotManagedIscsiPath(realPath);

  if (!isPathInside(rootRealPath, realPath)) {
    throw new PathSafetyError("Path escapes the storage pool");
  }

  return {
    rootRealPath,
    absolutePath,
    realPath,
    relativePath: toRootRelative(rootRealPath, realPath)
  };
}

/** LUN images are managed only by hostd, including through path aliases. */
export function isManagedIscsiPath(candidatePath: string): boolean {
  const segments = path.resolve(candidatePath).split(path.sep);
  return segments.some((segment, index) => segment === ".cyberos" && segments[index + 1] === "iscsi");
}

export function assertNotManagedIscsiPath(candidatePath: string): void {
  if (isManagedIscsiPath(candidatePath)) {
    throw new PathSafetyError("Managed iSCSI images cannot be accessed as ordinary files");
  }
}

/** Check only the fixed pool image directory, without scanning ordinary NAS data. */
export async function assertNoManagedIscsiDescendants(candidatePath: string, workspaceRoot: string): Promise<void> {
  assertNotManagedIscsiPath(candidatePath);
  const candidates = [path.join(candidatePath, ".cyberos", "iscsi")];
  if (path.basename(candidatePath) === ".cyberos") candidates.push(path.join(candidatePath, "iscsi"));
  // Some callers use the data root as their workspace. Its immediate children
  // are pools, so a whole-workspace transfer must also check each pool.
  if (candidatePath === workspaceRoot && (await lstat(candidatePath)).isDirectory()) {
    for (const entry of await readdir(candidatePath, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(candidatePath, entry.name, ".cyberos", "iscsi"));
    }
  }
  for (const protectedPath of candidates) {
    try {
      await lstat(protectedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    throw new PathSafetyError("Cannot transfer an ancestor of managed iSCSI images");
  }
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toRootRelative(rootPath: string, candidatePath: string): string {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" ? "." : relative;
}
