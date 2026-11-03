interface TooltipAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface TooltipSize {
  width: number;
  height: number;
}

interface TooltipViewport extends TooltipSize {
  left: number;
  top: number;
}

export function positionTooltip(anchor: TooltipAnchor, size: TooltipSize, viewport: TooltipViewport) {
  const margin = 8;
  const gap = 8;
  const minimumLeft = viewport.left + margin;
  const maximumLeft = Math.max(minimumLeft, viewport.left + viewport.width - size.width - margin);
  const minimumTop = viewport.top + margin;
  const maximumTop = Math.max(minimumTop, viewport.top + viewport.height - size.height - margin);
  const above = anchor.top - gap - size.height;
  const below = anchor.bottom + gap;
  const side = above >= minimumTop || anchor.top - viewport.top > viewport.top + viewport.height - anchor.bottom
    ? "top" : "bottom";
  return {
    left: Math.min(maximumLeft, Math.max(minimumLeft, (anchor.left + anchor.right - size.width) / 2)),
    top: Math.min(maximumTop, Math.max(minimumTop, side === "top" ? above : below)),
    side
  };
}

export function tooltipDescription(value: string | null, id: string, visible: boolean): string | null {
  const ids = new Set(value?.split(/\s+/u).filter(Boolean));
  if (visible) ids.add(id);
  else ids.delete(id);
  return [...ids].join(" ") || null;
}
