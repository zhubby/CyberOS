import { describe, expect, it } from "vitest";
import {
  remarkWorkspacePaths,
  resolveWorkspaceMessageLink,
  resolveWorkspaceMessagePath,
  splitWorkspaceMessagePaths,
  workspaceAbsolutePath,
  workspaceParentPath
} from "./chat-paths.js";

describe("resolveWorkspaceMessagePath", () => {
  it("maps absolute paths inside the selected root to workspace paths", () => {
    expect(resolveWorkspaceMessagePath("/cyberos/data/pool-1/docs/readme.md", "/cyberos/data/pool-1")).toEqual({
      displayPath: "/cyberos/data/pool-1/docs/readme.md",
      workspacePath: "docs/readme.md"
    });
    expect(resolveWorkspaceMessagePath("/cyberos/data/pool-1/", "/cyberos/data/pool-1/")).toEqual({
      displayPath: "/cyberos/data/pool-1/",
      workspacePath: "."
    });
    expect(resolveWorkspaceMessagePath("/cyberos/data/pool-1/docs/../readme.md", "/cyberos/data/pool-1")).toEqual({
      displayPath: "/cyberos/data/pool-1/docs/../readme.md",
      workspacePath: "readme.md"
    });
    expect(resolveWorkspaceMessagePath("/Users/zhubby/file.txt", "/")).toEqual({
      displayPath: "/Users/zhubby/file.txt",
      workspacePath: "Users/zhubby/file.txt"
    });
  });

  it("rejects paths outside the selected root or sharing only its prefix", () => {
    expect(resolveWorkspaceMessagePath("/cyberos/data/pool-1-backup/file.txt", "/cyberos/data/pool-1")).toBeNull();
    expect(resolveWorkspaceMessagePath("/private/other/file.txt", "/cyberos/data/pool-1")).toBeNull();
    expect(resolveWorkspaceMessagePath("/cyberos/data/pool-1/../../etc/passwd", "/cyberos/data/pool-1")).toBeNull();
    expect(resolveWorkspaceMessagePath("/cyberos/data/pool-1/docs/../../nas/file.txt", "/cyberos/data/pool-1")).toBeNull();
    expect(resolveWorkspaceMessagePath("//cyberos/data/pool-1/file.txt", "/cyberos/data/pool-1")).toBeNull();
    expect(resolveWorkspaceMessagePath("docs/readme.md", "/cyberos/data/pool-1")).toBeNull();
  });
});

describe("resolveWorkspaceMessageLink", () => {
  it("decodes Markdown link paths before matching the selected root", () => {
    expect(resolveWorkspaceMessageLink("/cyberos/data/pool-1/My%20Files/report.pdf#page=2", "/cyberos/data/pool-1")).toEqual({
      displayPath: "/cyberos/data/pool-1/My Files/report.pdf",
      workspacePath: "My Files/report.pdf"
    });
    expect(resolveWorkspaceMessageLink("https://example.com/cyberos/data/pool-1/file.txt", "/cyberos/data/pool-1")).toBeNull();
    expect(resolveWorkspaceMessageLink("//cyberos/data/pool-1/file.txt", "/cyberos/data/pool-1")).toBeNull();
    expect(resolveWorkspaceMessageLink("%E0%A4%A", "/cyberos/data/pool-1")).toBeNull();
  });
});

describe("splitWorkspaceMessagePaths", () => {
  it("separates unquoted and quoted paths while preserving punctuation", () => {
    expect(
      splitWorkspaceMessagePaths(
        'Found /cyberos/data/pool-1/docs/readme.md. Open "/cyberos/data/pool-1/My Files/report.pdf" next.',
        "/cyberos/data/pool-1"
      )
    ).toEqual([
      { kind: "text", value: "Found " },
      {
        kind: "path",
        value: "/cyberos/data/pool-1/docs/readme.md",
        displayPath: "/cyberos/data/pool-1/docs/readme.md",
        workspacePath: "docs/readme.md"
      },
      { kind: "text", value: '. Open "' },
      {
        kind: "path",
        value: "/cyberos/data/pool-1/My Files/report.pdf",
        displayPath: "/cyberos/data/pool-1/My Files/report.pdf",
        workspacePath: "My Files/report.pdf"
      },
      { kind: "text", value: '" next.' }
    ]);
  });

  it("keeps a standalone path with spaces together until the line break", () => {
    expect(
      splitWorkspaceMessagePaths("/cyberos/data/pool-1/My Files/report (1).pdf\nPlease inspect this file", "/cyberos/data/pool-1")
    ).toEqual([
      {
        kind: "path",
        value: "/cyberos/data/pool-1/My Files/report (1).pdf",
        displayPath: "/cyberos/data/pool-1/My Files/report (1).pdf",
        workspacePath: "My Files/report (1).pdf"
      },
      { kind: "text", value: "\nPlease inspect this file" }
    ]);
  });

  it("leaves external and storage-pool-relative paths as text", () => {
    const text = "See /private/other/file.txt and docs/readme.md";
    expect(splitWorkspaceMessagePaths(text, "/cyberos/data/pool-1")).toEqual([{ kind: "text", value: text }]);
  });
});

describe("remarkWorkspacePaths", () => {
  it("converts message text paths to inline code but skips links and code blocks", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Open /cyberos/data/pool-1/docs/readme.md" },
            { type: "link", url: "/cyberos/data/pool-1/linked.md", children: [{ type: "text", value: "/cyberos/data/pool-1/linked.md" }] }
          ]
        },
        { type: "code", value: "/cyberos/data/pool-1/not-interactive.txt" }
      ]
    };

    remarkWorkspacePaths({ rootPath: "/cyberos/data/pool-1" })(tree);

    expect(tree.children[0]).toEqual({
      type: "paragraph",
      children: [
        { type: "text", value: "Open " },
        { type: "inlineCode", value: "/cyberos/data/pool-1/docs/readme.md" },
        { type: "link", url: "/cyberos/data/pool-1/linked.md", children: [{ type: "text", value: "/cyberos/data/pool-1/linked.md" }] }
      ]
    });
    expect(tree.children[1]).toEqual({ type: "code", value: "/cyberos/data/pool-1/not-interactive.txt" });
  });
});

describe("workspaceParentPath", () => {
  it("returns a storage-pool-relative parent directory", () => {
    expect(workspaceParentPath("docs/reference/file.md")).toBe("docs/reference");
    expect(workspaceParentPath("file.md")).toBe(".");
  });
});

describe("workspaceAbsolutePath", () => {
  it("joins a storage-pool-relative path to an absolute storage pool", () => {
    expect(workspaceAbsolutePath("/cyberos/data/pool-1", "docs/readme.md")).toBe("/cyberos/data/pool-1/docs/readme.md");
    expect(workspaceAbsolutePath("/", "docs/readme.md")).toBe("/docs/readme.md");
    expect(workspaceAbsolutePath("/cyberos/data/pool-1/", ".")).toBe("/cyberos/data/pool-1");
  });
});
