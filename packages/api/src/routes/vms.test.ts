import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeVmConsoleAuthorization,
  openCyberOsDb,
  type CyberOsDatabase
} from "@cyberos/db";
import { loadConfig, type CyberOsConfig } from "@cyberos/shared";
import { buildServer } from "../server.js";
import { vmQemuCommand, type VmCommandRunner } from "../lib/vm-service.js";
import { vmConsoleSpawnSpec } from "./vms.js";
import type { SystemCommandRunner } from "../lib/system-management.js";

const TEST_STORAGE_POOL_ID = "pool-1";
const TEST_STORAGE_POOL_DEVICE = `/dev/md/${TEST_STORAGE_POOL_ID}`;

let tempDir: string;
let rootDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-vms-"));
  rootDir = path.join(tempDir, "data");
  await mkdir(rootDir);
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("VM routes", () => {
  it("runs virsh console inside a PTY wrapper without interpolating configuration into the shell command", () => {
    expect(vmConsoleSpawnSpec("qemu:///system; unsafe", "guest-name")).toEqual({
      command: "script",
      args: [
        "-q", "-e", "-f", "-c",
        'exec virsh -c "$CYBEROS_VM_LIBVIRT_URI" console "$CYBEROS_VM_DOMAIN"',
        "/dev/null"
      ],
      env: {
        CYBEROS_VM_LIBVIRT_URI: "qemu:///system; unsafe",
        CYBEROS_VM_DOMAIN: "guest-name"
      }
    });
  });

  it("issues a direct one-shot console session without an approval", async () => {
    const server = await buildServer({ config: testConfig(), db, vm: { commandRunner: vmRunner(), kvmAvailable: true } });

    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: { action: "console", domainName: "guest" }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      operation: { action: "console", status: "applied" },
      consoleSession: {
        domainName: "guest",
        websocketUrl: expect.stringContaining("/api/vms/console/")
      }
    });
    expectNoAgentSideEffects();
    const authorizationId = response.json().consoleSession.id as string;
    expect(consumeVmConsoleAuthorization(db, authorizationId)).toMatchObject({ status: "used" });
    expect(consumeVmConsoleAuthorization(db, authorizationId)).toBeNull();
    await server.close();
  });

  it("applies a lifecycle operation directly and records its history", async () => {
    const calls: string[][] = [];
    const server = await buildServer({ config: testConfig(), db, vm: { commandRunner: vmRunner(calls), kvmAvailable: true } });

    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: { action: "start", domainName: "guest" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ operation: { action: "start", status: "applied" } });
    expect(calls.some((args) => args.includes("start"))).toBe(true);
    expect((await server.inject({ method: "GET", url: "/api/vms/operations" })).json().operations)
      .toEqual([expect.objectContaining({ action: "start", status: "applied" })]);
    expectNoAgentSideEffects();
    await server.close();
  });

  it("records a failed direct lifecycle operation without creating an approval", async () => {
    const runner = vmRunner();
    const failingRunner: VmCommandRunner = {
      async run(command, args) {
        if (command === "virsh" && args.includes("start")) throw new Error("start failed");
        return runner.run(command, args);
      }
    };
    const server = await buildServer({ config: testConfig(), db, vm: { commandRunner: failingRunner, kvmAvailable: true } });

    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: { action: "start", domainName: "guest" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("start failed");
    expect((await server.inject({ method: "GET", url: "/api/vms/operations" })).json().operations)
      .toEqual([expect.objectContaining({ action: "start", status: "failed" })]);
    expectNoAgentSideEffects();
    await server.close();
  });

  it("rejects ISO paths outside configured VM roots", async () => {
    const server = await buildServer({ config: testConfig(), db, vm: { commandRunner: vmRunner(), kvmAvailable: true } });
    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: {
        action: "create",
        domainName: "new-vm",
        isoPath: path.join(tempDir, "outside.iso")
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("ISO path");
    await server.close();
  });

  it("resolves ISO files selected from a mounted storage pool", async () => {
    const calls: string[][] = [];
    const poolDir = path.join(rootDir, TEST_STORAGE_POOL_ID);
    const isoDir = path.join(poolDir, "images");
    const isoPath = path.join(isoDir, "installer.iso");
    await mkdir(isoDir, { recursive: true });
    await writeFile(isoPath, "iso-image");
    const server = await buildServer({
      config: testConfig(),
      db,
      vm: { commandRunner: vmRunner(calls), kvmAvailable: true },
      system: { commandRunner: storagePoolRunner(poolDir) }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: {
        action: "create",
        domainName: "new-vm",
        isoPath: "images/installer.iso",
        isoStoragePoolId: TEST_STORAGE_POOL_ID
      }
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(202);
    const resolvedIsoPath = await realpath(isoPath);
    expect(response.json()).toMatchObject({
      operation: { status: "applied", metadata: { proposal: { isoPath: resolvedIsoPath, isoStoragePoolId: TEST_STORAGE_POOL_ID, isoSourcePath: "images/installer.iso" } } }
    });
    expect(calls.some((args) => args.includes("--cdrom") && args.includes(resolvedIsoPath))).toBe(true);
    expectNoAgentSideEffects();
    await server.close();
  });

  it("rejects non-ISO files selected from a storage pool", async () => {
    const poolDir = path.join(rootDir, TEST_STORAGE_POOL_ID);
    await mkdir(poolDir);
    await writeFile(path.join(poolDir, "notes.txt"), "not an image");
    const server = await buildServer({
      config: testConfig(),
      db,
      vm: { commandRunner: vmRunner(), kvmAvailable: true },
      system: { commandRunner: storagePoolRunner(poolDir) }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: {
        action: "create",
        domainName: "new-vm",
        isoPath: "notes.txt",
        isoStoragePoolId: TEST_STORAGE_POOL_ID
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("ISO file");
    await server.close();
  });

  it("rejects a storage-pool ISO symlink that escapes the selected pool", async () => {
    const poolDir = path.join(rootDir, TEST_STORAGE_POOL_ID);
    const isoPath = path.join(poolDir, "installer.iso");
    const outsideIsoPath = path.join(rootDir, "outside.iso");
    await mkdir(poolDir);
    await writeFile(isoPath, "iso-image");
    await writeFile(outsideIsoPath, "outside-image");
    const server = await buildServer({
      config: testConfig(),
      db,
      vm: { commandRunner: vmRunner(), kvmAvailable: true },
      system: { commandRunner: storagePoolRunner(poolDir) }
    });
    await unlink(isoPath);
    await symlink(outsideIsoPath, isoPath);
    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: {
        action: "create",
        domainName: "new-vm",
        isoPath: "installer.iso",
        isoStoragePoolId: TEST_STORAGE_POOL_ID
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("escapes the storage pool");
    await server.close();
  });

  it("rejects option-like network names", async () => {
    const server = await buildServer({ config: testConfig(), db, vm: { commandRunner: vmRunner(), kvmAvailable: true } });
    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: { action: "start", domainName: "guest", networkName: "--network=unsafe" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Network name");
    await server.close();
  });

  it("creates a VM immediately without an approval record", async () => {
    const isoDir = path.join(tempDir, "iso");
    await mkdir(isoDir);
    const isoPath = path.join(isoDir, "installer.iso");
    await writeFile(isoPath, "iso-image");
    const calls: string[][] = [];
    const server = await buildServer({ config: testConfig(), db, vm: { commandRunner: vmRunner(calls), kvmAvailable: true } });
    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: {
        action: "create",
        domainName: "custom-vm",
        isoPath,
        vcpu: 4,
        vcpuTopology: { sockets: 1, cores: 2, threads: 2 },
        memoryBytes: 4 * 1024 ** 3,
        diskSizeBytes: 32 * 1024 ** 3,
        firmware: "uefi",
        cpuMode: "custom",
        cpuModel: "Skylake-Client",
        diskBus: "virtio",
        diskCache: "none",
        diskDiscard: "unmap",
        networkModel: "virtio",
        graphics: "spice",
        videoModel: "virtio",
        bootMenu: true,
        autostart: true
      }
    });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(202);
    expect(response.json()).toMatchObject({
      operation: { status: "applied", targetId: "custom-vm" }
    });
    const operations = await server.inject({ method: "GET", url: "/api/vms/operations" });
    expect(operations.json().operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "applied", targetId: "custom-vm" })
    ]));
    const virtInstall = calls.find((call) => call[0] === "virt-install");
    expect(virtInstall).toEqual(expect.arrayContaining([
      "--vcpus", "4,sockets=1,cores=2,threads=2", "--cpu", "Skylake-Client",
      "--boot", "uefi,firmware.feature0.name=secure-boot,firmware.feature0.enabled=no,menu=on", "--graphics", "spice", "--video", "virtio", "--autostart"
    ]));
    expectNoAgentSideEffects();
    await server.close();
  });

  it("uses compatible CPU and firmware defaults on arm64 hosts", async () => {
    const isoDir = path.join(tempDir, "iso");
    await mkdir(isoDir);
    const isoPath = path.join(isoDir, "installer.iso");
    await writeFile(isoPath, "iso-image");
    const calls: string[][] = [];
    const server = await buildServer({
      config: testConfig(),
      db,
      vm: { commandRunner: vmRunner(calls), kvmAvailable: true, architecture: "arm64" }
    });

    const created = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: { action: "create", domainName: "arm-guest", isoPath }
    });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(202);
    expect(calls.find((call) => call[0] === "virt-install")).toEqual(expect.arrayContaining([
      "--cpu",
      "host-passthrough",
      "--boot",
      "uefi,firmware.feature0.name=secure-boot,firmware.feature0.enabled=no"
    ]));

    const rejected = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: { action: "create", domainName: "arm-bios", isoPath, firmware: "bios" }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("UEFI");

    const rejectedCpu = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: { action: "create", domainName: "arm-host-model", isoPath, cpuMode: "host-model" }
    });
    expect(rejectedCpu.statusCode).toBe(400);
    expect(rejectedCpu.json().error).toContain("host-passthrough");
    expectNoAgentSideEffects();
    await server.close();
  });

  it("records a failed direct creation without creating an approval", async () => {
    const isoDir = path.join(tempDir, "iso");
    await mkdir(isoDir);
    const isoPath = path.join(isoDir, "installer.iso");
    await writeFile(isoPath, "iso-image");
    const runner = vmRunner();
    const failingRunner: VmCommandRunner = {
      async run(command, args) {
        if (command === "virt-install") throw new Error("virt-install failed");
        return runner.run(command, args);
      }
    };
    const server = await buildServer({ config: testConfig(), db, vm: { commandRunner: failingRunner, kvmAvailable: true } });
    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: { action: "create", domainName: "failed-vm", isoPath }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("virt-install failed");
    const operations = await server.inject({ method: "GET", url: "/api/vms/operations" });
    expect(operations.json().operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", targetId: "failed-vm" })
    ]));
    expectNoAgentSideEffects();
    await server.close();
  });

  it("rejects a vCPU topology that does not match vCPU", async () => {
    const server = await buildServer({ config: testConfig(), db, vm: { commandRunner: vmRunner(), kvmAvailable: true } });
    const response = await server.inject({
      method: "POST",
      url: "/api/vms/actions",
      payload: {
        action: "create",
        domainName: "bad-topology",
        isoPath: path.join(tempDir, "iso", "installer.iso"),
        vcpu: 4,
        vcpuTopology: { sockets: 1, cores: 1, threads: 1 }
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("topology");
    await server.close();
  });

  it("rejects unsupported and option-like advanced create values", async () => {
    const server = await buildServer({ config: testConfig(), db, vm: { commandRunner: vmRunner(), kvmAvailable: true } });
    const cases = [
      { domainName: "bad-firmware", options: { firmware: "efi" } },
      { domainName: "bad-machine", options: { machineType: "--q35" } },
      { domainName: "bad-mac", options: { macAddress: "52:54:00:12:34" } }
    ];

    for (const advanced of cases) {
      const response = await server.inject({
        method: "POST",
        url: "/api/vms/actions",
        payload: {
          action: "create",
          domainName: advanced.domainName,
          isoPath: path.join(tempDir, "iso", "installer.iso"),
          ...advanced.options
        }
      });
      expect(response.statusCode, JSON.stringify(response.json())).toBe(400);
    }

    expectNoAgentSideEffects();
    await server.close();
  });
});

function expectNoAgentSideEffects(): void {
  expect(db.prepare("SELECT COUNT(*) FROM jobs").pluck().get()).toBe(0);
  expect(db.prepare("SELECT COUNT(*) FROM agent_messages").pluck().get()).toBe(0);
  expect(db.prepare("SELECT COUNT(*) FROM capability_approvals").pluck().get()).toBe(0);
  expect(db.prepare("SELECT COUNT(*) FROM operation_notifications").pluck().get()).toBe(0);
}

function testConfig(): CyberOsConfig {
  const base = loadConfig({ CYBEROS_CONFIG: path.join(tempDir, "missing.toml"), CYBEROS_ROOT: tempDir }, tempDir);
  return {
    ...base,
    paths: { ...base.paths, dataRoot: rootDir, databasePath: path.join(tempDir, "cyberos.sqlite") },
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50, concurrency: 1 },
    admin: { displayName: "Test Admin", authMode: "local-only" },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1000, consoleShells: [] },
    vm: { enabled: true, libvirtUri: "qemu:///system", storagePath: path.join(tempDir, "vmstore"), networkName: "default", isoRoots: [path.join(tempDir, "iso")], operationTimeoutMs: 1000, consoleMode: "serial" },
    hostd: { socketPath: "/tmp/hostd.sock", mutationPolicy: "mutable" },
    shares: { enabled: false, account: { username: "share", password: null }, shares: [] },
    terminal: { user: "test-user", socketPath: "/tmp/terminald.sock", sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: "/tmp/vod-player.sock", statePath: "/tmp/vod-player-session.json", commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "cyberos" },
  };
}

function vmRunner(calls: string[][] = []): VmCommandRunner {
  return {
    async run(command, args) {
      calls.push([command, ...args]);
      if (command === "qemu-img") {
        const diskPath = args[3]!;
        await mkdir(path.dirname(diskPath), { recursive: true });
        await writeFile(diskPath, "qcow2");
        return "";
      }
      if (command === "virsh" && args.includes("version")) return "Using library: libvirt 10.0.0\nUsing API: QEMU 8.2.2";
      if (command === "virsh" && args.includes("--name")) return "guest\n";
      if (command === "virsh" && args.includes("dominfo")) return "State: running\nCPU(s): 2\nUsed memory: 2097152 KiB\nMax memory: 4194304 KiB\nUUID: guest-uuid";
      if (command === "virsh" && args.includes("net-list")) return " Name      State    Autostart\n--------------------------------\n default   active   yes\n";
      if (command === "virsh" && args.includes("pool-list")) return "";
      if (command.startsWith("qemu-system-") || command === vmQemuCommand()) return "QEMU emulator version 8.2.2";
      if (command === "nproc") return "8";
      if (command === "free") return "Mem: 100 0 0 0 0 80";
      if (command === "df") return "size avail\n100000 50000";
      return "";
    }
  };
}

function storagePoolRunner(target: string): SystemCommandRunner {
  return {
    async run(command, args) {
      if (command === "lsblk") return JSON.stringify({ blockdevices: [] });
      if (command === "findmnt") {
        return JSON.stringify({
          filesystems: [{
            source: TEST_STORAGE_POOL_DEVICE,
            target,
            fstype: "ext4",
            size: 1024,
            used: 128,
            avail: 896,
            "use%": "12.5%"
          }]
        });
      }
      if (command === "mdadm" && args[0] === "--detail" && args[1] === "--scan") {
        return `ARRAY ${TEST_STORAGE_POOL_DEVICE} name=${TEST_STORAGE_POOL_ID} UUID=test-pool`;
      }
      if (command === "mdadm" && args[0] === "--detail") {
        return ["Name : test-pool", "Raid Level : raid1", "State : clean", "UUID : test-pool"].join("\n");
      }
      if (command === "smartctl") return JSON.stringify({ devices: [] });
      return JSON.stringify({});
    }
  };
}
