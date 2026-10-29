import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n/index.js";
import type { DownloadTask } from "../../api.js";
import {
  downloadCreateControlState,
  DownloadTaskRow,
  HttpDownloaderPanel,
  type HttpDownloaderPool
} from "./HttpDownloaderPanel.js";

const mountedPool: HttpDownloaderPool = {
  id: "pool-1",
  name: "Data",
  path: "/cyberos/data/data",
  filesystem: "ext4",
  status: "ready"
};

beforeAll(async () => {
  await initI18n();
});

describe("HttpDownloaderPanel download creation", () => {
  it("does not render a dedicated connection state", () => {
    const html = renderDownloader({ storagePoolsLoading: false, pools: [mountedPool] });
    const header = html.match(/<header[^>]*class="management-header app-titlebar downloads-header"[^>]*>[\s\S]*?<\/header>/u)?.[0] ?? "";

    expect(header).toContain("<h2>Downloads</h2>");
    expect(header).toContain("Queue and monitor public HTTP and HTTPS downloads.");
    expect(header).not.toContain("HTTP transfer");
    expect(header).not.toContain("downloads-connection");
    expect(html).not.toContain("downloads-connection");
  });

  it("renders the full initial skeleton and a stable busy creation control", () => {
    const html = renderDownloader({ storagePoolsLoading: false, pools: [mountedPool] });
    const button = renderDownloadButton({ storagePoolsLoading: false, pools: [mountedPool] });

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="downloads-toolbar downloads-toolbar-skeleton"');
    expect(html).toContain('class="downloads-list downloads-list-skeleton"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('class="downloads-state"');
    expect(html).not.toContain("Unavailable");
    expect(button).toContain("disabled");
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain('aria-label="Loading"');
    expect(button).toContain('title="Loading"');
    expect(button).toContain('data-state="loading"');
    expect(button).toContain("is-spinning");
    expect(visibleButtonText(button)).toBe("");
  });

  it("enables the correct creation behavior after the initial snapshot", () => {
    expect(downloadCreateControlState(true, false, true)).toBe("loading");
    expect(downloadCreateControlState(false, true, true)).toBe("loading");
    expect(downloadCreateControlState(false, false, false)).toBe("needs-storage");
    expect(downloadCreateControlState(false, false, true)).toBe("ready");
  });
});

describe("DownloadTaskRow progress states", () => {
  it("exposes a determinate progressbar with the current percentage", () => {
    const html = renderDownloadRow({ receivedBytes: 25, totalBytes: 100 });

    expect(html).toContain('class="download-task-row" data-status="running"');
    expect(html).toContain('class="download-progress-track" role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain('style="width:25%"');
  });

  it("uses an indeterminate progress state when a running task has no total", () => {
    const html = renderDownloadRow({ receivedBytes: 2_000, totalBytes: null });

    expect(html).toContain('class="download-progress-track is-indeterminate"');
    expect(html).toContain('data-indeterminate="true"');
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain('style="width:36%"');
  });

  it("shows completed tasks as full even when the server has no total", () => {
    const html = renderDownloadRow({ status: "completed", receivedBytes: 2_000, totalBytes: null });

    expect(html).toContain('class="download-task-row" data-status="completed"');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('style="width:100%"');
  });

  it("keeps a distinct status marker for every download state", () => {
    for (const status of ["queued", "running", "paused", "completed", "failed", "cancelled"] as const) {
      expect(renderDownloadRow({ status })).toContain(`data-status="${status}"`);
    }
  });

  it("shows segmented, retry, control, checksum, and stable error details", () => {
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    const html = renderDownloadRow({
      status: "queued",
      phase: "retry_wait",
      downloadMode: "segmented",
      segmentCount: 4,
      retryCount: 2,
      nextRetryAt: retryAt,
      controlRequested: "pause",
      expectedSha256: "a".repeat(64),
      actualSha256: "b".repeat(64),
      errorCode: "checksum_mismatch",
      error: "SHA-256 mismatch"
    });

    expect(html).toContain("Segmented");
    expect(html).toContain("Waiting to retry");
    expect(html).toContain("4 segments");
    expect(html).toContain("Pausing");
    expect(html).toContain("Retry 2 in");
    expect(html).toContain("SHA-256 mismatch");
    expect(html).toContain("Checksum mismatch");
  });
});

function renderDownloadButton({
  storagePoolsLoading,
  pools
}: {
  storagePoolsLoading: boolean;
  pools: HttpDownloaderPool[];
}): string {
  const html = renderDownloader({ storagePoolsLoading, pools });
  const button = html.match(/<button[^>]*class="panel-header-action download-create-button"[^>]*>[\s\S]*?<\/button>/)?.[0];
  expect(button).toBeDefined();
  return button ?? "";
}

function renderDownloader({
  storagePoolsLoading,
  pools
}: {
  storagePoolsLoading: boolean;
  pools: HttpDownloaderPool[];
}): string {
  return renderToStaticMarkup(createElement(HttpDownloaderPanel, {
    pools,
    storagePoolsLoading,
    selectedStoragePoolId: pools[0]?.id ?? "",
    locale: "en",
    onSelectStoragePool: vi.fn(),
    onOpenDirectory: vi.fn(),
    onOpenStorage: vi.fn(),
    onNotifyError: vi.fn(),
    onNotifySuccess: vi.fn(),
    onNotifyWarning: vi.fn()
  }));
}

function visibleButtonText(button: string): string {
  return button.replace(/<[^>]+>/gu, "").trim();
}

const baseTask: DownloadTask = {
  id: "task-1",
  url: "https://example.com/archive.zip",
    storagePoolId: "pool-1",
  targetDirectory: "/cyberos/data/data",
  targetFileName: "archive.zip",
  targetPath: "/cyberos/data/data/archive.zip",
  partialPath: "/cyberos/data/data/.task-1.cyberos-download.part",
  status: "running",
  receivedBytes: 25,
  totalBytes: 100,
  speedBytesPerSecond: 10,
  etag: null,
  lastModified: null,
  error: null,
  workerId: "worker-1",
  leaseExpiresAt: null,
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
  startedAt: "2026-09-24T00:00:00.000Z",
  finishedAt: null,
  lastProgressAt: "2026-09-24T00:00:00.000Z",
  fileOperationId: null,
  phase: "downloading",
  downloadMode: "single",
  expectedSha256: null,
  actualSha256: null,
  errorCode: null,
  errorRetryable: false,
  retryCount: 0,
  nextRetryAt: null,
  controlRequested: null,
  segmentCount: 0
};

function renderDownloadRow(overrides: Partial<DownloadTask> = {}): string {
  return renderToStaticMarkup(createElement(DownloadTaskRow, {
    task: { ...baseTask, ...overrides },
    locale: "en",
    pendingAction: null,
    onAction: vi.fn(),
    onDelete: vi.fn(),
    onOpenDirectory: vi.fn()
  }));
}
