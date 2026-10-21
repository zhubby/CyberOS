import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFiles, searchFiles, updateSessionPath } from "../api.js";
import { loadEntriesForSession, loadFileListingForView, sessionTitle, syncSessionPath } from "./session.js";
import type { FileEntry, FileListing, Session, SessionSummary } from "../api.js";

vi.mock("../api.js", () => ({
  getFiles: vi.fn(),
  searchFiles: vi.fn(),
  updateSessionPath: vi.fn()
}));

const mockedGetFiles = vi.mocked(getFiles);
const mockedSearchFiles = vi.mocked(searchFiles);
const mockedUpdateSessionPath = vi.mocked(updateSessionPath);

const baseSession: SessionSummary = {
  id: "session-1",
  rootId: "root-1",
  currentPath: ".",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
      firstMessage: null,
      lastMessage: null,
      pendingApprovalCount: 0
};

const fileEntry: FileEntry = {
  name: "hello.txt",
  path: "hello.txt",
  kind: "file",
  sizeBytes: 12,
  modifiedAt: "2026-08-21T00:00:00.000Z",
  isSafe: true
};

const gitStatus: FileListing["git"] = {
  repositoryName: "repo",
  repositoryPath: ".",
  currentPath: ".",
  branch: "main",
  headSha: "abc123",
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  dirty: true,
  summary: {
    tracked: 1,
    staged: 0,
    modified: 1,
    untracked: 0,
    conflicted: 0
  }
};

describe("session helpers", () => {
  beforeEach(() => {
    mockedGetFiles.mockReset();
    mockedSearchFiles.mockReset();
    mockedUpdateSessionPath.mockReset();
  });

  it("prefers first message, then last message, then path fallback", () => {
    expect(sessionTitle({ ...baseSession, firstMessage: "First", lastMessage: "Last" })).toBe("First");
    expect(sessionTitle({ ...baseSession, lastMessage: "Last" })).toBe("Last");
    expect(sessionTitle(baseSession)).toBe("Root agent");
    expect(sessionTitle(baseSession, "Root session")).toBe("Root session");
    expect(sessionTitle({ ...baseSession, currentPath: "media/photostaff" })).toBe("media/photostaff");
  });

  it("keeps the existing 34-character truncation rule", () => {
    expect(sessionTitle({ ...baseSession, firstMessage: "12345678901234567890123456789012345" })).toBe(
      "1234567890123456789012345678901..."
    );
  });

  it("loads entries for the current session path without resetting", async () => {
    mockedGetFiles.mockResolvedValueOnce({ entries: [fileEntry], git: gitStatus });

    await expect(loadEntriesForSession("root-1", { ...baseSession, currentPath: "docs" }, "pool-1")).resolves.toEqual({
      session: { ...baseSession, currentPath: "docs" },
      entries: [fileEntry],
      git: gitStatus,
      didResetPath: false
    });
    expect(mockedGetFiles).toHaveBeenCalledWith("root-1", "docs", "pool-1");
    expect(mockedUpdateSessionPath).not.toHaveBeenCalled();
  });

  it("resets recoverable stale paths to root and reloads entries", async () => {
    const resetSession: Session = {
      id: "session-1",
      rootId: "root-1",
      currentPath: "."
    };
    mockedGetFiles.mockRejectedValueOnce(new Error("Path not found")).mockResolvedValueOnce({ entries: [fileEntry], git: gitStatus });
    mockedUpdateSessionPath.mockResolvedValueOnce(resetSession);

    await expect(loadEntriesForSession("root-1", { ...baseSession, currentPath: "missing" }, "pool-1")).resolves.toEqual({
      session: resetSession,
      entries: [fileEntry],
      git: gitStatus,
      didResetPath: true
    });
    expect(mockedUpdateSessionPath).toHaveBeenCalledWith("session-1", ".");
    expect(mockedGetFiles).toHaveBeenNthCalledWith(1, "root-1", "missing", "pool-1");
    expect(mockedGetFiles).toHaveBeenNthCalledWith(2, "root-1", ".", "pool-1");
  });

  it("rethrows root path and non-recoverable load errors", async () => {
    const rootError = new Error("Path not found");
    mockedGetFiles.mockRejectedValueOnce(rootError);
    await expect(loadEntriesForSession("root-1", baseSession, "pool-1")).rejects.toThrow(rootError);
    expect(mockedUpdateSessionPath).not.toHaveBeenCalled();

    const permissionError = new Error("Permission denied");
    mockedGetFiles.mockRejectedValueOnce(permissionError);
    await expect(loadEntriesForSession("root-1", { ...baseSession, currentPath: "locked" }, "pool-1")).rejects.toThrow(
      permissionError
    );
    expect(mockedUpdateSessionPath).not.toHaveBeenCalled();
  });

  it("loads file listings in the active directory or search mode", async () => {
    mockedGetFiles.mockResolvedValueOnce({ entries: [fileEntry], git: gitStatus });
    await expect(loadFileListingForView("root-1", ".", " ", "pool-1")).resolves.toEqual({
      entries: [fileEntry],
      git: gitStatus
    });
    expect(mockedGetFiles).toHaveBeenCalledWith("root-1", ".", "pool-1");
    expect(mockedSearchFiles).not.toHaveBeenCalled();

    mockedSearchFiles.mockResolvedValueOnce({ files: [{ ...fileEntry, name: "match.txt" }], git: gitStatus });
    await expect(loadFileListingForView("root-1", "docs", " match ", "pool-1")).resolves.toEqual({
      entries: [{ ...fileEntry, name: "match.txt" }],
      git: gitStatus
    });
    expect(mockedSearchFiles).toHaveBeenCalledWith("root-1", "docs", "match", "pool-1");
  });

  it("only updates a session path when the workspace path differs", async () => {
    await expect(syncSessionPath(baseSession, ".")).resolves.toBe(baseSession);
    expect(mockedUpdateSessionPath).not.toHaveBeenCalled();

    const updatedSession: Session = {
      id: "session-1",
      rootId: "root-1",
      currentPath: "docs"
    };
    mockedUpdateSessionPath.mockResolvedValueOnce(updatedSession);

    await expect(syncSessionPath(baseSession, "docs")).resolves.toBe(updatedSession);
    expect(mockedUpdateSessionPath).toHaveBeenCalledWith("session-1", "docs");
  });
});
