import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PhotostaffAsset, PhotostaffMapSettingsResponse } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import {
  groupPhotostaffByDate,
  isPhotostaffBusy,
  photostaffMediaKindForAsset,
  PhotostaffLibraryPanel,
  PHOTOSTAFF_ACCEPT,
  readyPhotostaffQueryFilters,
  retryCountdown,
  togglePhotostaffFacetValue
} from "./PhotostaffLibraryPanel.js";
import {
  mapArchiveReady,
  PhotostaffMapDownloadPanel,
  photostaffViewportBounds
} from "./PhotostaffMapView.js";
import { PHOTOSTAFF_UPLOAD_EXTENSIONS } from "@sigmaos/shared/photostaff-config";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("Photostaff offline map states", () => {
  it("renders download, progress, failure retry, and ready states", () => {
    const render = (status: PhotostaffMapSettingsResponse, requestError: string | null = null) => renderToStaticMarkup(
      createElement(PhotostaffMapDownloadPanel, {
        status,
        requestError,
        busy: false,
        onDownload: () => undefined
      })
    );
    const initial = mapStatus("not_downloaded");
    expect(render(initial)).toContain("Download offline map");
    const busyHtml = renderToStaticMarkup(createElement(PhotostaffMapDownloadPanel, {
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
    const html = renderToStaticMarkup(createElement(PhotostaffMapDownloadPanel, {
      status: mapStatus("not_downloaded"),
      requestError: null,
      busy: false,
      onDownload: () => undefined
    }));
    expect(html).toContain("下载离线地图");
    await i18n.changeLanguage("en");
  });
});

describe("photostaff timeline grouping", () => {
  it("allows selecting multiple media files for upload", () => {
    const html = renderToStaticMarkup(createElement(PhotostaffLibraryPanel, {
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
    expect(PHOTOSTAFF_ACCEPT.split(",")).toEqual([...PHOTOSTAFF_UPLOAD_EXTENSIONS]);
  });

  it("toggles multiple values within one facet as an OR set", () => {
    expect(togglePhotostaffFacetValue(["Alpha 1"], "Alpha 7")).toEqual(["Alpha 1", "Alpha 7"]);
    expect(togglePhotostaffFacetValue(["Alpha 1", "Alpha 7"], "Alpha 1")).toEqual(["Alpha 7"]);
    expect(togglePhotostaffFacetValue(["Alpha 1"], "Alpha 1")).toBeUndefined();
  });

  it("classifies video and RAW assets for timeline presentation", () => {
    expect(photostaffMediaKindForAsset(photostaff("clip", "2026-09-22T12:00:00.000Z", "clip.mkv", "video/x-matroska"))).toBe("video");
    expect(photostaffMediaKindForAsset(photostaff("raw", "2026-09-22T12:00:00.000Z", "camera.cr3", "image/x-canon-cr3"))).toBe("raw");
    expect(photostaffMediaKindForAsset(photostaff("still", "2026-09-22T12:00:00.000Z"))).toBe("image");
  });

  it("keeps chronological input order while grouping photostaff by local calendar day", () => {
    const assets = [
      photostaff("newest", "2026-09-22T12:00:00.000Z"),
      photostaff("same-day", "2026-09-22T08:00:00.000Z"),
      photostaff("older", "2026-09-20T12:00:00.000Z")
    ];

    const groups = groupPhotostaffByDate(assets, "en");

    expect(groups).toHaveLength(2);
    expect(groups[0]?.photostaff.map((item) => item.id)).toEqual(["newest", "same-day"]);
    expect(groups[1]?.photostaff.map((item) => item.id)).toEqual(["older"]);
  });

  it("falls back to file modification time for invalid dates", () => {
    const asset = photostaff("fallback", "invalid");
    asset.mtimeMs = Date.parse("2026-06-15T12:00:00.000Z");

    expect(groupPhotostaffByDate([asset], "en")[0]?.key).toMatch(/^2026-06-1[45]$/u);
  });

  it("groups indexed photostaff by their original wall-clock date", () => {
    const asset = {
      ...photostaff("wall-clock", "2026-06-15T23:00:00.000Z"),
      metadata: { capturedAtLocal: "2026-06-16T07:00:00" }
    };

    expect(groupPhotostaffByDate([asset], "en")[0]?.key).toBe("2026-06-16");
  });

  it("keeps incomplete advanced conditions editable without sending invalid queries", () => {
    expect(readyPhotostaffQueryFilters({
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
      isPhotostaffBusy(state as "queued" | "discovering" | "processing" | "retrying")
    )).toBe(true);
    expect(isPhotostaffBusy("ready")).toBe(false);
    expect(retryCountdown("2026-09-22T12:01:05.000Z", Date.parse("2026-09-22T12:00:00.000Z"))).toBe("1m 5s");
  });

  it("coerces advanced numeric and boolean values using the metadata field catalog", () => {
    expect(readyPhotostaffQueryFilters({
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
    expect(photostaffViewportBounds(-180, -85, 180, 85)).toEqual({
      kind: "bounds", west: -180, south: -85, east: 180, north: 85
    });
    expect(photostaffViewportBounds(170, -10, 190, 10)).toEqual({
      kind: "bounds", west: 170, south: -10, east: -170, north: 10
    });
    expect(photostaffViewportBounds(0, -10, 180, 10)).toEqual({
      kind: "bounds", west: 0, south: -10, east: 180, north: 10
    });
  });
});

function mapStatus(
  state: PhotostaffMapSettingsResponse["download"]["state"],
  overrides: Partial<PhotostaffMapSettingsResponse["download"]> = {}
): PhotostaffMapSettingsResponse {
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

function photostaff(id: string, takenAt: string, name = `${id}.jpg`, mimeType = "image/jpeg"): PhotostaffAsset {
  return {
    id,
    rootId: "local",
    storagePoolId: "pool-a",
    path: `Photostaff/${name}`,
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
