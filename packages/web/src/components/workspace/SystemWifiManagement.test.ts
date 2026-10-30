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
  it("keeps the settings page focused on status with network management behind dialog entry points", async () => {
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
    expect(html).toContain("wlan0");
    expect(html).toContain("Disconnected");
    expect(html).toContain("Scan");
    expect(html).toContain("Hotspot");
    expect(html).not.toContain("Available networks");
    expect(html).not.toContain("Saved networks");
    expect(html).not.toContain("zhubbyf50pro");
    expect(html).not.toContain('aria-label="Disable Wi-Fi radio"');
    expect(html).not.toContain('aria-label="Forget network"');
  });

  it("allows opening network settings while the radio is off so it can be enabled in the dialog", async () => {
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

    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu) ?? [];
    expect(buttons.find((button) => button.includes("<span>Scan</span>"))).not.toContain('disabled=""');
    expect(buttons.find((button) => button.includes("<span>Hotspot</span>"))).toContain('disabled=""');
  });

  it("shows active connection and hotspot data without inline disconnect, start, stop, or delete controls", async () => {
    await initI18n();
    await i18n.changeLanguage("en");

    const html = renderToStaticMarkup(createElement(SystemWifiManagement, {
      wifi: {
        ...wifi,
        devices: [{ ...wifi.devices[0]!, ssid: "Home", state: "connected", mode: "client", activeConnectionId: "profile-1" }],
        hotspots: [{
          device: "wlan0", profileId: "hotspot-1", ssid: "CyberOS hotspot", band: "2.4", channel: 6,
          autostart: false, active: true, credentialConfigured: true, revision: "r1", restoreProfileId: null
        }]
      },
      canManageWifi: true,
      canManageHotspot: true,
      onStatus: () => undefined,
      onRefresh: async () => undefined,
      onNotifySuccess: () => undefined,
      onNotifyError: () => undefined
    }));

    expect(html).toContain("Home");
    expect(html).toContain("Connected");
    expect(html).toContain("CyberOS hotspot");
    expect(html).toContain("Running");
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.includes("<span>Scan</span>") || button.includes("<span>Hotspot</span>"))).toBe(true);
  });

  it("disables every write entry point when host networking is declarative", async () => {
    await initI18n();
    await i18n.changeLanguage("en");

    const html = renderToStaticMarkup(createElement(SystemWifiManagement, {
      wifi: {
        ...wifi,
        devices: [{
          ...wifi.devices[0]!,
          state: "connected",
          mode: "client",
          activeConnectionId: "profile-1",
          activeConnectionName: "Home Wi-Fi"
        }]
      },
      canManageWifi: false,
      canManageHotspot: false,
      onStatus: () => undefined,
      onRefresh: async () => undefined,
      onNotifySuccess: () => undefined,
      onNotifyError: () => undefined
    }));

    expect(html).toContain("Wi-Fi settings are read-only");
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu) ?? [];
    expect(buttons.find((button) => button.includes("<span>Scan</span>"))).toContain('disabled=""');
    expect(buttons.find((button) => button.includes("<span>Hotspot</span>"))).toContain('disabled=""');
    expect(html).not.toContain('class="is-danger"');
    expect(html).not.toContain('aria-label="Connect"');
  });
});
