import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NetworkSummary } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { SystemWifiManagement } from "./SystemWifiManagement.js";

const wifi: NetworkSummary["wifi"] = {
  collectedAt: "2026-09-21T00:00:00.000Z",
  backend: "NetworkManager",
  radioEnabled: true,
  hostdReady: true,
  devices: [{
    id: "wlan0",
    name: "wlan0",
    mac: "2c:cf:67:c9:68:08",
    driver: "brcmfmac",
    state: "disconnected",
    mode: "idle",
    activeConnectionId: null,
    activeConnectionName: null,
    ssid: null,
    signal: null,
    frequencyMHz: null,
    channel: null,
    managementPath: false,
    capabilities: { accessPoint: true, bands: ["2.4", "5"], channels: [1, 6, 11, 36] }
  }],
  profiles: [{
    id: "profile-1",
    name: "Home Wi-Fi",
    ssid: "zhubbyf50pro",
    device: "wlan0",
    security: "wpa2",
    autoconnect: true,
    active: false,
    managed: false,
    credentialConfigured: true,
    revision: null
  }],
  hotspots: []
};

describe("SystemWifiManagement", () => {
  it("groups the device summary and network lists in a compact content layout", async () => {
    await initI18n();
    await i18n.changeLanguage("en");

    const html = renderToStaticMarkup(createElement(SystemWifiManagement, {
      wifi,
      canManageWifi: true,
      canManageHotspot: true,
      onStatus: () => undefined,
      onRefresh: async () => undefined,
      onNotifySuccess: () => undefined,
      onNotifyError: () => undefined
    }));

    expect(html).toContain('class="system-wifi-content"');
    expect(html).toContain('class="system-wifi-device-identity"');
    expect(html).toContain('class="system-wifi-device-details"');
    expect(html).toContain('class="system-wifi-grid"');
    expect(html).toContain("Available networks");
    expect(html).toContain("Saved networks");
    expect(html).toContain("zhubbyf50pro");
  });

  it("disables scanning and hotspot configuration while the radio is off", async () => {
    await initI18n();
    await i18n.changeLanguage("en");

    const html = renderToStaticMarkup(createElement(SystemWifiManagement, {
      wifi: { ...wifi, radioEnabled: false },
      canManageWifi: true,
      canManageHotspot: true,
      onStatus: () => undefined,
      onRefresh: async () => undefined,
      onNotifySuccess: () => undefined,
      onNotifyError: () => undefined
    }));

    expect(html).toMatch(/<button type="button" disabled="">.*?<span>Scan<\/span><\/button>/s);
    expect(html).toMatch(/<button type="button" disabled="">.*?<span>Hotspot<\/span><\/button>/s);
  });
});
