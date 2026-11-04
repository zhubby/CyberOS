import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { createServer } from "vite";

// Uses the browser dependencies installed by `npm --prefix docs ci`.
const { chromium } = createRequire(new URL("../docs/package.json", import.meta.url))("playwright");
let server;
let browser;
let baseUrl;

before(async () => {
  server = await createServer({
    configFile: fileURLToPath(new URL("../packages/web/vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../packages/web", import.meta.url)),
    optimizeDeps: { include: ["pinyin-ime/dictionary/google_pinyin_dict"] },
    server: { host: "127.0.0.1", port: 0 }
  });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openSearch(t, language) {
  const context = await browser.newContext({ locale: language, viewport: { width: 1920, height: 1080 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const fixtures = {
      "/api/media/home": { continueWatching: [], recentlyAdded: [], movies: [], series: [], watchlist: [], upNext: [], collections: [] },
      "/api/media/collections": { collections: [] },
      "/api/media/sources": { sources: [] },
      "/api/media/titles": { titles: [], nextCursor: null }
    };
    if (path.endsWith("/events")) return route.fulfill({ status: 204 });
    await route.fulfill({
      status: path in fixtures ? 200 : 503,
      contentType: "application/json",
      body: JSON.stringify(fixtures[path] ?? { error: "Service unavailable in navigation fixture" })
    });
  });
  await page.goto(`${baseUrl}tv/`);
  const movies = page.locator(".video-navigation button").nth(1);
  await movies.click();
  await page.locator(".tv-header-actions button").click();
  await page.locator(".tv-search").waitFor();
  await page.keyboard.press("Tab");
  await page.locator(".tv-search-input").focus();
  return page;
}

async function remoteKey(page, key, keyCode = 0) {
  return page.locator(".tv-search-input").evaluate((input, init) => {
    const event = new globalThis.KeyboardEvent("keydown", { ...init, bubbles: true, composed: true, cancelable: true });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  }, { key, keyCode });
}

for (const language of ["en-US", "zh-CN"]) {
  for (const [key, keyCode] of [["BrowserBack", 0], ["GoBack", 0], ["Unidentified", 461]]) {
    test(`${language}: ${key}/${keyCode} closes search and preserves the library view`, async (t) => {
      const page = await openSearch(t, language);
      assert.equal(await remoteKey(page, key, keyCode), true);
      await page.locator(".tv-search").waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await page.locator(".video-navigation button").nth(1).getAttribute("aria-pressed"), "true");
      await page.waitForFunction(() => globalThis.document.activeElement === globalThis.document.querySelector(".tv-header-actions button"));
    });
  }

  for (const key of ["BrowserHome", "Home"]) {
    test(`${language}: ${key} closes search and returns to the library home`, async (t) => {
      const page = await openSearch(t, language);
      assert.equal(await remoteKey(page, key), true);
      await page.locator(".tv-search").waitFor({ state: "detached", timeout: 3000 });
      assert.equal(await page.locator(".video-navigation button").first().getAttribute("aria-pressed"), "true");
    });
  }
}

test("Escape dismisses input help first, then closes search", async (t) => {
  const page = await openSearch(t, "en-US");
  await page.getByRole("tooltip").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("tooltip").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".tv-search").count(), 1);
  await page.keyboard.press("Escape");
  await page.locator(".tv-search").waitFor({ state: "detached", timeout: 3000 });
});

test("the close button remains operable with remote Enter", async (t) => {
  const page = await openSearch(t, "en-US");
  await page.locator(".tv-search-header button").last().focus();
  await page.keyboard.press("Enter");
  await page.locator(".tv-search").waitFor({ state: "detached", timeout: 3000 });
});
