import { access } from "node:fs/promises";
import path from "node:path";
import type { NasRootConfig, RootReadiness } from "@zos/shared";

export interface MountCommandRunner {
  run(command: string, args: string[]): Promise<string>;
}

class NodeMountCommandRunner implements MountCommandRunner {
  async run(command: string, args: string[]): Promise<string> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const result = await exec(command, args, { timeout: 5_000, maxBuffer: 1024 * 1024 });
    return result.stdout;
  }
}

export interface MountReadinessDependencies {
  commandRunner?: MountCommandRunner;
  now?: Date;
}

export async function checkMountReadiness(
  root: NasRootConfig,
  dependencies: MountReadinessDependencies = {}
): Promise<RootReadiness> {
  const checkedAt = (dependencies.now ?? new Date()).toISOString();
  const policy = root.mountPolicy ?? "optional";
  try {
    await access(root.path);
  } catch (error) {
    const reason = typeof error === "object" && error && (error as { code?: string }).code === "ENOENT"
      ? "path not found"
      : "path not accessible";
    return { rootId: root.id, status: "not_ready", checkedAt, reason, source: null, uuid: null, fstype: null };
  }

  if (policy === "optional") {
    return { rootId: root.id, status: "ready", checkedAt, reason: null, source: null, uuid: null, fstype: null };
  }

  const runner = dependencies.commandRunner ?? new NodeMountCommandRunner();
  let output: string;
  try {
    output = await runner.run("findmnt", ["--json", "--target", root.path, "--output", "SOURCE,UUID,FSTYPE,TARGET"]);
  } catch {
    return { rootId: root.id, status: "unknown", checkedAt, reason: "findmnt unavailable", source: null, uuid: null, fstype: null };
  }

  const identity = parseFindmnt(output);
  if (!identity) {
    return { rootId: root.id, status: "unknown", checkedAt, reason: "unable to parse mount identity", source: null, uuid: null, fstype: null };
  }
  const rootPath = path.resolve(root.path);
  const targetPath = identity.target ? path.resolve(identity.target) : null;
  const mountNotCoveringRoot = !targetPath ||
    (rootPath !== targetPath && !rootPath.startsWith(`${targetPath}${path.sep}`));
  const mismatch = mountNotCoveringRoot
    || (root.expectedSource && root.expectedSource !== identity.source)
    || (root.expectedUuid && root.expectedUuid !== identity.uuid)
    || (root.expectedFstype && root.expectedFstype !== identity.fstype);
  return {
    rootId: root.id,
    status: mismatch ? "not_ready" : "ready",
    checkedAt,
    reason: mismatch
      ? mountNotCoveringRoot
        ? "path is not covered by a dedicated mount"
        : "mount identity mismatch"
      : null,
    source: identity.source,
    uuid: identity.uuid,
    fstype: identity.fstype
  };
}

function parseFindmnt(output: string): { source: string | null; uuid: string | null; fstype: string | null; target: string | null } | null {
  try {
    const parsed = JSON.parse(output) as { filesystems?: Array<{ source?: string; uuid?: string; fstype?: string; target?: string }> };
    const row = parsed.filesystems?.[0];
    if (row) return { source: row.source ?? null, uuid: row.uuid ?? null, fstype: row.fstype ?? null, target: row.target ?? null };
  } catch {
    // Some findmnt versions emit a table despite --json; accept a simple line.
  }
  const line = output.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
  if (!line || /^SOURCE\s/u.test(line)) return null;
  const parts = line.split(/\s+/u);
  return { source: parts[0] ?? null, uuid: parts[1] ?? null, fstype: parts[2] ?? null, target: parts[3] ?? null };
}
