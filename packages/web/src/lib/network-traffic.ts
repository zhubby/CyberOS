import type { NetworkTrafficSummary } from "../api.js";

export interface NetworkTrafficRate {
  rxBytesPerSecond: number;
  txBytesPerSecond: number;
}

export function calculateNetworkTrafficRate(
  previous: NetworkTrafficSummary,
  current: NetworkTrafficSummary,
  interfaceIds: ReadonlySet<string>
): NetworkTrafficRate | null {
  const elapsedSeconds = (Date.parse(current.collectedAt) - Date.parse(previous.collectedAt)) / 1_000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return null;
  }

  const previousById = new Map(previous.interfaces.map((networkInterface) => [networkInterface.id, networkInterface]));
  let rxBytes = 0;
  let txBytes = 0;
  let matched = false;

  for (const networkInterface of current.interfaces) {
    if (!interfaceIds.has(networkInterface.id)) {
      continue;
    }
    const prior = previousById.get(networkInterface.id);
    if (!prior) {
      continue;
    }
    matched = true;
    rxBytes += Math.max(0, networkInterface.rxBytes - prior.rxBytes);
    txBytes += Math.max(0, networkInterface.txBytes - prior.txBytes);
  }

  return matched
    ? { rxBytesPerSecond: rxBytes / elapsedSeconds, txBytesPerSecond: txBytes / elapsedSeconds }
    : null;
}
