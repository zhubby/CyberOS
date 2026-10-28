#!/usr/bin/env node

import { execFile } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { promisify } from "node:util";
import { bumpVersion, prepareRelease, readVersionState, versionStateErrors } from "./versioning.mjs";

const execFileAsync = promisify(execFile);
const { increment, note, dryRun } = parseArguments(process.argv.slice(2));
const repoRoot = (await runGit(["rev-parse", "--show-toplevel"])).trim();
const state = await readVersionState(repoRoot);
const errors = versionStateErrors(state);
if (errors.length > 0) {
  fail(`Version state is inconsistent:\n- ${errors.join("\n- ")}`);
}

const status = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], repoRoot);
if (status.trim()) {
  fail("Release preparation requires a clean worktree. Commit or stash the current changes first.");
}

const target = bumpVersion(state.version, increment);
const result = await prepareRelease(repoRoot, { increment, note, write: !dryRun });
console.log(`${dryRun ? "Would prepare" : "Prepared"} CyberOS ${state.version} -> ${target}`);
for (const relativePath of result.files.keys()) {
  console.log(`- ${relativePath}`);
}
if (!dryRun) {
  console.log(`Next: review the diff, commit it as chore(release): v${target}, then create tag v${target}.`);
}

function parseArguments(args) {
  const increment = args[0];
  if (!increment || !["major", "minor", "patch"].includes(increment)) {
    fail("Usage: npm run release -- <major|minor|patch> --note \"release summary\" [--dry-run]");
  }

  const noteIndex = args.indexOf("--note");
  const note = noteIndex >= 0 ? args[noteIndex + 1]?.trim() : "";
  if (!note) {
    fail("A non-empty --note is required for the Debian changelog.");
  }

  return { increment, note, dryRun: args.includes("--dry-run") };
}

async function runGit(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return stdout;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
