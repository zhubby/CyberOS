import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getNasRoot, listNasRoots, type CyberOsDatabase } from "@cyberos/db";
import { isPathInside } from "@cyberos/nas-tools";
import type { NasRootRecord } from "@cyberos/shared";

export function resolveRoot(db: CyberOsDatabase, rootId: string | undefined) {
  if (rootId) {
    return getNasRoot(db, rootId);
  }

  return listNasRoots(db)[0] ?? null;
}

export async function withHomePath(root: NasRootRecord): Promise<NasRootRecord & { homePath: string | null }> {
  return {
    ...root,
    homePath: await resolveHomePath(root.path)
  };
}

async function resolveHomePath(rootPath: string): Promise<string | null> {
  try {
    const [rootRealPath, homeRealPath] = await Promise.all([realpath(rootPath), realpath(os.homedir())]);
    if (!isPathInside(rootRealPath, homeRealPath)) {
      return null;
    }
    return path.relative(rootRealPath, homeRealPath) || ".";
  } catch {
    return null;
  }
}
