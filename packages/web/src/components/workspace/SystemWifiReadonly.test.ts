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

describe("SystemWifiReadonly", () => {
  it("shows a disabled reason and settings entry without radio controls", () => {
    const html = renderToStaticMarkup(createElement(SystemWifiReadonly, {
      wifi,
      canScan: false,
      onStatus: vi.fn(),
      onOpenSettings: vi.fn(),
      onNotifyError: vi.fn()
    }));
    expect(html).toContain("Wi-Fi radio is off");
    expect(html).toContain("Open wireless settings");
    expect(html).not.toContain("Disable Wi-Fi radio");
  });

  it("does not describe an unknown radio state as switched off", () => {
    const html = renderToStaticMarkup(createElement(SystemWifiReadonly, {
      wifi: { ...wifi, backend: "unknown", radioEnabled: null },
      canScan: false,
      onStatus: vi.fn(),
      onOpenSettings: vi.fn(),
      onNotifyError: vi.fn()
    }));
    expect(html).toContain("Wi-Fi management is unavailable");
    expect(html).not.toContain("Wi-Fi radio is off");
  });

  it("disables refresh when NetworkManager cannot report the radio state", () => {
    const html = renderToStaticMarkup(createElement(SystemWifiReadonly, {
      wifi: {
        ...wifi,
        radioEnabled: null,
        devices: [{
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
        }]
      },
      canScan: true,
      onStatus: vi.fn(),
      onOpenSettings: vi.fn(),
      onNotifyError: vi.fn()
    }));
    expect(html).toContain("Wi-Fi radio state is unavailable");
    expect(html).toMatch(/<button type="button" disabled="">.*Refresh/u);
  });
});
