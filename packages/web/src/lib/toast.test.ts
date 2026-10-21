import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleToastDismissal, TOAST_DISMISS_MS } from "./toast.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleToastDismissal", () => {
  it("dismisses a visible toast after the standard lifetime", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();

    scheduleToastDismissal("Saved", dismiss);
    vi.advanceTimersByTime(TOAST_DISMISS_MS - 1);
    expect(dismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledWith("Saved");
  });

  it("cancels a pending dismissal when the toast changes", () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const cancel = scheduleToastDismissal("Old notice", dismiss);

    cancel();
    vi.advanceTimersByTime(TOAST_DISMISS_MS);

    expect(dismiss).not.toHaveBeenCalled();
  });
});
