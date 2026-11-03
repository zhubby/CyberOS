import { describe, expect, it } from "vitest";
import { tooltipPosition } from "./tooltip-position.js";

const viewport = { left: 0, top: 0, width: 400, height: 300 };
const anchor = { left: 100, top: 100, right: 140, bottom: 120, width: 40, height: 20 };

describe("tooltip viewport positioning", () => {
  it("centers a hint below its trigger with a reading gap", () => {
    expect(tooltipPosition(anchor, { width: 120, height: 40 }, viewport)).toEqual({
      left: 60, top: 128, maxHeight: 160, placement: "below"
    });
  });

  it("opens above controls near the bottom edge", () => {
    expect(tooltipPosition({ ...anchor, top: 260, bottom: 280 }, { width: 120, height: 50 }, viewport))
      .toEqual({ left: 60, top: 202, maxHeight: 240, placement: "above" });
  });

  it.each([
    { left: 0, right: 20, expected: 12 },
    { left: 380, right: 400, expected: 268 }
  ])("keeps the hint inside the viewport at x=$left", ({ left, right, expected }) => {
    expect(tooltipPosition({ ...anchor, left, right, width: 20 }, { width: 120, height: 40 }, viewport).left)
      .toBe(expected);
  });

  it("limits long help to the larger available vertical space", () => {
    const result = tooltipPosition(anchor, { width: 300, height: 900 }, viewport);
    expect(result.placement).toBe("below");
    expect(result.maxHeight).toBe(160);
    expect(result.top + result.maxHeight).toBe(viewport.height - 12);
  });

  it("accounts for a zoomed or panned visual viewport", () => {
    const result = tooltipPosition({ ...anchor, left: 310, right: 350, top: 250, bottom: 270 },
      { width: 120, height: 50 }, { left: 40, top: 100, width: 320, height: 200 });
    expect(result).toEqual({ left: 228, top: 192, maxHeight: 130, placement: "above" });
  });

  it("clamps an oversized tooltip to a narrow viewport", () => {
    expect(tooltipPosition(anchor, { width: 800, height: 80 }, { ...viewport, width: 320 }).left).toBe(12);
  });

  it("keeps a reading area in short viewports", () => {
    const result = tooltipPosition({ ...anchor, top: 30, bottom: 50 }, { width: 120, height: 150 }, { ...viewport, height: 80 });
    expect(result.maxHeight).toBe(10);
    expect(result.top).toBe(58);
    expect(result.top + result.maxHeight).toBe(68);
  });
});
