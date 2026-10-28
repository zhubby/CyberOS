#!/usr/bin/env node

import { execFile } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { promisify } from "node:util";
import {
  compareStableVersions,
  readVersionState,
  requiresVersionBump,
  versionStateErrors
} from "./versioning.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = (await runGit(["rev-parse", "--show-toplevel"])).trim();
const state = await readVersionState(repoRoot);
const errors = versionStateErrors(state);
const base = argumentValue("--base") ?? process.env.CYBEROS_VERSION_BASE?.trim() ?? null;

if (base) {
  const changedFiles = (await runGit(["diff", "--name-only", `${base}...HEAD`], repoRoot))
    .split(/\r?\n/u)
    .filter(Boolean);
  const versionedChanges = changedFiles.filter(requiresVersionBump);
  if (versionedChanges.length > 0) {
    const baseManifest = JSON.parse(await runGit(["show", `${base}:package.json`], repoRoot));
    if (baseManifest.version === state.version) {
      errors.push(
        `Runtime or packaging changes require a version bump from ${state.version}: ${versionedChanges.join(", ")}`
      );
    } else if (compareStableVersions(state.version, baseManifest.version) < 0) {
      errors.push(`Version must advance beyond ${baseManifest.version}; received ${state.version}`);
    }
  }
}

const tag = process.env.CYBEROS_RELEASE_TAG?.trim() ?? null;
if (tag && tag !== `v${state.version}`) {
  errors.push(`Release tag ${JSON.stringify(tag)} does not match v${state.version}`);
}

if (errors.length > 0) {
  console.error(`Version check failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log(`Version check passed: ${state.version}`);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}
