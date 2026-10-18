import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsPhotosPage } from "./SettingsModal.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("SettingsPhotosPage", () => {
  it("renders the library location and editable processing, retry, and resource controls", () => {
    const html = renderToStaticMarkup(createElement(SettingsPhotosPage, {
      settings: {
        rootId: "nas",
        storagePoolId: "pool-a",
        path: "Pictures/Library",
        updatedAt: "2026-09-24T06:00:00.000Z"
      },
      status: {
        state: "ready",
        total: 42,
        failed: 1,
        scanned: 50,
        processed: 43,
        currentPath: null,
        phase: null,
        error: null,
        errorCode: null,
        retryCount: 0,
        nextRetryAt: null,
        updatedAt: "2026-09-24T06:10:00.000Z"
      },
      processingSettings: processingSettings(),
      loading: false,
      onSettingsChange: async () => undefined,
      onClose: () => undefined
    }));

    expect(html).toContain("Pictures/Library");
    expect(html).toContain("Processing concurrency");
    expect(html).toContain("Retry Policy");
    expect(html).toContain("Resource Limits");
    expect(html).toContain("Maximum intermediate bytes");
    expect(html).not.toContain("pool-a");
    expect(html).not.toContain("Worker Health");
    expect(html).not.toContain("Runtime Capabilities");
    expect(html).not.toContain("Supported formats");
  });

  it("shows an explicit unconfigured state without inventing library paths", () => {
    const html = renderToStaticMarkup(createElement(SettingsPhotosPage, {
      settings: null,
      status: {
        state: "unconfigured",
        total: 0,
        failed: 0,
        scanned: 0,
        processed: 0,
        currentPath: null,
        phase: null,
        error: null,
        errorCode: null,
        retryCount: 0,
        nextRetryAt: null,
        updatedAt: null
      },
      processingSettings: null,
      loading: false,
      onSettingsChange: async () => undefined,
      onClose: () => undefined
    }));

    expect(html).toContain("Not configured");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("undefined");
  });

  it("does not represent an unavailable status endpoint as zero activity", () => {
    const html = renderToStaticMarkup(createElement(SettingsPhotosPage, {
      settings: {
        rootId: "nas",
        storagePoolId: "pool-a",
        path: "Pictures",
        updatedAt: "2026-09-24T06:00:00.000Z"
      },
      status: null,
      processingSettings: null,
      loading: false,
      onSettingsChange: async () => undefined,
      onClose: () => undefined
    }));

    expect(html).toContain("Unavailable");
    expect(html).not.toContain(">0<");
  });
});

function processingSettings() {
  return {
    processingConcurrency: 1,
    scanIntervalMs: 1_800_000,
    maxAutoRetries: 5,
    retryBaseDelayMs: 2_000,
    retryMaxDelayMs: 300_000,
    commandTimeoutMs: 120_000,
    maxFileSizeBytes: 512 * 1024 ** 2,
    maxXmpSizeBytes: 16 * 1024 ** 2,
    maxIntermediateBytes: 2 * 1024 ** 3,
    minFreeSpaceBytes: 0,
    maxDecodedPixels: 268_402_689,
    updatedAt: "2026-09-24T06:00:00.000Z"
  } as const;
}
