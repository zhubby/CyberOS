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
});
