import { test, expect, type Page } from "@playwright/test";

const appIds = ["video", "downloads", "monitoring", "docker", "virtualMachines", "network", "storage", "shares", "terminal", "settings", "files", "photos", "music", "agent"];
const stamp = "2026-11-02T00:00:00.000Z";
const session = { id: "session-1", currentPath: ".", firstMessage: "移动端会话 / Mobile session", lastMessage: null, pendingApprovalCount: 0, createdAt: stamp, updatedAt: stamp };
const tracks = Array.from({ length: 80 }, (_, i) => ({ id: `track-${i}`, title: `音乐 ${i} / Long song title`, artists: ["CyberOS"], artist: "CyberOS", album: "Test album", durationSeconds: 180, favorite: false, coverKey: null }));
const photos = Array.from({ length: 80 }, (_, i) => ({ id: `photo-${i}`, name: `照片 ${i}.jpg`, path: `photos/${i}.jpg`, storagePoolId: "pool-1", sizeBytes: 1024, width: 800, height: 600, takenAt: stamp, modifiedAt: stamp, mimeType: "image/jpeg", status: "ready", metadata: null }));
const videoTitle = { id: "movie-1", sourceId: "source-1", kind: "movie", title: "CyberOS 测试影片", originalTitle: null, sourcePath: "media/test.webm", tmdbId: null, overview: "Test film", year: 2026, releaseDate: null, runtimeMinutes: 1, originalLanguage: null, genres: [], metadataSource: "local", matchStatus: "unmatched", matchConfidence: null, posterKey: null, backdropKey: null, addedAt: stamp, updatedAt: stamp, progress: null, personal: { favorite: false, watchlist: false, watched: null }, watched: false, rating: null, credits: [], seasons: [], artwork: [], fileProgress: {}, episodeWatched: {}, technical: {}, nextFileId: "movie-file", files: [{ id: "movie-file", titleId: "movie-1", name: "test.webm", relativePath: "media/test.webm", storagePoolId: "pool-1", available: true, sizeBytes: 1024, durationSeconds: 1, videoCodec: "vp8", audioCodec: null, width: 160, height: 90 }] };

async function fixtures(page: Page, locale = "en") {
  page.on("pageerror", (error) => console.error(error.stack));
  await page.addInitScript((language) => {
    localStorage.setItem("cyberos:language", language);
    // Keep connection subscriptions observable without a real backend.
    class FixtureEvents extends EventTarget {
      static opened: Record<string, number> = {};
      constructor(public url: string) { super(); FixtureEvents.opened[url] = (FixtureEvents.opened[url] ?? 0) + 1; }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: FixtureEvents });
  }, locale);
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown;
    if (path === "/api/system/storage") body = { storage: { pools: [{ id: "pool-1", mountpoint: "/cyberos/data/pool-1", filesystem: "btrfs", status: "ready", memberDevices: [], totalBytes: 102400, usedBytes: 1024, availableBytes: 101376, usedPercent: 1, raidLevel: null }], disks: [], arrays: [], mounts: [], issues: [], metrics: {}, capabilities: {} } };
    else if (path === "/api/sessions") body = { sessions: [session] };
    else if (path.endsWith("/transcript")) body = { transcript: [], liveEvents: [], activeJob: null, lastEventId: 0 };
    else if (path.endsWith("/approvals")) body = { capabilityApprovals: [] };
    else if (path === "/api/notifications/summary") body = { operations: 0, bluetoothTransfers: 0, alerts: 0 };
    else if (path === "/api/notifications") body = { notifications: [], bluetoothTransfers: [], unreadCount: 0, bluetoothUnreadCount: 0 };
    else if (path === "/api/monitoring/alerts/incidents") body = { incidents: [] };
    else if (path.endsWith("/operations") || path === "/api/operations") body = { operations: [] };
    else if (path === "/api/files/batches") body = { batches: [] };
    else if (path === "/api/files") {
      const dir = url.searchParams.get("path") ?? ".";
      body = { git: null, entries: Array.from({ length: 100 }, (_, i) => ({ name: i === 0 && dir === "." ? "Documents" : `${String(i).padStart(3, "0")} 超长中文文件名称 Long filename with spaces and details.txt`, path: dir === "." ? i === 0 ? "Documents" : `file-${i}.txt` : `${dir}/file-${i}.txt`, kind: i === 0 && dir === "." ? "directory" : "file", sizeBytes: 1024, modifiedAt: stamp, isSafe: true })) };
    }
    else if (path === "/api/photos/settings") body = { settings: { storagePoolId: "pool-1", path: "photos", updatedAt: stamp } };
    else if (path === "/api/photos/status") body = { status: { state: "ready", total: 80, processed: 80, scanned: 80, failed: 0, retryCount: 0, nextRetryAt: null, error: null, updatedAt: stamp }, workerHealth: { status: "ready", freshWorkers: 1, activeJobs: 0, queuedJobs: 0, retryingJobs: 0, lastHeartbeatAt: stamp } };
    else if (path === "/api/photos/query") body = { photos, total: photos.length, nextCursor: null, facets: null };
    else if (path === "/api/photos/metadata/fields") body = { fields: [] };
    else if (/\/api\/photos\/photo-\d+\/metadata/.test(path)) body = { fields: [], groups: [], privacy: {}, asset: photos[0] };
    else if (path.endsWith("/preview") || path.endsWith("/thumbnail")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#211016"/></svg>' });
    else if (path === "/api/music/home") body = { recentlyAdded: [], recentlyPlayed: tracks.slice(0, 8), mostPlayed: [], favorites: [] };
    else if (path === "/api/music/tracks") body = { items: tracks, nextCursor: null };
    else if (path === "/api/music/albums") body = { items: [], nextCursor: null };
    else if (path === "/api/music/artists") body = { items: [], nextCursor: null };
    else if (path === "/api/music/playlists") body = { items: [], nextCursor: null };
    else if (path === "/api/music/sources") body = { sources: [] };
    else if (path === "/api/music/library") body = { state: "idle", tracks: 80, albums: 0, artists: 0 };
    else if (path === "/api/media/home") body = { continueWatching: [], upNext: [], recentlyAdded: [videoTitle], watchlist: [], movies: [videoTitle], series: [], collections: [] };
    else if (path === "/api/media/titles") body = { titles: [videoTitle], nextCursor: null };
    else if (path === "/api/media/titles/movie-1") body = { title: videoTitle };
    else if (path === "/api/media/collections") body = { collections: [] };
    else if (path === "/api/media/sources") body = { sources: [] };
    else return route.fulfill({ status: 503, json: { error: "Fixture service unavailable" } });
    return route.fulfill({ json: body });
  });
}

async function home(page: Page) { await page.locator(".mobile-app-home:visible").click(); await expect(page.locator(".mobile-home")).toBeVisible(); }
async function open(page: Page, id: string) { await page.locator(`[data-app-id="${id}"]`).click(); await expect(page.locator(".app-shell")).toHaveAttribute("data-mobile-route", id); }
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const header = page.locator(".app-titlebar:visible");
  if (await header.count()) {
    const boxes = await header.locator("button:visible").evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { width: Number(r.width.toFixed(3)), height: Number(r.height.toFixed(3)), left: r.left, right: r.right }; }));
    for (const box of boxes) { expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1); }
  }
}

for (const locale of ["en", "zh-CN"]) for (const width of [320, 390, 560, 820, 1440]) {
  test(`${locale} ${width}px: App entries, touch chrome and breakpoint`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await fixtures(page, locale);
    const errors: string[] = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
    await page.goto("/");
    if (width > 1040) {
      await expect(page.locator(".workspace-panel-rail")).toBeVisible();
      await expect(page.locator(".agent-list")).toBeVisible();
      await expect(page.locator(".agent-playback-button")).toBeVisible();
      await expect(page.locator(".playback-shell")).toHaveCount(0);
      await page.locator(".agent-playback-button").click();
      await expect(page.locator(".playback-menu")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("desktop.png") });
      await page.setViewportSize({ width: 820, height: 844 });
      await expect(page.locator(".playback-menu")).toHaveCount(0);
      await expect(page.locator(".agent-playback-button")).toHaveCount(0);
    }
    await expect(page.locator(".mobile-app-icon")).toHaveCount(14);
    expect(await page.locator(".mobile-app-icon").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-app-id")))).toEqual(appIds);
    const columns = await page.locator(".mobile-app-grid").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(width <= 560 ? 4 : 6);
    await page.screenshot({ path: testInfo.outputPath("home.png") });
    for (const id of appIds) {
      await open(page, id);
      await expect(page.locator(".mobile-app-loading")).toHaveCount(0);
      await expect(page.locator(".mobile-app-home:visible")).toBeVisible();
      for (const notice of await page.locator(".app-notification button").all()) await notice.click();
      await noOverflow(page);
      if (id === "files") {
        await expect(page.locator(".file-row:not(.file-row-head)")).toHaveCount(100);
        const bounds = await page.locator(".file-row:not(.file-row-head)").first().evaluate((row) => ({ name: row.querySelector(".file-name")!.getBoundingClientRect().right, action: row.querySelector(".file-action-button-more")!.getBoundingClientRect().left }));
        expect(bounds.name).toBeLessThanOrEqual(bounds.action);
      }
      if (width === 390 && ["files", "photos", "music", "video", "agent", "settings"].includes(id)) {
        if (id === "files") await expect(page.locator(".file-row:not(.file-row-head)")).toHaveCount(100);
        if (id === "photos") await expect(page.locator(".photo-tile")).toHaveCount(80);
        if (id === "agent") await expect(page.locator(".composer textarea")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`${id}.png`) });
      }
      await home(page);
    }
    expect(errors).toEqual([]);
  });
}

test("direct links, browser history, menu and nested confirmation back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page);
  await page.goto("/#/app/files");
  await expect(page.locator(".file-row:not(.file-row-head)")).toHaveCount(100);
  await page.goBack(); await expect(page.locator(".mobile-home")).toBeVisible();
  await page.goForward(); await expect(page.locator(".file-browser")).toBeVisible();
  await page.locator(".mobile-more-button").click();
  await page.goBack(); await expect(page.locator(".mobile-action-menu")).toHaveCount(0);
  await expect(page.locator(".file-browser")).toBeVisible();
  await home(page); await open(page, "settings");
  await page.locator(".settings-nav button").filter({ hasText: /^System Profile$/ }).click();
  await page.locator(".settings-power-button").click();
  await page.locator('[data-action="reboot"]').click();
  await page.goBack(); await expect(page.locator(".power-action-list")).toBeVisible();
  await page.goBack(); await expect(page.locator(".power-dialog")).toHaveCount(0);
  await page.goBack(); await expect(page.locator(".settings-rail")).toBeVisible();
  await page.goto("/#/app/unknown"); await expect(page.locator(".mobile-home")).toBeVisible(); await expect(page).toHaveURL(/#\/home$/);
});

test("home notifications and nested filters close before browser navigation and restore focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto("/");
  await page.locator(".mobile-notifications").click(); await expect(page.locator(".notification-drawer")).toBeVisible();
  await page.goBack(); await expect(page.locator(".notification-drawer")).toHaveCount(0);
  await expect(page.locator(".mobile-home")).toBeVisible(); await expect(page.locator(".mobile-notifications")).toBeFocused();
  await open(page, "files"); await page.locator(".workspace-search-filter-trigger").click();
  await page.locator("#workspace-search-file-type").click(); await expect(page.locator('[role="listbox"]')).toBeVisible();
  await page.goBack(); await expect(page.locator('[role="listbox"]')).toHaveCount(0);
  await expect(page.locator(".workspace-search-filter-menu")).toBeVisible();
  await expect(page.locator("#workspace-search-file-type")).toBeFocused();
  await page.goBack(); await expect(page.locator(".workspace-search-filter-menu")).toHaveCount(0);
  await expect(page.locator(".workspace-search-filter-trigger")).toBeFocused();
});

test("an upload continues while its App is closed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  let completed = false;
  await page.route("**/api/files/upload?**", async (route) => {
    started = true;
    await gate;
    await route.fulfill({ json: { operation: { id: "upload-1", operation: "upload", status: "applied", sourcePath: null, targetPath: "test.txt", createdAt: stamp, metadata: { reversible: false } } } });
    completed = true;
  });
  await page.goto("/#/app/files"); await expect(page.locator(".file-row:not(.file-row-head)")).toHaveCount(100);
  await page.locator('input[type="file"]').first().setInputFiles({ name: "test.txt", mimeType: "text/plain", buffer: Buffer.from("mobile upload") });
  await expect.poll(() => started).toBe(true);
  await home(page); await open(page, "agent"); release();
  await expect.poll(() => completed).toBe(true);
  await home(page); await open(page, "files"); await page.locator(".mobile-more-button").click();
  await page.locator(".activity-menu-button").click();
  await expect(page.locator(".activity-upload-item")).toHaveAttribute("data-state", "ready");
});

test("dynamic viewport keeps the Agent composer reachable and respects reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: "reduce" });
  await fixtures(page); await page.goto("/#/app/agent");
  await page.locator(".composer textarea").fill("键盘打开时的草稿");
  await page.setViewportSize({ width: 390, height: 440 });
  const input = page.locator(".composer textarea");
  await expect.poll(() => input.evaluate((node) => node.getBoundingClientRect().bottom <= (window.visualViewport?.height ?? innerHeight))).toBe(true);
  expect(await input.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  await page.setViewportSize({ width: 390, height: 844 }); await home(page);
  expect(await page.locator(".mobile-app-art").first().evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
});

test("browser playback survives App navigation, minimizing and breakpoint changes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page);
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext("2d")!; context.fillStyle = "#211016"; context.fillRect(0, 0, 160, 90);
    const stream = canvas.captureStream(10); const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const recording = new Promise<Blob>((resolve) => { recorder.ondataavailable = (event) => chunks.push(event.data); recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" })); });
    recorder.start();
    let frame = 0;
    const animation = setInterval(() => { context.fillStyle = ++frame % 2 ? "#211016" : "#160d12"; context.fillRect(0, 0, 160, 90); }, 50);
    await new Promise((resolve) => setTimeout(resolve, 600)); clearInterval(animation); recorder.stop();
    const blob = await recording; stream.getTracks().forEach((track) => track.stop()); return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.route("**/mobile-test.webm", (route) => route.fulfill({ contentType: "video/webm", body: Buffer.from(bytes) }));
  const stream = { id: "browser-stream", fileId: "movie-file", state: "ready", mode: "direct", startPositionSeconds: 0, durationSeconds: 1, tracks: [], audioTrack: null, subtitleTrack: null, error: null, reason: null, url: "/mobile-test.webm" };
  let streamsCreated = 0; let streamsClosed = 0;
  await page.route(/\/api\/media\/playback-sessions(?:\/|$)/, (route) => {
    const request = route.request();
    if (request.method() === "DELETE") { streamsClosed++; return route.fulfill({ status: 204 }); }
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("playback-sessions")) streamsCreated++;
    return route.fulfill({ json: { session: stream } });
  });
  await page.goto("/#/app/video"); await page.locator(".video-poster").first().click();
  await home(page); await open(page, "video"); await expect(page.locator(".video-detail h2")).toHaveText(videoTitle.title);
  await page.locator(".video-detail .primary-button").click();
  const video = page.locator(".browser-player video"); await expect(video).toBeVisible();
  await video.evaluate(async (node: HTMLVideoElement) => { node.loop = true; node.muted = true; await node.play(); Object.assign(window, { originalMobileVideo: node }); });
  await page.getByRole("button", { name: "Control device", exact: true }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.goBack(); await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.locator(".browser-player-backdrop")).not.toHaveClass(/is-minimized/);
  await page.getByRole("button", { name: "Minimize player", exact: true }).click();
  await expect(page.locator(".browser-player-backdrop")).toHaveClass(/is-minimized/);
  await page.locator(".mobile-app-back").click(); await expect(page.locator(".video-detail")).toHaveCount(0);
  await home(page);
  const bar = await page.locator(".playback-shell").boundingBox(); const dock = await page.locator(".mobile-home-dock").boundingBox();
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(dock!.y + 1);
  await page.screenshot({ path: testInfo.outputPath("home-with-playback.png") });
  await open(page, "files");
  await expect(page.locator(".mobile-home-dock")).toHaveCount(0); await expect(page.locator(".shared-player-bar")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".agent-playback-button")).toBeVisible();
  await expect(page.locator(".playback-shell")).toHaveCount(0);
  await page.locator(".agent-playback-button").click();
  await expect(page.locator(".playback-menu")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-with-playback.png") });
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.locator(".playback-menu")).toHaveCount(0);
  await expect(page.locator(".shared-player-bar")).toBeVisible();
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => !node.paused && node.currentTime > 0)).toBe(true);
  expect(await video.evaluate((node) => node === (window as unknown as { originalMobileVideo: Element }).originalMobileVideo)).toBe(true);
  expect(streamsCreated).toBe(1); expect(streamsClosed).toBe(0); await noOverflow(page);
});

test("directory, scroll, selection and Agent draft survive navigation and resizing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto("/#/app/files");
  await page.getByText("Documents", { exact: true }).click();
  await expect(page.locator(".breadcrumbs")).toContainText("Documents");
  const playbackConnections = await page.evaluate(() => (window.EventSource as unknown as { opened: Record<string, number> }).opened["/api/playback/events"]);
  await page.locator(".file-list").evaluate((node) => { node.scrollTop = 1100; });
  await expect.poll(() => page.locator(".file-list").evaluate((node) => node.scrollTop)).toBeGreaterThan(1000);
  await home(page); await open(page, "files");
  await expect(page.locator(".breadcrumbs")).toContainText("Documents");
  await expect.poll(() => page.locator(".file-list").evaluate((node) => node.scrollTop)).toBeGreaterThan(1000);
  await page.locator(".file-list").evaluate((node) => { node.scrollTop = 0; });
  await page.locator(".mobile-file-select").click();
  await page.locator(".mobile-file-checkbox").first().check(); await expect(page.locator(".file-batch-toolbar")).toBeVisible();
  await page.locator(".mobile-app-back").click(); await expect(page.locator(".mobile-file-checkbox")).toHaveCount(0);
  await home(page); await open(page, "agent");
  await page.locator(".composer textarea").fill("尚未发送的草稿 / unsent draft");
  await home(page); await open(page, "agent");
  await expect(page.locator(".composer textarea")).toHaveValue("尚未发送的草稿 / unsent draft");
  await page.setViewportSize({ width: 1440, height: 900 }); await expect(page.locator(".agent-list")).toBeVisible();
  await expect(page.locator(".composer textarea")).toHaveValue("尚未发送的草稿 / unsent draft");
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator(".composer textarea")).toHaveValue("尚未发送的草稿 / unsent draft");
  expect(await page.evaluate(() => (window.EventSource as unknown as { opened: Record<string, number> }).opened["/api/playback/events"])).toBe(playbackConnections);
});

test("media query and photo scroll restore after leaving the App", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page); await page.goto("/#/app/photos");
  await expect(page.locator(".photo-tile")).toHaveCount(80);
  await page.locator(".photo-library-content").evaluate((node) => { node.scrollTop = 1400; });
  await page.locator(".photo-tile").nth(24).click();
  await expect(page.locator(".photo-lightbox-backdrop")).toBeVisible();
  const photoPosition = await page.locator(".photo-library-content").evaluate((node) => node.scrollTop);
  await page.goBack(); await expect(page.locator(".photo-lightbox-backdrop")).toHaveCount(0);
  expect(await page.locator(".photo-library-content").evaluate((node) => node.scrollTop)).toBe(photoPosition);
  await home(page); await open(page, "photos");
  await expect.poll(() => page.locator(".photo-library-content").evaluate((node) => node.scrollTop)).toBeGreaterThan(1300);
  await home(page); await open(page, "music");
  await page.locator(".library-search-toolbar input[type='search'], .library-search-toolbar .search input").fill("CyberOS");
  await page.locator(".library-search-toolbar .search input").press("Enter");
  await home(page); await open(page, "music"); await expect(page.locator(".library-search-toolbar .search input")).toHaveValue("CyberOS");
  await home(page); await open(page, "video"); await page.locator(".library-search-toolbar input").fill("电影 CyberOS");
  await home(page); await open(page, "video"); await expect(page.locator(".library-search-toolbar input")).toHaveValue("电影 CyberOS");
});

test("temporary media failures preserve the requested detail for retry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixtures(page);
  let unavailable = false;
  let rejected = 0;
  await page.route("**/api/media/titles/movie-1", (route) => {
    if (unavailable) {
      rejected++;
      return route.fulfill({ status: 429, json: { error: "Rate limit exceeded, retry in 1 second" } });
    }
    return route.fulfill({ json: { title: videoTitle } });
  });
  await page.goto("/#/app/video"); await page.locator(".video-poster").first().click();
  await expect(page.locator(".video-detail h2")).toHaveText(videoTitle.title);
  await home(page); unavailable = true; await open(page, "video");
  await expect.poll(() => rejected).toBeGreaterThan(0);
  await expect(page.locator(".video-error")).toContainText("Rate limit exceeded");
  unavailable = false;
  await page.locator(".mobile-more-button").click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".video-detail h2")).toHaveText(videoTitle.title);
  await home(page); await open(page, "video");
  await expect(page.locator(".video-detail h2")).toHaveText(videoTitle.title);
});
