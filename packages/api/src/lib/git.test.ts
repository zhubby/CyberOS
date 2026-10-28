import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDir } from "@cyberos/storage-tools";
import type { StorageWorkspace } from "@cyberos/shared";
import {
  classifyGitStatusCode,
  getDirectoryGitView,
  parseGitStatusRecords,
  summarizeGitStatus
} from "./git.js";

const execFileAsync = promisify(execFile);

let tempDir: string;
let rootDir: string;
let root: StorageWorkspace;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-git-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir);
  root = {
    path: rootDir
  };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Git file status helpers", () => {
  it("parses porcelain status codes into display statuses", () => {
    expect(classifyGitStatusCode("??")).toBe("untracked");
    expect(classifyGitStatusCode("A ")).toBe("staged");
    expect(classifyGitStatusCode(" M")).toBe("modified");
    expect(classifyGitStatusCode("AM")).toBe("modified");
    expect(classifyGitStatusCode("UU")).toBe("conflicted");
    expect(classifyGitStatusCode("  ")).toBeNull();

    const changedPaths = parseGitStatusRecords("UU conflict.txt\0A  staged.txt\0 M changed.txt\0?? new.txt\0AM added-edited.txt\0");
    expect(Object.fromEntries(changedPaths)).toEqual({
      "conflict.txt": "conflicted",
      "staged.txt": "staged",
      "changed.txt": "modified",
      "new.txt": "untracked",
      "added-edited.txt": "modified"
    });
    expect(summarizeGitStatus(changedPaths, new Set(["clean.txt", "changed.txt"]))).toEqual({
      tracked: 2,
      staged: 1,
      modified: 2,
      untracked: 1,
      conflicted: 1
    });
  });

  it("summarizes a repository and annotates current directory entries", async () => {
    const remoteDir = path.join(tempDir, "remote.git");
    await git(["init", "--bare", remoteDir], tempDir);
    await git(["init", "-b", "main"]);
    await writeFile(path.join(rootDir, "clean.txt"), "clean");
    await writeFile(path.join(rootDir, "tracked.txt"), "tracked");
    await mkdir(path.join(rootDir, "dir"));
    await writeFile(path.join(rootDir, "dir", "nested.txt"), "nested");
    await git(["add", "."]);
    await gitCommit("initial");
    await git(["remote", "add", "origin", remoteDir]);
    await git(["push", "-u", "origin", "main"]);

    const peerDir = path.join(tempDir, "peer");
    await git(["clone", "--branch", "main", remoteDir, peerDir], tempDir);
    await writeFile(path.join(peerDir, "remote.txt"), "remote");
    await git(["add", "."], peerDir);
    await gitCommit("remote", peerDir);
    await git(["push", "origin", "main"], peerDir);
    await git(["fetch", "origin", "main"]);

    await writeFile(path.join(rootDir, "local.txt"), "local");
    await git(["add", "."]);
    await gitCommit("local");
    await writeFile(path.join(rootDir, "tracked.txt"), "changed");
    await writeFile(path.join(rootDir, "staged.txt"), "staged");
    await git(["add", "staged.txt"]);
    await writeFile(path.join(rootDir, "new.txt"), "new");
    await writeFile(path.join(rootDir, "dir", "nested.txt"), "changed");

    const view = await getDirectoryGitView(root.path, ".", await listDir(root, "."));

    expect(view.git).toMatchObject({
      repositoryName: "root",
      repositoryPath: ".",
      currentPath: ".",
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 1,
      dirty: true,
      summary: {
        staged: 1,
        modified: 2,
        untracked: 1,
        conflicted: 0
      }
    });
    expect(statusFor(view.entries, "clean.txt")).toBe("tracked");
    expect(statusFor(view.entries, "tracked.txt")).toBe("modified");
    expect(statusFor(view.entries, "staged.txt")).toBe("staged");
    expect(statusFor(view.entries, "new.txt")).toBe("untracked");
    expect(statusFor(view.entries, "dir")).toBe("modified");

    const subdirView = await getDirectoryGitView(root.path, "dir", await listDir(root, "dir"));
    expect(subdirView.git).toMatchObject({
      currentPath: "dir",
      dirty: true,
      summary: {
        staged: 1,
        modified: 2,
        untracked: 1,
        conflicted: 0
      }
    });
    expect(statusFor(subdirView.entries, "nested.txt")).toBe("modified");
  });

  it("aggregates directory statuses using display priority", async () => {
    await git(["init", "-b", "main"]);
    await mkdir(path.join(rootDir, "priority"));
    await writeFile(path.join(rootDir, "priority", "conflict.txt"), "base\n");
    await writeFile(path.join(rootDir, "priority", "modified.txt"), "base\n");
    await git(["add", "."]);
    await gitCommit("initial");

    await git(["checkout", "-b", "side"]);
    await writeFile(path.join(rootDir, "priority", "conflict.txt"), "side\n");
    await git(["add", "."]);
    await gitCommit("side");

    await git(["checkout", "main"]);
    await writeFile(path.join(rootDir, "priority", "conflict.txt"), "main\n");
    await git(["add", "."]);
    await gitCommit("main");
    await expect(git(["merge", "side"])).rejects.toThrow();

    await writeFile(path.join(rootDir, "priority", "modified.txt"), "changed\n");
    await writeFile(path.join(rootDir, "priority", "staged.txt"), "staged\n");
    await git(["add", "priority/staged.txt"]);
    await writeFile(path.join(rootDir, "priority", "untracked.txt"), "new\n");

    const rootView = await getDirectoryGitView(root.path, ".", await listDir(root, "."));
    expect(statusFor(rootView.entries, "priority")).toBe("conflicted");

    const priorityView = await getDirectoryGitView(root.path, "priority", await listDir(root, "priority"));
    expect(statusFor(priorityView.entries, "conflict.txt")).toBe("conflicted");
    expect(statusFor(priorityView.entries, "modified.txt")).toBe("modified");
    expect(statusFor(priorityView.entries, "staged.txt")).toBe("staged");
    expect(statusFor(priorityView.entries, "untracked.txt")).toBe("untracked");
  });

  it("ignores repositories whose metadata escapes the storage pool", async () => {
    const parentRepo = path.join(tempDir, "parent");
    const nestedRoot = path.join(parentRepo, "nas");
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(path.join(nestedRoot, "hello.txt"), "hello");
    await git(["init", "-b", "main"], parentRepo);
    await git(["add", "."], parentRepo);
    await gitCommit("initial", parentRepo);

    const nestedStoragePool = {
      ...root,
      path: nestedRoot
    };
    const view = await getDirectoryGitView(nestedStoragePool.path, ".", await listDir(nestedStoragePool, "."));

    expect(view.git).toBeNull();
    expect(view.entries).toMatchObject([{ name: "hello.txt" }]);
  });

  it("does not execute repository-local fsmonitor helpers while reading status", async () => {
    await git(["init", "-b", "main"]);
    await writeFile(path.join(rootDir, "tracked.txt"), "tracked");
    await git(["add", "."]);
    await gitCommit("initial");

    const sentinelPath = path.join(tempDir, "fsmonitor-hit");
    const helperPath = path.join(rootDir, "fsmonitor.sh");
    await writeFile(helperPath, `#!/bin/sh\necho hit >> "${sentinelPath}"\nexit 0\n`);
    await chmod(helperPath, 0o755);
    await git(["config", "core.fsmonitor", helperPath]);

    const view = await getDirectoryGitView(root.path, ".", await listDir(root, "."));

    expect(view.git).toMatchObject({ repositoryName: "root" });
    await expect(access(sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores linked worktrees whose metadata escapes the storage pool", async () => {
    const sourceRepo = path.join(tempDir, "source");
    await mkdir(sourceRepo);
    await git(["init", "-b", "main"], sourceRepo);
    await writeFile(path.join(sourceRepo, "hello.txt"), "hello");
    await git(["add", "."], sourceRepo);
    await gitCommit("initial", sourceRepo);

    const worktreeRoot = path.join(rootDir, "worktree");
    await git(["worktree", "add", "-b", "nas-view", worktreeRoot], sourceRepo);
    const worktreeStoragePool = {
      ...root,
      path: worktreeRoot
    };

    const view = await getDirectoryGitView(worktreeStoragePool.path, ".", await listDir(worktreeStoragePool, "."));

    expect(view.git).toBeNull();
    expect(view.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "hello.txt"
        })
      ])
    );
  });

  it("keeps entries available when the git executable is unavailable", async () => {
    await mkdir(path.join(rootDir, ".git"));
    await writeFile(path.join(rootDir, "visible.txt"), "visible");
    const emptyBinPath = path.join(tempDir, "empty-bin");
    await mkdir(emptyBinPath);
    const originalPath = process.env.PATH;

    try {
      process.env.PATH = emptyBinPath;
      const view = await getDirectoryGitView(root.path, ".", await listDir(root, "."));

      expect(view.git).toBeNull();
      expect(statusFor(view.entries, "visible.txt")).toBeUndefined();
      expect(view.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "visible.txt"
          })
        ])
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

function statusFor(entries: Array<{ name: string; gitStatus?: string }>, name: string): string | undefined {
  return entries.find((entry) => entry.name === name)?.gitStatus;
}

async function git(args: string[], cwd = rootDir): Promise<void> {
  await execFileAsync("git", ["-c", "user.name=CyberOS", "-c", "user.email=cyberos@example.test", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0"
    }
  });
}

async function gitCommit(message: string, cwd = rootDir): Promise<void> {
  await git(["commit", "-m", message], cwd);
}
