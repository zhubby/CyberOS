import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DockerImageSummary } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { DockerImageDetailsDialog, DockerImageManagement } from "./DockerImageManagement.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

function image(name: string, id: string, containerCount: number | null): DockerImageSummary {
  return {
    id,
    shortId: id.replace(/^sha256:/u, "").slice(0, 12),
    tags: [name],
    digests: [],
    createdAt: null,
    sizeBytes: 1024,
    sharedSizeBytes: null,
    architecture: "arm64",
    containerCount
  };
}

describe("DockerImageManagement", () => {
  it("renders architecture and three-state usage without container counts", () => {
    const html = renderToStaticMarkup(createElement(DockerImageManagement, {
      images: [
        image("team/used:latest", "sha256:used", 7),
        image("team/unused:latest", "sha256:unused", 0),
        image("team/unknown:latest", "sha256:unknown", null)
      ],
      engineReady: true,
      engineError: null,
      locale: "en",
      onRefreshSummary: vi.fn(),
      onNotifySuccess: vi.fn(),
      onNotifyError: vi.fn()
    }));

    expect(html).toContain("Architecture");
    expect(html).toContain("Usage");
    expect(html).toContain("arm64");
    expect(html).toContain("In use");
    expect(html).toContain("Unused");
    expect(html).toContain("Unknown");
    expect(html).not.toContain("Containers");
    expect(html).not.toContain(">7<");
  });
});

describe("DockerImageDetailsDialog", () => {
  it("shows architecture and usage while keeping occupancy counts private", () => {
    const target = image("team/app:latest", "sha256:abcdef", 7);
    const html = renderToStaticMarkup(createElement(DockerImageDetailsDialog, {
      image: target,
      locale: "en",
      engineReady: true,
      deleteReference: target.tags[0]!,
      deleteConfirming: false,
      deleting: false,
      error: null,
      onDeleteReference: vi.fn(),
      onBeginDelete: vi.fn(),
      onCancelDelete: vi.fn(),
      onConfirmDelete: vi.fn(),
      onClose: vi.fn()
    }));

    expect(html).toContain("Architecture");
    expect(html).toContain("arm64");
    expect(html).toContain("Usage");
    expect(html).toContain("In use");
    expect(html).not.toContain("Containers");
    expect(html).not.toContain(">7<");
  });
});
