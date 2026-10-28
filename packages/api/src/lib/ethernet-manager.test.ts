import { describe, expect, it, vi } from "vitest";
import type { SystemEthernetConfig } from "@cyberos/shared";
import {
  EthernetManagerRequestError,
  SystemEthernetManagerRuntime,
  validateEthernetConfig,
  type EthernetHostdClient
} from "./ethernet-manager.js";

const config: SystemEthernetConfig = {
  enabled: true,
  ipv4: { mode: "dhcp", address: null, prefixLength: null, gateway: null, dnsMode: "automatic", dns: [], useDefaultRoute: true, routeMetric: 100 },
  ipv6: { mode: "automatic", address: null, prefixLength: null, gateway: null, dnsMode: "automatic", dns: [], useDefaultRoute: false, routeMetric: 600 }
};

describe("Ethernet manager", () => {
  it("rejects invalid static addresses, DNS families, and metrics", () => {
    const invalid = structuredClone(config);
    invalid.ipv4 = {
      ...invalid.ipv4,
      mode: "static",
      address: "192.168.11.20",
      prefixLength: 24,
      gateway: "2001:db8::1",
      dnsMode: "manual",
      dns: ["2001:4860:4860::8888"],
      routeMetric: 0
    };
    expect(() => validateEthernetConfig(invalid)).toThrow(EthernetManagerRequestError);
  });

  it("rejects malformed booleans, non-string DNS values, and wrong-family optional gateways", () => {
    const malformedBoolean = structuredClone(config) as unknown as Record<string, unknown>;
    (malformedBoolean.ipv4 as Record<string, unknown>).useDefaultRoute = "yes";

    const malformedDns = structuredClone(config) as unknown as Record<string, unknown>;
    (malformedDns.ipv4 as Record<string, unknown>).dns = [123];

    const wrongGateway = structuredClone(config);
    wrongGateway.ipv4 = {
      ...wrongGateway.ipv4,
      mode: "static",
      address: "192.168.11.20",
      prefixLength: 24,
      gateway: "2001:db8::1",
      useDefaultRoute: false
    };

    for (const invalid of [malformedBoolean, malformedDns, wrongGateway]) {
      expect(() => validateEthernetConfig(invalid as unknown as SystemEthernetConfig))
        .toThrow(EthernetManagerRequestError);
    }
  });

  it("sends bounded hostd actions for save and apply", async () => {
    const request = vi.fn(async (payload: { action: string }) => {
      if (payload.action === "ethernet_save") {
        return { collectedAt: "2026-10-12T00:00:00Z", backend: "NetworkManager", hostdReady: true, devices: [], transaction: null, warnings: [] };
      }
      return { id: "550e8400-e29b-41d4-a716-446655440000", status: "awaiting_confirmation", deviceIds: ["2ccf67c96807"], createdAt: "2026-10-12T00:00:00Z", deadlineAt: "2026-10-12T00:01:30Z", rollback: "not_required", error: null };
    });
    const runtime = new SystemEthernetManagerRuntime("/unused", { request } as unknown as EthernetHostdClient);

    await runtime.save("2ccf67c96807", { config, expectedRevision: "a".repeat(64) });
    await runtime.apply(true);

    expect(request).toHaveBeenNthCalledWith(1, { action: "ethernet_save", deviceId: "2ccf67c96807", input: { config, expectedRevision: "a".repeat(64) } });
    expect(request).toHaveBeenNthCalledWith(2, { action: "ethernet_apply", confirmed: true });
  });

  it("uses the dedicated Ethernet status action", async () => {
    const request = vi.fn(async () => ({
      collectedAt: "2026-10-12T00:00:00Z",
      backend: "NetworkManager" as const,
      hostdReady: true,
      devices: [],
      transaction: null,
      warnings: []
    }));
    const runtime = new SystemEthernetManagerRuntime("/unused", { request } as unknown as EthernetHostdClient);

    await expect(runtime.getStatus()).resolves.toMatchObject({ backend: "NetworkManager" });
    expect(request).toHaveBeenCalledWith({ action: "ethernet_status" });
  });
});
