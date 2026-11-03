import { describe, expect, it } from "vitest";
import { parseTailscaleStatus, unavailableTailscaleStatus } from "./tailscale.js";

describe("Tailscale public status boundary", () => {
  it("accepts unavailable states and future backend states without exposing raw preferences", () => {
    const status = unavailableTailscaleStatus("hostd unavailable");
    expect(parseTailscaleStatus(status)).toEqual(status);
    expect(parseTailscaleStatus({ ...status, backendState: "FutureState" })?.backendState).toBe("FutureState");
    expect(parseTailscaleStatus({ ...status, Config: { PrivateNodeKey: "secret" } })).toBeNull();
    expect(parseTailscaleStatus({ ...status, settings: { ...status.settings, RunSSH: true } })).toBeNull();
  });
  it("rejects unsafe links and malformed nested status", () => {
    const status = unavailableTailscaleStatus(null);
    expect(parseTailscaleStatus({ ...status, loginUrl: "javascript:alert(1)" })).toBeNull();
    expect(parseTailscaleStatus({ ...status, service: { ...status.service, active: "true" } })).toBeNull();
    expect(parseTailscaleStatus({ ...status, transaction: { id: "fake", state: "pending" } })).toBeNull();
  });
});
