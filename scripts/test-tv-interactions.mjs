import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { before, after, test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { createServer } from "vite";

const { chromium } = createRequire(new URL("../docs/package.json", import.meta.url))("playwright");
let server, browser, baseUrl;
before(async () => {
  server = await createServer({ configFile: fileURLToPath(new URL("../packages/web/vite.config.ts", import.meta.url)), root: fileURLToPath(new URL("../packages/web", import.meta.url)), optimizeDeps: { include: ["pinyin-ime/dictionary/google_pinyin_dict"] }, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

const title = { id: "series-1", title: "Test Series", kind: "series", sourceId: "source-1", sourcePath: "Series", genres: ["Drama"], year: 2024, posterKey: null, progress: null, personal: { favorite: false, watchlist: false, watched: null }, credits: [], rating: null };
const file = { id: "file-1", titleId: title.id, episodeId: "episode-1", sourceId: "source-1", storagePoolId: "pool-1", relativePath: "Series/episode.mkv", name: "Test.Series.S01E01.1080p.mkv", sizeBytes: 1024, container: "mkv", videoCodec: "h264", audioCodec: "aac" };
const detail = { ...title, files: [], seasons: [{ id: "season-1", seasonNumber: 1, name: "Season 1", episodes: [{ id: "episode-1", episodeNumber: 1, name: "Episode one", files: [file, { ...file, id: "file-1-4k", name: "Test.Series.S01E01.2160p.HDR.Extended.Version.mkv", relativePath: "Series/4k/episode.mkv", videoCodec: "hevc" }] }, { id: "episode-2", episodeNumber: 2, name: "Episode two", files: [{ ...file, id: "file-2", episodeId: "episode-2" }] }] }], artwork: [], fileProgress: {}, episodeWatched: {}, technical: { "file-1-4k": [{ type: "video", codec: "hevc", width: 3840, height: 2160, hdr: true }] }, nextFileId: "file-1" };
const music = { serviceInstanceId: "instance-1", sessionId: "music-1", owner: "music", revision: 1, queueVersion: 1, state: "paused", queue: [{ id: "item-1", fileId: "song-1", title: "Test song", artist: "Test artist", durationSeconds: 100 }], currentItemId: "item-1", positionSeconds: 0, durationSeconds: 100, volume: 50, shuffle: false, repeat: "off", error: null, updatedAt: "2026-11-04T00:00:00Z" };
const playback = { target: "nas", owner: "music", sessionId: "music-1", serviceInstanceId: "instance-1", revision: 1, music, video: { state: "idle", sessionId: null, audioTracks: [], subtitleTracks: [], capabilities: {} }, preferences: { musicVolume: 50, videoVolume: 50, musicMuted: false, videoMuted: false }, output: { requested: { kind: "default", deviceId: null }, effective: { kind: "default", deviceId: null } } };

async function library(t, options = {}) {
  const context = await browser.newContext({ locale: options.locale ?? "en-US", viewport: options.viewport ?? { width: 1920, height: 1080 }, reducedMotion: options.reducedMotion ?? "no-preference" });
  t.after(() => context.close());
  const page = await context.newPage();
  const writes = [];
  const reads = [];
  await page.addInitScript(() => {
    globalThis.window.__tvSources = [];
    globalThis.window.EventSource = class extends globalThis.EventTarget {
      constructor(url) { super(); this.url = url; globalThis.window.__tvSources.push(this); }
      close() { globalThis.window.__tvSources = globalThis.window.__tvSources.filter(source => source !== this); }
    };
  });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      const write = { path: url.pathname, body: request.postDataJSON() };
      writes.push(write);
      await options.onWrite?.(write);
    } else reads.push(url);
    if (url.pathname.endsWith("/events")) return route.fulfill({ status: 204 });
    if (url.pathname === "/api/media/titles" && url.searchParams.get("query") && options.searchFailure?.()) return route.fulfill({ status: 503, json: { error: "Search unavailable" } });
    const fixtures = {
      "/api/media/home": options.home ?? { continueWatching: [], recentlyAdded: [title], movies: [], series: [title], watchlist: [], upNext: [], collections: [] },
      "/api/media/collections": { collections: [{ id: "collection-1", name: "Test collection", kind: "manual", titleIds: [title.id] }] },
      "/api/media/sources": { sources: [] },
      "/api/media/filter-options": { years: [2024, 1999], genres: ["Drama", "Sci-Fi"] },
      "/api/media/titles": { titles: [title], nextCursor: null },
      "/api/media/titles/series-1": { title: detail },
      "/api/media/files/file-2/play": { status: globalThis.structuredClone(playback) },
      "/api/playback/status": { status: globalThis.structuredClone(options.playback ?? playback) },
      "/api/playback/command": { status: globalThis.structuredClone(options.playback ?? playback) },
      "/api/music/player": { status: music },
      "/api/music/player/command": { status: music },
      "/api/settings/bluetooth": { audioDevices: [] }
    };
    await route.fulfill({ status: url.pathname in fixtures ? 200 : 503, json: fixtures[url.pathname] ?? { error: "Not available in TV test" } });
  });
  await page.goto(`${baseUrl}tv/`);
  await page.locator(".video-poster").first().waitFor();
  return { page, writes, reads };
}

async function key(page, value, keyCode = 0) {
  return page.evaluate(({ value, keyCode }) => {
    const event = new globalThis.KeyboardEvent("keydown", { key: value, keyCode, bubbles: true, composed: true, cancelable: true });
    (globalThis.document.activeElement ?? globalThis.document.body).dispatchEvent(event);
    return event.defaultPrevented;
  }, { value, keyCode });
}
async function openDetail(page) { await page.locator(".video-poster").first().focus(); await page.keyboard.press("Enter"); await page.locator(".video-detail").waitFor(); }
async function snapshot(page, status) {
  await page.evaluate(status => {
    const source = globalThis.window.__tvSources.find(source => source.url === "/api/playback/events");
    assertSource(source);
    function assertSource(source) { if (!source) throw new Error("Playback subscription missing"); }
    source.dispatchEvent(new globalThis.MessageEvent("snapshot", { data: JSON.stringify(status) }));
  }, status);
}

for (const locale of ["en-US", "zh-CN"]) test(`${locale}: shared playback actions and library search retain HUD styling`, async t => {
  const { page } = await library(t, { locale });
  await page.locator(".playback-output > button").waitFor();
  const failures = await page.evaluate(() => {
    const failures = [];
    for (const element of globalThis.document.querySelectorAll("button")) {
      if (!element.getClientRects().length) continue;
      const style = globalThis.getComputedStyle(element);
      if (style.backgroundColor === "rgb(107, 107, 107)") failures.push(`Native gray button: ${element.getAttribute("aria-label")}`);
    }
    const search = globalThis.document.querySelector(".tv-library-search");
    const icon = search.querySelector("svg").getBoundingClientRect();
    const text = [...search.childNodes].find(node => node.nodeType === globalThis.Node.TEXT_NODE && node.textContent.trim());
    const range = globalThis.document.createRange();
    range.selectNode(text);
    if (icon.right + 6 > range.getBoundingClientRect().left) failures.push("Search icon overlaps its label");
    if (icon.left > search.getBoundingClientRect().left + 24) failures.push("Search content must remain aligned to the leading edge");
    return failures;
  });
  assert.deepEqual(failures, []);
  const output = page.locator(".playback-output > button");
  await page.keyboard.press("Shift");
  await output.focus();
  assert.deepEqual(await output.evaluate(element => {
    const s = globalThis.getComputedStyle(element);
    return [s.backgroundColor, s.outlineWidth, s.outlineColor, s.outlineOffset];
  }), ["rgba(0, 0, 0, 0)", "3px", "rgb(0, 240, 255)", "4px"]);
});

for (const name of ["BrowserHome", "Home", "BrowserBack", "GoBack"]) test(`${name} returns a category to home`, async t => {
  const { page } = await library(t);
  await page.locator(".video-navigation button").nth(1).click();
  assert.equal(await key(page, name), true);
  await page.waitForFunction(() => globalThis.document.querySelector('.video-navigation button')?.getAttribute('aria-pressed') === 'true', null, { timeout: 2000 });
});

test("cancelling a pending list request does not leave home loading", async t => {
  const { page } = await library(t);
  await page.evaluate(async () => {
    globalThis.document.querySelectorAll('.video-navigation button')[1].click();
    await new Promise(resolve => globalThis.setTimeout(resolve, 40));
    globalThis.document.querySelector('.tv-brand').click();
  });
  await page.locator(".video-poster").waitFor({ timeout: 2000 });
  assert.equal(await page.getByRole("button", { name: "Refresh", exact: true }).isEnabled(), true);
});

test("media play key controls music without activating the focused category", async t => {
  const { page, writes } = await library(t);
  await page.locator(".video-navigation button").nth(2).focus();
  await key(page, "MediaPlayPause");
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".video-navigation button").first().getAttribute("aria-pressed"), "true");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/api/music/player/command");
  assert.equal(writes[0].body.type, "resume");
});

for (const name of ["BrowserBack", "BrowserHome"]) test(`${name} dismisses the queue dialog`, async t => {
  const { page } = await library(t);
  await page.locator(".playback-queue").click();
  await page.locator(".music-dialog").waitFor();
  await key(page, name);
  await page.locator(".music-dialog").waitFor({ state: "detached", timeout: 2000 });
});

test("detail restores its poster and stays closed after refresh", async t => {
  const { page } = await library(t);
  await openDetail(page);
  await page.waitForFunction(() => globalThis.document.activeElement?.matches('[data-tv-detail-primary]'), null, { timeout: 2000 });
  await key(page, "BrowserBack");
  await page.locator(".video-detail").waitFor({ state: "detached" });
  await page.waitForFunction(() => globalThis.document.activeElement?.matches('.video-poster'));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".video-detail").count(), 0);
});

test("OK on an episode opens the existing takeover confirmation for that episode", async t => {
  const { page, writes } = await library(t);
  await openDetail(page);
  await page.locator(".video-episode > button").nth(2).focus();
  await page.keyboard.press("Enter");
  await page.locator('[role="dialog"]').waitFor({ timeout: 2000 });
  assert.equal(writes.length, 0);
  await key(page, "BrowserBack");
  await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 2000 });
});

test("English virtual typing and delete retain keyboard focus", async t => {
  const { page } = await library(t);
  await page.locator(".tv-header-actions button").click();
  await page.locator(".tv-keyboard-tools button").first().click();
  for (const letter of ["Q", "W"]) {
    await page.getByRole("button", { name: letter, exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(letter => globalThis.document.activeElement?.textContent === letter, letter);
  }
  const input = page.locator(".tv-search-input, pinyin-ime-editor input").first();
  assert.equal(await input.inputValue(), "qw");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  assert.equal(await input.inputValue(), "q");
});

test("English virtual editing preserves the caret between keyboard activations", async t => {
  const { page } = await library(t);
  await page.locator(".tv-header-actions button").click();
  await page.locator(".tv-keyboard-tools button").first().click();
  const input = page.locator(".tv-search-input");
  const frame = () => page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
  await frame();
  for (const [name, expected] of [["Q", "q"], ["W", "qw"], ["1", "qw1"], ["Delete", "qw"], ["Space", "qw "], ["Z", "qw z"]]) {
    const button = page.getByRole("button", { name, exact: true });
    await button.click();
    await frame();
    assert.equal(await input.inputValue(), expected);
    assert.equal(await input.evaluate(element => element.selectionStart), expected.length);
    assert.equal(await button.evaluate(element => globalThis.document.activeElement === element), true);
  }
  await input.focus();
  await input.evaluate(element => element.setSelectionRange(1, 3));
  await page.getByRole("button", { name: "A", exact: true }).focus();
  await page.keyboard.press("Enter");
  await frame();
  assert.equal(await input.inputValue(), "qaz");
  assert.equal(await input.evaluate(element => element.selectionStart), 2);
});

test("Chinese letters keep key focus and candidates can be selected with the remote", async t => {
  const { page } = await library(t);
  await page.locator(".tv-header-actions button").click();
  const q = page.getByRole("button", { name: "Q", exact: true });
  await q.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => globalThis.document.activeElement?.textContent === 'Q', null, { timeout: 2000 });
  const candidate = page.locator(".tv-ime-candidates button[data-tv-candidate]").first();
  await candidate.waitFor({ timeout: 5000 });
  const word = await candidate.textContent();
  await candidate.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(word => globalThis.document.querySelector('.tv-search-input')?.value === word, word.trim());
});

test("search failures support retry and detail Back restores search context", async t => {
  let fail = true;
  const { page } = await library(t, { searchFailure: () => fail });
  await page.locator(".tv-header-actions button").click();
  await page.locator(".tv-keyboard-tools button").first().click();
  const input = page.locator(".tv-search-input, pinyin-ime-editor input").first();
  await input.fill("Test");
  await page.locator(".tv-search-error").waitFor({ timeout: 2000 });
  assert.equal(await page.locator(".tv-search-empty").count(), 0);
  fail = false;
  await page.locator(".tv-search-error button").click();
  await page.locator(".tv-search-result").first().click();
  await page.locator(".video-detail").waitFor();
  await key(page, "BrowserBack");
  await page.locator(".tv-search").waitFor({ timeout: 2000 });
  assert.equal(await input.inputValue(), "Test");
  await page.waitForFunction(() => globalThis.document.activeElement?.classList.contains('tv-search-result'));
});

test("the library search entry opens the same TV keyboard", async t => {
  const { page } = await library(t);
  await page.getByRole("button", { name: "Search library", exact: true }).click();
  await page.locator(".tv-search").waitFor({ timeout: 2000 });
});

test("year and genre filters support remote selection and nested Back", async t => {
  const { page, reads } = await library(t);
  const trigger = page.locator(".workspace-search-filter-trigger");
  await trigger.click();
  const year = page.getByRole("button", { name: "Year", exact: true });
  await year.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.match(await year.textContent(), /2024/);
  const genre = page.getByRole("button", { name: "Genre", exact: true });
  await genre.focus();
  await page.keyboard.press("ArrowDown");
  await key(page, "Unidentified", 461);
  assert.equal(await page.locator('[role="listbox"]').count(), 0);
  assert.equal(await page.locator(".workspace-search-filter-menu").count(), 1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const applied = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/media/titles" && url.searchParams.get("year") === "2024" && url.searchParams.get("genre") === "Drama";
  }, { timeout: 5000 });
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  assert.equal((await applied).status(), 200);
  assert.ok(reads.some(url => url.searchParams.get("year") === "2024"));
  await trigger.click();
  await key(page, "BrowserBack");
  assert.equal(await page.locator(".workspace-search-filter-menu").count(), 0);
  assert.equal(await trigger.evaluate(element => globalThis.document.activeElement === element), true);
});

test("Back leaves collection contents before the collections category", async t => {
  const { page } = await library(t);
  await page.locator(".video-navigation button").nth(3).click();
  const collection = page.locator("[data-tv-collection]");
  await collection.click();
  await page.locator(".video-poster").waitFor();
  await key(page, "BrowserBack");
  await collection.waitFor();
  await page.waitForFunction(() => globalThis.document.activeElement?.hasAttribute('data-tv-collection'));
  await key(page, "BrowserBack");
  assert.equal(await page.locator(".video-navigation button").first().getAttribute("aria-pressed"), "true");
});

test("episode takeover submits the chosen episode and busy confirmation blocks Back and Home", async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { page, writes } = await library(t, { onWrite: () => held });
  t.after(() => release());
  await openDetail(page);
  await page.locator(".video-episode > button").nth(2).click();
  await page.locator(".music-dialog .primary-button").click();
  await page.waitForFunction(() => globalThis.document.querySelector('.music-dialog .primary-button')?.disabled);
  await key(page, "BrowserBack");
  await key(page, "BrowserHome");
  assert.equal(await page.locator(".music-dialog").count(), 1);
  assert.equal(await page.locator(".video-detail").count(), 1);
  assert.equal(writes[0].path, "/api/media/files/file-2/play");
  release();
  await page.locator(".music-dialog").waitFor({ state: "detached" });
});

test("directional navigation remembers a poster in each horizontal region", async t => {
  const titles = [0, 1, 2].map(index => ({ ...title, id: `title-${index}`, title: `Title ${index}` }));
  const { page } = await library(t, { home: { continueWatching: [], recentlyAdded: titles, movies: [], series: [], watchlist: titles, upNext: [], collections: [] }, reducedMotion: "reduce" });
  const rails = page.locator(".video-poster-rail");
  await rails.nth(0).locator("button").nth(1).focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await rails.nth(1).evaluate(element => element.contains(globalThis.document.activeElement)), true);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  assert.equal(await rails.nth(0).locator("button").nth(1).evaluate(element => globalThis.document.activeElement === element), true);
});

test("native Home navigates once, ignores historical snapshots, and sends no stop command", async t => {
  const initial = globalThis.structuredClone(playback);
  initial.video.tvHomeRequestId = "historical-home";
  const { page, writes } = await library(t, { playback: initial });
  await page.locator(".video-navigation button").nth(1).click();
  await snapshot(page, { ...initial, revision: 2 });
  assert.equal(await page.locator(".video-navigation button").nth(1).getAttribute("aria-pressed"), "true");
  const next = { ...initial, revision: 3, video: { ...initial.video, tvHomeRequestId: "new-home" } };
  await snapshot(page, next);
  await page.waitForFunction(() => globalThis.document.querySelector('.video-navigation button')?.getAttribute('aria-pressed') === 'true');
  await page.locator(".video-navigation button").nth(1).click();
  await snapshot(page, { ...next, revision: 4 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".video-navigation button").nth(1).getAttribute("aria-pressed"), "true");
  assert.equal(writes.length, 0);
});

test("media keys with no playback session do not activate focused actions", async t => {
  const idle = globalThis.structuredClone(playback);
  idle.owner = null;
  idle.sessionId = null;
  idle.music = { ...idle.music, owner: null, sessionId: null, queue: [], state: "idle" };
  const { page, writes } = await library(t, { playback: idle });
  await page.locator(".video-navigation button").nth(2).focus();
  for (const name of ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop"]) await key(page, name);
  assert.equal(writes.length, 0);
  assert.equal(await page.locator(".video-navigation button").first().getAttribute("aria-pressed"), "true");
});

test("versions can be selected by remote and their full file metadata is available", async t => {
  const { page, writes } = await library(t);
  await openDetail(page);
  const version = page.getByRole("button", { name: "Version", exact: true });
  await version.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.match(await version.textContent(), /Version 2.*2160p.*hevc/);
  await page.locator(".tv-file-details summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".tv-file-details").getAttribute("open"), "");
  assert.match(await page.locator(".tv-file-details").textContent(), /Test.Series.S01E01.2160p.HDR.Extended.Version.mkv/);
  assert.equal(writes.length, 0);
});

for (const [locale, width, height] of [["en-US", 1920, 1080], ["zh-CN", 1280, 720], ["en-US", 720, 540], ["zh-CN", 320, 640]]) test(`${locale}: TV layout at ${width}x${height} stays operable`, async t => {
  const { page } = await library(t, { locale, viewport: { width, height }, reducedMotion: "reduce" });
  const output = fileURLToPath(new URL("../.cyberos/tv-review/fixed/", import.meta.url));
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/home-${locale}-${width}.png` });
  await openDetail(page);
  assert.equal(await page.locator(".video-episode strong").first().evaluate(element => globalThis.getComputedStyle(element).fontSize), "22px");
  await page.screenshot({ path: `${output}/detail-${locale}-${width}.png` });
  await key(page, "BrowserBack");
  await page.locator(".tv-header-actions button").click();
  const q = page.getByRole("button", { name: "Q", exact: true });
  await q.focus();
  await page.keyboard.press("Enter");
  await page.locator("[data-tv-candidate]").first().waitFor();
  assert.equal(await page.locator("[data-tv-candidate]").first().evaluate(element => globalThis.getComputedStyle(element).fontSize), "26px");
  const overflow = await page.locator(".tv-search").evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
  await page.screenshot({ path: `${output}/search-${locale}-${width}.png` });
  await key(page, "BrowserHome");
  await page.locator(".tv-search").waitFor({ state: "detached" });
});
