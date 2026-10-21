import { describe, expect, it } from "vitest";
import {
  groupSystemWifiAccessPoints,
  parseSystemWifiStatus,
  systemWifiChannels,
  validSystemWifiPassword,
  validSystemWifiSsid
} from "./system-wifi.js";

describe("system Wi-Fi helpers", () => {
  it("groups BSSIDs by SSID and security and selects the strongest access point", () => {
    const groups = groupSystemWifiAccessPoints([
      accessPoint("Home", "wpa2", 42, "AA:AA:AA:AA:AA:AA"),
      accessPoint("Home", "wpa2", 88, "BB:BB:BB:BB:BB:BB"),
      accessPoint("Home", "wpa3", 70, "CC:CC:CC:CC:CC:CC"),
      { ...accessPoint("Guest", "open", 60, "DD:DD:DD:DD:DD:DD"), active: true }
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ ssid: "Guest", strongest: { active: true } });
    expect(groups.find((group) => group.security === "wpa2")).toMatchObject({
      strongest: { signal: 88, bssid: "BB:BB:BB:BB:BB:BB" },
      accessPoints: [{ signal: 88 }, { signal: 42 }]
    });
  });

  it("validates SSID byte length and personal-network passwords", () => {
    expect(validSystemWifiSsid("home")).toBe(true);
    expect(validSystemWifiSsid("你".repeat(11))).toBe(false);
    expect(validSystemWifiSsid("bad\nssid")).toBe(false);
    expect(validSystemWifiPassword("password123")).toBe(true);
    expect(validSystemWifiPassword("short")).toBe(false);
    expect(validSystemWifiPassword("a".repeat(64))).toBe(true);
  });

  it("parses valid SSE status and rejects malformed payloads", () => {
    const value = JSON.stringify({
      collectedAt: "2026-09-20T00:00:00.000Z",
      backend: "NetworkManager",
      radioEnabled: true,
      hostdReady: true,
      devices: [],
      hotspots: []
    });
    expect(parseSystemWifiStatus(value)).toMatchObject({ backend: "NetworkManager", radioEnabled: true });
    expect(parseSystemWifiStatus("{}" )).toBeNull();
    expect(parseSystemWifiStatus("not-json")).toBeNull();
  });

  it("filters hotspot channels by selected band", () => {
    expect(systemWifiChannels([36, 1, 11, 36, 149], "2.4")).toEqual([1, 11]);
    expect(systemWifiChannels([36, 1, 11, 149], "5")).toEqual([36, 149]);
    expect(systemWifiChannels([1, 36], "auto")).toEqual([]);
  });
});

function accessPoint(ssid: string, security: "open" | "wpa2" | "wpa3", signal: number, bssid: string) {
  return {
    ssid,
    security,
    signal,
    bssid,
    frequencyMHz: 5180,
    channel: 36,
    band: "5" as const,
    active: false,
    savedProfileId: null
  };
}
