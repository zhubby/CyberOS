import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { createServer } from "vite";

const { chromium, expect } = createRequire(new URL("../docs/package.json", import.meta.url))("@playwright/test");
let server, browser, baseUrl;
const timestamp = "2026-11-04T00:00:00.000Z";
const defaults = {
  concurrency: 1, btConcurrency: 3, defaultStoragePoolId: "pool-2", defaultTargetDirectory: "Downloads",
  parallelRequestsPerTask: 4, segmentedDownloadMinBytes: 67108864, maxAutoRetries: 5,
  retryBaseDelayMs: 2000, retryMaxDelayMs: 300000, retryAfterMaxDelayMs: 900000,
  connectTimeoutMs: 15000, responseHeaderTimeoutMs: 30000, readIdleTimeoutMs: 60000,
  minFreeSpaceBytes: 0, maxFileSizeBytes: null, updatedAt: timestamp
};
const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsDownloadsPage } from '/src/components/settings/SettingsModal.tsx';
import { HttpDownloaderPanel } from '/src/components/workspace/HttpDownloaderPanel.tsx';
import { ModalPortal } from '/src/components/common/ModalPortal.tsx';
import { TooltipLayer } from '/src/components/common/TooltipLayer.tsx';
import { getDownloadSettings, updateDownloadSettings } from '/src/api.ts';
import { initI18n } from '/src/i18n/index.ts';
import i18n from 'i18next';
import '/src/styles.css';
const params = new URLSearchParams(location.search);
const pools = [
  { id: 'pool-1', name: 'Data', path: '.', filesystem: 'ext4', status: 'ready' },
  { id: 'pool-2', name: 'Archive', path: '.', filesystem: 'ext4', status: params.has('offline') ? 'offline' : 'ready' }
];
function Harness() {
  const [settings, setSettings] = useState(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  return <div className="app-shell" style={{ display: 'block', height: '100dvh', overflow: 'auto' }}>
    <button onClick={async () => { setSettings(await getDownloadSettings()); setOpen(true); }}>Download settings</button>
    {notice ? <p role="status">{notice}</p> : null}
    <HttpDownloaderPanel pools={pools} storagePoolsLoading={false} selectedStoragePoolId="pool-1" locale={params.has('zh') ? 'zh-CN' : 'en'}
      onSelectStoragePool={() => {}} onOpenDirectory={() => {}} onOpenStorage={() => {}}
      onNotifyError={setNotice} onNotifySuccess={setNotice} onNotifyWarning={setNotice} />
    {open ? <ModalPortal className="settings-backdrop" onRequestClose={() => setOpen(false)}>
      <section className="settings-modal" role="dialog" aria-label="Download settings" style={{ display: 'flex', flexDirection: 'column' }} onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setOpen(false); }
      }}>
        <SettingsDownloadsPage settings={settings} loading={false} storagePools={pools} locale={params.has('zh') ? 'zh-CN' : 'en'}
          onSettingsChange={async patch => setSettings(await updateDownloadSettings(patch))} onClose={() => setOpen(false)} />
      </section>
    </ModalPortal> : null}
    <TooltipLayer />
  </div>;
}
await initI18n();
await i18n.changeLanguage(params.has('zh') ? 'zh-CN' : 'en');
createRoot(document.getElementById('root')).render(<Harness />);
`;

before(async () => {
  server = await createServer({
    configFile: fileURLToPath(new URL("../packages/web/vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../packages/web", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "download-settings-browser-harness",
      resolveId(id) { if (id === "/__download-settings-entry.tsx") return id; },
      load(id) { if (id === "/__download-settings-entry.tsx") return harness; },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__download-settings-test")) return next();
          response.setHeader("Content-Type", "text/html");
          response.end(await vite.transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/__download-settings-entry.tsx"></script></body></html>'));
        });
      }
    }]
  });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

async function openDownloads(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, reducedMotion: options.reducedMotion ?? "no-preference" });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let settings = { ...defaults, ...options.settings };
  const writes = [];
  let heldSettings = null;
  let hold = false;
  t.after(async () => { heldSettings?.resolve(); await context.close(); assert.deepEqual(errors, []); });
  await page.addInitScript(() => { globalThis.EventSource = class extends globalThis.EventTarget { close() {} }; });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/settings/downloads") {
      if (request.method() === "PATCH") {
        writes.push(request.postDataJSON());
        settings = { ...settings, ...request.postDataJSON() };
      } else if (hold) {
        hold = false;
        heldSettings = Promise.withResolvers();
        await heldSettings.promise;
      }
      return route.fulfill({ json: { settings } });
    }
    if (url.pathname === "/api/files") {
      const directory = url.searchParams.get("path") ?? ".";
      return route.fulfill({ json: { entries: directory === "." ? ["Downloads", "Other"].map(name => ({ name, path: name, kind: "directory", isSafe: true, sizeBytes: 0, modifiedAt: timestamp })) : [], git: null } });
    }
    if (url.pathname === "/api/files/meta") {
      if (options.missingDirectory) return route.fulfill({ status: 404, json: { error: "Directory no longer exists" } });
      return route.fulfill({ json: { meta: { path: url.searchParams.get("path"), kind: options.directoryKind ?? "directory" } } });
    }
    if (url.pathname === "/api/downloads/torrent-previews" || url.pathname.startsWith("/api/downloads/torrent-previews/")) {
      if (request.method() === "DELETE") return route.fulfill({ status: 204 });
      return route.fulfill({ json: { preview: { id: "preview", status: "ready", name: "release", files: [{ fileIndex: 0, path: "release/file.bin", sizeBytes: 42 }] } } });
    }
    if (url.pathname === "/api/downloads") {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        writes.push(body);
        return route.fulfill({ status: 201, json: { task: { id: "created", ...body, status: "queued", sourceKind: "http", receivedBytes: 0, totalBytes: null, speedBytesPerSecond: 0, targetFileName: body.fileName, targetPath: body.fileName, createdAt: timestamp } } });
      }
      return route.fulfill({ json: { tasks: [], health: { status: "ready", freshWorkers: 1, activeTasks: 0, queuedTasks: 0 } } });
    }
    await route.fulfill({ status: 404, json: { error: "Unknown browser test route" } });
  });
  await page.goto(`${baseUrl}__download-settings-test?${options.zh ? "zh&" : ""}${options.offline ? "offline" : ""}`, { timeout: 30_000 });
  await page.locator(".download-create-button").waitFor();
  await expect(page.locator(".download-create-button")).toBeEnabled();
  return {
    page, writes,
    holdSettings() { hold = true; },
    async releaseSettings() { hold = false; await expect.poll(() => Boolean(heldSettings)).toBe(true); heldSettings.resolve(); },
    setSettings(patch) { settings = { ...settings, ...patch }; }
  };
}

test("new downloads prefill the saved pool and directory and reread settings on reopen", async t => {
  const { page, setSettings } = await openDownloads(t);
  await page.locator(".download-create-button").click();
  await expect(page.locator(".download-target-value")).toContainText("Downloads");
  await expect(page.locator(".download-target-field")).toContainText("Archive");
  await page.keyboard.press("Escape");
  setSettings({ defaultStoragePoolId: "pool-1", defaultTargetDirectory: "Other" });
  await page.locator(".download-create-button").click();
  await expect(page.locator(".download-target-value")).toContainText("Other");
  await page.reload();
  await expect(page.locator(".download-create-button")).toBeEnabled();
  await page.locator(".download-create-button").click();
  await expect(page.locator(".download-target-value")).toContainText("Other");
});

test("an explicit folder choice wins over a late settings response", async t => {
  const state = await openDownloads(t);
  state.holdSettings();
  await state.page.locator(".download-create-button").click();
  await state.page.locator(".download-target-control button").click();
  await state.page.locator(".storage-file-picker-footer button").last().click();
  await state.releaseSettings();
  await expect(state.page.locator(".download-target-value")).toHaveText(".");
});

test("the settings directory picker persists a choice from another pool", async t => {
  const { page, writes } = await openDownloads(t, { settings: { defaultStoragePoolId: null, defaultTargetDirectory: null } });
  await page.getByRole("button", { name: "Download settings", exact: true }).click();
  await page.locator("#download-default-directory").click();
  await page.locator(".storage-file-picker-pool").filter({ hasText: "Archive" }).click();
  await page.locator(".storage-file-picker-row").filter({ hasText: "Downloads" }).click();
  await page.locator(".storage-file-picker-footer button").last().click();
  await expect(page.locator(".settings-download-directory-value")).toHaveText("Archive / Downloads");
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  assert.equal(writes[0].defaultStoragePoolId, "pool-2");
  assert.equal(writes[0].defaultTargetDirectory, "Downloads");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Download settings", exact: true })).toBeHidden();
  await page.locator(".download-create-button").click();
  await expect(page.locator(".download-target-value")).toHaveText("Downloads");
  await expect(page.locator(".download-target-field")).toContainText("Archive");
});

test("an unavailable configured pool requires a new choice while an unset default uses the selected pool", async t => {
  const { page, setSettings } = await openDownloads(t, { offline: true });
  await page.locator(".download-create-button").click();
  await expect(page.getByRole("alert")).toContainText("unavailable");
  await page.keyboard.press("Escape");
  setSettings({ defaultStoragePoolId: null, defaultTargetDirectory: null });
  await page.locator(".download-create-button").click();
  await expect(page.locator(".download-target-value")).toHaveText(".");
  await expect(page.locator(".download-target-field")).toContainText("Data");
});

for (const options of [{ missingDirectory: true }, { directoryKind: "file" }]) test(`an invalid saved directory requires a new choice: ${JSON.stringify(options)}`, async t => {
  const { page } = await openDownloads(t, options);
  await page.locator(".download-create-button").click();
  await expect(page.getByRole("alert")).toContainText("Choose a directory");
  await expect(page.locator(".download-target-value")).toContainText("Choose directory");
  await page.locator(".download-target-control button").click();
  await page.locator(".storage-file-picker-footer button").last().click();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.locator(".download-target-value")).toHaveText(".");
});

for (const mode of ["http", "magnet", "torrent-file"]) test(`${mode} creation submits the prefilled target`, async t => {
  const { page, writes } = await openDownloads(t);
  await page.locator(".download-create-button").click();
  await expect(page.locator(".download-target-value")).toContainText("Downloads");
  if (mode === "torrent-file") {
    await page.getByRole("tab", { name: "Torrent file", exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "test.torrent", mimeType: "application/x-bittorrent", buffer: Buffer.from("test") });
  } else {
    await page.locator('input[inputmode="url"]').fill(mode === "http" ? "https://example.com/file.bin" : "magnet:?xt=urn:btih:0123456789012345678901234567890123456789");
    if (mode === "magnet") await page.locator(".download-resolve-button").click();
  }
  await page.getByRole("button", { name: "Start download", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  assert.equal(writes[0].storagePoolId, "pool-2");
  assert.equal(writes[0].targetDirectory, "Downloads");
});

for (const [width, zh] of [[1440, false], [1040, false], [390, true]]) test(`settings controls and nested directory picker at ${width}px`, async t => {
  const { page, writes } = await openDownloads(t, { width, zh, reducedMotion: width === 390 ? "reduce" : "no-preference" });
  await page.getByRole("button", { name: "Download settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Download settings", exact: true });
  const bt = page.locator("#download-bt-concurrency");
  await expect(bt).toContainText("3");
  await bt.click();
  await page.getByRole("option", { name: zh ? "10 个连接" : "10 connection", exact: true }).click();
  await page.locator("#download-default-directory").click();
  await expect(page.locator(".storage-file-picker")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).toBeVisible();
  await expect(page.locator("#download-default-directory")).toBeFocused();
  await page.getByRole("button", { name: zh ? "清除默认目录" : "Clear default", exact: true }).click();
  await page.getByRole("button", { name: zh ? "保存更改" : "Save Changes", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  assert.equal(writes[0].btConcurrency, 10);
  assert.equal(writes[0].defaultStoragePoolId, null);
  assert.equal(writes[0].defaultTargetDirectory, null);
  assert.equal(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  const screenshots = fileURLToPath(new URL("../.cyberos/checks/download-settings-browser/", import.meta.url));
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/settings-${width}.png` });
});
