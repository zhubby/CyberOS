import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BuildSource, PublicBuildInfo } from "@cyberos/shared";

const BUILD_SOURCES = new Set<BuildSource>(["release", "ci", "local", "unknown"]);

export async function loadBuildInfo({
  configuredPath = process.env.CYBEROS_BUILD_INFO_PATH,
  cwd = process.cwd()
}: {
  configuredPath?: string;
  cwd?: string;
} = {}): Promise<PublicBuildInfo> {
  const candidates = uniquePaths([
    configuredPath,
    path.resolve(cwd, ".cyberos/build-info.json"),
    path.resolve(cwd, "../../.cyberos/build-info.json"),
    path.resolve(cwd, "build-info.json"),
    "/usr/lib/cyberos/build-info.json"
  ]);

  for (const candidate of candidates) {
    try {
      const parsed = parseBuildInfo(JSON.parse(await readFile(candidate, "utf8")));
      if (parsed) return parsed;
    } catch {
      // Missing or malformed build metadata must not prevent appliance startup.
    }
  }

  return unknownBuildInfo(await readFallbackVersion(cwd));
}

export function unknownBuildInfo(version = "unknown"): PublicBuildInfo {
  return {
    version,
    commitSha: null,
    commitShortSha: null,
    tag: null,
    branch: null,
    builtAt: null,
    source: "unknown",
    dirty: null,
    reproducible: false
  };
}

export function parseBuildInfo(value: unknown): PublicBuildInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.version !== "string" ||
    !isNullableString(candidate.commitSha) ||
    !isNullableString(candidate.commitShortSha) ||
    !isNullableString(candidate.tag) ||
    !isNullableString(candidate.branch) ||
    !isNullableTimestamp(candidate.builtAt) ||
    typeof candidate.source !== "string" ||
    !BUILD_SOURCES.has(candidate.source as BuildSource) ||
    !isNullableBoolean(candidate.dirty) ||
    typeof candidate.reproducible !== "boolean"
  ) {
    return null;
  }

  return {
    version: candidate.version,
    commitSha: candidate.commitSha,
    commitShortSha: candidate.commitShortSha,
    tag: candidate.tag,
    branch: candidate.branch,
    builtAt: candidate.builtAt,
    source: candidate.source as BuildSource,
    dirty: candidate.dirty,
    reproducible: candidate.reproducible
  };
}

async function readFallbackVersion(cwd: string): Promise<string> {
  const packagePaths = uniquePaths([
    path.resolve(cwd, "package.json"),
    path.resolve(cwd, "../../package.json"),
    "/usr/lib/cyberos/package.json"
  ]);
  for (const packagePath of packagePaths) {
    try {
      const value = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
      if (typeof value.version === "string" && value.version) return value.version;
    } catch {
      // Continue to the next known package location.
    }
  }
  return "unknown";
}

function uniquePaths(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}
