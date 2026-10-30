import { beforeAll, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n, i18n } from "../../i18n/index.js";
import { PlaybackProvider } from "../playback/PlaybackProvider.js";
import { VideoLibraryPanel, videoQueryWithFilters } from "./VideoLibraryPanel.js";

beforeAll(async () => {
  await initI18n();
});

it("resets video filters while retaining the search and collection scope", () => {
  expect(videoQueryWithFilters({
    query: "arrival", collectionId: "science-fiction", sourceId: "nas", year: 2016,
    genre: "Drama", favorite: true, watched: false, sort: "rating",
  }, {
    sourceId: undefined, year: undefined, genre: undefined,
    favorite: undefined, watched: undefined, sort: "title",
  })).toEqual({ query: "arrival", collectionId: "science-fiction", sort: "title" });
});

it("applies unwatched and sorting filters without erasing current search text", () => {
  expect(videoQueryWithFilters({ query: "arrival", sourceId: "old-source" }, {
    sourceId: "nas", year: 2016, genre: "Science Fiction",
    favorite: true, watched: false, sort: "year",
  })).toEqual({
    query: "arrival", sourceId: "nas", year: 2016, genre: "Science Fiction",
    favorite: true, watched: false, sort: "year",
  });
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
      expect(html).toContain('class="library-search-toolbar"');
      expect(html).toContain('aria-haspopup="dialog"');
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain("<select");
      expect(html).not.toContain("<details");
      expect(html).not.toContain("<video");
    }
  }
});
