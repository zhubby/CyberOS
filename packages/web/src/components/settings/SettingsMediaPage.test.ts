import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsMediaContent } from "./SettingsMediaPage.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("SettingsMediaContent", () => {
  it("renders write-only TMDB settings, sources, scans, and match correction", () => {
    const html = renderToStaticMarkup(createElement(SettingsMediaContent, {
      data: {
        settings: { tmdbTokenConfigured: true, language: "zh-CN", region: "CN", updatedAt: "2026-10-21T00:00:00.000Z" },
        sources: [{
          id: "source-1", name: "Movies", kind: "movie",  storagePoolId: "pool-1",
          path: "Media/Movies", enabled: true, createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z"
        }],
        status: { state: "ready", sources: 1, titles: 1, movies: 1, series: 0, unmatched: 1, activeScan: null, latestScan: null },
        scans: [{
          id: "scan-1", sourceId: "source-1", status: "completed", generation: "g1", scanned: 1, added: 1,
          updated: 0, removed: 0, unmatched: 1, currentPath: null, error: null, workerId: null, leaseExpiresAt: null,
          createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z", startedAt: null, finishedAt: null
        }],
        unmatched: [{
          id: "title-1", sourceId: "source-1", kind: "movie", sourcePath: "Media/Movies/Arrival", tmdbId: null,
          title: "Arrival", originalTitle: null, overview: null, year: 2016, releaseDate: null, runtimeMinutes: null,
          originalLanguage: null, genres: [], metadataSource: "filename", matchStatus: "unmatched", matchConfidence: null,
          posterKey: null, backdropKey: null, addedAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z", progress: null
        }],
        tvStatus: {
          enabled: true,
          state: "ready",
          weston: { state: "ready", detail: "wayland-0", updatedAt: "2026-10-21T00:00:00.000Z" },
          chromium: { state: "ready", detail: "/tv/", updatedAt: "2026-10-21T00:00:00.000Z" },
          vodPlayer: { state: "ready", detail: "idle", updatedAt: "2026-10-21T00:00:00.000Z" },
          cec: { state: "degraded", detail: "Keyboard input remains available", updatedAt: "2026-10-21T00:00:00.000Z" },
          gamepad: { state: "degraded", detail: "No supported gamepad connected", updatedAt: "2026-10-21T00:00:00.000Z" },
          updatedAt: "2026-10-21T00:00:00.000Z"
        },
        tvSettings: {
          enabled: true,
          videoOutput: "wayland",
          drmConnector: "HDMI-A-1",
          audioDevice: "default",
          hardwareDecoding: "auto-safe",
          updatedAt: "2026-10-21T00:00:00.000Z"
        }
      },
      busy: null,
      deleteId: null,
      selectedTitleId: "title-1",
      candidates: [{ tmdbId: 329865, kind: "movie", title: "Arrival", originalTitle: "Arrival", overview: "First contact", year: 2016, releaseDate: "2016-11-11", originalLanguage: "en", posterUrl: null, backdropUrl: null, popularity: 42 }],
      candidateQuery: "Arrival",
      tmdbToken: "",
      clearTmdbToken: false,
      language: "zh-CN",
      region: "CN",
      onTmdbTokenChange: vi.fn(), onClearTmdbTokenChange: vi.fn(), onLanguageChange: vi.fn(), onRegionChange: vi.fn(),
      onSaveSettings: vi.fn(), onAddSource: vi.fn(), onToggleSource: vi.fn(), onScanSource: vi.fn(), onDeleteSource: vi.fn(),
      onCancelDelete: vi.fn(), onCandidateQueryChange: vi.fn(), onSearchCandidates: vi.fn(), onSelectTitle: vi.fn(), onApplyMatch: vi.fn(),
      onToggleTv: vi.fn(), onTvSettingsChange: vi.fn(), onSaveTvSettings: vi.fn()
    }));

    expect(html).toContain("Configured; leave blank to keep");
    expect(html).not.toContain("secret-token");
    expect(html).toContain("Media/Movies");
    expect(html).toContain("Completed");
    expect(html).toContain("Match correction");
    expect(html).toContain("First contact");
    expect(html).toContain("TV mode health");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(html).toContain("HDMI-A-1");
    expect(html).toContain("Keyboard input remains available");
  });
});
