import { execFile } from "node:child_process";
import { access, chmod, mkdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";
import type {
  CyberOsRuntime,
  VmConfig,
  VmInstanceSummary,
  VmOperationProposal,
  VmOperationRecord,
  VmSummary
} from "@cyberos/shared";

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;

export interface VmCommandRunner {
  run(command: string, args: string[]): Promise<string>;
}

export interface VmRuntimeDependencies {
  commandRunner?: VmCommandRunner;
  kvmAvailable?: boolean;
  architecture?: NodeJS.Architecture;
}

export function vmQemuCommand(architecture = process.arch): "qemu-system-aarch64" | "qemu-system-x86_64" {
  return architecture === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
}

class NodeVmCommandRunner implements VmCommandRunner {
  constructor(
    private readonly timeoutMs: number,
    private readonly cachePath: string
  ) {}

  async run(command: string, args: string[]): Promise<string> {
    await mkdir(this.cachePath, { recursive: true, mode: 0o700 });
    const { stdout } = await execFileAsync(command, args, {
      timeout: this.timeoutMs,
      maxBuffer: COMMAND_MAX_BUFFER,
      env: { ...process.env, XDG_CACHE_HOME: this.cachePath }
    });
    return stdout;
  }
}

export function vmCommandRunner(config: CyberOsRuntime, dependencies?: VmRuntimeDependencies): VmCommandRunner {
  const vm = config.vm;
  return dependencies?.commandRunner ?? new NodeVmCommandRunner(
    vm.operationTimeoutMs,
    path.join(config.paths.stateDir, ".cache")
  );
}

export async function collectVmSummary(config: CyberOsRuntime, dependencies?: VmRuntimeDependencies): Promise<VmSummary> {
  const vm = config.vm;
  if (!vm.enabled) return unavailableSummary(vm, "disabled");
  const runner = vmCommandRunner(config, dependencies);
  const architecture = dependencies?.architecture ?? process.arch;
  const issues: string[] = [];
  let libvirtVersion: string | null = null;
  let qemuVersion: string | null = null;
  let domains: string[] = [];
  try {
    const version = await runVirsh(runner, vm, ["version"]);
    libvirtVersion = version.match(/Using library:\s+libvirt\s+([\w.-]+)/u)?.[1] ??
      version.match(/libvirt\s+(\d[\w.-]*)/iu)?.[1] ?? null;
    domains = parseNames(await runVirsh(runner, vm, ["list", "--all", "--name"]));
  } catch (error) {
    return unavailableSummary(vm, safeVmMessage(error));
  }
  try {
    qemuVersion = (await runner.run(vmQemuCommand(architecture), ["--version"])).match(/version\s+(\S+)/iu)?.[1] ?? null;
  } catch (error) {
    issues.push(`QEMU is unavailable: ${safeVmMessage(error)}`);
  }
  const kvmAvailable = dependencies?.kvmAvailable ?? await canReadKvm();
  if (!kvmAvailable) issues.push("/dev/kvm is unavailable; enable VT-x/AMD-V in firmware or the outer hypervisor.");
  const [hostResources, instances, storagePools, networks] = await Promise.all([
    collectHostResources(vm, runner, issues),
    Promise.all(domains.map((name) => collectInstance(vm, runner, name, issues))),
    collectStoragePools(vm, runner, issues),
    collectNetworks(vm, runner, issues)
  ]);
  const filteredInstances = instances.filter((item): item is VmInstanceSummary => item !== null);
  const running = filteredInstances.filter((item) => item.state === "running").length;
  const paused = filteredInstances.filter((item) => item.state === "paused").length;
  const vcpu = filteredInstances.reduce((sum, item) => sum + (item.vcpu ?? 0), 0);
  const memoryBytes = filteredInstances.reduce((sum, item) => sum + (item.maxMemoryBytes ?? item.memoryBytes ?? 0), 0);
  const diskBytes = filteredInstances.reduce(
    (sum, item) => sum + item.disks.reduce((diskSum, disk) => diskSum + (disk.capacityBytes ?? 0), 0),
    0
  );
  const status = kvmAvailable && qemuVersion ? "ready" : "degraded";
  return {
    collectedAt: new Date().toISOString(), enabled: true,
    host: {
      status, libvirtUri: vm.libvirtUri, libvirtVersion, qemuVersion, kvmAvailable,
      architecture,
      cpuCount: hostResources.cpuCount, memoryTotalBytes: hostResources.memoryTotalBytes,
      memoryFreeBytes: hostResources.memoryFreeBytes, storagePath: vm.storagePath,
      storageTotalBytes: hostResources.storageTotalBytes, storageFreeBytes: hostResources.storageFreeBytes,
      networkName: vm.networkName, error: null, issues
    },
    metrics: { total: filteredInstances.length, running, paused, vcpu, memoryBytes, diskBytes },
    instances: filteredInstances,
    storagePools,
    networks
  };
}

export async function applyVmOperation(
  config: CyberOsRuntime,
  operation: VmOperationRecord,
  proposal: VmOperationProposal,
  dependencies?: VmRuntimeDependencies
): Promise<Record<string, unknown>> {
  const vmConfig = config.vm;
  if (!vmConfig.enabled) throw new Error("Virtual machine management is disabled");
  if (proposal.action !== "console" && proposal.action !== "delete") {
    const summary = await collectVmSummary(config, dependencies);
    if (summary.host.status !== "ready") throw new Error(summary.host.issues[0] ?? "Virtualization host is not ready");
  }
  const runner = vmCommandRunner(config, dependencies);
  const domain = requiredDomain(proposal);
  switch (proposal.action) {
    case "start": await runVirshTransition(runner, vmConfig, ["start", domain], domain, ["running"]); break;
    case "shutdown": await runVirshTransition(runner, vmConfig, ["shutdown", domain], domain, ["shut off"]); break;
    case "stop": await runVirshTransition(runner, vmConfig, ["destroy", domain], domain, ["shut off"]); break;
    case "restart": await runVirsh(runner, vmConfig, ["reboot", domain]); break;
    case "pause": await runVirshTransition(runner, vmConfig, ["suspend", domain], domain, ["paused"]); break;
    case "resume": await runVirshTransition(runner, vmConfig, ["resume", domain], domain, ["running"]); break;
    case "reset":
      await runVirshTransition(runner, vmConfig, ["destroy", domain], domain, ["shut off"]);
      await runVirshTransition(runner, vmConfig, ["start", domain], domain, ["running"]);
      break;
    case "snapshot":
      await runVirsh(runner, vmConfig, [
        "snapshot-create-as",
        domain,
        requiredSnapshot(proposal),
        "--disk-only",
        "--atomic"
      ]);
      return { action: proposal.action, domainName: domain, snapshotMode: "disk-only" };
    case "snapshot_revert":
      await runVirsh(runner, vmConfig, ["snapshot-revert", domain, requiredSnapshot(proposal), "--running"]);
      return { action: proposal.action, domainName: domain, snapshotName: requiredSnapshot(proposal) };
    case "snapshot_delete":
      await runVirsh(runner, vmConfig, ["snapshot-delete", domain, requiredSnapshot(proposal)]);
      return { action: proposal.action, domainName: domain, snapshotName: requiredSnapshot(proposal) };
    case "delete": {
      const diskPaths = await collectDomainDiskChain(vmConfig, runner, domain);
      await runVirsh(runner, vmConfig, ["destroy", domain]).catch(() => undefined);
      await runVirsh(runner, vmConfig, [
        "undefine",
        domain,
        "--managed-save",
        "--snapshots-metadata",
        "--checkpoints-metadata",
        "--nvram"
      ]);
      await Promise.all(diskPaths.map((diskPath) => unlink(diskPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      })));
      return { action: proposal.action, domainName: domain, removedDiskPaths: diskPaths.length };
    }
    case "create": {
      const diskPath = proposal.diskPath ?? path.join(vmConfig.storagePath, `${domain}.qcow2`);
      await assertDiskPath(vmConfig.storagePath, diskPath);
      if (proposal.isoPath) {
        await assertAllowedIso(vmConfig, proposal.isoPath);
      }
      const sizeBytes = proposal.diskSizeBytes ?? 20 * 1024 ** 3;
      let createdDisk = false;
      if (!proposal.diskPath) {
        try {
          await access(diskPath);
          throw new Error("Virtual machine disk already exists");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await runner.run("qemu-img", ["create", "-f", "qcow2", diskPath, String(sizeBytes)]);
        createdDisk = true;
      } else {
        try {
          await access(diskPath);
        } catch {
          throw new Error("Existing virtual machine disk was not found");
        }
      }
      try {
        await chmod(diskPath, 0o600);
        const args = buildVmCreateArgs(vmConfig, domain, diskPath, proposal);
        await runner.run("virt-install", args);
      } catch (error) {
        if (createdDisk && !(await domainExists(vmConfig, runner, domain))) {
          await unlink(diskPath).catch(() => undefined);
        }
        throw error;
      }
      break;
    }
    case "console":
      return { action: proposal.action, domainName: domain, operationId: operation.id };
    default: throw new Error("Unsupported virtual machine action");
  }
  return { action: proposal.action, domainName: domain };
}

export function buildVmCreateArgs(
  vmConfig: VmConfig,
  domain: string,
  diskPath: string,
  proposal: VmOperationProposal
): string[] {
  const vcpu = proposal.vcpuTopology
    ? `${proposal.vcpu ?? proposal.vcpuTopology.sockets * proposal.vcpuTopology.cores * proposal.vcpuTopology.threads},sockets=${proposal.vcpuTopology.sockets},cores=${proposal.vcpuTopology.cores},threads=${proposal.vcpuTopology.threads}`
    : String(proposal.vcpu ?? 2);
  const diskOptions = [
    `path=${diskPath}`,
    "format=qcow2",
    ...(proposal.diskBus ? [`bus=${proposal.diskBus}`] : []),
    ...(proposal.diskCache ? [`cache=${proposal.diskCache}`] : []),
    ...(proposal.diskDiscard ? [`discard=${proposal.diskDiscard}`] : [])
  ];
  const networkOptions = [
    `network=${proposal.networkName ?? vmConfig.networkName}`,
    ...(proposal.networkModel ? [`model=${proposal.networkModel}`] : []),
    ...(proposal.macAddress ? [`mac=${proposal.macAddress}`] : [])
  ];
  const args = [
    "--connect", vmConfig.libvirtUri,
    "--name", domain,
    "--memory", String(Math.round((proposal.memoryBytes ?? 2 * 1024 ** 3) / 1024 ** 2)),
    "--vcpus", vcpu,
    "--disk", diskOptions.join(","),
    "--network", networkOptions.join(","),
    "--noautoconsole"
  ];
  if (proposal.osVariant) args.push("--os-variant", proposal.osVariant);
  else args.push("--osinfo", "detect=on,name=linux2024");
  if (proposal.machineType) args.push("--machine", proposal.machineType);
  if (proposal.cpuMode) args.push("--cpu", proposal.cpuMode === "custom" ? proposal.cpuModel! : proposal.cpuMode);
  if (proposal.memoryBacking === "hugepages") args.push("--memorybacking", "hugepages=yes");
  if (proposal.firmware || proposal.bootMenu !== undefined) {
    const boot = [
      ...(proposal.firmware === "uefi" ? [
        "uefi",
        "firmware.feature0.name=secure-boot",
        "firmware.feature0.enabled=no"
      ] : []),
      ...(proposal.bootMenu !== undefined ? [`menu=${proposal.bootMenu ? "on" : "off"}`] : [])
    ];
    if (boot.length) args.push("--boot", boot.join(","));
  }
  if (proposal.graphics) args.push("--graphics", proposal.graphics);
  if (proposal.videoModel) args.push("--video", proposal.videoModel);
  if (proposal.autostart === true) args.push("--autostart");
  if (proposal.isoPath) args.push("--cdrom", proposal.isoPath);
  else args.push("--import");
  return args;
}

export function buildVmUnavailableSummary(config: VmConfig, error: string | null): VmSummary {
  return unavailableSummary(config, error);
}

export function safeVmMessage(error: unknown): string {
  const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
    ? error.stderr.trim()
    : "";
  const message = stderr || (error instanceof Error ? error.message : String(error));
  return message.replace(/password\s*[:=]\s*\S+/giu, "password: [redacted]").slice(0, 2_000);
}

async function collectInstance(config: VmConfig, runner: VmCommandRunner, name: string, issues: string[]): Promise<VmInstanceSummary | null> {
  try {
    const [info, block, iface] = await Promise.all([
      runVirsh(runner, config, ["dominfo", name]),
      runVirsh(runner, config, ["domblklist", name, "--details"]).catch(() => ""),
      runVirsh(runner, config, ["domiflist", name]).catch(() => "")
    ]);
    const value = (key: string) => info.split(/\r?\n/u).find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? null;
    const stateText = value("State")?.toLowerCase() ?? "";
    const state = stateText.includes("running") ? "running" : stateText.includes("paused") ? "paused" : stateText.includes("crashed") ? "crashed" : stateText.includes("shut off") ? "shutoff" : "unknown";
    const memory = Number(value("Used memory")?.match(/\d+/u)?.[0] ?? 0) * 1024;
    const maxMemory = Number(value("Max memory")?.match(/\d+/u)?.[0] ?? 0) * 1024;
    const disks = await Promise.all(parseBlockDevices(block).map(async (disk) => ({
      source: disk.source,
      capacityBytes: await runVirsh(runner, config, ["domblkinfo", name, disk.target])
        .then((output) => parseIntegerField(output, "Capacity"))
        .catch(() => null)
    })));
    return {
      id: value("UUID") ?? name, name, state, uuid: value("UUID"),
      vcpu: Number(value("CPU(s)")) || null, memoryBytes: memory || null, maxMemoryBytes: maxMemory || null,
      os: null, disks, networks: parseInterfaces(iface)
    };
  } catch (error) {
    issues.push(`${name}: ${safeVmMessage(error)}`);
    return null;
  }
}

async function collectStoragePools(config: VmConfig, runner: VmCommandRunner, issues: string[]) {
  try {
    const names = parseNames(await runVirsh(runner, config, ["pool-list", "--all", "--name"]));
    return (await Promise.all(names.map(async (name) => {
      try {
        const [info, xml] = await Promise.all([
          runVirsh(runner, config, ["pool-info", name]),
          runVirsh(runner, config, ["pool-dumpxml", name])
        ]);
        const value = (key: string) => info.split(/\r?\n/u).find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? "";
        const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml) as {
          pool?: { target?: { path?: string } };
        };
        return { name, path: parsed.pool?.target?.path ?? "", state: value("State") || "unknown", capacityBytes: parseSize(value("Capacity")), allocationBytes: parseSize(value("Allocation")), availableBytes: parseSize(value("Available")) };
      } catch (error) {
        issues.push(`Storage pool ${name}: ${safeVmMessage(error)}`);
        return null;
      }
    }))).filter((pool): pool is NonNullable<typeof pool> => Boolean(pool?.path));
  } catch (error) { issues.push(`Storage pools: ${safeVmMessage(error)}`); return []; }
}

async function collectNetworks(config: VmConfig, runner: VmCommandRunner, issues: string[]) {
  try {
    const output = await runVirsh(runner, config, ["net-list", "--all"]);
    return output.split(/\r?\n/u).slice(2).map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = line.split(/\s{2,}/u); const name = parts[0] ?? ""; const state = parts[1] ?? "inactive";
      return { name, state, mode: name === "default" ? "nat" as const : "unknown" as const };
    });
  } catch (error) { issues.push(`Networks: ${safeVmMessage(error)}`); return []; }
}

async function collectHostResources(config: VmConfig, runner: VmCommandRunner, _issues: string[]) {
  let cpuCount: number | null = null, memoryTotalBytes: number | null = null, memoryFreeBytes: number | null = null, storageTotalBytes: number | null = null, storageFreeBytes: number | null = null;
  try { cpuCount = Number((await runner.run("nproc", [])).trim()) || null; } catch { /* optional */ }
  try { const free = await runner.run("free", ["-b"]); const line = free.split(/\r?\n/u).find((item) => item.startsWith("Mem:")); const p = line?.trim().split(/\s+/u) ?? []; memoryTotalBytes = Number(p[1]) || null; memoryFreeBytes = Number(p[6] ?? p[3]) || null; } catch { /* optional */ }
  memoryTotalBytes ??= os.totalmem();
  memoryFreeBytes ??= os.freemem();
  try { const output = await runner.run("df", ["-B1", "--output=size,avail", config.storagePath]); const p = output.trim().split(/\r?\n/u).at(-1)?.trim().split(/\s+/u) ?? []; storageTotalBytes = Number(p[0]) || null; storageFreeBytes = Number(p[1]) || null; } catch { /* optional */ }
  return { cpuCount, memoryTotalBytes, memoryFreeBytes, storageTotalBytes, storageFreeBytes };
}

function parseBlockDevices(output: string) { return output.split(/\r?\n/u).slice(2).map((line) => line.trim()).filter(Boolean).map((line) => { const parts = line.split(/\s+/u); return { device: parts[1] ?? "", target: parts[2] ?? "", source: parts.at(-1) ?? line }; }).filter((disk) => disk.device === "disk" && disk.target); }
function parseInterfaces(output: string) { return output.split(/\r?\n/u).slice(2).map((line) => line.trim()).filter(Boolean).map((line) => { const parts = line.split(/\s+/u); return { name: parts[0] ?? "", source: parts[2] ?? null, mac: parts[4] ?? null }; }); }
function parseNames(output: string) { return output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean); }
function parseSize(value: string): number | null { const match = value.match(/([\d.]+)\s*(KiB|MiB|GiB|TiB|bytes?)/iu); if (!match) return null; const factor = { kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, byte: 1, bytes: 1 }[match[2]!.toLowerCase()] ?? 1; return Math.round(Number(match[1]) * factor); }
function parseIntegerField(output: string, key: string): number | null { const value = output.split(/\r?\n/u).find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim(); const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
async function runVirsh(runner: VmCommandRunner, config: VmConfig, args: string[]): Promise<string> { return runner.run("virsh", ["-c", config.libvirtUri, ...args]); }
async function runVirshTransition(
  runner: VmCommandRunner,
  config: VmConfig,
  args: string[],
  domain: string,
  desiredStates: string[]
): Promise<void> {
  if (desiredStates.includes(await domainState(config, runner, domain))) return;
  try {
    await runVirsh(runner, config, args);
  } catch (error) {
    if (!desiredStates.includes(await domainState(config, runner, domain))) throw error;
  }
}
async function domainState(config: VmConfig, runner: VmCommandRunner, domain: string): Promise<string> {
  return runVirsh(runner, config, ["domstate", domain])
    .then((output) => output.trim().toLowerCase().replace(/\s+/gu, " "))
    .catch(() => "");
}
async function domainExists(config: VmConfig, runner: VmCommandRunner, domain: string): Promise<boolean> { try { await runVirsh(runner, config, ["dominfo", domain]); return true; } catch { return false; } }
async function canReadKvm() { try { await access("/dev/kvm"); return true; } catch { return false; } }
function unavailableSummary(config: VmConfig, error: string | null): VmSummary { return { collectedAt: new Date().toISOString(), enabled: config.enabled, host: { status: error === "disabled" ? "disabled" : "unavailable", libvirtUri: config.libvirtUri, libvirtVersion: null, qemuVersion: null, architecture: process.arch, kvmAvailable: false, cpuCount: null, memoryTotalBytes: null, memoryFreeBytes: null, storagePath: config.storagePath, storageTotalBytes: null, storageFreeBytes: null, networkName: config.networkName, error: error === "disabled" ? null : error, issues: error && error !== "disabled" ? [error] : [] }, metrics: { total: 0, running: 0, paused: 0, vcpu: 0, memoryBytes: 0, diskBytes: 0 }, instances: [], storagePools: [], networks: [] }; }
function requiredDomain(proposal: VmOperationProposal) { if (!proposal.domainName || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u.test(proposal.domainName)) throw new Error("A valid virtual machine name is required"); return proposal.domainName; }
function requiredSnapshot(proposal: VmOperationProposal) { if (!proposal.snapshotName || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u.test(proposal.snapshotName)) throw new Error("A valid snapshot name is required"); return proposal.snapshotName; }
function assertInside(root: string, candidate: string) { const base = path.resolve(root); const target = path.resolve(candidate); if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Virtual machine disk must stay inside the configured storage path"); }
async function assertDiskPath(root: string, candidate: string) {
  assertInside(root, candidate);
  const rootReal = await realpath(root).catch(() => path.resolve(root));
  const parentReal = await realpath(path.dirname(candidate)).catch(() => path.resolve(path.dirname(candidate)));
  if (!isInside(rootReal, parentReal)) throw new Error("Virtual machine disk must stay inside the configured storage path");
  const targetReal = await realpath(candidate).catch(() => null);
  if (targetReal && !isInside(rootReal, targetReal)) throw new Error("Virtual machine disk must stay inside the configured storage path");
}
async function assertAllowedIso(config: VmConfig, isoPath: string) {
  const target = await realpath(isoPath).catch(() => null);
  if (target) {
    for (const root of config.isoRoots) {
      const rootReal = await realpath(root).catch(() => path.resolve(root));
      if (isInside(rootReal, target)) {
        return;
      }
    }
  }
  throw new Error("ISO path must stay inside a configured ISO root");
}
async function collectDomainDiskChain(config: VmConfig, runner: VmCommandRunner, domain: string): Promise<string[]> {
  const xml = await runVirsh(runner, config, ["dumpxml", domain]);
  type DiskNode = {
    "@_device"?: string;
    "@_type"?: string;
    source?: { "@_file"?: string };
    backingStore?: DiskNode;
  };
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml) as {
    domain?: { devices?: { disk?: DiskNode | DiskNode[] } };
  };
  const disks = parsed.domain?.devices?.disk;
  const fileDisks = (Array.isArray(disks) ? disks : disks ? [disks] : [])
    .filter((disk) => disk["@_device"] === "disk" && disk["@_type"] === "file");
  if (!fileDisks.length) throw new Error("Unable to identify managed virtual machine disks");

  const diskPaths = new Set<string>();
  for (const disk of fileDisks) {
    let current: DiskNode | undefined = disk;
    while (current?.source?.["@_file"]) {
      diskPaths.add(await managedDiskPath(config.storagePath, current.source["@_file"]));
      current = current.backingStore;
    }
  }
  return [...diskPaths];
}
async function managedDiskPath(root: string, candidate: string): Promise<string> {
  const rootReal = await realpath(root);
  const targetReal = await realpath(candidate);
  if (!isInside(rootReal, targetReal)) throw new Error("Virtual machine disk must stay inside the configured storage path");
  return targetReal;
}
function isInside(root: string, candidate: string) { const base = path.resolve(root); const target = path.resolve(candidate); return target === base || target.startsWith(`${base}${path.sep}`); }
