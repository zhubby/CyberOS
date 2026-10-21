export const TOAST_DISMISS_MS = 6_000;

export function scheduleToastDismissal(
  notice: string | null,
  dismiss: (notice: string) => void,
  delayMs = TOAST_DISMISS_MS
): () => void {
  if (!notice) {
    return () => undefined;
  }

  const timer = setTimeout(() => dismiss(notice), delayMs);
  return () => clearTimeout(timer);
}
