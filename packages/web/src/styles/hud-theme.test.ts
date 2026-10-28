import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("shared HUD theme", () => {
  it("keeps the Web shell on the shared single dark theme", async () => {
    const [imports, base, workspaces] = await Promise.all([
      readFile(new URL("../styles.css", import.meta.url), "utf8"),
      readFile(new URL("./base.css", import.meta.url), "utf8"),
      readFile(new URL("./hud-workspaces.css", import.meta.url), "utf8")
    ]);

    expect(base).toContain('@import "@zos/shared/hud-tokens.css"');
    expect(base).toContain("color-scheme: dark");
    expect(base).toContain("--app-bg: var(--zos-color-canvas)");
    expect(imports).toContain('./styles/hud-workspaces.css');
    expect(imports).not.toContain("hud-sample.css");
    expect(workspaces).toContain("--hud-void: var(--zos-hud-void)");
  });
});
