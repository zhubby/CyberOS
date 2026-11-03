import { describe, expect, it } from "vitest";
import { positionTooltip, tooltipDescription } from "./tooltip.js";

describe("tooltip viewport positioning", () => {
  const viewport = { left: 0, top: 0, width: 320, height: 560 };
  const size = { width: 120, height: 40 };

  it("centers the tooltip above its trigger when there is room", () => {
    expect(positionTooltip({ left: 140, right: 180, top: 100, bottom: 132 }, size, viewport))
      .toEqual({ left: 100, top: 52, side: "top" });
  });

  it("flips below triggers at the top of the viewport", () => {
    expect(positionTooltip({ left: 140, right: 180, top: 8, bottom: 40 }, size, viewport))
      .toEqual({ left: 100, top: 48, side: "bottom" });
  });

  it.each([
    [{ left: 0, right: 32, top: 100, bottom: 132 }, 8],
    [{ left: 288, right: 320, top: 100, bottom: 132 }, 192]
  ])("keeps an edge tooltip inside the viewport", (anchor, expectedLeft) => {
    expect(positionTooltip(anchor, size, viewport).left).toBe(expectedLeft);
  });

  it("keeps long tooltips inside a short viewport", () => {
    const position = positionTooltip({ left: 120, right: 152, top: 60, bottom: 92 }, { width: 304, height: 144 }, { ...viewport, height: 160 });
    expect(position.left).toBe(8);
    expect(position.top).toBe(8);
  });

  it("accounts for visual viewport offsets", () => {
    expect(positionTooltip({ left: 40, right: 72, top: 100, bottom: 132 }, size, { left: 30, top: 80, width: 200, height: 250 }))
      .toEqual({ left: 38, top: 140, side: "bottom" });
  });
});

describe("tooltip accessible descriptions", () => {
  it("adds the tooltip without replacing existing descriptions", () => {
    expect(tooltipDescription("field-help field-error", "hud-tip", true)).toBe("field-help field-error hud-tip");
  });

  it("does not duplicate an existing tooltip description", () => {
    expect(tooltipDescription("field-help hud-tip", "hud-tip", true)).toBe("field-help hud-tip");
  });

  it("removes only its own description, including after another description changes", () => {
    expect(tooltipDescription("new-help hud-tip field-error", "hud-tip", false)).toBe("new-help field-error");
  });

  it("removes the attribute when no other description remains", () => {
    expect(tooltipDescription("hud-tip", "hud-tip", false)).toBeNull();
    expect(tooltipDescription(null, "hud-tip", false)).toBeNull();
  });
});
