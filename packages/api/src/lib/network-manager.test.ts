import { describe, expect, it } from "vitest";
import {
  collectNetworkManagerStatus,
  parseWifiScanOutput,
  safeNetworkManagerMessage,
  SystemNetworkManagerRuntime,
  type NetworkManagerHostdClient
} from "./network-manager.js";
import type { SystemCommandRunner } from "./system-management.js";

describe("NetworkManager runtime", () => {
  it("collects wireless status, capabilities, and management path", async () => {
    const runner = new FakeRunner({
      "nmcli --terse --escape yes --fields RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI general":
        "running:connected:full:enabled:enabled\n",
      "nmcli --terse --escape yes --fields DEVICE,TYPE,STATE,CONNECTION,CON-UUID device status":
        `wlan0:wifi:connected:Home:${CLIENT_ID}\n`,
      "nmcli --terse --escape yes --fields DEVICE,IN-USE,SSID,BSSID,CHAN,FREQ,SIGNAL,SECURITY device wifi list --rescan no":
        "wlan0:*:Home:AA\\:BB\\:CC\\:DD\\:EE\\:FF:36:5180 MHz:82:WPA2\n",
      "nmcli --get-values WIFI-PROPERTIES.AP,WIFI-PROPERTIES.2GHZ,WIFI-PROPERTIES.5GHZ device show wlan0":
        "yes\nyes\nyes\n",
      "iw dev wlan0 info": "Interface wlan0\n\twiphy 0\n",
      "iw phy phy0 info": "* 2412 MHz [1]\n* 5180 MHz [36]\n"
    });

    const status = await collectNetworkManagerStatus(
      runner,
      { profiles: [], recovery: {} },
      new Set(["wlan0"])
    );

    expect(status).toMatchObject({
      backend: "NetworkManager",
      radioEnabled: true,
      hostdReady: true,
      devices: [
        {
          name: "wlan0",
          state: "connected",
          mode: "client",
          activeConnectionId: CLIENT_ID,
          ssid: "Home",
          signal: 82,
          frequencyMHz: 5180,
          channel: 36,
          managementPath: true,
          capabilities: { accessPoint: true, bands: ["2.4", "5"], channels: [1, 36] }
        }
      ]
    });
  });

  it("falls back to read-only systemd-networkd when NetworkManager is unavailable", async () => {
    const runner = new FakeRunner({
      "systemctl is-active systemd-networkd.service": "active\n"
    });

    await expect(collectNetworkManagerStatus(runner, null)).resolves.toMatchObject({
      backend: "systemd-networkd",
      radioEnabled: null,
      hostdReady: false,
      devices: []
    });
  });

  it("parses escaped BSSIDs, transition security, open networks, and unsupported WEP", () => {
    const accessPoints = parseWifiScanOutput([
      "*:Home:AA\\:BB\\:CC\\:DD\\:EE\\:FF:Infra:36:5180 MHz:90:WPA2 WPA3 SAE",
      ":Guest:11\\:22\\:33\\:44\\:55\\:66:Infra:1:2412 MHz:50:--",
      ":Legacy:77\\:88\\:99\\:AA\\:BB\\:CC:Infra:6:2437:40:WEP"
    ].join("\n"));

    expect(accessPoints).toEqual([
      expect.objectContaining({ ssid: "Home", bssid: "AA:BB:CC:DD:EE:FF", security: "wpa2", band: "5", frequencyMHz: 5180 }),
      expect.objectContaining({ ssid: "Guest", security: "open", band: "2.4" }),
      expect.objectContaining({ ssid: "Legacy", security: "unsupported" })
    ]);
  });

  it("preserves hostd string errors while redacting credentials", () => {
    expect(safeNetworkManagerMessage("activation failed: password=top-secret")).toBe(
      "activation failed: password=[redacted]"
    );
  });

  it("marks matching scan results with saved profile ids", async () => {
    const hostd = new FakeHostd();
    const runner = new FakeRunner({
      "ip -j route": "[]",
      "nmcli --terse --escape yes --fields RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI general":
        "running:disconnected:none:enabled:enabled\n",
      "nmcli --terse --escape yes --fields DEVICE,TYPE,STATE,CONNECTION,CON-UUID device status":
        "wlan0:wifi:disconnected:--:--\n",
      "nmcli --terse --escape yes --fields DEVICE,IN-USE,SSID,BSSID,CHAN,FREQ,SIGNAL,SECURITY device wifi list --rescan no": "",
      "nmcli --get-values WIFI-PROPERTIES.AP,WIFI-PROPERTIES.2GHZ,WIFI-PROPERTIES.5GHZ device show wlan0":
        "yes\nyes\nyes\n",
      "nmcli --terse --escape yes --fields NAME,UUID,TYPE,AUTOCONNECT,DEVICE,FILENAME connection show":
        `Home:${CLIENT_ID}:wifi:yes:--:/etc/NetworkManager/system-connections/cyberos-home.nmconnection\n`
    });
    const runtime = new SystemNetworkManagerRuntime({ commandRunner: runner, hostd, hostdSocketPath: "/unused" });

    const result = await runtime.scan({ device: "wlan0" });

    expect(result.accessPoints[0]).toMatchObject({ ssid: "Home", savedProfileId: CLIENT_ID });
  });

  it("keeps disconnected devices disconnected and resolves external profile details", async () => {
    const externalId = "22345678-1234-4123-8123-123456789abc";
    const hostd = new FakeHostd([], {});
    const runner = new FakeRunner({
      "ip -j route": "[]",
      "nmcli --terse --escape yes --fields RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI general":
        "running:disconnected:none:enabled:enabled\n",
      "nmcli --terse --escape yes --fields DEVICE,TYPE,STATE,CONNECTION,CON-UUID device status":
        "wlan0:wifi:disconnected:--:--\n",
      "nmcli --terse --escape yes --fields DEVICE,IN-USE,SSID,BSSID,CHAN,FREQ,SIGNAL,SECURITY device wifi list --rescan no": "",
      "nmcli --get-values WIFI-PROPERTIES.AP,WIFI-PROPERTIES.2GHZ,WIFI-PROPERTIES.5GHZ device show wlan0":
        "yes\nyes\nyes\n",
      "nmcli --terse --escape yes --fields NAME,UUID,TYPE,AUTOCONNECT,DEVICE,FILENAME connection show":
        `netplan-wlan0-home:${externalId}:802-11-wireless:yes:--:/etc/NetworkManager/system-connections/netplan-wlan0-home.nmconnection\n`,
      [`nmcli --get-values 802-11-wireless.ssid,802-11-wireless.mode,802-11-wireless-security.key-mgmt connection show uuid ${externalId}`]:
        "Home\ninfrastructure\nwpa-psk\n"
    });
    const runtime = new SystemNetworkManagerRuntime({ commandRunner: runner, hostd, hostdSocketPath: "/unused" });

    const summary = await runtime.getSummary();

    expect(summary.devices[0]).toMatchObject({ name: "wlan0", state: "disconnected", mode: "idle" });
    expect(summary.profiles).toEqual([
      expect.objectContaining({
        id: externalId,
        name: "netplan-wlan0-home",
        ssid: "Home",
        security: "wpa2",
        managed: false
      })
    ]);
  });
});

class FakeRunner implements SystemCommandRunner {
  constructor(private readonly outputs: Record<string, string>) {}

  async run(command: string, args: string[]): Promise<string> {
    const key = [command, ...args].join(" ");
    if (!(key in this.outputs)) throw new Error(`Unexpected command: ${key}`);
    return this.outputs[key]!;
  }
}

class FakeHostd implements NetworkManagerHostdClient {
  constructor(
    private readonly profiles = [managedProfile()],
    private readonly recovery: Record<string, { restoreProfileId: string | null; hotspotProfileId: string }> = {}
  ) {}

  async ping(): Promise<boolean> {
    return true;
  }

  async inspect() {
    return {
      profiles: this.profiles,
      recovery: this.recovery
    };
  }

  async scan() {
    return {
      device: "wlan0",
      scannedAt: new Date().toISOString(),
      accessPoints: [
        {
          ssid: "Home",
          bssid: "AA:BB:CC:DD:EE:FF",
          signal: 70,
          frequencyMHz: 5180,
          channel: 36,
          band: "5" as const,
          security: "wpa2" as const,
          active: false,
          savedProfileId: null
        }
      ]
    };
  }

  async mutate(): Promise<{ rollback: "not_required"; message: null }> {
    return { rollback: "not_required", message: null };
  }
}

function managedProfile() {
  return {
    id: CLIENT_ID,
    name: "CyberOS Home",
    ssid: "Home",
    device: "wlan0",
    security: "wpa2" as const,
    mode: "client" as const,
    band: "auto" as const,
    channel: null,
    autoconnect: true,
    credentialConfigured: true,
    revision: "a".repeat(64)
  };
}

const CLIENT_ID = "12345678-1234-4123-8123-123456789abc";
