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
    expect(resolveWorkspaceMessagePath("/zos/data/primary/docs/readme.md", "/zos/data/primary")).toEqual({
      displayPath: "/zos/data/primary/docs/readme.md",
      workspacePath: "docs/readme.md"
    });
    expect(resolveWorkspaceMessagePath("/zos/data/primary/", "/zos/data/primary/")).toEqual({
      displayPath: "/zos/data/primary/",
      workspacePath: "."
    });
    expect(resolveWorkspaceMessagePath("/zos/data/primary/docs/../readme.md", "/zos/data/primary")).toEqual({
      displayPath: "/zos/data/primary/docs/../readme.md",
      workspacePath: "readme.md"
    });
    expect(resolveWorkspaceMessagePath("/Users/zhubby/file.txt", "/")).toEqual({
      displayPath: "/Users/zhubby/file.txt",
      workspacePath: "Users/zhubby/file.txt"
    });
  });

  it("rejects paths outside the selected root or sharing only its prefix", () => {
    expect(resolveWorkspaceMessagePath("/zos/data/primary-backup/file.txt", "/zos/data/primary")).toBeNull();
    expect(resolveWorkspaceMessagePath("/private/other/file.txt", "/zos/data/primary")).toBeNull();
    expect(resolveWorkspaceMessagePath("/zos/data/primary/../../etc/passwd", "/zos/data/primary")).toBeNull();
    expect(resolveWorkspaceMessagePath("/zos/data/primary/docs/../../nas/file.txt", "/zos/data/primary")).toBeNull();
    expect(resolveWorkspaceMessagePath("//zos/data/primary/file.txt", "/zos/data/primary")).toBeNull();
    expect(resolveWorkspaceMessagePath("docs/readme.md", "/zos/data/primary")).toBeNull();
  });
});

describe("resolveWorkspaceMessageLink", () => {
  it("decodes Markdown link paths before matching the selected root", () => {
    expect(resolveWorkspaceMessageLink("/zos/data/primary/My%20Files/report.pdf#page=2", "/zos/data/primary")).toEqual({
      displayPath: "/zos/data/primary/My Files/report.pdf",
      workspacePath: "My Files/report.pdf"
    });
    expect(resolveWorkspaceMessageLink("https://example.com/zos/data/primary/file.txt", "/zos/data/primary")).toBeNull();
    expect(resolveWorkspaceMessageLink("//zos/data/primary/file.txt", "/zos/data/primary")).toBeNull();
    expect(resolveWorkspaceMessageLink("%E0%A4%A", "/zos/data/primary")).toBeNull();
  });
});

describe("splitWorkspaceMessagePaths", () => {
  it("separates unquoted and quoted paths while preserving punctuation", () => {
    expect(
      splitWorkspaceMessagePaths(
        'Found /zos/data/primary/docs/readme.md. Open "/zos/data/primary/My Files/report.pdf" next.',
        "/zos/data/primary"
      )
    ).toEqual([
      { kind: "text", value: "Found " },
      {
        kind: "path",
        value: "/zos/data/primary/docs/readme.md",
        displayPath: "/zos/data/primary/docs/readme.md",
        workspacePath: "docs/readme.md"
      },
      { kind: "text", value: '. Open "' },
      {
        kind: "path",
        value: "/zos/data/primary/My Files/report.pdf",
        displayPath: "/zos/data/primary/My Files/report.pdf",
        workspacePath: "My Files/report.pdf"
      },
      { kind: "text", value: '" next.' }
    ]);
  });

  it("keeps a standalone path with spaces together until the line break", () => {
    expect(
      splitWorkspaceMessagePaths("/zos/data/primary/My Files/report (1).pdf\nPlease inspect this file", "/zos/data/primary")
    ).toEqual([
      {
        kind: "path",
        value: "/zos/data/primary/My Files/report (1).pdf",
        displayPath: "/zos/data/primary/My Files/report (1).pdf",
        workspacePath: "My Files/report (1).pdf"
      },
      { kind: "text", value: "\nPlease inspect this file" }
    ]);
  });

  it("leaves external and root-relative paths as text", () => {
    const text = "See /private/other/file.txt and docs/readme.md";
    expect(splitWorkspaceMessagePaths(text, "/zos/data/primary")).toEqual([{ kind: "text", value: text }]);
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
            { type: "text", value: "Open /zos/data/primary/docs/readme.md" },
            { type: "link", url: "/zos/data/primary/linked.md", children: [{ type: "text", value: "/zos/data/primary/linked.md" }] }
          ]
        },
        { type: "code", value: "/zos/data/primary/not-interactive.txt" }
      ]
    };

    remarkWorkspacePaths({ rootPath: "/zos/data/primary" })(tree);

    expect(tree.children[0]).toEqual({
      type: "paragraph",
      children: [
        { type: "text", value: "Open " },
        { type: "inlineCode", value: "/zos/data/primary/docs/readme.md" },
        { type: "link", url: "/zos/data/primary/linked.md", children: [{ type: "text", value: "/zos/data/primary/linked.md" }] }
      ]
    });
    expect(tree.children[1]).toEqual({ type: "code", value: "/zos/data/primary/not-interactive.txt" });
  });
});

describe("workspaceParentPath", () => {
  it("returns a root-relative parent directory", () => {
    expect(workspaceParentPath("docs/reference/file.md")).toBe("docs/reference");
    expect(workspaceParentPath("file.md")).toBe(".");
  });
});

describe("workspaceAbsolutePath", () => {
  it("joins a root-relative path to an absolute NAS root", () => {
    expect(workspaceAbsolutePath("/zos/data/primary", "docs/readme.md")).toBe("/zos/data/primary/docs/readme.md");
    expect(workspaceAbsolutePath("/", "docs/readme.md")).toBe("/docs/readme.md");
    expect(workspaceAbsolutePath("/zos/data/primary/", ".")).toBe("/zos/data/primary");
  });
});
