import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  isPathInside,
  resolveSafeExistingPath,
  toRootRelative,
  type FileEntry,
  type SafePathResult
} from "@cyberos/storage-tools";
import type { GitDirectoryStatus, GitFileStatus, GitStatusSummary } from "@cyberos/shared";

const GIT_TIMEOUT_MS = 2_000;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_GIT_MARKER_BYTES = 4096;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const SAFE_GIT_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "submodule.recurse=false"
];
const CONFLICT_STATUS_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const STATUS_PRIORITY: Record<GitFileStatus, number> = {
  tracked: 0,
  untracked: 1,
  staged: 2,
  modified: 3,
  conflicted: 4
};

export interface FileEntryWithGitStatus extends FileEntry {
  gitStatus?: GitFileStatus;
}

export interface DirectoryGitView {
  entries: FileEntryWithGitStatus[];
  git: GitDirectoryStatus | null;
}

interface GitRepositoryContext {
  rootRealPath: string;
  repositoryRealPath: string;
  gitDirRealPath: string;
  gitCommonDirRealPath: string;
  currentRealPath: string;
  repositoryPath: string;
  currentPath: string;
}

interface DiscoveredGitRepository {
  repositoryRealPath: string;
  gitDirRealPath: string;
  gitCommonDirRealPath: string;
}

interface GitPathIndex {
  changedPaths: Map<string, GitFileStatus>;
  trackedPaths: Set<string>;
  changedDirectories: Map<string, GitFileStatus>;
  trackedDirectories: Set<string>;
}

export async function getDirectoryGitView(
  rootPath: string,
  requestedPath: string,
  entries: FileEntry[],
  scopeRootPath?: string
): Promise<DirectoryGitView> {
  try {
    const safe = await resolveSafeExistingPath(rootPath, requestedPath);
    const repository = await resolveGitRepository(safe);
    if (!repository) {
      return { entries, git: null };
    }
    if (scopeRootPath && !isPathInside(scopeRootPath, repository.repositoryRealPath)) {
      return { entries, git: null };
    }

    const git = await readGitDirectoryStatus(repository);
    return {
      entries: annotateEntriesWithGitStatus(entries, repository, git.changedPaths, git.trackedPaths),
      git: git.status
    };
  } catch {
    return { entries, git: null };
  }
}

export function parseGitStatusRecords(output: string): Map<string, GitFileStatus> {
  const changedPaths = new Map<string, GitFileStatus>();
  for (const record of output.split("\0")) {
    if (!record) {
      continue;
    }

    const status = classifyGitStatusCode(record.slice(0, 2));
    const filePath = record.slice(3);
    if (status && filePath) {
      changedPaths.set(normalizeGitPath(filePath), status);
    }
  }
  return changedPaths;
}

export function classifyGitStatusCode(code: string): GitFileStatus | null {
  if (code === "??") {
    return "untracked";
  }
  if (CONFLICT_STATUS_CODES.has(code)) {
    return "conflicted";
  }

  const indexStatus = code.charAt(0);
  const worktreeStatus = code.charAt(1);
  if (worktreeStatus && worktreeStatus !== " ") {
    return "modified";
  }
  if (indexStatus && indexStatus !== " ") {
    return "staged";
  }
  return null;
}

export function summarizeGitStatus(
  changedPaths: Map<string, GitFileStatus>,
  trackedPaths: Set<string>
): GitStatusSummary {
  const summary: GitStatusSummary = {
    tracked: trackedPaths.size,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0
  };

  for (const status of changedPaths.values()) {
    summary[status] += 1;
  }
  return summary;
}

async function resolveGitRepository(safe: SafePathResult): Promise<GitRepositoryContext | null> {
  const discovered = await discoverGitRepository(safe);
  if (!discovered) {
    return null;
  }

  const repository = {
    rootRealPath: safe.rootRealPath,
    repositoryRealPath: discovered.repositoryRealPath,
    gitDirRealPath: discovered.gitDirRealPath,
    gitCommonDirRealPath: discovered.gitCommonDirRealPath,
    currentRealPath: safe.realPath,
    repositoryPath: toRootRelative(safe.rootRealPath, discovered.repositoryRealPath),
    currentPath: safe.relativePath
  };

  const insideWorkTree = (await runRepositoryGit(repository, ["rev-parse", "--is-inside-work-tree"])).trim();
  if (insideWorkTree !== "true") {
    return null;
  }

  const [repositoryPath, gitDirPath, gitCommonDirPath] = await Promise.all([
    runRepositoryGit(repository, ["rev-parse", "--show-toplevel"]),
    runRepositoryGit(repository, ["rev-parse", "--absolute-git-dir"]),
    runRepositoryGit(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ]);
  const [repositoryRealPath, gitDirRealPath, gitCommonDirRealPath] = await Promise.all([
    safeRealpathInside(safe.rootRealPath, repositoryPath.trim()),
    safeRealpathInside(safe.rootRealPath, gitDirPath.trim()),
    safeRealpathInside(safe.rootRealPath, gitCommonDirPath.trim())
  ]);

  if (
    !repositoryRealPath ||
    !gitDirRealPath ||
    !gitCommonDirRealPath ||
    repositoryRealPath !== discovered.repositoryRealPath ||
    gitDirRealPath !== discovered.gitDirRealPath ||
    gitCommonDirRealPath !== discovered.gitCommonDirRealPath
  ) {
    return null;
  }

  return {
    ...repository,
    repositoryRealPath,
    gitDirRealPath,
    gitCommonDirRealPath,
    repositoryPath: toRootRelative(safe.rootRealPath, repositoryRealPath),
  };
}

async function discoverGitRepository(safe: SafePathResult): Promise<DiscoveredGitRepository | null> {
  let cursor = safe.realPath;

  while (isPathInside(safe.rootRealPath, cursor)) {
    const repository = await readGitMarker(safe.rootRealPath, cursor);
    if (repository) {
      return repository;
    }

    if (cursor === safe.rootRealPath) {
      return null;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }

  return null;
}

async function readGitMarker(rootRealPath: string, repositoryRealPath: string): Promise<DiscoveredGitRepository | null> {
  const markerPath = path.join(repositoryRealPath, ".git");
  let markerStat: Awaited<ReturnType<typeof lstat>>;
  try {
    markerStat = await lstat(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let gitDirRealPath: string | null = null;
  if (markerStat.isDirectory()) {
    gitDirRealPath = await safeRealpathInside(rootRealPath, markerPath);
  } else if (markerStat.isFile()) {
    gitDirRealPath = await readGitDirFile(rootRealPath, repositoryRealPath, markerPath);
  }

  if (!gitDirRealPath) {
    throw new Error("Git metadata escapes the storage pool");
  }

  const gitCommonDirRealPath = await readGitCommonDir(rootRealPath, gitDirRealPath);
  if (!gitCommonDirRealPath) {
    throw new Error("Git common metadata escapes the storage pool");
  }

  return {
    repositoryRealPath,
    gitDirRealPath,
    gitCommonDirRealPath
  };
}

async function readGitDirFile(rootRealPath: string, repositoryRealPath: string, markerPath: string): Promise<string | null> {
  const content = await readSmallGitFile(markerPath);
  const firstLine = content.split(/\r?\n/u)[0]?.trim() ?? "";
  const match = /^gitdir:\s*(.+)$/u.exec(firstLine);
  if (!match) {
    return null;
  }

  const gitDirPath = match[1];
  if (!gitDirPath) {
    return null;
  }

  return safeRealpathInside(rootRealPath, path.resolve(repositoryRealPath, gitDirPath));
}

async function readGitCommonDir(rootRealPath: string, gitDirRealPath: string): Promise<string | null> {
  try {
    const content = await readSmallGitFile(path.join(gitDirRealPath, "commondir"));
    const firstLine = content.split(/\r?\n/u)[0]?.trim() ?? "";
    return safeRealpathInside(rootRealPath, path.resolve(gitDirRealPath, firstLine || "."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return gitDirRealPath;
    }
    throw error;
  }
}

async function readSmallGitFile(filePath: string): Promise<string> {
  const markerStat = await lstat(filePath);
  if (!markerStat.isFile() || markerStat.size > MAX_GIT_MARKER_BYTES) {
    throw new Error("Git metadata marker is invalid");
  }
  return readFile(filePath, "utf8");
}

async function safeRealpathInside(rootRealPath: string, candidatePath: string): Promise<string | null> {
  if (!candidatePath || !isPathInside(rootRealPath, candidatePath)) {
    return null;
  }

  const candidateRealPath = await realpath(candidatePath);
  return isPathInside(rootRealPath, candidateRealPath) ? candidateRealPath : null;
}

async function readGitDirectoryStatus(repository: GitRepositoryContext): Promise<{
  changedPaths: Map<string, GitFileStatus>;
  status: GitDirectoryStatus;
  trackedPaths: Set<string>;
}> {
  const [statusOutput, trackedOutput, branchOutput, headOutput, upstreamOutput] = await Promise.all([
    runRepositoryGit(repository, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--ignore-submodules=all"
    ]),
    runRepositoryGit(repository, ["ls-files", "-z", "--cached"]),
    runOptionalRepositoryGit(repository, ["branch", "--show-current"]),
    runOptionalRepositoryGit(repository, ["rev-parse", "--short=12", "HEAD"]),
    runOptionalRepositoryGit(repository, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
  ]);
  const branch = branchOutput.trim() || null;
  const upstream = upstreamOutput.trim() || null;
  const { ahead, behind } = upstream ? await readAheadBehind(repository, upstream) : { ahead: 0, behind: 0 };
  const changedPaths = parseGitStatusRecords(statusOutput);
  const trackedPaths = parseGitPathSet(trackedOutput);
  const summary = summarizeGitStatus(changedPaths, trackedPaths);

  return {
    changedPaths,
    trackedPaths,
    status: {
      repositoryName: path.basename(repository.repositoryRealPath),
      repositoryPath: repository.repositoryPath,
      currentPath: repository.currentPath,
      branch,
      headSha: headOutput.trim() || null,
      detached: branch === null,
      upstream,
      ahead,
      behind,
      dirty: summary.staged > 0 || summary.modified > 0 || summary.untracked > 0 || summary.conflicted > 0,
      summary
    }
  };
}

async function readAheadBehind(repository: GitRepositoryContext, upstream: string): Promise<{ ahead: number; behind: number }> {
  try {
    const output = await runRepositoryGit(repository, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    const [behindRaw, aheadRaw] = output.trim().split(/\s+/u);
    const behind = Number(behindRaw);
    const ahead = Number(aheadRaw);
    return {
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

function annotateEntriesWithGitStatus(
  entries: FileEntry[],
  repository: GitRepositoryContext,
  changedPaths: Map<string, GitFileStatus>,
  trackedPaths: Set<string>
): FileEntryWithGitStatus[] {
  const gitPathIndex = buildGitPathIndex(changedPaths, trackedPaths);
  return entries.map((entry) => {
    const gitPath = rootRelativeToGitPath(repository, entry.path);
    if (!gitPath) {
      return entry;
    }

    const gitStatus = statusForEntry(gitPath, entry.kind, gitPathIndex);
    return gitStatus ? { ...entry, gitStatus } : entry;
  });
}

function statusForEntry(
  gitPath: string,
  kind: FileEntry["kind"],
  gitPathIndex: GitPathIndex
): GitFileStatus | null {
  const status =
    gitPathIndex.changedPaths.get(gitPath) ?? (kind === "directory" ? gitPathIndex.changedDirectories.get(gitPath) : null);
  if (status) {
    return status;
  }

  if (gitPathIndex.trackedPaths.has(gitPath) || (kind === "directory" && gitPathIndex.trackedDirectories.has(gitPath))) {
    return "tracked";
  }
  return null;
}

function buildGitPathIndex(changedPaths: Map<string, GitFileStatus>, trackedPaths: Set<string>): GitPathIndex {
  const changedDirectories = new Map<string, GitFileStatus>();
  const trackedDirectories = new Set<string>();

  for (const [changedPath, status] of changedPaths) {
    addAncestorDirectories(changedPath, (directory) => {
      changedDirectories.set(directory, higherPriorityStatus(changedDirectories.get(directory) ?? null, status));
    });
  }

  for (const trackedPath of trackedPaths) {
    addAncestorDirectories(trackedPath, (directory) => {
      trackedDirectories.add(directory);
    });
  }

  return {
    changedPaths,
    trackedPaths,
    changedDirectories,
    trackedDirectories
  };
}

function addAncestorDirectories(gitPath: string, visit: (directory: string) => void): void {
  let directory = path.posix.dirname(gitPath);
  while (directory && directory !== ".") {
    visit(directory);
    directory = path.posix.dirname(directory);
  }
}

function higherPriorityStatus(current: GitFileStatus | null, next: GitFileStatus): GitFileStatus {
  if (!current || STATUS_PRIORITY[next] > STATUS_PRIORITY[current]) {
    return next;
  }
  return current;
}

function parseGitPathSet(output: string): Set<string> {
  return new Set(output.split("\0").filter(Boolean).map(normalizeGitPath));
}

function rootRelativeToGitPath(repository: GitRepositoryContext, rootRelativePath: string): string | null {
  const absolutePath = path.resolve(repository.rootRealPath, rootRelativePath);
  if (!isPathInside(repository.rootRealPath, absolutePath)) {
    return null;
  }
  const relativePath = path.relative(repository.repositoryRealPath, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  return normalizeGitPath(relativePath);
}

function normalizeGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/").replace(/\/+$/u, "");
}

function runOptionalRepositoryGit(repository: GitRepositoryContext, args: string[]): Promise<string> {
  return runRepositoryGit(repository, args).catch(() => "");
}

function runRepositoryGit(repository: GitRepositoryContext, args: string[]): Promise<string> {
  return runGit(["--git-dir", repository.gitDirRealPath, "--work-tree", repository.repositoryRealPath, ...args], repository.repositoryRealPath, {
    GIT_CEILING_DIRECTORIES: repository.rootRealPath
  });
}

function runGit(args: string[], cwd: string, envOverrides: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE_GIT_CONFIG_ARGS, ...args], {
      cwd,
      shell: false,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: NULL_DEVICE,
        GIT_CONFIG_GLOBAL: NULL_DEVICE,
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
        GIT_ATTR_NOSYSTEM: "1",
        LC_ALL: "C",
        ...envOverrides
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let outputBytes = 0;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      stopGitProcess(child);
      settle(() => reject(new Error(`git timed out after ${GIT_TIMEOUT_MS}ms`)));
    }, GIT_TIMEOUT_MS);

    function settle(callback: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    }

    function stopGitProcess(target: ReturnType<typeof spawn>) {
      target.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => target.kill("SIGKILL"), 1_000);
    }

    function clearForceKillTimer() {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    }

    function appendOutput(chunk: Buffer, collectOutput: boolean) {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        stopGitProcess(child);
        settle(() => reject(new Error("git output exceeded limit")));
        return;
      }
      if (collectOutput) {
        output += chunk.toString("utf8");
      }
    }

    child.stdout.on("data", (chunk: Buffer) => appendOutput(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => appendOutput(chunk, false));
    child.on("error", (error) => {
      clearForceKillTimer();
      settle(() => reject(error));
    });
    child.on("close", (exitCode) => {
      clearForceKillTimer();
      if (settled) {
        return;
      }
      if (exitCode === 0) {
        settle(() => resolve(output));
        return;
      }
      settle(() => reject(new Error(`git exited with ${exitCode ?? "signal"}`)));
    });
  });
}
