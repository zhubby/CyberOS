import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n, initI18n } from "../../i18n/index.js";
import { SystemEthernetManagement } from "./SystemEthernetManagement.js";

type EthernetStatus = Parameters<typeof SystemEthernetManagement>[0]["ethernet"];

const externalPort: EthernetStatus["devices"][number] = {
  id: "2ccf67c96807",
  name: "eth0",
  permanentMac: "2c:cf:67:c9:68:07",
  mac: "2c:cf:67:c9:68:07",
  driver: "macb",
  speedMbps: 1000,
  carrier: true,
  state: "connected",
  addresses: [{ family: "inet", address: "192.168.11.91", prefixLength: 24, cidr: "192.168.11.91/24", scope: "global", label: "eth0" }],
  ipv4Gateway: null,
  ipv6Gateway: null,
  activeProfileId: "550e8400-e29b-41d4-a716-446655440000",
  activeProfileName: "netplan-eth0",
  managementState: "external",
  activeConfig: null,
  desiredConfig: {
    enabled: true,
    ipv4: { mode: "dhcp", address: null, prefixLength: null, gateway: null, dnsMode: "automatic", dns: [], useDefaultRoute: false, routeMetric: 600 },
    ipv6: { mode: "automatic", address: null, prefixLength: null, gateway: null, dnsMode: "automatic", dns: [], useDefaultRoute: false, routeMetric: 600 }
  },
  revision: "a".repeat(64),
  needsApply: false,
  warnings: []
};

function renderPorts(devices: EthernetStatus["devices"], warnings: string[] = []) {
  return renderToStaticMarkup(createElement(SystemEthernetManagement, {
    ethernet: {
      collectedAt: "2026-11-02T00:00:00Z",
      backend: "NetworkManager",
      hostdReady: true,
      devices,
      transaction: null,
      warnings
    },
    canManageEthernet: true,
    locale: "en",
    onStatus: () => undefined,
    onRefresh: async () => undefined,
    onNotifySuccess: () => undefined,
    onNotifyError: () => undefined
  }));
}

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en");
});

describe("SystemEthernetManagement", () => {
  it("renders pending physical ports and a global apply action", () => {
    const html = renderPorts(
      [{ ...externalPort, managementState: "pending", needsApply: true }],
      ["Ethernet ports share a subnet but use asymmetric default-route settings"]
    );

    expect(html).toContain("eth0");
    expect(html).toContain("192.168.11.91/24");
    expect(html).toContain("Apply network configuration");
    expect(html).toContain("Pending takeover");
    expect(html).toContain("Replies may leave through a different port");
  });

  it("offers explicit management without marking an untouched external port as pending", () => {
    const html = renderPorts([externalPort]);
    const apply = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu)?.find((button) => button.includes("Apply network configuration"));

    expect(html).toContain('data-state="neutral">Not managed');
    expect(html).toContain('aria-label="Manage eth0"');
    expect(html).not.toContain("Pending apply");
    expect(html).not.toContain("Pending takeover");
    expect(apply).toContain('disabled=""');
  });
});
