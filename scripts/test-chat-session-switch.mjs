import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { createServer } from "vite";

// Reuse the browser installed for the documentation smoke suite.
const { chromium, expect } = createRequire(new URL("../docs/package.json", import.meta.url))("@playwright/test");
const timestamp = "2026-11-04T00:00:00.000Z";
const sessions = ["a", "b", "c", "empty", "failed", ...Array.from({ length: 24 }, (_, index) => `extra-${index}`)].map((id) => ({
  id, currentPath: ".", createdAt: timestamp, updatedAt: timestamp,
  firstMessage: `Session ${id.toUpperCase()}`, lastMessage: null, pendingApprovalCount: 0,
  activeJob: id === "c" ? { id: "job-c", sessionId: id, messageId: "prompt-c", status: "running" } : null
}));
const streams = new Map();
let server;
let browser;
let baseUrl;

before(async () => {
  server = await createServer({
    configFile: fileURLToPath(new URL("../packages/web/vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../packages/web", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "chat-test-events",
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const path = new URL(request.url, "http://localhost").pathname;
          if (!path.endsWith("/events")) return next();
          response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          response.write(": connected\n\n");
          const clients = streams.get(path) ?? new Set();
          clients.add(response);
          streams.set(path, clients);
          request.on("close", () => clients.delete(response));
        });
      }
    }]
  });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  for (const clients of streams.values()) for (const response of clients) response.end();
  await server?.close();
});

function snapshot(id) {
  return {
    transcript: id === "empty" ? [] : Array.from({ length: 31 }, (_, index) => ({
      id: `${id}-message-${index}`, role: index % 2 ? "assistant" : "user",
      content: `${id.toUpperCase()} message ${index}\n\n${"Persisted conversation. ".repeat(10)}`,
      createdAt: timestamp, sequence: index + 1, turnSequence: Math.floor(index / 2) + 1
    })),
    lastEventId: 40, activeJob: sessions.find((item) => item.id === id)?.activeJob ?? null, liveEvents: []
  };
}

async function openChat(t, { width = 1440, language = "en-US", reducedMotion = "no-preference", holdInitial = false, failure = null, initialApprovals = [] } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language, reducedMotion });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const blocks = new Map();
  const failed = new Set();
  const mutations = [];
  const block = (id) => {
    const gate = Promise.withResolvers();
    blocks.set(id, gate);
    return () => { blocks.delete(id); gate.resolve(); };
  };
  t.after(async () => {
    for (const gate of blocks.values()) gate.resolve();
    await context.close();
  });
  const releaseInitial = holdInitial ? block("a") : () => {};
  const fixtures = {
    "/api/system/storage": { storage: { pools: [], drives: [] } },
    "/api/settings/model-provider": { settings: { generation: 1, providerName: "openai", model: "test-model", baseUrl: null, apiKeyConfigured: false, updatedAt: timestamp } },
    "/api/approvals": { capabilityApprovals: [] },
    "/api/operations": { operations: [] },
    "/api/docker/operations": { operations: [] },
    "/api/vms/operations": { operations: [] },
    "/api/files/batches": { batches: [] },
    "/api/notifications": { notifications: [], bluetoothTransfers: [], unreadCount: 0, bluetoothUnreadCount: 0 },
    "/api/notifications/summary": { operations: 0, bluetoothTransfers: 0, alerts: 0 },
    "/api/monitoring/alerts/incidents": { incidents: [] }
  };
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/events")) return route.continue();
    if (route.request().method() !== "GET") mutations.push(path);
    let body = fixtures[path];
    let status = body ? 200 : 503;
    if (path === "/api/approvals") body = { capabilityApprovals: url.searchParams.get("sessionId") === "a" ? initialApprovals : [] };
    if (path === "/api/sessions") {
      body = failure === "sessions" ? { error: "Initial sessions failed" } : { sessions };
      status = failure === "sessions" ? 503 : 200;
      if (route.request().method() === "POST") {
        const gate = blocks.get("create");
        if (gate) await gate.promise;
        body = { session: { ...sessions[0], id: "created", firstMessage: null } };
        status = 201;
      }
    }
    const transcriptMatch = /^\/api\/sessions\/([^/]+)\/transcript$/u.exec(path);
    if (transcriptMatch) {
      const id = transcriptMatch[1];
      const gate = blocks.get(id);
      if (gate) await gate.promise;
      status = failed.has(id) || failure === "transcript" ? 503 : 200;
      body = status === 200 ? snapshot(id) : { error: "Transcript request failed" };
    }
    if (path === "/api/settings/model-provider" && failure === "model") {
      status = 503;
      body = { error: "Model settings unavailable" };
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body ?? { error: "Unavailable in chat fixture" }) });
  });
  await page.goto(`${baseUrl}#/app/agent`);
  return { page, block, failed, mutations, errors, releaseInitial, compact: width <= 1040 };
}

async function ready(page) {
  await expect(page.locator(".composer textarea")).toBeVisible();
  await expect(page.locator(".transcript")).toHaveAttribute("aria-busy", "false");
}

async function select(chat, id, { preserveFocus = false } = {}) {
  const { page, compact } = chat;
  if (compact) await page.locator(".chat-header .panel-header-action").first().click();
  const button = page.locator(compact ? ".mobile-sessions-dialog .session-item" : ".agent-list .session-item")
    .nth(sessions.findIndex((item) => item.id === id));
  if (preserveFocus) await button.evaluate((element) => element.click());
  else await button.click();
}

async function rememberShell(page) {
  await page.evaluate(() => {
    globalThis.chatShell = Object.fromEntries([".chat-pane", ".agent-list", ".session-list", ".agent-footer", ".chat-main", ".chat-header", ".composer", ".composer textarea"]
      .map((selector) => [selector, globalThis.document.querySelector(selector)]));
  });
}

async function assertSameShell(page) {
  assert.deepEqual(await page.evaluate(() => Object.entries(globalThis.chatShell)
    .filter(([selector, element]) => globalThis.document.querySelector(selector) !== element)
    .map(([selector]) => selector)), [], "session loading replaced persistent shell nodes");
}

for (const options of [
  { width: 1440, language: "en-US", reducedMotion: "no-preference" },
  { width: 1440, language: "zh-CN", reducedMotion: "reduce" },
  { width: 820, language: "zh-CN", reducedMotion: "no-preference" },
  { width: 560, language: "en-US", reducedMotion: "reduce" },
  { width: 390, language: "zh-CN", reducedMotion: "reduce" },
  { width: 320, language: "en-US", reducedMotion: "no-preference" }
]) {
  test(`${options.width}px ${options.language} ${options.reducedMotion}: switch only the transcript`, async (t) => {
    const chat = await openChat(t, { ...options, holdInitial: true });
    const { page } = chat;
    await expect(page.locator(".chat-pane.chat-loading")).toBeVisible();
    assert.equal(await page.locator("textarea").count(), 0);
    chat.releaseInitial();
    await ready(page);
    await page.locator(".composer textarea").fill("Preserved draft 草稿");
    await rememberShell(page);
    const releaseB = chat.block("b");
    await select(chat, "b", { preserveFocus: !chat.compact });
    await expect(page.locator(".transcript")).toHaveAttribute("aria-busy", "true");
    await assertSameShell(page);
    await expect(page.locator(".chat-header")).toContainText("Session B");
    await expect(page.locator(".transcript-skeleton")).toBeVisible();
    await expect(page.locator(".transcript .message")).toHaveCount(0);
    await expect(page.locator(".composer textarea")).toHaveValue("Preserved draft 草稿");
    await expect(page.locator(".composer button[type=submit]")).toBeDisabled();
    if (!chat.compact) await expect(page.locator(".composer textarea")).toBeFocused();
    await page.locator(".composer textarea").fill("Edited while loading");
    await page.locator(".composer textarea").press("Enter");
    assert.deepEqual(chat.mutations, [], "loading allowed a message to be submitted");
    if (options.width === 1440 && options.language === "en-US") {
      const directory = fileURLToPath(new URL("../.cyberos/chat-browser/", import.meta.url));
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: `${directory}/switch-loading.png` });
    }
    releaseB();
    await ready(page);
    await assertSameShell(page);
    await expect(page.locator(".transcript")).toContainText("B message 30");
    await expect(page.locator(".composer textarea")).toHaveValue("Edited while loading");
    await expect(page.locator(".composer button[type=submit]")).toBeEnabled();
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
    assert.deepEqual(chat.errors, []);
  });
}

test("rapid A to B to C ignores late history, restores running controls and reading positions", async (t) => {
  const chat = await openChat(t);
  const { page } = chat;
  await ready(page);
  await page.locator(".transcript").evaluate((element) => { element.scrollTop = 220; });
  await expect.poll(() => page.locator(".transcript").evaluate((element) => element.scrollTop)).toBe(220);
  // Allow the scroll listener to persist the reader's position before switching.
  await page.waitForFunction(() => globalThis.document.querySelector(".transcript").scrollTop === 220);
  const releaseB = chat.block("b");
  await select(chat, "b");
  await expect(page.locator(".transcript")).toHaveAttribute("aria-busy", "true");
  await select(chat, "c");
  await ready(page);
  await expect(page.locator(".transcript")).toContainText("C message 30");
  await expect(page.locator(".composer-delivery")).toBeVisible();
  const lateB = page.waitForResponse("**/api/sessions/b/transcript");
  releaseB();
  await lateB;
  await expect(page.locator(".chat-header")).toContainText("Session C");
  await expect(page.locator(".transcript")).not.toContainText("B message 30");
  await select(chat, "a");
  await ready(page);
  await expect.poll(() => page.locator(".transcript").evaluate((element) => element.scrollTop)).toBe(220);
  await page.waitForFunction(() => [...globalThis.document.querySelectorAll(".message")].at(-1)?.textContent.includes("A message 30"));
  await expect.poll(() => page.locator(".transcript").evaluate((element) => element.scrollTop)).toBe(220);
  assert.deepEqual(chat.errors, []);
});

test("keyboard switching preserves sidebar scroll and focus", async (t) => {
  const chat = await openChat(t);
  const { page } = chat;
  await ready(page);
  const sidebarTop = await page.locator(".session-list").evaluate((element) => {
    element.scrollTop = 120;
    return element.scrollTop;
  });
  assert.ok(sidebarTop > 0, "fixture must have a scrollable session list");
  const target = page.locator(".agent-list .session-item").nth(1);
  await target.evaluate((element) => element.focus({ preventScroll: true }));
  const releaseB = chat.block("b");
  await page.keyboard.press("Enter");
  await expect(page.locator(".transcript")).toHaveAttribute("aria-busy", "true");
  await expect(target).toBeFocused();
  assert.equal(await page.locator(".session-list").evaluate((element) => element.scrollTop), sidebarTop);
  await expect(page.locator(".agent-settings-button:not(.agent-playback-button)")).toBeEnabled();
  await expect(page.locator(".agent-playback-button")).toBeEnabled();
  await expect(page.locator(".agent-notification-button")).toBeEnabled();
  releaseB();
  await ready(page);
  await expect(target).toBeFocused();
  assert.equal(await page.locator(".session-list").evaluate((element) => element.scrollTop), sidebarTop);
});

test("a late new-session response cannot replace a subsequently selected session", async (t) => {
  const chat = await openChat(t);
  const { page } = chat;
  await ready(page);
  const releaseCreate = chat.block("create");
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/sessions" && response.request().method() === "POST");
  await page.locator(".agent-list-head button").click();
  await expect(page.locator(".transcript")).toHaveAttribute("aria-busy", "true");
  await select(chat, "b");
  await ready(page);
  releaseCreate();
  await created;
  await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
  await expect(page.locator(".chat-header")).toContainText("Session B");
  await expect(page.locator(".transcript")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".transcript")).toContainText("B message 30");
});

test("live messages preserve historical reading and follow the end when requested", async (t) => {
  const { page, errors } = await openChat(t);
  await ready(page);
  const transcript = page.locator(".transcript");
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await transcript.evaluate((element) => { element.scrollTop = 220; });
  await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
  const path = "/api/sessions/a/events";
  await expect.poll(() => streams.get(path)?.size ?? 0).toBe(1);
  const emit = (id) => {
    const event = {
      id, sessionId: "a", runId: "run-a", type: "agent.message", audience: "chat", createdAt: timestamp,
      transcriptSequence: id, transcriptTurnSequence: 17,
      payload: { role: "assistant", content: `Live message ${id}\n\n${"New live content. ".repeat(30)}` }
    };
    for (const response of streams.get(path)) response.write(`id: ${id}\nevent: agent.message\ndata: ${JSON.stringify(event)}\n\n`);
  };
  emit(41);
  await expect(transcript).toContainText("Live message 41");
  assert.equal(await transcript.evaluate((element) => element.scrollTop), 220);
  await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
  emit(42);
  await expect(transcript).toContainText("Live message 42");
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  assert.deepEqual(errors, []);
});

test("a session switch clears old deletion and approval confirmations", async (t) => {
  const approval = {
    id: "approval-a", runId: "run-a", sessionId: "a", jobId: "job-a", status: "pending",
    proposal: { summary: "Old session action" }, risk: "high", revision: 1, requiresConfirmation: true,
    expiresAt: "2026-11-05T00:00:00.000Z", createdAt: timestamp, updatedAt: timestamp, client: null,
    run: { id: "run-a", capabilityId: "cyberos.files.mutate", state: "waiting_approval", subjectId: "a", subjectKind: "agent", input: {}, revision: 1, createdAt: timestamp }
  };
  const chat = await openChat(t, { initialApprovals: [approval] });
  const { page } = chat;
  await ready(page);
  await page.locator(".approval-approve").click();
  await expect(page.locator("#approval-secret-title")).toBeVisible();
  await select(chat, "b", { preserveFocus: true });
  await ready(page);
  await expect(page.locator("#approval-secret-title")).toHaveCount(0);
  await page.locator(".chat-delete-session-button").click();
  await expect(page.locator(".session-delete-dialog")).toBeVisible();
  await select(chat, "empty", { preserveFocus: true });
  await ready(page);
  await expect(page.locator(".session-delete-dialog")).toHaveCount(0);
  assert.deepEqual(chat.mutations, []);
  assert.deepEqual(chat.errors, []);
});

test("empty history, failures and subsequent switches keep the shell usable", async (t) => {
  const chat = await openChat(t);
  const { page } = chat;
  await ready(page);
  await rememberShell(page);
  chat.failed.add("failed");
  await select(chat, "failed");
  await ready(page);
  await assertSameShell(page);
  await expect(page.locator(".transcript-skeleton")).toHaveCount(0);
  await expect(page.locator(".transcript .empty-state")).toHaveCount(0);
  await expect(page.locator(".app-notification[data-tone=error]")).toContainText("Transcript request failed");
  await select(chat, "empty");
  await ready(page);
  await expect(page.locator(".transcript .empty-state")).toBeVisible();
  await select(chat, "b");
  await ready(page);
  await expect(page.locator(".transcript")).toContainText("B message 30");
  await assertSameShell(page);
  assert.deepEqual(chat.errors, []);
});

for (const failure of ["sessions", "transcript", "model"]) {
  test(`initial ${failure} failure exits the full skeleton`, async (t) => {
    const { page, errors } = await openChat(t, { failure });
    await ready(page);
    await expect(page.locator(".chat-pane.chat-loading")).toHaveCount(0);
    assert.deepEqual(errors, []);
  });
}
