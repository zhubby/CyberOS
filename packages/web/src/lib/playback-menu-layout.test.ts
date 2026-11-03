import { describe, expect, it } from "vitest";
import { playbackMenuLayout } from "./playback-menu-layout.js";

describe("anchored playback menu", () => {
  it("stays near the playback button with space for the outer frame", () => {
    const layout = playbackMenuLayout({ right: 60, top: 742, bottom: 780 }, { width: 1440, height: 900 }, 500);
    expect(layout.width).toBe(360);
    expect(layout.left).toBe(84);
    expect(layout.top + 500).toBe(780);
  });

  it.each([1440, 820, 560, 390, 320])("stays inside a %ipx viewport including short screens", (width) => {
    for (const height of [900, 280]) {
      const layout = playbackMenuLayout({ right: 60, top: height - 96, bottom: height - 58 }, { width, height }, 650);
      expect(layout.width).toBeLessThanOrEqual(360);
      expect(layout.left).toBeGreaterThanOrEqual(16);
      expect(layout.left + layout.width).toBeLessThanOrEqual(width - 16);
      expect(layout.top).toBeGreaterThanOrEqual(16);
      expect(layout.top + Math.min(650, layout.maxHeight)).toBeLessThanOrEqual(height - 16);
    }
  });

  it("clamps within the visible viewport when the mobile keyboard reduces it", () => {
    const layout = playbackMenuLayout({ right: 60, top: 350, bottom: 388 }, { width: 390, height: 300, offsetLeft: 15, offsetTop: 120 }, 600);
    expect(layout.left).toBeGreaterThanOrEqual(31);
    expect(layout.left + layout.width).toBeLessThanOrEqual(389);
    expect(layout.top).toBe(136);
    expect(layout.top + layout.maxHeight).toBeLessThanOrEqual(326);
  });

  it("keeps the playback button clickable when a narrow popup overlaps its column", () => {
    const anchor = { right: 48, top: 764, bottom: 802 };
    const layout = playbackMenuLayout(anchor, { width: 320, height: 900 }, 600);
    expect(layout.left).toBeLessThan(anchor.right);
    expect(layout.top + Math.min(600, layout.maxHeight)).toBeLessThanOrEqual(anchor.top - 24);
  });

  it("keeps the popup visible if the keyboard moves the button outside the visual viewport", () => {
    const layout = playbackMenuLayout({ right: 60, top: 760, bottom: 800 }, { width: 390, height: 300, offsetTop: 120 }, 600);
    expect(layout.top).toBeGreaterThanOrEqual(136);
    expect(layout.top + layout.maxHeight).toBeLessThanOrEqual(404);
  });
});
