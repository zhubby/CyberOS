const margin = 8;

export function playbackMenuLayout(
  anchor: { right: number; top: number; bottom: number },
  viewport: { width: number; height: number; offsetLeft?: number; offsetTop?: number },
  contentHeight: number
) {
  const minLeft = (viewport.offsetLeft ?? 0) + margin;
  const minTop = (viewport.offsetTop ?? 0) + margin;
  const width = Math.min(360, Math.max(0, viewport.width - margin * 2));
  const left = Math.max(minLeft, Math.min(anchor.right + margin, minLeft + viewport.width - margin * 2 - width));
  const viewportHeight = Math.max(0, viewport.height - margin * 2);
  const above = Math.max(0, anchor.top - margin - minTop);
  const below = Math.max(0, minTop + viewportHeight - anchor.bottom - margin);
  const overlapsTrigger = left < anchor.right;
  const placeAbove = above >= below;
  const maxHeight = overlapsTrigger ? Math.min(viewportHeight, Math.max(above, below)) : viewportHeight;
  const height = Math.min(contentHeight, maxHeight);
  const preferredTop = overlapsTrigger ? placeAbove ? anchor.top - margin - height : anchor.bottom + margin : anchor.bottom - height;
  return {
    width,
    maxHeight,
    left,
    top: Math.max(minTop, Math.min(preferredTop, minTop + viewportHeight - height))
  };
}
