import { describe, expect, it } from "vitest";
import { parseBluetoothTransfersEvent } from "./use-bluetooth-transfers.js";

const transfer = {
  id: "transfer-1",
  direction: "send",
  adapterId: "adapter-hci0",
  deviceAddress: "AA:BB:CC:DD:EE:FF",
  storagePoolId: "pool-1",
  relativePath: "media/file.bin",
  displayName: "file.bin",
  status: "running",
  transferredBytes: 10,
  totalBytes: 100,
  error: null,
  obexTransferPath: "/org/bluez/obex/transfer1",
  controlRequested: null,
  readAt: null,
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:01Z",
  startedAt: "2026-10-20T00:00:00Z",
  finishedAt: null,
  lastProgressAt: "2026-10-20T00:00:01Z"
};

const health = {
  status: "ready",
  heartbeatAt: "2026-10-20T00:00:01Z",
  error: null,
  activeTransfers: 1,
  queuedTransfers: 0
};

describe("parseBluetoothTransfersEvent", () => {
  it("accepts an exact persistent transfer event", () => {
    expect(parseBluetoothTransfersEvent(JSON.stringify({ transfers: [transfer], health })))
      .toEqual({ transfers: [transfer], health });
    const finalizing = { ...transfer, direction: "receive", status: "finalizing" };
    expect(parseBluetoothTransfersEvent(JSON.stringify({ transfers: [finalizing], health })))
      .toEqual({ transfers: [finalizing], health });
  });

  it("rejects unknown fields and invalid transfer state", () => {
    expect(parseBluetoothTransfersEvent(JSON.stringify({ transfers: [transfer], health, extra: true }))).toBeNull();
    expect(parseBluetoothTransfersEvent(JSON.stringify({
      transfers: [{ ...transfer, status: "finished" }],
      health
    }))).toBeNull();
  });
});
