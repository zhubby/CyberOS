import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getNasRoot, listNasRoots, type ZosDatabase } from "@zos/db";
import { isPathInside } from "@zos/nas-tools";
import type { NasRootRecord } from "@zos/shared";

export function resolveRoot(db: ZosDatabase, rootId: string | undefined) {
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
