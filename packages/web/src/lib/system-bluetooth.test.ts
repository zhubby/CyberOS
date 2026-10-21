import { describe, expect, it } from "vitest";
import { parseSystemBluetoothStatus } from "./system-bluetooth.js";

const status = {
  collectedAt: "2026-10-20T00:00:00.000Z",
  backend: "BlueZ",
  available: true,
  adapters: [{
    id: "adapter-hci0",
    address: "00:11:22:33:44:55",
    name: "hci0",
    alias: "ZOS",
    state: "powered",
    powered: true,
    discovering: false,
    defaultAdapter: true
  }],
  devices: [{
    adapterId: "adapter-hci0",
    address: "AA:BB:CC:DD:EE:FF",
    name: "Headphones",
    alias: null,
    type: "headset",
    rssi: -42,
    paired: true,
    trusted: false,
    connected: false,
    servicesResolved: true,
    lastSeenAt: "2026-10-20T00:00:00.000Z"
  }],
  scan: { active: false, adapterId: null, startedAt: null, endsAt: null },
  challenge: null,
  error: null
};

describe("parseSystemBluetoothStatus", () => {
  it("accepts a complete BlueZ status", () => {
    expect(parseSystemBluetoothStatus(JSON.stringify(status))).toEqual(status);
  });

  it("rejects malformed nested state and unknown fields", () => {
    expect(parseSystemBluetoothStatus(JSON.stringify({
      ...status,
      devices: [{ ...status.devices[0], rssi: 500 }]
    }))).toBeNull();
    expect(parseSystemBluetoothStatus(JSON.stringify({
      ...status,
      adapters: [{ ...status.adapters[0], unexpected: true }]
    }))).toBeNull();
  });
});
