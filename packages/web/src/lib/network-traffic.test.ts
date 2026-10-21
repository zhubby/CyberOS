import { describe, expect, it } from "vitest";
import type { NetworkTrafficSummary } from "../api.js";
import { calculateNetworkTrafficRate } from "./network-traffic.js";

describe("network traffic rate", () => {
  it("calculates aggregate receive and transmit rates for selected interfaces", () => {
    const previous = sample("2026-09-11T03:00:00.000Z", [
      ["eno1", 1_000, 2_000],
      ["docker0", 4_000, 8_000]
    ]);
    const current = sample("2026-09-11T03:00:02.000Z", [
      ["eno1", 3_000, 3_000],
      ["docker0", 10_000, 12_000]
    ]);

    expect(calculateNetworkTrafficRate(previous, current, new Set(["eno1", "docker0"]))).toEqual({
      rxBytesPerSecond: 4_000,
      txBytesPerSecond: 2_500
    });
  });

  it("ignores counter resets and returns null without a valid matching interval", () => {
    const previous = sample("2026-09-11T03:00:00.000Z", [["eno1", 5_000, 8_000]]);
    const reset = sample("2026-09-11T03:00:02.000Z", [["eno1", 100, 200]]);

    expect(calculateNetworkTrafficRate(previous, reset, new Set(["eno1"]))).toEqual({
      rxBytesPerSecond: 0,
      txBytesPerSecond: 0
    });
    expect(calculateNetworkTrafficRate(previous, reset, new Set(["missing"]))).toBeNull();
    expect(calculateNetworkTrafficRate(previous, previous, new Set(["eno1"]))).toBeNull();
  });
});

function sample(
  collectedAt: string,
  interfaces: Array<[id: string, rxBytes: number, txBytes: number]>
): NetworkTrafficSummary {
  return {
    collectedAt,
    interfaces: interfaces.map(([id, rxBytes, txBytes]) => ({ id, name: id, rxBytes, txBytes }))
  };
}
