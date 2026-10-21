import { describe, expect, it, vi } from "vitest";
import { createTrailingSingleFlight } from "./trailing-single-flight.js";

describe("createTrailingSingleFlight", () => {
  it("serializes overlapping requests and keeps one trailing refresh", async () => {
    const releases: Array<() => void> = [];
    let activeTasks = 0;
    let maxActiveTasks = 0;
    const task = vi.fn(async () => {
      activeTasks += 1;
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeTasks -= 1;
    });
    const refresh = createTrailingSingleFlight(task);

    const first = refresh.request();
    const second = refresh.request();
    const third = refresh.request();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(task).toHaveBeenCalledOnce();

    releases.shift()?.();
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await first;

    expect(maxActiveTasks).toBe(1);
  });

  it("allows a new refresh after the active cycle completes", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const refresh = createTrailingSingleFlight(task);

    await refresh.request();
    await refresh.request();

    expect(task).toHaveBeenCalledTimes(2);
  });
});
