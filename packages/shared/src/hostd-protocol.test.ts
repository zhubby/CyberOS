import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  parseHostdResult,
  type HostdNetworkMutationRequest,
  type HostdRequest,
  type HostdResult
} from "./hostd-protocol.js";

const dockerSnapshot = {
  path: "/etc/docker/daemon.json",
  content: "{}\n",
  revision: "a".repeat(64),
  exists: true,
  restartPending: false
} as const;

const networkMutation = {
  rollback: "not_required",
  message: null
} as const;

const ethernetStatus = {
  collectedAt: "2026-10-10T00:00:00Z",
  backend: "NetworkManager",
  hostdReady: true,
  devices: [],
  transaction: null,
  warnings: []
} as const;

describe("hostd protocol", () => {
  it("parses results for every top-level operation", () => {
    const sharesRequest: HostdRequest<"shares.apply"> = {
      settings: {
        enabled: false,
        account: { username: "zos_share", password: null },
        shares: []
      },
      roots: [{ id: "primary", path: "/zos/data/mediaprimary" }]
    };
    expect(parseHostdResult("shares.apply", sharesRequest, {
      appliedAt: "2026-10-10T00:00:00Z",
      files: ["/etc/samba/smb.conf.d/zos-shares.conf"],
      services: ["smbd.service"]
    })).toEqual({
      appliedAt: "2026-10-10T00:00:00Z",
      files: ["/etc/samba/smb.conf.d/zos-shares.conf"],
      services: ["smbd.service"]
    });

    expect(parseHostdResult("storage.command", { command: "mdadm", args: ["--detail", "/dev/md0"] }, {
      stdout: "detail\n"
    })).toEqual({ stdout: "detail\n" });

    expect(parseHostdResult("system.power", { action: "reboot", confirmed: true }, {
      action: "reboot",
      accepted: true
    })).toEqual({ action: "reboot", accepted: true });
  });

  it("pairs both storage actions with their exact result variants", () => {
    const createRequest = {
      action: "create_pool",
      name: "media",
      raidLevel: "1",
      devices: ["/dev/sda", "/dev/sdb"],
      filesystem: "ext4",
      mountpoint: "/zos/data/media",
      risk: "high"
    } satisfies HostdRequest<"storage.operation">;
    const createResult = {
      action: "create_pool",
      name: "media",
      raidLevel: "1",
      devices: ["/dev/sda", "/dev/sdb"],
      filesystem: "ext4",
      mountpoint: "/zos/data/media",
      mdDevice: "/dev/md/media",
      uuid: "array-uuid"
    } as const;
    expect(parseHostdResult("storage.operation", createRequest, createResult)).toEqual(createResult);

    const deleteRequest = {
      action: "delete_pool",
      name: "media",
      mdDevice: "/dev/md/media",
      devices: ["/dev/sda", "/dev/sdb"],
      mountpoint: "/zos/data/media",
      risk: "high"
    } satisfies HostdRequest<"storage.operation">;
    const deleteResult = {
      action: "delete_pool",
      name: "media",
      mountpoint: "/zos/data/media",
      mdDevice: "/dev/md/media",
      devices: ["/dev/sda", "/dev/sdb"]
    } as const;
    expect(parseHostdResult("storage.operation", deleteRequest, deleteResult)).toEqual(deleteResult);
    expect(parseHostdResult("storage.operation", createRequest, deleteResult)).toBeNull();
  });

  it("pairs Docker read and update requests with their result variants", () => {
    const read = parseHostdResult("docker.daemon", { action: "read" }, dockerSnapshot);
    expect(read).toEqual(dockerSnapshot);
    expectTypeOf(read).toEqualTypeOf<HostdResult<"docker.daemon", { action: "read" }> | null>();

    const updateRequest = {
      action: "update",
      input: {
        content: "{}\n",
        expectedRevision: "a".repeat(64),
        restart: true,
        confirmed: true
      }
    } as const;
    const updateResult = {
      snapshot: dockerSnapshot,
      restarted: true,
      rollback: "not_required",
      error: null
    } as const;
    expect(parseHostdResult("docker.daemon", updateRequest, updateResult)).toEqual(updateResult);
  });

  it("parses ping, inspection, scan, and every NetworkManager mutation action", () => {
    expect(parseHostdResult("network.manager", { action: "ping" }, { ready: true })).toEqual({ ready: true });

    const inspection = {
      profiles: [{
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "ZOS Home",
        ssid: "Home",
        device: "wlan0",
        security: "wpa2",
        mode: "client",
        band: "5",
        channel: 36,
        autoconnect: true,
        credentialConfigured: true,
        revision: "profile-revision"
      }],
      recovery: {
        wlan0: {
          restoreProfileId: null,
          hotspotProfileId: "550e8400-e29b-41d4-a716-446655440001"
        }
      }
    } as const;
    expect(parseHostdResult("network.manager", { action: "inspect" }, inspection)).toEqual(inspection);
    expect(parseHostdResult("network.manager", { action: "ethernet_status" }, ethernetStatus)).toEqual(ethernetStatus);

    const scan = {
      device: "wlan0",
      scannedAt: "2026-10-10T00:00:00Z",
      accessPoints: [{
        active: true,
        ssid: "Home",
        bssid: "00:11:22:33:44:55",
        channel: 36,
        frequencyMHz: 5180,
        signal: 82,
        band: "5",
        security: "wpa2",
        savedProfileId: null
      }]
    } as const;
    expect(parseHostdResult("network.manager", { action: "scan", input: { device: "wlan0" } }, scan)).toEqual(scan);

    const mutations: HostdNetworkMutationRequest[] = [
      { action: "connect", input: { device: "wlan0", profileId: "profile", confirmed: true } },
      { action: "disconnect", input: { device: "wlan0", confirmed: true } },
      { action: "radio", input: { enabled: true, confirmed: true } },
      { action: "update_profile", profileId: "profile", input: { expectedRevision: "revision", confirmed: true } },
      { action: "delete_profile", profileId: "profile", confirmed: true },
      { action: "update_hotspot", input: { device: "wlan0", ssid: "ZOS", band: "5", autostart: true, confirmed: true } },
      { action: "start_hotspot", input: { device: "wlan0", confirmed: true } },
      { action: "stop_hotspot", input: { device: "wlan0", confirmed: true } },
      { action: "delete_hotspot", input: { device: "wlan0", confirmed: true } }
    ];
    for (const request of mutations) {
      expect(parseHostdResult("network.manager", request, networkMutation)).toEqual(networkMutation);
    }

    const transaction = {
      id: "550e8400-e29b-41d4-a716-446655440010",
      status: "awaiting_confirmation",
      deviceIds: ["2ccf67c96807"],
      createdAt: "2026-10-10T00:00:00Z",
      deadlineAt: "2026-10-10T00:01:30Z",
      rollback: "not_required",
      error: null
    } as const;
    expect(parseHostdResult("network.manager", { action: "ethernet_apply", confirmed: true }, transaction)).toEqual(transaction);
  });

  it("rejects mismatched, out-of-range, and non-exact result shapes", () => {
    expect(parseHostdResult("shares.apply", {
      settings: { enabled: false, account: { username: "zos_share", password: null }, shares: [] },
      roots: []
    }, {
      appliedAt: "2026-10-10T00:00:00Z",
      files: [],
      services: [],
      extra: true
    })).toBeNull();
    expect(parseHostdResult("docker.daemon", { action: "read" }, {
      ...dockerSnapshot,
      path: "/tmp/daemon.json"
    })).toBeNull();
    expect(parseHostdResult("network.manager", { action: "ping" }, { ready: false })).toBeNull();
    expect(parseHostdResult("network.manager", { action: "scan", input: { device: "wlan0" } }, {
      device: "wlan0",
      scannedAt: "2026-10-10T00:00:00Z",
      accessPoints: [{
        active: false,
        ssid: "Home",
        bssid: "00:11:22:33:44:55",
        channel: 65_536,
        frequencyMHz: 5180,
        signal: 82,
        band: "5",
        security: "wpa2",
        savedProfileId: null
      }]
    })).toBeNull();
    expect(parseHostdResult("network.manager", { action: "disconnect", input: { device: "wlan0", confirmed: true } }, {
      rollback: "unknown",
      message: null
    })).toBeNull();
    expect(parseHostdResult("system.power", { action: "shutdown", confirmed: true }, {
      action: "reboot",
      accepted: true
    })).toBeNull();
  });

  it("keeps the checked-in operation and action fixtures valid", async () => {
    const fixtures = JSON.parse(await readFile(new URL("../fixtures/hostd-protocol-v1.json", import.meta.url), "utf8")) as {
      contracts: HostdFixtureContract[];
    };
    expect(fixtures.contracts).toHaveLength(27);
    for (const contract of fixtures.contracts) {
      expect(parseFixtureContract(contract)).toEqual(contract.result);
    }
  });
});

interface HostdFixtureContract {
  operation: "shares.apply" | "storage.command" | "storage.operation" | "docker.daemon" | "network.manager" | "system.power" | "system.ops";
  request: unknown;
  result: unknown;
}

function parseFixtureContract(contract: HostdFixtureContract): unknown {
  switch (contract.operation) {
    case "shares.apply":
      return parseHostdResult(contract.operation, contract.request as HostdRequest<"shares.apply">, contract.result);
    case "storage.command":
      return parseHostdResult(contract.operation, contract.request as HostdRequest<"storage.command">, contract.result);
    case "storage.operation":
      return parseHostdResult(contract.operation, contract.request as HostdRequest<"storage.operation">, contract.result);
    case "docker.daemon":
      return parseHostdResult(contract.operation, contract.request as HostdRequest<"docker.daemon">, contract.result);
    case "network.manager":
      return parseHostdResult(contract.operation, contract.request as HostdRequest<"network.manager">, contract.result);
    case "system.power":
      return parseHostdResult(contract.operation, contract.request as HostdRequest<"system.power">, contract.result);
    case "system.ops":
      return parseHostdResult(contract.operation, contract.request as HostdRequest<"system.ops">, contract.result);
  }
}
