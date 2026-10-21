import { describe, expect, it } from "vitest";
import type { SystemEthernetConfig } from "@zos/shared";
import {
  ethernetTransactionSeconds,
  hasSystemEthernetMetricConflict,
  parseSystemEthernetStatus,
  systemEthernetDeviceTone,
  validateSystemEthernetConfig,
  validIp
} from "./system-ethernet.js";

const config: SystemEthernetConfig = {
  enabled: true,
  ipv4: {
    mode: "dhcp",
    address: null,
    prefixLength: null,
    gateway: null,
    dnsMode: "automatic",
    dns: [],
    useDefaultRoute: true,
    routeMetric: 100
  },
  ipv6: {
    mode: "automatic",
    address: null,
    prefixLength: null,
    gateway: null,
    dnsMode: "automatic",
    dns: [],
    useDefaultRoute: false,
    routeMetric: 600
  }
};

describe("system Ethernet helpers", () => {
  it("validates static addressing, DNS families, and route metrics", () => {
    expect(validateSystemEthernetConfig(config)).toEqual([]);
    const invalid = structuredClone(config);
    invalid.ipv4 = {
      ...invalid.ipv4,
      mode: "static",
      address: "192.168.11.20",
      prefixLength: 33,
      gateway: "2001:db8::1",
      dnsMode: "manual",
      dns: ["2001:4860:4860::8888"],
      routeMetric: 0
    };
    expect(validateSystemEthernetConfig(invalid)).toEqual(expect.arrayContaining([
      "ipv4.prefixLength",
      "ipv4.gateway",
      "ipv4.dns",
      "ipv4.metric"
    ]));
  });

  it("recognizes both address families", () => {
    expect(validIp("192.168.11.91", 4)).toBe(true);
    expect(validIp("192.168.011.091", 4)).toBe(false);
    expect(validIp("256.1.1.1", 4)).toBe(false);
    expect(validIp("fd00::91", 6)).toBe(true);
    expect(validIp("fd00::zz", 6)).toBe(false);
  });

  it("detects route metric conflicts across pending and already-saved ports", () => {
    const second = structuredClone(config);
    expect(hasSystemEthernetMetricConflict([config, second])).toBe(true);
    second.ipv4.routeMetric = 600;
    expect(hasSystemEthernetMetricConflict([config, second])).toBe(false);
  });

  it("parses SSE status and does not treat reconnecting as live", () => {
    const status = {
      collectedAt: "2026-10-12T00:00:00Z",
      backend: "NetworkManager",
      hostdReady: true,
      devices: [],
      transaction: null,
      warnings: []
    };
    expect(parseSystemEthernetStatus(JSON.stringify(status))).toEqual(status);
    expect(parseSystemEthernetStatus("{}" )).toBeNull();
    expect(systemEthernetDeviceTone("connected", true)).toBe("warning");
  });

  it("calculates a bounded transaction countdown", () => {
    expect(ethernetTransactionSeconds("2026-10-12T00:01:30Z", Date.parse("2026-10-12T00:01:00Z"))).toBe(30);
    expect(ethernetTransactionSeconds("2026-10-12T00:00:00Z", Date.parse("2026-10-12T00:01:00Z"))).toBe(0);
  });
});
