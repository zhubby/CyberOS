import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PhotoAsset, PhotoMapSettingsResponse } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import {
  groupPhotosByDate,
  isPhotoBusy,
  photoMediaKindForAsset,
  PhotoLibraryPanel,
  photoLibraryLoadMode,
  PHOTO_ACCEPT,
  readyPhotoQueryFilters,
  retryCountdown,
  togglePhotoFacetValue
} from "./PhotoLibraryPanel.js";
import {
  configureMapLibreWorker,
  mapArchiveReady,
  PhotoMapDownloadPanel,
  photoViewportBounds
} from "./PhotoMapView.js";
import { PHOTOSTAFF_UPLOAD_EXTENSIONS } from "@zos/shared/photostaff-config";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("Photo offline map states", () => {
  it("configures MapLibre to load its packaged worker asset", () => {
    let configuredUrl = "";

    configureMapLibreWorker({
      setWorkerUrl: (url) => {
        configuredUrl = url;
      }
    });

    expect(configuredUrl).toContain("maplibre-gl-worker.mjs");
  });

  it("renders download, progress, failure retry, and ready states", () => {
    const render = (status: PhotoMapSettingsResponse, requestError: string | null = null) => renderToStaticMarkup(
      createElement(PhotoMapDownloadPanel, {
        status,
        requestError,
        busy: false,
        onDownload: () => undefined
      })
    );
    const initial = mapStatus("not_downloaded");
    expect(render(initial)).toContain("Download offline map");
    const busyHtml = renderToStaticMarkup(createElement(PhotoMapDownloadPanel, {
      status: initial,
      requestError: null,
      busy: true,
      onDownload: () => undefined
    }));
    expect(busyHtml).toContain('class="primary-button"');
    expect(busyHtml).toContain('disabled=""');
    expect(busyHtml).toContain('aria-busy="true"');

    const downloading = mapStatus("downloading", { receivedBytes: 50, totalBytes: 100 });
    const progressHtml = render(downloading);
    expect(progressHtml).toContain('role="progressbar"');
    expect(progressHtml).toContain('aria-valuenow="50"');

    const failed = mapStatus("failed", { error: "Checksum mismatch" });
    const failedHtml = render(failed);
    expect(failedHtml).toContain("Checksum mismatch");
    expect(failedHtml).toContain("Retry");

    const ready = mapStatus("ready");
    ready.settings = {
      ...ready.map,
      tileType: "jpeg",
      minZoom: 0,
      maxZoom: 6,
      bounds: [-180, -85, 180, 85],
      updatedAt: "2026-10-13T00:00:00.000Z"
    };
    expect(mapArchiveReady(ready)).toBe(true);
    expect(render(ready)).toBe("");
  });

  it("renders the managed download action in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    const html = renderToStaticMarkup(createElement(PhotoMapDownloadPanel, {
      status: mapStatus("not_downloaded"),
      requestError: null,
      busy: false,
      onDownload: () => undefined
    }));
    expect(html).toContain("下载离线地图");
    await i18n.changeLanguage("en");
  });
});

describe("photo timeline grouping", () => {
  it("renders the full library skeleton instead of an initial centered spinner", () => {
    const html = renderToStaticMarkup(createElement(PhotoLibraryPanel, {
      pools: [],
      selectedRootId: "local",
      sessionId: null,
      approvalRefreshKey: "",
      locale: "en",
      onWorkQueuesChanged: () => undefined,
      onNotifyError: () => undefined,
      onNotifySuccess: () => undefined,
      onNotifyWarning: () => undefined
    }));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("photo-library-bar-skeleton");
    expect(html).toContain("photo-query-panel-skeleton");
    expect(html).toContain("photo-timeline-skeleton");
    expect(html).toContain('role="status"');
    expect(html).not.toContain('class="workspace-empty-state"');
  });

  it("shows initial failures but preserves loaded content across later refresh failures", () => {
    expect(photoLibraryLoadMode(false, false, null)).toBe("loading");
    expect(photoLibraryLoadMode(true, false, "Unavailable")).toBe("error");
    expect(photoLibraryLoadMode(true, true, null)).toBe("content");
    expect(photoLibraryLoadMode(true, true, "Refresh failed")).toBe("content");
  });

  it("allows selecting multiple media files for upload", () => {
    const html = renderToStaticMarkup(createElement(PhotoLibraryPanel, {
      pools: [],
      selectedRootId: "local",
      sessionId: null,
      approvalRefreshKey: "",
      locale: "en",
      onWorkQueuesChanged: () => undefined,
      onNotifyError: () => undefined,
      onNotifySuccess: () => undefined,
      onNotifyWarning: () => undefined
    }));

    expect(html).toMatch(/<input(?=[^>]*type="file")(?=[^>]*multiple="")[^>]*>/u);
  });

  it("uses the shared media and XMP extension list for upload filtering", () => {
    expect(PHOTO_ACCEPT.split(",")).toEqual([...PHOTOSTAFF_UPLOAD_EXTENSIONS]);
  });

  it("toggles multiple values within one facet as an OR set", () => {
    expect(togglePhotoFacetValue(["Alpha 1"], "Alpha 7")).toEqual(["Alpha 1", "Alpha 7"]);
    expect(togglePhotoFacetValue(["Alpha 1", "Alpha 7"], "Alpha 1")).toEqual(["Alpha 7"]);
    expect(togglePhotoFacetValue(["Alpha 1"], "Alpha 1")).toBeUndefined();
  });

  it("classifies video and RAW assets for timeline presentation", () => {
    expect(photoMediaKindForAsset(photo("clip", "2026-09-22T12:00:00.000Z", "clip.mkv", "video/x-matroska"))).toBe("video");
    expect(photoMediaKindForAsset(photo("raw", "2026-09-22T12:00:00.000Z", "camera.cr3", "image/x-canon-cr3"))).toBe("raw");
    expect(photoMediaKindForAsset(photo("still", "2026-09-22T12:00:00.000Z"))).toBe("image");
  });

  it("keeps chronological input order while grouping photos by local calendar day", () => {
    const assets = [
      photo("newest", "2026-09-22T12:00:00.000Z"),
      photo("same-day", "2026-09-22T08:00:00.000Z"),
      photo("older", "2026-09-20T12:00:00.000Z")
    ];

    const groups = groupPhotosByDate(assets, "en");

    expect(groups).toHaveLength(2);
    expect(groups[0]?.photos.map((item) => item.id)).toEqual(["newest", "same-day"]);
    expect(groups[1]?.photos.map((item) => item.id)).toEqual(["older"]);
  });

  it("falls back to file modification time for invalid dates", () => {
    const asset = photo("fallback", "invalid");
    asset.mtimeMs = Date.parse("2026-06-15T12:00:00.000Z");

    expect(groupPhotosByDate([asset], "en")[0]?.key).toMatch(/^2026-06-1[45]$/u);
  });

  it("groups indexed photos by their original wall-clock date", () => {
    const asset = {
      ...photo("wall-clock", "2026-06-15T23:00:00.000Z"),
      metadata: { capturedAtLocal: "2026-06-16T07:00:00" }
    };

    expect(groupPhotosByDate([asset], "en")[0]?.key).toBe("2026-06-16");
  });

  it("keeps incomplete advanced conditions editable without sending invalid queries", () => {
    expect(readyPhotoQueryFilters({
      text: "coast",
      advanced: {
        mode: "all",
        conditions: [
          { key: "exif.ISO", operator: "between", value: "100" },
          { key: "xmp.dc.creator", operator: "exists" },
          { key: "exif.Model", operator: "contains", value: "" }
        ]
      }
    })).toEqual({
      text: "coast",
      advanced: { mode: "all", conditions: [{ key: "xmp.dc.creator", operator: "exists" }] }
    });
  });

  it("treats discovery, processing, and retry waits as active work", () => {
    expect(["queued", "discovering", "processing", "retrying"].every((state) =>
      isPhotoBusy(state as "queued" | "discovering" | "processing" | "retrying")
    )).toBe(true);
    expect(isPhotoBusy("ready")).toBe(false);
    expect(retryCountdown("2026-09-22T12:01:05.000Z", Date.parse("2026-09-22T12:00:00.000Z"))).toBe("1m 5s");
  });

  it("coerces advanced numeric and boolean values using the metadata field catalog", () => {
    expect(readyPhotoQueryFilters({
      advanced: {
        mode: "all",
        conditions: [
          { key: "exif.ISO", operator: "between", value: "100", valueTo: "800" },
          { key: "xmp.Flagged", operator: "eq", value: "false" }
        ]
      }
    }, [
      { key: "exif.ISO", valueType: "number", count: 1, sensitive: false },
      { key: "xmp.Flagged", valueType: "boolean", count: 1, sensitive: false }
    ])).toEqual({
      advanced: {
        mode: "all",
        conditions: [
          { key: "exif.ISO", operator: "between", value: 100, valueTo: 800 },
          { key: "xmp.Flagged", operator: "eq", value: false }
        ]
      }
    });
  });

  it("keeps whole-world and antimeridian map viewports queryable", () => {
    expect(photoViewportBounds(-180, -85, 180, 85)).toEqual({
      kind: "bounds", west: -180, south: -85, east: 180, north: 85
    });
    expect(photoViewportBounds(170, -10, 190, 10)).toEqual({
      kind: "bounds", west: 170, south: -10, east: -170, north: 10
    });
    expect(photoViewportBounds(0, -10, 180, 10)).toEqual({
      kind: "bounds", west: 0, south: -10, east: 180, north: 10
    });
  });
});

function mapStatus(
  state: PhotoMapSettingsResponse["download"]["state"],
  overrides: Partial<PhotoMapSettingsResponse["download"]> = {}
): PhotoMapSettingsResponse {
  return {
    map: {
      name: "Natural Earth II",
      version: "3.2.0",
      attribution: "Made with Natural Earth",
      sizeBytes: 100
    },
    settings: null,
    download: {
      state,
      receivedBytes: state === "ready" ? 100 : 0,
      totalBytes: 100,
      error: null,
      ...overrides
    }
  };
}

function photo(id: string, takenAt: string, name = `${id}.jpg`, mimeType = "image/jpeg"): PhotoAsset {
  return {
    id,
    rootId: "local",
    storagePoolId: "pool-a",
    path: `Photo/${name}`,
    name,
    mimeType,
    sizeBytes: 100,
    mtimeMs: 0,
    contentHash: id,
    width: 40,
    height: 20,
    orientation: 1,
    takenAt,
    takenAtSource: "exif",
    thumbnailKey: `thumbnail/${id}.webp`,
    previewKey: `preview/${id}.webp`,
    status: "ready",
    error: null,
    errorCode: null,
    errorRetryable: false,
    derivativeSchemaVersion: 1,
    indexedAt: "2026-09-22T12:00:00.000Z"
  };
}
