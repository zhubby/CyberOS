import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FileMeta, VodPlayerStatus } from "../../api.js";
import { isPathWithinStoragePool } from "../../App.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { defaultCodeFontSettings } from "../../lib/editor-settings.js";
import {
  defaultWorkspaceSearchOptions,
  hasWorkspaceSearchFilters,
  storagePoolRootDepth,
  WorkspacePane
} from "./WorkspacePane.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("isPathWithinStoragePool", () => {
  it("allows nested paths when the pool is mounted at the storage pool", () => {
    expect(isPathWithinStoragePool("docs/readme.txt", ".")).toBe(true);
    expect(isPathWithinStoragePool("../outside.txt", ".")).toBe(false);
  });

  it("keeps nested pool paths inside their mountpoint", () => {
    expect(isPathWithinStoragePool("pool/docs", "pool")).toBe(true);
    expect(isPathWithinStoragePool("pool-old/docs", "pool")).toBe(false);
    expect(isPathWithinStoragePool("pool/../outside", "pool")).toBe(false);
  });
});

describe("workspace search options", () => {
  it("treats the default relevance sort as an unfiltered file listing", () => {
    expect(hasWorkspaceSearchFilters(defaultWorkspaceSearchOptions())).toBe(false);
  });

  it("detects file type, boundary, and sort filters", () => {
    const defaults = defaultWorkspaceSearchOptions();
    expect(hasWorkspaceSearchFilters({ ...defaults, fileType: "pdf" })).toBe(true);
    expect(hasWorkspaceSearchFilters({ ...defaults, sizeMin: "1024" })).toBe(true);
    expect(hasWorkspaceSearchFilters({ ...defaults, sort: { field: "mtime", direction: "desc" } })).toBe(true);
  });
});

describe("storage pool breadcrumbs", () => {
  it("keeps root-relative breadcrumbs visible for the canonical pool path", () => {
    expect(storagePoolRootDepth(".")).toBe(0);
    expect(storagePoolRootDepth("pool/nested")).toBe(2);
  });
});

const videoMeta: FileMeta = {
  path: "movies/clip.mp4",
  name: "clip.mp4",
  kind: "file",
  mimeType: "video/mp4",
  previewKind: "video",
  sizeBytes: 1024,
  modifiedAt: "2026-11-02T00:00:00.000Z"
};

const playerStatus: VodPlayerStatus = {
  state: "paused",
  sessionId: "session-1",
  serviceInstanceId: "instance-1",
  revision: 1,
  storagePoolId: "pool1",
  relativePath: "movies/clip.mp4",
  fileName: "clip.mp4",
  mediaFileId: null,
  videoOutput: "drm",
  positionSeconds: 30,
  durationSeconds: 120,
  volume: 75,
  retryCount: 0,
  nextRetryAt: null,
  audioDeviceId: null,
  effectiveAudioDeviceId: null,
  audioFallbackReason: null,
  audioTracks: [],
  subtitleTracks: [],
  selectedAudioTrackId: null,
  selectedSubtitleTrackId: null,
  capabilities: { mpvAvailable: true, drmAvailable: true, audioAvailable: true, hardwareDecode: "enabled", error: null },
  error: null,
  errorCode: null,
  updatedAt: "2026-11-02T00:00:00.000Z"
};

function renderPreview(overrides: Partial<ComponentProps<typeof WorkspacePane>> = {}) {
  return renderToStaticMarkup(createElement(WorkspacePane, {
    active: true,
    activePanel: "files",
    onPanelChange: () => undefined,
    selectedStoragePoolId: "pool1",
    storagePools: [{ id: "pool1", name: "pool1", path: ".", mountpoint: "/pool1", filesystem: "btrfs", status: "ready" }],
    storageSummaryLoading: false,
    photoLibrarySettingsUpdatedAt: null,
    currentPath: ".",
    breadcrumbs: [],
    entries: [],
    fileListingLoading: false,
    gitStatus: null,
    selectedFilePath: "movies/clip.mp4",
    previewMeta: videoMeta,
    previewLoading: false,
    previewError: null,
    textPreview: null,
    blobUrl: "/blob",
    videoUrl: "/video",
    vodPlayerStatus: playerStatus,
    vodPlayerBusy: false,
    previewFileSizeLimitBytes: 1024 * 1024,
    searchQuery: "",
    searchOptions: defaultWorkspaceSearchOptions(),
    searchResults: null,
    searchNextCursor: null,
    operations: [],
    fileBatches: [],
    uploadBatches: [],
    dockerOperations: [],
    vmOperations: [],
    operationsReady: true,
    locale: "en",
    codeFontSettings: defaultCodeFontSettings(),
    filesPanelActivationId: 0,
    onSelectStoragePool: vi.fn(),
    onOpenDownloadedDirectory: vi.fn(),
    onGoUp: vi.fn(),
    onRefreshFiles: vi.fn(),
    onSubmitSearch: vi.fn(),
    onSearchQueryChange: vi.fn(),
    onSearchOptionsChange: vi.fn(),
    onApplySearchFilters: vi.fn(),
    onLoadMoreSearchResults: vi.fn(),
    onGoToBreadcrumb: vi.fn(),
    onGoToStoragePool: vi.fn(),
    onOpenEntry: vi.fn(),
    onOpenWorkspacePath: vi.fn(),
    onInsertWorkspacePath: vi.fn(),
    onOpenEditor: vi.fn(),
    onPlayToVodPlayer: vi.fn(),
    onVodPlayerCommand: vi.fn(),
    onRetryVodPlayer: vi.fn(),
    onRequestCreateFolder: vi.fn(),
    onRequestRename: vi.fn(),
    onRequestTrash: vi.fn(),
    onRequestTransfer: vi.fn(),
    onRequestBatch: vi.fn(),
    onRequestExtract: vi.fn(),
    onUploadSources: vi.fn(),
    onCancelUploadBatch: vi.fn(),
    onCancelFileBatch: vi.fn(),
    onWorkQueuesChanged: vi.fn(),
    onNotifyError: vi.fn(),
    onNotifySuccess: vi.fn(),
    onNotifyWarning: vi.fn(),
    onOpenDeviceSettings: vi.fn(),
    onOpenPhotoSettings: vi.fn(),
    onClosePreview: vi.fn(),
    onRollback: vi.fn(),
    ...overrides
  }));
}

describe("file preview NAS playback controls", () => {
  it.each(["unsupported", "text", "image", "audio", "pdf", "document", "spreadsheet", "presentation"] as const)(
    "keeps an existing video session out of a %s preview",
    (previewKind) => {
      const html = renderPreview({
        selectedFilePath: "documents/archive.tar.gz",
        previewMeta: { ...videoMeta, path: "documents/archive.tar.gz", name: "archive.tar.gz", mimeType: "application/gzip", previewKind }
      });
      expect(html).toContain('id="file-preview-title"');
      expect(html.includes('class="vod-player-controls"')).toBe(false);
      expect(html).not.toContain('aria-label="Play on NAS"');
    }
  );

  it("does not control another video with the same filename", () => {
    const html = renderPreview({ vodPlayerStatus: { ...playerStatus, relativePath: "other/clip.mp4" } });
    expect(html.includes('class="vod-player-controls"')).toBe(false);
  });

  it("does not control the same path in another storage pool", () => {
    const html = renderPreview({ vodPlayerStatus: { ...playerStatus, storagePoolId: "pool2" } });
    expect(html.includes('class="vod-player-controls"')).toBe(false);
  });

  it.each([
    { previewLoading: true },
    { previewError: "Preview unavailable" },
    { previewMeta: null },
    { vodPlayerStatus: null }
  ])("hides controls while the current preview is unavailable: %j", (overrides) => {
    expect(renderPreview(overrides).includes('class="vod-player-controls"')).toBe(false);
  });

  it.each(["playing", "paused", "recovering"] as const)("keeps %s controls for the video being previewed", (state) => {
    const html = renderPreview({ vodPlayerStatus: { ...playerStatus, state } });
    expect(html.includes('class="vod-player-controls"')).toBe(true);
    expect(html).toContain("clip.mp4");
  });

  it("does not label an unsupported file with a playback icon", () => {
    const html = renderPreview({ previewMeta: { ...videoMeta, previewKind: "unsupported" }, vodPlayerStatus: null });
    expect(html.includes('lucide-play"')).toBe(false);
  });
});


function filePaneProps(): ComponentProps<typeof WorkspacePane> {
  const noop = () => undefined;
  const complete = async () => undefined;
  return {
    active: true,
    activePanel: "files",
    onPanelChange: noop,
    selectedStoragePoolId: "pool-1",
    storagePools: [{ id: "pool-1", name: "NAS", mountpoint: "/cyberos/data", path: ".", filesystem: "ext4", status: "ready" }],
    storageSummaryLoading: false,
    photoLibrarySettingsUpdatedAt: null,
    currentPath: "documents",
    breadcrumbs: ["documents"],
    entries: [{ name: "Projects", path: "documents/Projects", kind: "directory", sizeBytes: 0, modifiedAt: "2026-11-01T00:00:00Z", isSafe: true }],
    fileListingLoading: false,
    gitStatus: null,
    selectedFilePath: null,
    previewMeta: null,
    previewLoading: false,
    previewError: null,
    textPreview: null,
    blobUrl: "",
    videoUrl: "",
    vodPlayerStatus: null,
    vodPlayerBusy: false,
    previewFileSizeLimitBytes: 1048576,
    searchQuery: "",
    searchOptions: defaultWorkspaceSearchOptions(),
    searchResults: null,
    searchNextCursor: null,
    operations: [],
    fileBatches: [],
    uploadBatches: [],
    dockerOperations: [],
    vmOperations: [],
    operationsReady: true,
    locale: "en",
    codeFontSettings: defaultCodeFontSettings(),
    filesPanelActivationId: 0,
    onSelectStoragePool: noop,
    onOpenDownloadedDirectory: noop,
    onGoUp: noop,
    onRefreshFiles: noop,
    onSubmitSearch: noop,
    onSearchQueryChange: noop,
    onSearchOptionsChange: noop,
    onApplySearchFilters: noop,
    onLoadMoreSearchResults: noop,
    onGoToBreadcrumb: noop,
    onGoToStoragePool: noop,
    onOpenEntry: noop,
    onOpenWorkspacePath: noop,
    onInsertWorkspacePath: noop,
    onOpenEditor: noop,
    onPlayToVodPlayer: noop,
    onVodPlayerCommand: noop,
    onRetryVodPlayer: noop,
    onRequestCreateFolder: complete,
    onRequestRename: complete,
    onRequestTrash: complete,
    onRequestTransfer: complete,
    onRequestBatch: complete,
    onRequestExtract: complete,
    onUploadSources: noop,
    onCancelUploadBatch: noop,
    onCancelFileBatch: noop,
    onWorkQueuesChanged: noop,
    onNotifyError: noop,
    onNotifySuccess: noop,
    onNotifyWarning: noop,
    onOpenDeviceSettings: noop,
    onOpenPhotoSettings: noop,
    onClosePreview: noop,
    onRollback: noop
  };
}

describe("file directory loading", () => {
  it("keeps navigation and the current rows visible while a directory is loading", async () => {
    await initI18n();
    const html = renderToStaticMarkup(createElement(WorkspacePane, { ...filePaneProps(), fileListingLoading: true }));
    expect(html).toContain('id="storage-pool-switcher"');
    expect(html).toContain('class="breadcrumbs files-content-breadcrumbs"');
    expect(html).toContain('>documents</span>');
    expect(html).toContain('class="file-row file-row-head"');
    expect(html).toContain('class="file-name-text">Projects</span>');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="file-list-entries" role="rowgroup" inert=""');
    expect(html).not.toContain('files-skeleton-');
    expect(html).not.toContain('file-list-skeleton');
  });

  it("releases file controls after loading, including an empty directory", async () => {
    await initI18n();
    const html = renderToStaticMarkup(createElement(WorkspacePane, { ...filePaneProps(), entries: [] }));
    expect(html).toContain('class="file-list-entries" role="rowgroup"');
    expect(html).not.toContain('aria-busy="true"');
    expect(html).not.toContain('inert=""');
    expect(html).not.toContain('file-list-loading');
  });
});
