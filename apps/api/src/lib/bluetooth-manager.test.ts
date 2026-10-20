import { describe, expect, it } from "vitest";
import { BluetoothManagerRequestError, HostdBluetoothManagerClient } from "./bluetooth-manager.js";

describe("HostdBluetoothManagerClient", () => {
  it("rejects missing and invalid request fields before contacting hostd", () => {
    const client = new HostdBluetoothManagerClient("/tmp/unused-hostd.sock");

    expect(() => client.startScan(undefined as never)).toThrow(BluetoothManagerRequestError);
    expect(() => client.setAdapterPower({ adapterId: "adapter-hci0", powered: "yes" as never }))
      .toThrow("power state must be a boolean");
    expect(() => client.answerChallenge({
      adapterId: "adapter-hci0",
      address: "AA:BB:CC:DD:EE:FF",
      challengeId: "abcdef12-3456-7890",
      accept: true,
      pin: 1234 as never
    })).toThrow("Invalid Bluetooth pairing PIN");
  });
});
