interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TooltipLayout {
  left: number;
  top: number;
  maxHeight: number;
  placement: "above" | "below";
}

export function tooltipPosition(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { left: number; top: number; width: number; height: number }
): TooltipLayout {
  const margin = 12;
  const gap = 8;
  const leftEdge = viewport.left + margin;
  const topEdge = viewport.top + margin;
  const rightEdge = viewport.left + viewport.width - margin;
  const bottomEdge = viewport.top + viewport.height - margin;
  const below = Math.max(0, bottomEdge - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - topEdge - gap);
  const placement = below >= size.height || below >= above ? "below" : "above";
  const maxHeight = placement === "below" ? below : above;
  const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
  return {
    left: Math.max(leftEdge, Math.min(anchor.left + anchor.width / 2 - width / 2, rightEdge - width)),
    top: placement === "below" ? anchor.bottom + gap : Math.max(topEdge, anchor.top - gap - Math.min(size.height, maxHeight)),
    maxHeight,
    placement
  };
}

export function measureTooltipPosition(anchor: HTMLElement, tooltip: HTMLElement): TooltipLayout | null {
  if (!anchor.isConnected || !anchor.getClientRects().length) return null;
  const viewport = window.visualViewport;
  const bounds = {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight
  };
  tooltip.style.setProperty("--tooltip-viewport-width", `${bounds.width}px`);
  const rect = anchor.getBoundingClientRect();
  let left = bounds.left;
  let top = bounds.top;
  let right = bounds.left + bounds.width;
  let bottom = bounds.top + bounds.height;
  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const parentRect = parent.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
      left = Math.max(left, parentRect.left);
      right = Math.min(right, parentRect.right);
    }
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
      top = Math.max(top, parentRect.top);
      bottom = Math.min(bottom, parentRect.bottom);
    }
  }
  if (rect.right <= left || rect.left >= right || rect.bottom <= top || rect.top >= bottom) return null;
  return tooltipPosition(rect, {
    width: tooltip.offsetWidth,
    height: tooltip.scrollHeight + tooltip.offsetHeight - tooltip.clientHeight
  }, bounds);
}
