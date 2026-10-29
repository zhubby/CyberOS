import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NetworkSummary } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { SystemWifiReadonly } from "./SystemWifiReadonly.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

const wifi: NetworkSummary["wifi"] = {
  collectedAt: "2026-10-20T00:00:00Z",
  backend: "NetworkManager",
  radioEnabled: false,
  hostdReady: true,
  devices: [],
  profiles: [],
  hotspots: []
};

const disconnectedDevice: NetworkSummary["wifi"]["devices"][number] = {
  id: "wlan0",
  name: "wlan0",
  driver: "iwlwifi",
  mac: "00:11:22:33:44:55",
  state: "disconnected",
  mode: "client",
  ssid: null,
  signal: null,
  frequencyMHz: null,
  channel: null,
  activeConnectionId: null,
  activeConnectionName: null,
  managementPath: false,
  capabilities: { accessPoint: true, bands: ["2.4", "5"], channels: [1, 36] }
};

describe("SystemWifiReadonly", () => {
  it("shows a disabled reason and settings entry without radio controls", () => {
    const html = renderToStaticMarkup(createElement(SystemWifiReadonly, {
      wifi,
      onStatus: vi.fn(),
      onOpenSettings: vi.fn()
    }));
    expect(html).toContain("Wi-Fi radio is off");
    expect(html).toContain("Wi-Fi settings");
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuetext="Signal unavailable"');
    expect(html).not.toContain("Disable Wi-Fi radio");
    expect(html).not.toContain("Available networks");
    expect(html).not.toContain("Refresh");
  });

  it("does not describe an unknown radio state as switched off", () => {
    const html = renderToStaticMarkup(createElement(SystemWifiReadonly, {
      wifi: { ...wifi, backend: "unknown", radioEnabled: null },
      onStatus: vi.fn(),
      onOpenSettings: vi.fn()
    }));
    expect(html).toContain("Wi-Fi management is unavailable");
    expect(html).not.toContain("Wi-Fi radio is off");
  });

  it("shows an unavailable status without exposing scan controls", () => {
    const html = renderToStaticMarkup(createElement(SystemWifiReadonly, {
      wifi: {
        ...wifi,
        radioEnabled: null,
        devices: [disconnectedDevice]
      },
      onStatus: vi.fn(),
      onOpenSettings: vi.fn()
    }));
    expect(html).toContain("Wi-Fi radio state is unavailable");
    expect(html).toContain('data-state="offline"');
    expect(html).not.toContain("Refresh");
    expect(html).not.toContain("Wireless device");
  });

  it("prefers the connected adapter and presents its signal as a meter", () => {
    const html = renderToStaticMarkup(createElement(SystemWifiReadonly, {
      wifi: {
        ...wifi,
        radioEnabled: true,
        devices: [
          disconnectedDevice,
          {
            ...disconnectedDevice,
            id: "wlan1",
            name: "wlan1",
            state: "connected",
            ssid: "Studio Wi-Fi",
            signal: 78,
            activeConnectionId: "profile-1",
            activeConnectionName: "Studio Wi-Fi"
          }
        ]
      },
      onStatus: vi.fn(),
      onOpenSettings: vi.fn()
    }));

    expect(html).toContain("Studio Wi-Fi");
    expect(html).toContain('aria-valuenow="78"');
    expect(html).toContain('aria-valuetext="78%"');
    expect(html).toContain("78%");
    expect(html).not.toContain("wlan0");
    expect(html).not.toContain("Available networks");
  });
});
