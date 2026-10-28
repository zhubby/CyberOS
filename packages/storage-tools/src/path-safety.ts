import { realpath } from "node:fs/promises";
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
  const realPath = await realpath(absolutePath);

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

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toRootRelative(rootPath: string, candidatePath: string): string {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" ? "." : relative;
}
