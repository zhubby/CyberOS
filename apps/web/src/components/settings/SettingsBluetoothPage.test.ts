import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BluetoothStatus } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { SettingsBluetoothPage } from "./SettingsBluetoothPage.js";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

const status: BluetoothStatus = {
  collectedAt: "2026-10-20T00:00:00Z",
  backend: "BlueZ",
  available: true,
  adapters: [{ id: "adapter-hci0", address: "00:11:22:33:44:55", name: "hci0", alias: "ZOS", state: "powered", powered: true, discovering: false, defaultAdapter: true }],
  devices: [{ adapterId: "adapter-hci0", address: "AA:BB:CC:DD:EE:FF", name: "Headphones", alias: "Desk Headphones", type: "headset", rssi: -42, paired: true, trusted: false, connected: false, servicesResolved: true, lastSeenAt: "2026-10-20T00:00:00Z" }],
  scan: { active: false, adapterId: null, startedAt: null, endsAt: null },
  challenge: null,
  error: null
};

describe("SettingsBluetoothPage", () => {
  it("renders adapter selection and independent trust and connection actions", () => {
    const html = renderToStaticMarkup(createElement(SettingsBluetoothPage, {
      status,
      pools: [],
      locale: "en",
      onStatus: vi.fn(),
      onNotifySuccess: vi.fn(),
      onNotifyError: vi.fn()
    }));
    expect(html).toContain("Bluetooth adapters");
    expect(html).toContain("Desk Headphones");
    expect(html).toContain("Trust");
    expect(html).toContain("Connect");
    expect(html).toContain("Scan for 15 seconds");
  });

  it("explains why controls are unavailable when no adapter exists", () => {
    const html = renderToStaticMarkup(createElement(SettingsBluetoothPage, {
      status: { ...status, available: false, adapters: [], devices: [], error: "BlueZ is unavailable" },
      pools: [],
      locale: "en",
      onStatus: vi.fn(),
      onNotifySuccess: vi.fn(),
      onNotifyError: vi.fn()
    }));
    expect(html).toContain("BlueZ is unavailable");
  });

  it("renders an accessible pairing challenge before adapter controls", () => {
    const html = renderToStaticMarkup(createElement(SettingsBluetoothPage, {
      status: {
        ...status,
        challenge: {
          id: "challenge-1",
          adapterId: "adapter-hci0",
          deviceAddress: "AA:BB:CC:DD:EE:FF",
          kind: "confirmation",
          pin: null,
          passkey: 1234,
          expiresAt: "2026-10-20T00:00:30Z"
        }
      },
      pools: [],
      locale: "en",
      onStatus: vi.fn(),
      onNotifySuccess: vi.fn(),
      onNotifyError: vi.fn()
    }));

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-describedby="bluetooth-challenge-description"');
    expect(html).toContain("001234");
    expect(html.indexOf("Pairing request")).toBeLessThan(html.indexOf("Bluetooth adapters"));
  });
});
