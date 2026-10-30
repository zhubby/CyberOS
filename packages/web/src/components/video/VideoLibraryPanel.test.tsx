import { beforeAll, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n, i18n } from "../../i18n/index.js";
import { PlaybackProvider } from "../playback/PlaybackProvider.js";
import { VideoLibraryPanel } from "./VideoLibraryPanel.js";

beforeAll(async () => {
  await initI18n();
});
it("shares localized Web and TV library navigation with explicit management on Web", async () => {
  for (const [language, movies, series, collections] of [
    ["en", "Movies", "Series", "Collections"],
    ["zh-CN", "电影", "剧集", "合集"],
  ]) {
    await i18n.changeLanguage(language);
    for (const tv of [false, true]) {
      const html = renderToStaticMarkup(
        createElement(PlaybackProvider, {
          children: createElement(VideoLibraryPanel, {
            tv,
            onManage: () => {},
          }),
        }),
      );
      expect(html).toContain(movies);
      expect(html).toContain(series);
      expect(html).toContain(collections);
      expect(html.includes(i18n.t("video.manage"))).toBe(!tv);
      expect(html).not.toContain("<video");
    }
  }
});
