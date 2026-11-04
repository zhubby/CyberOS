import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { before, after, test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { createServer } from "vite";

const { chromium } = createRequire(new URL("../docs/package.json", import.meta.url))("playwright");
let server, browser, baseUrl;
before(async () => {
  server = await createServer({
    configFile: fileURLToPath(new URL("../packages/web/vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../packages/web", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 }
  });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, render, options = {}) {
  const { tv = false, ...pageOptions } = options;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", ...pageOptions });
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/system/network", route => route.fulfill({
    json: { interfaces: [{ name: "eth0", kind: "ethernet" }] }
  }));
  await page.route("**/__style_fixture__", route => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/${tv ? "tv/tv.css" : "styles.css"}"></head><body><main id="root" class="${tv ? "tv-library-shell" : "app-shell"}" style="display:block;height:100dvh;overflow:auto"></main><script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      globalThis.window.$RefreshReg$ = () => {};
      globalThis.window.$RefreshSig$ = () => type => type;
      globalThis.window.__vite_plugin_react_preamble_installed__ = true;
      const R = await import("/node_modules/.vite/deps/react.js");
      const React = R.default ?? R;
      const D = await import("/node_modules/.vite/deps/react-dom_client.js");
      const createRoot = D.createRoot ?? D.default.createRoot;
      const { CustomSelect } = await import("/src/components/common/CustomSelect.tsx");
      const { ModalPortal } = await import("/src/components/common/ModalPortal.tsx");
      const { useModalDialog } = await import("/src/components/workspace/useModalDialog.ts");
      ${render}
      globalThis.window.__fixtureReady = true;
    </script></body></html>`
  }));
  await page.goto(`${baseUrl}__style_fixture__`);
  await page.waitForFunction(() => globalThis.window.__fixtureReady);
  assert.deepEqual(errors, []);
  return page;
}

test("required custom select blocks form submission and focuses its trigger", async t => {
  const page = await fixture(t, `
    globalThis.window.__submissions = 0;
    function Form() {
      const [value, setValue] = React.useState("");
      return React.createElement("form", { onSubmit: event => { event.preventDefault(); globalThis.window.__submissions++; } },
        React.createElement(CustomSelect, { required: true, ariaLabel: "Storage pool", value, onChange: setValue,
          options: [{ value: "", label: "Choose a pool" }, { value: "pool-1", label: "Pool one" }] }),
        React.createElement("button", { type: "submit", className: "primary-button" }, "Save"));
    }
    createRoot(globalThis.document.getElementById("root")).render(React.createElement(Form));
  `);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.window.__submissions), 0);
  const trigger = page.getByRole("button", { name: "Storage pool", exact: true });
  assert.equal(await trigger.evaluate(element => element === globalThis.document.activeElement), true);
  await trigger.press("End");
  await trigger.press("Enter");
  assert.equal(await page.getByRole("listbox").count(), 0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.window.__submissions), 1);
});

test("command geometry, disabled, busy and keyboard focus agree across feature containers", async t => {
  const page = await fixture(t, `
    const contexts = ["standard", "music-panel", "music-dialog", "video-panel", "create-form-dialog-footer",
      "docker-compose-app-footer", "docker-daemon-settings-footer", "docker-image-dialog-footer",
      "storage-file-picker-footer", "storage-pool-form-actions"];
    createRoot(globalThis.document.getElementById("root")).render(React.createElement("div", { style: { padding: 24, display: "grid", gap: 20 } },
      ...contexts.map(context => React.createElement("section", { key: context, className: context, "data-context": context,
        style: { display: "flex", flexWrap: "wrap", gap: 12, height: "auto", width: "auto", padding: 20 } },
        ...["primary-button", "secondary-button", "danger-button"].flatMap(className =>
          ["default", "disabled", "busy"].map(state => React.createElement("button", { key: className + state, className,
            disabled: state !== "default", "aria-busy": state === "busy" || undefined,
            "data-state": state }, "Save")))))));
  `);
  const properties = ["minHeight", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "borderTopWidth", "borderRadius", "backgroundColor", "color", "fontFamily", "fontWeight", "opacity"];
  for (const kind of ["primary-button", "secondary-button", "danger-button"]) {
    for (const state of ["default", "disabled", "busy"]) {
      const styles = await page.locator(`.${kind}[data-state="${state}"]`).evaluateAll((elements, properties) =>
        elements.map(element => Object.fromEntries(properties.map(property => [property, globalThis.getComputedStyle(element)[property]]))), properties);
      for (const actual of styles) assert.deepEqual(actual, styles[0], `${kind} ${state}`);
      assert.equal(styles[0].minHeight, "34px");
      assert.equal(styles[0].opacity, "1");
      assert.equal(styles[0].borderRadius, "0px");
    }
  }
  await page.keyboard.press("Tab");
  const command = page.locator('.music-dialog .primary-button[data-state="default"]');
  await command.focus();
  assert.deepEqual(await command.evaluate(element => {
    const s = globalThis.getComputedStyle(element); return [s.outlineWidth, s.outlineColor, s.outlineOffset];
  }), ["2px", "rgb(0, 240, 255)", "3px"]);
});

test("management icon actions share quiet surfaces and target sizes inside modal portals", async t => {
  for (const { tv, width, size } of [
    { tv: false, width: 1440, size: 32 },
    { tv: false, width: 390, size: 44 },
    { tv: true, width: 1920, size: 44 }
  ]) {
    const page = await fixture(t, `
      const action = (state, key) => React.createElement("button", {
        key, className: "management-icon-action", "aria-label": key,
        disabled: state !== "default", "aria-busy": state === "busy" || undefined,
        "data-state": state
      }, "×");
      const states = ["default", "disabled", "busy"];
      createRoot(document.getElementById("root")).render(React.createElement(React.Fragment, null,
        React.createElement("div", { style: { padding: 24 } }, ...states.map(state => action(state, "workspace-" + state))),
        React.createElement(ModalPortal, null,
          React.createElement("section", { className: "management-modal docker-daemon-settings-dialog", role: "dialog", "aria-modal": true },
            React.createElement("header", null, ...states.map(state => action(state, "modal-" + state)))))));
    `, { tv, viewport: { width, height: 900 } });
    for (const state of ["default", "disabled", "busy"]) {
      const styles = await page.locator(`.management-icon-action[data-state="${state}"]`).evaluateAll(elements => elements.map(e => {
        const s = globalThis.getComputedStyle(e), rect = e.getBoundingClientRect();
        return { width: rect.width, height: rect.height, background: s.backgroundColor, color: s.color, border: s.borderTopColor, opacity: s.opacity };
      }));
      assert.deepEqual(styles[0], styles[1], `${tv ? "TV" : "Web"} ${width}px ${state}`);
      assert.equal(styles[0].width, size);
      assert.equal(styles[0].height, size);
      assert.equal(styles[0].opacity, "1");
      if (state === "default") assert.equal(styles[0].background, "rgba(0, 0, 0, 0)");
    }
  }
});

test("Web and TV share menu surfaces and states while retaining TV target size", async t => {
  const render = `createRoot(globalThis.document.getElementById("root")).render(React.createElement("div", { className: "workspace-search-field", style: { width: "min(320px, 100%)", padding: 24 } },
    React.createElement(CustomSelect, { value: "one", ariaLabel: "Library", onChange: () => undefined,
      options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }] })));`;
  const results = [];
  for (const tv of [false, true]) {
    const page = await fixture(t, render, { tv });
    await page.getByRole("button", { name: "Library", exact: true }).click();
    const palette = await page.getByRole("listbox").evaluate(menu => {
      const selected = menu.querySelector('[aria-selected="true"]');
      const s = globalThis.getComputedStyle(menu), o = globalThis.getComputedStyle(selected);
      return [s.backgroundColor, s.borderTopColor, s.boxShadow, o.color, o.backgroundColor, o.borderLeftColor];
    });
    results.push(palette);
    assert.equal(await page.getByRole("button", { name: "Library", exact: true }).evaluate(el => el.getBoundingClientRect().height), tv ? 48 : 40);
    assert.equal(await page.getByRole("option").first().evaluate(el => el.getBoundingClientRect().height), tv ? 48 : 32);
  }
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0][0], "rgb(22, 13, 18)");
  assert.notEqual(results[0][2], "none");
});

test("explicit compact fields share sizes across photo, network and playback containers", async t => {
  for (const { tv, width, height } of [
    { tv: false, width: 1440, height: 34 },
    { tv: false, width: 390, height: 44 },
    { tv: true, width: 1920, height: 48 }
  ]) {
    const page = await fixture(t, `
      const contexts = ["photo-sort-field", "photo-common-filters", "photo-condition-row", "system-wifi-toolbar", "playback-target-compact"];
      createRoot(document.getElementById("root")).render(React.createElement("div", null,
        ...contexts.map(context => React.createElement("div", { key: context, className: context, style: { padding: 24 } },
          React.createElement(CustomSelect, { className: "control-compact", value: "one", ariaLabel: context,
            onChange: () => undefined, options: [{ value: "one", label: "One" }] })))));
    `, { tv, viewport: { width, height: 900 } });
    for (const trigger of await page.locator(".custom-select-trigger").all()) {
      assert.equal(await trigger.evaluate(e => e.getBoundingClientRect().height), height);
    }
  }
});

test("numeric options, disabled options and disabled fieldsets preserve form semantics", async t => {
  const page = await fixture(t, `
    globalThis.window.__value = 60; globalThis.window.__submissions = 0;
    function Form() {
      const [value, setValue] = React.useState(60), [disabled, setDisabled] = React.useState(false);
      return React.createElement("form", { onSubmit: event => { event.preventDefault(); globalThis.window.__submissions++; } },
        React.createElement("fieldset", { disabled },
          React.createElement(CustomSelect, { required: true, ariaLabel: "Window", value: String(value),
            onChange: v => { globalThis.window.__value = Number(v); setValue(Number(v)); },
            options: [{ value: "60", label: "1m" }, { value: "300", label: "5m", disabled: true }, { value: "900", label: "15m" }] })),
        React.createElement("button", { type: "button", onClick: () => setDisabled(!disabled) }, "Toggle disabled"),
        React.createElement("button", { type: "submit" }, "Save"));
    }
    createRoot(globalThis.document.getElementById("root")).render(React.createElement(Form));
  `);
  const select = page.getByRole("button", { name: "Window", exact: true });
  await select.press("ArrowDown");
  await select.press("Enter");
  assert.equal(await page.evaluate(() => globalThis.window.__value), 900);
  assert.equal(await select.evaluate(element => element === globalThis.document.activeElement), true);
  await page.getByRole("button", { name: "Toggle disabled", exact: true }).click();
  assert.equal(await select.isDisabled(), true);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.window.__submissions), 1);
});

test("menus escape a clipped form row and keep the trigger focused after selection", async t => {
  const page = await fixture(t, `
    function Form() {
      const [value, setValue] = React.useState("one");
      return React.createElement("div", { style: { width: 280, height: 44, overflow: "hidden", margin: 24 } },
        React.createElement(CustomSelect, { value, ariaLabel: "Clipped row", onChange: setValue,
          options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }, { value: "three", label: "Three" }] }));
    }
    createRoot(document.getElementById("root")).render(React.createElement(Form));
  `);
  const trigger = page.getByRole("button", { name: "Clipped row", exact: true });
  await trigger.click();
  const menu = await page.getByRole("listbox").boundingBox();
  assert.ok(menu.height > 44);
  await page.getByRole("option", { name: "Three", exact: true }).click();
  assert.match(await trigger.textContent(), /Three/);
  await page.waitForFunction(() => globalThis.document.activeElement?.getAttribute("aria-label") === "Clipped row");
});

test("shared fields and disabled commands retain their geometry and contrast in feature forms", async t => {
  const page = await fixture(t, `
    const contexts = ["standard", "music-dialog", "management-dialog", "docker-create-dialog"];
    const footers = ["docker-compose-app-footer", "docker-daemon-settings-footer", "docker-image-dialog-footer",
      "docker-image-toolbar", "storage-file-picker-footer", "storage-pool-form-actions"];
    createRoot(document.getElementById("root")).render(React.createElement("div", null,
      ...contexts.map(context => React.createElement("section", { key: context, className: context },
        React.createElement("label", { className: "form-field create-form-field music-field" }, "Name", React.createElement("input")),
        React.createElement(CustomSelect, { value: "one", ariaLabel: context, onChange: () => undefined,
          options: [{ value: "one", label: "One" }] }))),
      ...footers.map(context => React.createElement("footer", { key: context, className: context },
        React.createElement("button", { disabled: true, className: "secondary-button" }, "Save")))));
  `);
  for (const input of await page.locator("input").all()) {
    assert.equal(await input.evaluate(e => e.getBoundingClientRect().height), 40);
  }
  for (const button of await page.locator("button:disabled").all()) {
    assert.equal(await button.evaluate(e => globalThis.getComputedStyle(e).opacity), "1");
  }
});

test("VOD track selectors submit numeric track IDs and a null subtitle ID for Off", async t => {
  const page = await fixture(t, `
    const i18n = await (await import("/src/i18n/index.ts")).initI18n();
    await i18n.changeLanguage("en");
    const { VodPlayerControls } = await import("/src/components/preview/VodPlayerControls.tsx");
    const track = { language: "eng", default: true, forced: false, external: false };
    const status = { state: "playing", sessionId: "session-1", fileName: "clip.mp4", relativePath: "movies/clip.mp4",
      positionSeconds: 30, durationSeconds: 120, volume: 75, retryCount: 0, nextRetryAt: null,
      audioFallbackReason: null, audioTracks: [{ ...track, id: 1, title: "Stereo" }, { ...track, id: 4, title: "Surround" }],
      subtitleTracks: [{ ...track, id: 2, title: "English" }], selectedAudioTrackId: 1, selectedSubtitleTrackId: 2 };
    globalThis.window.__commands = [];
    createRoot(document.getElementById("root")).render(React.createElement(VodPlayerControls,
      { status, busy: false, onRetry: () => undefined, onCommand: command => globalThis.window.__commands.push(command) }));
  `);
  await page.getByRole("button", { name: "Audio track", exact: true }).click();
  await page.getByRole("option", { name: "Surround · ENG", exact: true }).click();
  await page.getByRole("button", { name: "Subtitle track", exact: true }).click();
  await page.getByRole("option", { name: "Subtitles off", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.window.__commands), [
    { type: "set-audio-track", trackId: 4, sessionId: "session-1" },
    { type: "set-subtitle-track", trackId: null, sessionId: "session-1" }
  ]);
});

test("clicking a portaled option keeps its filter open until Apply", async t => {
  const page = await fixture(t, `
    await (await import("/src/i18n/index.ts")).initI18n();
    const { SearchFilterPopover } = await import("/src/components/common/SearchFilterPopover.tsx");
    function Filter() {
      const [value, setValue] = React.useState("one");
      return React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", padding: 24 } },
        React.createElement(SearchFilterPopover, { label: "Filters", active: false, onOpen: () => undefined, onApply: () => undefined, onReset: () => undefined },
          React.createElement(CustomSelect, { value, ariaLabel: "Category", onChange: setValue,
            options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }] })));
    }
    createRoot(document.getElementById("root")).render(React.createElement(Filter));
  `);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("button", { name: "Category", exact: true }).click();
  await page.getByRole("option", { name: "Two", exact: true }).click();
  assert.equal(await page.getByRole("dialog", { name: "Filters", exact: true }).count(), 1);
  assert.match(await page.getByRole("button", { name: "Category", exact: true }).textContent(), /Two/);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
});

test("Docker network form uses shared options and retains conditional driver modes", async t => {
  const page = await fixture(t, `
    const i18n = await (await import("/src/i18n/index.ts")).initI18n();
    await i18n.changeLanguage("en");
    const { DockerCreateDialogs } = await import("/src/components/workspace/DockerCreateDialogs.tsx");
    const summary = { enabled: true, engine: { status: "ready", version: "28", resourceCapabilities: {} },
      metrics: { containers: { total: 0 }, volumes: 0, networks: 0 }, networks: [], volumes: [] };
    createRoot(document.getElementById("root")).render(React.createElement(DockerCreateDialogs, { kind: "network", summary, storagePools: [],
      onClose: () => undefined, onComplete: () => undefined, onError: () => undefined }));
  `);
  assert.equal(await page.locator("select").count(), 0);
  const selects = page.locator(".create-form-field .custom-select-trigger");
  await selects.nth(0).click();
  await page.getByRole("option", { name: "macvlan", exact: true }).click();
  await selects.nth(2).click();
  assert.equal(await page.getByRole("option", { name: "passthru", exact: true }).count(), 1);
  await page.keyboard.press("Escape");
  await selects.nth(0).click();
  await page.getByRole("option", { name: "ipvlan", exact: true }).click();
  await selects.nth(2).click();
  assert.equal(await page.getByRole("option", { name: "l3s", exact: true }).count(), 1);
  assert.equal(await page.getByRole("option", { name: "passthru", exact: true }).count(), 0);
});

test("Escape dismisses a select, then the nested modal, and restores focus at each level", async t => {
  const page = await fixture(t, `
    function Dialog({ inner = false, onClose }) {
      const [nested, setNested] = React.useState(false);
      const ref = useModalDialog(onClose);
      return React.createElement(ModalPortal, { className: "management-dialog-backdrop", onRequestClose: onClose },
        React.createElement("section", { ref, tabIndex: -1, className: "management-dialog", role: "dialog", "aria-modal": true, "aria-label": inner ? "Inner" : "Outer" },
          React.createElement(CustomSelect, { required: true, ariaLabel: inner ? "Inner choice" : "Outer choice", value: "one", onChange: () => undefined,
            options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }] }),
          !inner && React.createElement("button", { className: "secondary-button", onClick: () => setNested(true) }, "Open inner"),
          React.createElement("button", { className: "secondary-button", onClick: onClose }, "Close"),
          nested && React.createElement(Dialog, { inner: true, onClose: () => setNested(false) })));
    }
    function App() { const [open, setOpen] = React.useState(false); return React.createElement(React.Fragment, null,
      React.createElement("button", { className: "primary-button", onClick: () => setOpen(true) }, "Open outer"),
      open && React.createElement(Dialog, { onClose: () => setOpen(false) })); }
    createRoot(globalThis.document.getElementById("root")).render(React.createElement(App));
  `);
  await page.getByRole("button", { name: "Open outer", exact: true }).click();
  await page.getByRole("button", { name: "Open inner", exact: true }).click();
  const select = page.getByRole("button", { name: "Inner choice", exact: true });
  await select.click();
  await select.press("Escape");
  assert.equal(await page.getByRole("listbox").count(), 0);
  assert.equal(await page.getByRole("dialog").count(), 2);
  await select.press("Tab");
  assert.equal(await page.getByRole("dialog", { name: "Inner", exact: true }).getByRole("button", { name: "Close", exact: true }).evaluate(e => e === globalThis.document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(await select.evaluate(e => e === globalThis.document.activeElement), true);
  await select.press("Escape");
  await page.waitForFunction(() => globalThis.document.activeElement?.textContent === "Open inner");
  assert.equal(await page.getByRole("dialog").count(), 1);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => globalThis.document.activeElement?.textContent === "Open outer");
  assert.equal(await page.getByRole("dialog").count(), 0);
});

for (const locale of ["zh-CN", "en-US"]) for (const width of [1440, 820, 560, 390, 320]) {
  test(`long form labels and menus fit ${locale} at ${width}px in a short viewport`, async t => {
    const page = await fixture(t, `
      const chinese = ${locale === "zh-CN"};
      const long = chinese ? "非常长的存储池名称与操作说明".repeat(5) : "Very long storage pool and operation description ".repeat(5);
      createRoot(globalThis.document.getElementById("root")).render(React.createElement(ModalPortal, { className: "management-dialog-backdrop" },
        React.createElement("form", { className: "management-dialog create-form-dialog", role: "dialog", "aria-label": "Create" },
          React.createElement("header", { className: "create-form-dialog-header" }, React.createElement("h2", { style: { overflowWrap: "anywhere", margin: 0 } }, long)),
          React.createElement("div", { className: "create-form-dialog-body" },
            React.createElement("label", { className: "create-form-field" }, React.createElement("span", null, chinese ? "存储池" : "Storage pool"),
              React.createElement(CustomSelect, { required: true, value: "one", ariaLabel: "Pool", onChange: () => undefined,
                options: [{ value: "one", label: long }, ...Array.from({ length: 30 }, (_, i) => ({ value: String(i), label: long + i }))] }))),
          React.createElement("footer", { className: "create-form-dialog-footer" }, React.createElement("div", null,
            React.createElement("button", { type: "button", className: "secondary-button" }, chinese ? "取消" : "Cancel"),
            React.createElement("button", { type: "button", className: "primary-button" }, chinese ? "创建" : "Create"))))));
    `, { viewport: { width, height: 420 }, locale });
    const trigger = page.getByRole("button", { name: "Pool", exact: true });
    await trigger.click();
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    assert.equal(await page.getByRole("dialog").evaluate(e => e.scrollWidth <= e.clientWidth), true);
    const box = await page.getByRole("listbox").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 420, JSON.stringify(box));
    await trigger.press("End");
    assert.equal(await page.getByRole("listbox").evaluate(e => e.scrollTop > 0), true);
    await trigger.press("Escape");
    assert.equal(await trigger.evaluate(e => e === globalThis.document.activeElement), true);
    assert.equal(await page.locator(".is-spinning").count(), 0);
    if (width === 390 && locale === "zh-CN") {
      await mkdir(fileURLToPath(new URL("../.cyberos/style-refactor/screenshots/", import.meta.url)), { recursive: true });
      await page.screenshot({ path: fileURLToPath(new URL("../.cyberos/style-refactor/screenshots/form-390.png", import.meta.url)) });
    }
  });
}
