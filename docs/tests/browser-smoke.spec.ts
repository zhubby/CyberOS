import { expect, test } from "@playwright/test";

test("serves the documentation site under /docs with navigation, search, and diagrams", async ({ page }) => {
  await page.goto("/docs/");
  await expect(page).toHaveTitle(/ZOS/);
  await expect(page.locator("a[href='/docs/architecture/system-overview/']").first()).toBeVisible();
  await expect(page.locator("input[placeholder*='搜索'], button[aria-label*='搜索']").first()).toBeVisible();

  await page.goto("/docs/architecture/system-overview/");
  await expect(page.locator("main h1")).toContainText("系统总览");
  await expect(page.locator("pre.mermaid svg")).toBeVisible({ timeout: 10_000 });
});

test("does not expose a React fallback for an unknown documentation route", async ({ request }) => {
  const response = await request.get("/docs/does-not-exist/");
  expect(response.status()).toBe(404);
  expect(await response.text()).not.toContain("ZOS current");
});
