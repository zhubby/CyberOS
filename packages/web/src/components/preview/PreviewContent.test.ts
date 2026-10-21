import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileMeta, TextPreview } from "../../api.js";
import { PreviewContent } from "./PreviewContent.js";

const markdownMeta: FileMeta = {
  path: "docs/CLAUDE.md",
  name: "CLAUDE.md",
  kind: "file",
  mimeType: "text/plain",
  previewKind: "text",
  sizeBytes: 128,
  modifiedAt: "2026-09-01T00:00:00.000Z"
};

const markdownPreview: TextPreview = {
  path: markdownMeta.path,
  content: ["[local](./AGENTS.md)", "", "[external](https://example.com/docs)"].join("\n"),
  truncated: false,
  maxBytes: 64 * 1024
};

describe("PreviewContent Markdown links", () => {
  it("keeps internal links in the workspace and external links in a new tab", () => {
    const html = renderToStaticMarkup(
      createElement(PreviewContent, {
        blobUrl: "",
        videoUrl: "",
        rootId: "root-1",
        loading: false,
        meta: markdownMeta,
        error: null,
        textPreview: markdownPreview,
        previewFileSizeLimitBytes: 64 * 1024,
        locale: "en",
        onOpenWorkspacePath: vi.fn()
      })
    );

    expect(html).toContain('<a href="./AGENTS.md">local</a>');
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noreferrer">external</a>');
    expect(html).not.toContain('href="./AGENTS.md" target="_blank"');
  });
});

describe("PreviewContent Office files", () => {
  it.each([
    ["document", "report.docx"],
    ["spreadsheet", "budget.xlsx"],
    ["presentation", "roadmap.pptx"]
  ] as const)("mounts the %s renderer for %s", (previewKind, name) => {
    const html = renderToStaticMarkup(
      createElement(PreviewContent, {
        blobUrl: `/api/files/blob?path=${name}`,
        videoUrl: "",
        rootId: "root-1",
        loading: false,
        meta: {
          ...markdownMeta,
          path: name,
          name,
          mimeType: "application/octet-stream",
          previewKind
        },
        error: null,
        textPreview: null,
        previewFileSizeLimitBytes: 64 * 1024,
        locale: "en",
        onOpenWorkspacePath: vi.fn()
      })
    );

    expect(html).toContain(`office-${previewKind}-preview`);
    expect(html).toContain("preview.officeLoading");
    expect(html).not.toContain("cannot be previewed inline");
  });
});
