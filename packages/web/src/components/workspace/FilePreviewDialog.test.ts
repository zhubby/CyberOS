import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FileMeta } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { FilePreviewDialog } from "./FilePreviewDialog.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

const meta: FileMeta = {
  path: "documents/report.txt",
  name: "report.txt",
  kind: "file",
  mimeType: "text/plain",
  previewKind: "text",
  sizeBytes: 6,
  modifiedAt: "2026-10-14T00:00:00.000Z"
};

describe("FilePreviewDialog", () => {
  it("renders preview content in a modal without a download action", () => {
    const html = renderToStaticMarkup(createElement(FilePreviewDialog, {
      title: meta.name,
      meta,
      loading: false,
      error: null,
      textPreview: {
        path: meta.path,
        content: "report",
        truncated: false,
        maxBytes: 1024
      },
      blobUrl: "/api/files/blob?path=documents%2Freport.txt",
      videoUrl: "",
      storagePoolId: "local",
      previewFileSizeLimitBytes: 1024,
      locale: "en",
      onOpenWorkspacePath: vi.fn(),
      onClose: vi.fn()
    }));

    expect(html).toContain('class="file-preview-backdrop"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("report.txt");
    expect(html).not.toContain("download=");
  });
});
