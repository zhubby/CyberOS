import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { i18n, initI18n } from "../../i18n/index.js";
import { MusicLibraryPanel } from "./MusicLibraryPanel.js";
import { MusicProvider, MusicTakeoverDialog } from "./MusicProvider.js";
import { WORKSPACE_PANEL_IDS } from "../../lib/workspace-panel-settings.js";

beforeAll(async () => {
  await initI18n();
});

describe("Music workspace", () => {
  it("registers Music next to Photos for persistent navigation", () => {
    expect(WORKSPACE_PANEL_IDS.indexOf("music")).toBe(
      WORKSPACE_PANEL_IDS.indexOf("photos") + 1,
    );
  });

  it("renders localized library navigation without a browser audio player", async () => {
    for (const [language, songs, playlists] of [
      ["en", "Songs", "Playlists"],
      ["zh-CN", "歌曲", "歌单"],
    ]) {
      await i18n.changeLanguage(language);
      const html = renderToStaticMarkup(
        createElement(MusicProvider, {
          children: createElement(MusicLibraryPanel, {
            pools: [],
            locale: language === "en" ? "en" : "zh-CN",
          }),
        }),
      );
      expect(html).toContain(songs);
      expect(html).toContain(playlists);
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('class="library-search-toolbar"');
      expect(html).toContain('aria-haspopup="dialog"');
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain('type="submit"');
      expect(html).not.toContain("<audio");
    }
  });

  it("presents cancellation and explicit confirmation for NAS takeover", async () => {
    await i18n.changeLanguage("en");
    const html = renderToStaticMarkup(
      createElement(MusicTakeoverDialog, {
        title: "Switch NAS playback?",
        body: "Video will stop",
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }),
    );
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Cancel");
    expect(html).toContain("Switch playback");
  });
});
