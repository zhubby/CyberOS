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
    await page.goto("/docs/operations/cm5/");
    const toolbar = page.locator('site-search [data-open-modal], .sl-menu-button').filter({ visible: true });
    await expect(toolbar).toHaveCount(width < 800 ? 2 : 1);
    await expect(page.locator('.expressive-code .copy button').first()).toHaveAttribute("aria-label", /\S/);
    const toolbarButtons = page.locator('site-search [data-open-modal], .sl-menu-button, .expressive-code .copy button').filter({ visible: true });
    for (const button of await toolbarButtons.all()) {
      await expect(button).toHaveAttribute("aria-label", /\S/);
      await expect(button).toHaveAttribute("title", await button.getAttribute("aria-label") ?? "");
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
  }
});
