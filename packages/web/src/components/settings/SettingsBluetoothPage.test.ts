import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BluetoothStatus } from "../../api.js";
import { i18n, initI18n } from "../../i18n/index.js";
import { BluetoothAudioOutputField, SettingsBluetoothPage } from "./SettingsBluetoothPage.js";

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

  it("renders a dedicated gamepad icon and keeps device management actions", () => {
    const html = renderToStaticMarkup(createElement(SettingsBluetoothPage, {
      status: {
        ...status,
        devices: [{ ...status.devices[0]!, name: "Xbox Wireless Controller", alias: null, type: "gamepad" }]
      },
      pools: [],
      locale: "en",
      onStatus: vi.fn(),
      onNotifySuccess: vi.fn(),
      onNotifyError: vi.fn()
    }));
    expect(html).toContain("Xbox Wireless Controller");
    expect(html).toContain("lucide-gamepad-2");
    expect(html).toContain("Trust");
    expect(html).toContain("Connect");
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

  it("localizes the generic host integration unavailable reason", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      const html = renderToStaticMarkup(createElement(SettingsBluetoothPage, {
        status: {
          ...status,
          available: false,
          adapters: [],
          devices: [],
          error: "BlueZ and the host integration service are unavailable"
        },
        pools: [],
        locale: "zh-CN",
        onStatus: vi.fn(),
        onNotifySuccess: vi.fn(),
        onNotifyError: vi.fn()
      }));
      expect(html).toContain("BlueZ 和主机集成服务当前不可用。");
      expect(html).not.toContain("BlueZ and the host integration service are unavailable");
    } finally {
      await i18n.changeLanguage("en");
    }
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
          entered: null,
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

  it("shows display-only passkeys without response controls", () => {
    const html = renderToStaticMarkup(createElement(SettingsBluetoothPage, {
      status: {
        ...status,
        challenge: {
          id: "challenge-display",
          adapterId: "adapter-hci0",
          deviceAddress: "AA:BB:CC:DD:EE:FF",
          kind: "passkey_display",
          pin: null,
          passkey: 123456,
          entered: 2,
          expiresAt: "2026-10-20T00:00:30Z"
        }
      },
      pools: [],
      locale: "en",
      onStatus: vi.fn(),
      onNotifySuccess: vi.fn(),
      onNotifyError: vi.fn()
    }));

    expect(html).toContain('role="status"');
    expect(html).toContain("123456");
    expect(html).toContain("2 of 6 digits entered");
    expect(html).not.toContain("Confirm pairing</button>");
  });

  it("does not offer to stop a scan owned by another adapter", () => {
    const second = { ...status.adapters[0]!, id: "adapter-hci1", name: "hci1", alias: "USB" };
    const html = renderToStaticMarkup(createElement(SettingsBluetoothPage, {
      status: {
        ...status,
        adapters: [status.adapters[0]!, second],
        scan: { active: true, adapterId: "adapter-hci1", startedAt: null, endsAt: null }
      },
      pools: [],
      locale: "en",
      onStatus: vi.fn(),
      onNotifySuccess: vi.fn(),
      onNotifyError: vi.fn()
    }));

    expect(html).toContain("adapter-hci1 is currently scanning");
    expect(html).not.toContain(">Stop scan</span>");
  });

  it("keeps an unavailable configured audio output visible and disabled", () => {
    const html = renderToStaticMarkup(createElement(BluetoothAudioOutputField, {
      audioDevices: [],
      defaultAudioDeviceId: "bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF",
      disabled: false,
      onChange: vi.fn()
    }));

    expect(html).toContain("Configured Bluetooth output unavailable");
    expect(html).toContain('value="bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF" disabled="" selected=""');
  });
});
