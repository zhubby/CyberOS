import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsIndexerPage } from "./SettingsIndexerPage.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("SettingsIndexerPage", () => {
  it("shows worker limits, daemon state, OCR roots, and rebuild controls", () => {
    const html = renderToStaticMarkup(createElement(SettingsIndexerPage, {
      settings: {
        scanConcurrency: 4,
        extractionConcurrency: 2,
        reconciliationIntervalMs: 1_800_000,
        maxExtractedTextBytes: 2 * 1024 ** 2,
        maxSourceDocumentBytes: 512 * 1024 ** 2,
        commandTimeoutMs: 120_000,
        maxPdfTextPages: 500,
        maxOcrPages: 20,
        ocrRootIds: ["nas"],
        updatedAt: "2026-10-12T00:00:00.000Z"
      },
      status: {
        roots: [],
        service: { status: "ready", freshWorkers: 1, lastHeartbeatAt: "2026-10-12T00:00:00.000Z" },
        watcher: { status: "ready", degradedRoots: [], reason: null },
        queue: { queued: 2, running: 1, retrying: 0, failed: 0, oldestQueuedAt: null, stalled: false },
        rebuild: { status: "rebuilding", copied: 75, total: 100, rootsReady: 0, rootsTotal: 1 }
      },
      roots: [{ id: "nas", name: "Primary NAS", path: "/zos/data/primary", homePath: null }],
      loading: false,
      locale: "en",
      onSettingsChange: vi.fn(),
      onReindex: vi.fn(),
      onClose: vi.fn()
    }));

    expect(html).toContain("Scan concurrency");
    expect(html).toContain("Extraction concurrency");
    expect(html).toContain("Primary NAS");
    expect(html).toContain("/zos/data/primary");
    expect(html).toContain("OCR");
    expect(html).toContain("Rebuild");
    expect(html).toContain("2 queued · 1 running · 0 failed");
    expect(html).toContain("75 / 100 copied");
  });
});
