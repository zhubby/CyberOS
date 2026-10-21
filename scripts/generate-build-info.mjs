#!/usr/bin/env node

import { execFile } from "node:child_process";
import console from "node:console";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUILD_SOURCES = new Set(["release", "ci", "local", "nix", "unknown"]);

export async function collectBuildInfo({ repoRoot, env = process.env, now = new Date(), runGit = defaultRunGit }) {
  const packageManifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const explicitCommit = optionalText(env.ZOS_BUILD_COMMIT_SHA) ?? optionalText(env.GITHUB_SHA);
  const gitCommit = explicitCommit ? null : await optionalGit(runGit, repoRoot, ["rev-parse", "HEAD"]);
  const commitSha = normalizeCommitSha(explicitCommit ?? gitCommit);
  const tag =
    optionalText(env.ZOS_BUILD_TAG) ??
    (env.GITHUB_REF_TYPE === "tag" ? optionalText(env.GITHUB_REF_NAME) : null) ??
    (await optionalGit(runGit, repoRoot, ["describe", "--tags", "--exact-match", "HEAD"]));
  const branch =
    optionalText(env.ZOS_BUILD_BRANCH) ??
    optionalText(env.GITHUB_HEAD_REF) ??
    (env.GITHUB_REF_TYPE === "branch" ? optionalText(env.GITHUB_REF_NAME) : null) ??
    (await optionalGit(runGit, repoRoot, ["branch", "--show-current"]));
  const dirty = await resolveDirtyState(env, runGit, repoRoot);

  const source = resolveBuildSource(env, tag, commitSha);
  return {
    version: packageManifest.version,
    commitSha,
    commitShortSha: commitSha?.slice(0, 12) ?? null,
    tag,
    branch,
    builtAt: resolveBuildTime(env, now),
    source,
    dirty,
    reproducible: resolveReproducibleState(env, source)
  };
}

export async function writeBuildInfo(repoRoot, buildInfo) {
  const outputPath = path.join(repoRoot, ".zos/build-info.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
  return outputPath;
}

async function main() {
  const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const buildInfo = await collectBuildInfo({ repoRoot });
  const outputPath = await writeBuildInfo(repoRoot, buildInfo);
  console.log(`Build metadata written to ${outputPath}`);
}

async function resolveDirtyState(env, runGit, repoRoot) {
  const explicit = optionalText(env.ZOS_BUILD_DIRTY);
  if (explicit) {
    if (["1", "true"].includes(explicit.toLowerCase())) return true;
    if (["0", "false"].includes(explicit.toLowerCase())) return false;
    throw new Error("ZOS_BUILD_DIRTY must be true, false, 1, or 0");
  }

  const status = await optionalGit(runGit, repoRoot, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  return status === null ? null : Boolean(status);
}

function resolveBuildTime(env, now) {
  const explicit = optionalText(env.ZOS_BUILD_TIME);
  if (explicit) {
    const parsed = new Date(explicit);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("ZOS_BUILD_TIME must be a valid date");
    }
    return parsed.toISOString();
  }

  const sourceDateEpoch = optionalText(env.SOURCE_DATE_EPOCH);
  if (sourceDateEpoch) {
    const seconds = Number(sourceDateEpoch);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error("SOURCE_DATE_EPOCH must be a non-negative number");
    }
    return new Date(seconds * 1000).toISOString();
  }

  return now.toISOString();
}

function resolveBuildSource(env, tag, commitSha) {
  const explicit = optionalText(env.ZOS_BUILD_SOURCE);
  if (explicit) {
    if (!BUILD_SOURCES.has(explicit)) {
      throw new Error(`Unsupported ZOS_BUILD_SOURCE ${JSON.stringify(explicit)}`);
    }
    return explicit;
  }
  if (env.GITHUB_ACTIONS === "true") return tag ? "release" : "ci";
  return commitSha ? "local" : "unknown";
}

function resolveReproducibleState(env, source) {
  const explicit = optionalText(env.ZOS_BUILD_REPRODUCIBLE);
  if (explicit) {
    if (["1", "true"].includes(explicit.toLowerCase())) return true;
    if (["0", "false"].includes(explicit.toLowerCase())) return false;
    throw new Error("ZOS_BUILD_REPRODUCIBLE must be true, false, 1, or 0");
  }
  return source === "nix" && Boolean(optionalText(env.SOURCE_DATE_EPOCH));
}

function normalizeCommitSha(value) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/u.test(normalized)) {
    throw new Error("Build commit SHA must contain 7 to 64 hexadecimal characters");
  }
  return normalized;
}

function optionalText(value) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function optionalGit(runGit, repoRoot, args) {
  try {
    const value = (await runGit(args, repoRoot)).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function defaultRunGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
