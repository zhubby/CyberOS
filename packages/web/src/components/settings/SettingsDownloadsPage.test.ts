import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n/index.js";
import { SettingsDownloadsPage } from "./SettingsModal.js";

beforeAll(async () => {
  await initI18n();
});

describe("SettingsDownloadsPage", () => {
  it("exposes concurrency, segmentation, retry, timeout, and storage reliability settings", () => {
    const html = renderToStaticMarkup(createElement(SettingsDownloadsPage, {
      settings: {
        concurrency: 10,
        btConcurrency: 3,
        defaultStoragePoolId: "pool-1",
        defaultTargetDirectory: "Downloads",
        parallelRequestsPerTask: 4,
        segmentedDownloadMinBytes: 64 * 1024 * 1024,
        maxAutoRetries: 5,
        retryBaseDelayMs: 2_000,
        retryMaxDelayMs: 300_000,
        retryAfterMaxDelayMs: 900_000,
        connectTimeoutMs: 15_000,
        responseHeaderTimeoutMs: 30_000,
        readIdleTimeoutMs: 60_000,
        minFreeSpaceBytes: 0,
        maxFileSizeBytes: null,
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      loading: false,
      storagePools: [{ id: "pool-1", name: "Data", path: ".", filesystem: "ext4", status: "ready" }],
      locale: "en",
      onSettingsChange: vi.fn(),
      onClose: vi.fn()
    }));

    expect(html).toContain("10 connection");
    expect(html).toContain("Concurrent BitTorrent downloads");
    expect(html).toContain("Default download directory");
    expect(html).toContain("Downloads");
    expect(html).toContain("Range requests per task");
    expect(html).toContain("Segmentation threshold (bytes)");
    expect(html).toContain("Maximum automatic retries");
    expect(html).toContain("Response header timeout (ms)");
    expect(html).toContain("Minimum free space (bytes)");
    expect(html).toContain("Maximum file size (bytes)");
    expect(html).not.toContain("Download runtime");
    expect(html).not.toContain("Resume when supported");
  });
});
