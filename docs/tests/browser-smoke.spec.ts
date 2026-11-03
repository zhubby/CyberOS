import { expect, test } from "@playwright/test";

test("serves the documentation site under /docs with navigation, search, and diagrams", async ({ page }) => {
  await page.goto("/docs/");
  await expect(page).toHaveTitle(/CyberOS/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("starlight-theme-select")).toHaveCount(0);
  await expect(page.locator("a[href='/docs/architecture/system-overview/']").first()).toBeVisible();
  await expect(page.locator("input[placeholder*='搜索'], button[aria-label*='搜索']").first()).toBeVisible();

  await page.goto("/docs/architecture/system-overview/");
  await expect(page.locator("main h1")).toContainText("系统总览");
  await expect(page.locator("pre.mermaid svg")).toBeVisible({ timeout: 10_000 });
});

test("does not expose a React fallback for an unknown documentation route", async ({ request }) => {
  const response = await request.get("/docs/does-not-exist/");
  expect(response.status()).toBe(404);
  expect(await response.text()).not.toContain("CyberOS current");
});

test("keeps compact toolbar buttons labeled and square at desktop and mobile widths", async ({ page }) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/docs/operations/cybermachine/");
    const toolbar = page.locator('site-search [data-open-modal], .sl-menu-button').filter({ visible: true });
    await expect(toolbar).toHaveCount(width < 800 ? 2 : 1);
    await expect(page.locator('.expressive-code .copy button').first()).toHaveAttribute("aria-label", /\S/);
    const toolbarButtons = page.locator('site-search [data-open-modal], .sl-menu-button, .expressive-code .copy button').filter({ visible: true });
    for (const button of await toolbarButtons.all()) {
      await expect(button).toHaveAttribute("aria-label", /\S/);
      await expect(button).toHaveAttribute("data-tooltip", await button.getAttribute("aria-label") ?? "");
      const geometry = await button.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
        };
      });
      expect(geometry.width).toBeGreaterThanOrEqual(32);
      expect(geometry.height).toBeGreaterThanOrEqual(32);
      expect(geometry.corners).toEqual(["0px", "0px", "0px", "0px"]);
    }
    await expect(page.locator('.pagefind-ui__search-input')).toHaveAttribute("data-tooltip", /\S/);
    await expect(page.locator('.pagefind-ui__search-input')).toHaveAttribute("aria-label", /\S/);
    await expect(page.locator('[title]')).toHaveCount(0);
    await toolbarButtons.first().hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveClass("hud-tooltip");
    await expect(tooltip).toHaveText(await toolbarButtons.first().getAttribute("aria-label") ?? "");
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  }
});

test("keeps tooltips open during unrelated scrolling and dismisses when their own container scrolls", async ({ page }) => {
  await page.goto("/docs/");
  await expect(page.locator('site-search [data-open-modal]')).toHaveAttribute("data-tooltip", /\S/);
  await page.evaluate(() => {
    const fixture = document.createElement("section");
    fixture.style.cssText = "position:fixed;left:20px;top:200px;z-index:9999;width:260px";
    fixture.innerHTML = '<div id="tooltip-own-scroll" style="height:80px;overflow:auto"><button id="tooltip-scroll-trigger" data-tooltip="Shared scrolling tooltip">Tooltip trigger</button><div style="height:500px"></div></div><div id="tooltip-unrelated-scroll" style="height:80px;overflow:auto"><div style="height:1000px"></div></div>';
    document.body.append(fixture);
  });
  await page.locator("#tooltip-scroll-trigger").hover();
  const timer = await page.evaluate(() => {
    const scroller = document.getElementById("tooltip-unrelated-scroll")!;
    return window.setInterval(() => { scroller.scrollTop = (scroller.scrollTop + 10) % 500; }, 20);
  });
  try {
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText("Shared scrolling tooltip");
    await page.waitForTimeout(600);
    await expect(tooltip).toBeVisible();
    await page.locator("#tooltip-own-scroll").evaluate((element) => { element.scrollTop = 10; });
    await expect(tooltip).toHaveCount(0);
  } finally {
    await page.evaluate((timer) => window.clearInterval(timer), timer);
  }
});

test("coordinates shared tooltips with other help layers", async ({ page }) => {
  await page.goto("/docs/");
  await expect(page.locator('site-search [data-open-modal]')).toHaveAttribute("data-tooltip", /\S/);
  await page.evaluate(() => {
    const trigger = document.createElement("button");
    trigger.id = "tooltip-coordination-trigger";
    trigger.dataset.tooltip = "Shared help";
    trigger.textContent = "Help trigger";
    trigger.style.cssText = "position:fixed;left:20px;top:200px;z-index:9999";
    document.body.append(trigger);
    document.addEventListener("cyberos:tooltip-open", (event) => {
      if (event instanceof CustomEvent) trigger.dataset.openedTooltip = event.detail;
    });
  });
  const trigger = page.locator("#tooltip-coordination-trigger");
  const tooltip = page.getByRole("tooltip");
  await trigger.focus();
  await expect(tooltip).toHaveText("Shared help");
  await expect(trigger).toHaveAttribute("data-opened-tooltip", await tooltip.getAttribute("id") ?? "");
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent("cyberos:tooltip-open", { detail: "settings-help-tip" }));
  });
  await expect(tooltip).toHaveCount(0);
  await expect(trigger).not.toHaveAttribute("aria-describedby");

  await trigger.blur();
  await trigger.hover();
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent("cyberos:tooltip-open", { detail: "settings-help-tip" }));
  });
  await page.waitForTimeout(500);
  await expect(tooltip).toHaveCount(0);
});
