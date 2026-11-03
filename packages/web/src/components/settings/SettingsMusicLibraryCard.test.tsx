import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MusicLibraryStatus, MusicSource } from "@cyberos/shared";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsMusicLibraryContent } from "./SettingsMusicLibraryCard.js";

beforeAll(async () => { await initI18n(); });
const source: MusicSource = {
  id: "music-source", name: "My Music", storagePoolId: "pool-1", path: "Media/Music",
  enabled: true, createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z",
};
const library: MusicLibraryStatus = {
  sourceCount: 1, trackCount: 61, albumCount: 3, artistCount: 2, missingCount: 0, revision: "r1",
  scans: [{ id: "scan", sourceId: source.id, status: "failed", generation: "g1", scanned: 61,
    added: 1, updated: 0, removed: 0, currentPath: null, error: "Folder unavailable",
    createdAt: source.createdAt, updatedAt: source.updatedAt, startedAt: null, finishedAt: null }],
};
function render(overrides: Partial<Parameters<typeof SettingsMusicLibraryContent>[0]> = {}) {
  return renderToStaticMarkup(createElement(SettingsMusicLibraryContent, {
    data: { sources: [source], library }, loading: false, error: null, busy: null, canAdd: true,
    onAdd: vi.fn(), onRetry: vi.fn(), onToggle: vi.fn(), onScan: vi.fn(), onRemove: vi.fn(), ...overrides,
  }));
}

describe("Settings music library", () => {
  it("renders localized source management, totals, and scan errors in a full-width card", async () => {
    for (const [locale, title, add] of [["en", "Music library", "Add music folder"], ["zh-CN", "音乐库", "添加音乐文件夹"]]) {
      await i18n.changeLanguage(locale);
      const html = render();
      expect(html).toContain(title);
      expect(html).toContain(add);
      expect(html).toContain("settings-field-wide");
      expect(html).toContain("Media/Music");
      expect(html).toContain("My Music");
      expect(html).toContain(">61<");
      expect(html).toContain('role="switch"');
      expect(html).toContain('aria-checked="true"');
      expect(html).toContain("Folder unavailable");
      expect(html).toContain('role="alert"');
      expect(html).not.toContain("<select");
    }
  });
  it("keeps a local retry and disables source writes while data is unavailable", async () => {
    await i18n.changeLanguage("en");
    const html = render({ data: null, loading: false, error: "Music catalog unavailable" });
    expect(html).toContain("Music catalog unavailable");
    expect(html).toContain("Retry");
    expect(html).toMatch(/disabled=""[^>]*>.*?Add music folder/su);
  });
  it("exposes a busy state without hiding the source list", () => {
    const html = render({ busy: "scan-music-source" });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Media/Music");
    expect(html).toContain('disabled=""');
  });
});
