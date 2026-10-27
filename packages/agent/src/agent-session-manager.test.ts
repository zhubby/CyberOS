import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";

describe("AgentSessionManager", () => {
  it("serializes work for one session and reuses its resource", async () => {
    const manager = new AgentSessionManager<{ id: string }>(60_000);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const create = vi.fn(async () => ({
      sessionId: "a",
      fingerprint: "same",
      session: { id: "resource" },
      dispose: vi.fn()
    }));

    const first = manager.run({
      sessionId: "a",
      fingerprint: "same",
      create,
      execute: async () => {
        order.push("first:start");
        await firstBlocked;
        order.push("first:end");
        return 1;
      }
    });
    const second = manager.run({
      sessionId: "a",
      fingerprint: "same",
      create,
      execute: async () => {
        order.push("second");
        return 2;
      }
    });

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(create).toHaveBeenCalledTimes(1);
    await manager.disposeAll();
  });

  it("runs different sessions concurrently and replaces incompatible resources", async () => {
    const manager = new AgentSessionManager<{ id: string }>(60_000);
    const disposed: string[] = [];
    const create = (sessionId: string, fingerprint: string) => async () => ({
      sessionId,
      fingerprint,
      session: { id: fingerprint },
      dispose: () => {
        disposed.push(fingerprint);
      }
    });

    const seen = await Promise.all([
      manager.run({
        sessionId: "a",
        fingerprint: "one",
        create: create("a", "one"),
        execute: async (session) => session.id
      }),
      manager.run({
        sessionId: "b",
        fingerprint: "two",
        create: create("b", "two"),
        execute: async (session) => session.id
      })
    ]);
    expect(seen).toEqual(["one", "two"]);

    await expect(manager.run({
      sessionId: "a",
      fingerprint: "three",
      create: create("a", "three"),
      execute: async (session) => session.id
    })).resolves.toBe("three");
    expect(disposed).toEqual(["one"]);
    await manager.disposeAll();
  });

  it("queues new work behind an idle disposal already in progress", async () => {
    vi.useFakeTimers();
    try {
      const manager = new AgentSessionManager<{ id: string }>(10);
      let startDisposal!: () => void;
      const disposalStarted = new Promise<void>((resolve) => {
        startDisposal = resolve;
      });
      let releaseDisposal!: () => void;
      const disposalBlocked = new Promise<void>((resolve) => {
        releaseDisposal = resolve;
      });
      let createCount = 0;
      const create = async () => {
        createCount += 1;
        const current = createCount;
        return {
          sessionId: "a",
          fingerprint: "same",
          session: { id: `resource-${current}` },
          dispose: current === 1
            ? async () => {
                startDisposal();
                await disposalBlocked;
              }
            : vi.fn()
        };
      };

      await manager.run({
        sessionId: "a",
        fingerprint: "same",
        create,
        execute: async (session) => session.id
      });
      await vi.advanceTimersByTimeAsync(10);
      await disposalStarted;

      let secondCompleted = false;
      const second = manager.run({
        sessionId: "a",
        fingerprint: "same",
        create,
        execute: async (session) => session.id
      }).then((value) => {
        secondCompleted = true;
        return value;
      });
      await Promise.resolve();
      expect(secondCompleted).toBe(false);

      releaseDisposal();
      await expect(second).resolves.toBe("resource-2");
      expect(manager.size).toBe(1);
      await manager.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });
});
