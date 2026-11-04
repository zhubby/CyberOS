import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readStylesheet } from "./test-utils.js";

describe("shared HUD theme", () => {
  it("keeps the Web shell on the shared single dark theme", async () => {
    const [imports, base, workspaces] = await Promise.all([
      readFile(new URL("../styles.css", import.meta.url), "utf8"),
      readStylesheet(new URL("./base.css", import.meta.url)),
      readStylesheet(new URL("./hud-workspaces.css", import.meta.url))
    ]);

    expect(base).toContain('@import "@cyberos/shared/hud-tokens.css"');
    expect(base).toContain("color-scheme: dark");
    expect(base).toContain("--app-bg: var(--cyberos-color-canvas)");
    expect(imports).toContain('./styles/hud-workspaces.css');
    expect(imports).not.toContain("hud-sample.css");
    expect(workspaces).toContain("--hud-void: var(--cyberos-hud-void)");
  });

  it("keeps loading skeletons visible against dark panel surfaces", async () => {
    const [base, brand] = await Promise.all([
      readStylesheet(new URL("./base.css", import.meta.url)),
      readStylesheet(new URL("./brand.css", import.meta.url))
    ]);
    const skeletonStyles = brand.match(/\.management-skeleton-block,\s*\.skeleton-block\s*\{([^}]+)\}/)?.[1];

    expect(base).toContain("--skeleton-base: color-mix(in srgb, var(--text) 14%, var(--surface))");
    expect(base).toContain("--skeleton-highlight: color-mix(in srgb, var(--text) 28%, var(--surface))");
    expect(skeletonStyles).toContain("background-color: var(--skeleton-base)");
    expect(skeletonStyles).toContain("background-image: linear-gradient(90deg, var(--skeleton-base), var(--skeleton-highlight), var(--skeleton-base))");
    expect(skeletonStyles).not.toContain("rgb(5 10 14");
  });
});
