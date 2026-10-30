export function focusMusicReorderRow(
  row: HTMLElement | undefined,
  direction: -1 | 1,
): void {
  const preferred = direction === -1 ? "up" : "down";
  const alternate = direction === -1 ? "down" : "up";
  const target =
    row?.querySelector<HTMLButtonElement>(
      `[data-music-reorder="${preferred}"]:not(:disabled)`,
    ) ??
    row?.querySelector<HTMLButtonElement>(
      `[data-music-reorder="${alternate}"]:not(:disabled)`,
    ) ??
    row?.querySelector<HTMLElement>(
      "[data-music-reorder-title]:not(:disabled)",
    );
  target?.focus();
}
