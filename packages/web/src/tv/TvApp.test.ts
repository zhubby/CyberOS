import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("TV display policy", () => {
  it("keeps the HDMI shell visible while idle", async () => {
    const [component, styles] = await Promise.all([
      readFile(new URL("./TvApp.tsx", import.meta.url), "utf8"),
      readFile(new URL("./tv.css", import.meta.url), "utf8")
    ]);

    expect(component).not.toContain("IDLE_TIMEOUT_MS");
    expect(component).not.toContain("tv-sleep");
    expect(styles).not.toContain(".tv-sleep");
  });

  it("uses the shared dark HUD without moving focused controls", async () => {
    const [entry, styles, tokens] = await Promise.all([
      readFile(new URL("./main.tsx", import.meta.url), "utf8"),
      readFile(new URL("./tv.css", import.meta.url), "utf8"),
      readFile(new URL("../../../shared/src/hud-tokens.css", import.meta.url), "utf8")
    ]);

    expect(entry).toContain('@fontsource/rajdhani/700.css');
    expect(entry).not.toContain("Newsreader");
    expect(styles).toContain('@import "@zos/shared/hud-tokens.css"');
    expect(styles).toContain("outline: 3px solid var(--tv-focus)");
    expect(styles).not.toContain("transform: translateY(-6px)");
    expect(tokens).toContain("--zos-color-command: var(--zos-hud-yellow)");
    expect(tokens).toContain("--zos-color-focus: var(--zos-hud-cyan)");
  });
});
