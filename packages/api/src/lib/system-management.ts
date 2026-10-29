import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  SystemCollectionIssue,
  SystemCollectionStatus,
  SystemNetworkAddress,
  SystemNetworkInterface,
  SystemNetworkInterfaceKind,
  SystemNetworkInterfaceState,
  SystemNetworkRoute,
  SystemNetworkSummary,
  SystemNetworkTrafficSummary,
  SystemRaidArray,
  SystemSmartAttribute,
  SystemSmartHealth,
  SystemSmartSelfTest,
  SystemSmartSummary,
  SystemStorageDisk,
  SystemStorageMount,
  SystemStoragePartition,
  SystemStoragePool,
  SystemStorageSummary
} from "@cyberos/shared";
import type { NetworkManagerRuntime } from "./network-manager.js";
import type { EthernetManagerRuntime } from "./ethernet-manager.js";
import type { BluetoothManagerRuntime } from "./bluetooth-manager.js";
import { HostdClient, HostdRequestError } from "./hostd-client.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const HOSTD_TIMEOUT_MS = 5_000;

export interface SystemCommandRunner {
  run(command: string, args: string[]): Promise<string>;
}

export interface SystemManagementDependencies {
  commandRunner?: SystemCommandRunner;
  networkManager?: NetworkManagerRuntime;
  ethernetManager?: EthernetManagerRuntime;
  bluetoothManager?: BluetoothManagerRuntime;
}

class NodeSystemCommandRunner implements SystemCommandRunner {
  async run(command: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(command, args, {
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER
      });
      return stdout;
    } catch (error) {
      const stdout = errorStdout(error);
      if (stdout.trim()) {
        return stdout;
      }
      throw error;
    }
  }
}

export function createSystemCommandRunner(hostdSocketPath?: string): SystemCommandRunner {
  const fallback = new NodeSystemCommandRunner();
  if (!hostdSocketPath) {
    return fallback;
  }
  return new HybridSystemCommandRunner(hostdSocketPath, fallback);
}

class HybridSystemCommandRunner implements SystemCommandRunner {
  private readonly client: HostdClient;

  constructor(hostdSocketPath: string, private readonly fallback: SystemCommandRunner) {
    this.client = new HostdClient(hostdSocketPath);
  }

  async run(command: string, args: string[]): Promise<string> {
    if (command !== "mdadm" && command !== "smartctl") {
      return this.fallback.run(command, args);
    }
    try {
      return await requestStorageHostd(this.client, command, args);
    } catch (error) {
      if (isMissingHostd(error)) {
        return this.fallback.run(command, args);
      }
      throw error;
    }
  }
}

async function requestStorageHostd(
  client: HostdClient,
  command: "mdadm" | "smartctl",
  args: string[]
): Promise<string> {
  const result = await client.request(
    "storage.command",
    { command, args },
    HOSTD_TIMEOUT_MS
  );
  if (!result || typeof result.stdout !== "string") {
    throw new Error("Invalid response from hostd");
  }
  return result.stdout;
}

function isMissingHostd(error: unknown): boolean {
  const code = error instanceof HostdRequestError ? error.socketCode : null;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "ENXIO";
}

interface CommandResult<T> {
  value: T | null;
  issue: SystemCollectionIssue | null;
}

interface MdadmScanArray {
  path: string;
  name: string | null;
  uuid: string | null;
}

export async function collectSystemNetwork(
  dependencies: SystemManagementDependencies = {}
): Promise<SystemNetworkSummary> {
  const runner = systemCommandRunner(dependencies);
  const [linkResult, addressResult, routeResult] = await Promise.all([
    runJson<unknown>("network links", runner, "ip", ["-j", "link"]),
    runJson<unknown>("network addresses", runner, "ip", ["-j", "addr"]),
    runJson<unknown>("network routes", runner, "ip", ["-j", "route"])
  ]);
  const issues = compactIssues([linkResult.issue, addressResult.issue, routeResult.issue]);
  const linkRows = recordsFrom(linkResult.value);
  const addressRows = recordsFrom(addressResult.value);
  const routeRows = recordsFrom(routeResult.value);
  const linksByName = new Map(
    linkRows.map((row): [string | null, Record<string, unknown>] => [stringField(row, "ifname"), row]).filter(hasName)
  );
  const addressesByName = new Map(
    addressRows
      .map((row): [string | null, Record<string, unknown>] => [stringField(row, "ifname"), row])
      .filter(hasName)
  );
  const names = [...new Set([...linksByName.keys(), ...addressesByName.keys()])].sort((left, right) =>
    left.localeCompare(right)
  );
  const routes = routeRows.map(mapRoute);
  const defaultRouteDevices = new Set(
    routes.filter((route) => route.destination === "default" && route.device).map((route) => route.device as string)
  );
  const interfaces = await Promise.all(
    names.map(async (name) =>
      mapNetworkInterface(name, linksByName.get(name) ?? null, addressesByName.get(name) ?? null, defaultRouteDevices)
    )
  );
  let wifi = unavailableWifiSummary();
  try {
    wifi = await (dependencies.networkManager?.getSummary() ?? Promise.resolve(wifi));
  } catch (error) {
    issues.push({ source: "Wi-Fi status", message: safeSystemMessage(error) });
  }
  let ethernet = unavailableEthernetStatus();
  if (wifi.backend !== "systemd-networkd" && dependencies.ethernetManager) {
    try {
      ethernet = await dependencies.ethernetManager.getStatus();
    } catch (error) {
      issues.push({ source: "Ethernet status", message: safeSystemMessage(error) });
    }
  }
  const status = collectionStatus(interfaces.length > 0 || routes.length > 0, issues);
  const networkManagerBackend = wifi.backend === "NetworkManager" || ethernet.backend === "NetworkManager";
  const hostdReady = wifi.hostdReady || ethernet.hostdReady;
  return {
    collectedAt: new Date().toISOString(),
    status,
    capabilities: {
      backend: networkManagerBackend ? "NetworkManager" : wifi.backend,
      canApplyConfiguration: networkManagerBackend && hostdReady,
      canConfigureBridge: false,
      canConfigureBond: false,
      canConfigureVlan: false,
      canManageEthernet: ethernet.backend === "NetworkManager" && ethernet.hostdReady && ethernet.devices.length > 0,
      canManageWifi: wifi.backend === "NetworkManager" && wifi.hostdReady && wifi.devices.length > 0,
      canManageHotspot:
        wifi.backend === "NetworkManager" &&
        wifi.hostdReady &&
        wifi.devices.some((device) => device.capabilities.accessPoint),
      hostdReady
    },
    metrics: {
      interfaces: interfaces.length,
      connected: interfaces.filter((networkInterface) => networkInterface.state === "connected").length,
      addresses: interfaces.reduce((sum, networkInterface) => sum + networkInterface.addresses.length, 0),
      defaultRoutes: routes.filter((route) => route.destination === "default").length
    },
    interfaces,
    routes,
    ethernet,
    wifi,
    issues
  };
}

function unavailableEthernetStatus(): SystemNetworkSummary["ethernet"] {
  return {
    collectedAt: new Date().toISOString(),
    backend: "unknown",
    hostdReady: false,
    devices: [],
    transaction: null,
    warnings: []
  };
}

function unavailableWifiSummary(): SystemNetworkSummary["wifi"] {
  return {
    collectedAt: new Date().toISOString(),
    backend: "unknown",
    radioEnabled: null,
    hostdReady: false,
    devices: [],
    hotspots: [],
    profiles: []
  };
}

export async function collectSystemNetworkTraffic(
  dependencies: SystemManagementDependencies = {}
): Promise<SystemNetworkTrafficSummary> {
  const raw = await systemCommandRunner(dependencies).run("cat", ["/proc/net/dev"]);
  return {
    collectedAt: new Date().toISOString(),
    interfaces: parseSystemNetworkTraffic(raw)
  };
}

export function parseSystemNetworkTraffic(raw: string): SystemNetworkTrafficSummary["interfaces"] {
  const interfaces: SystemNetworkTrafficSummary["interfaces"] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }

    const name = line.slice(0, separator).trim();
    const fields = line.slice(separator + 1).trim().split(/\s+/u);
    const rxBytes = Number(fields[0]);
    const txBytes = Number(fields[8]);
    if (!name || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes) || rxBytes < 0 || txBytes < 0) {
      continue;
    }

    interfaces.push({ id: name, name, rxBytes, txBytes });
  }
  return interfaces;
}

export async function collectSystemStorage(
  dependencies: SystemManagementDependencies = {}
): Promise<SystemStorageSummary> {
  const runner = systemCommandRunner(dependencies);
  const [lsblkResult, findmntResult, mdadmScanResult, smartScanResult] = await Promise.all([
    runJson<unknown>("block devices", runner, "lsblk", [
      "--json",
      "--bytes",
      "--output",
      "NAME,KNAME,PATH,TYPE,SIZE,MODEL,SERIAL,TRAN,ROTA,FSTYPE,LABEL,UUID,MOUNTPOINTS,PKNAME"
    ]),
    runJson<unknown>("mounts", runner, "findmnt", [
      "--json",
      "--bytes",
      "--output",
      "SOURCE,TARGET,FSTYPE,SIZE,USED,AVAIL,USE%"
    ]),
    runText("mdadm scan", runner, "mdadm", ["--detail", "--scan"]),
    runJson<unknown>("SMART scan", runner, "smartctl", ["--scan-open", "--json"])
  ]);
  const issues = compactIssues([
    lsblkResult.issue,
    findmntResult.issue,
    mdadmScanResult.issue,
    smartScanResult.issue
  ]);
  const mdadmScanArrays = mdadmScanResult.value ? parseMdadmScan(mdadmScanResult.value) : [];
  const [arrays, mdadmDetailIssues] = await collectMdadmArrays(runner, mdadmScanArrays);
  issues.push(...mdadmDetailIssues);

  const [smartByDevice, smartIssues] = await collectSmartSummaries(runner, smartScanResult.value);
  issues.push(...smartIssues);

  const blockDevices = recordsFrom(recordField(asRecord(lsblkResult.value), "blockdevices"));
  const mounts = flattenMounts(recordsFrom(recordField(asRecord(findmntResult.value), "filesystems")));
  const disks = blockDevices
    .filter((device) => stringField(device, "type") === "disk")
    .map((device) => mapStorageDisk(device, smartByDevice));
  const pools = arrays.map((array) => mapStoragePool(array, mounts));
  const metrics = storageMetrics(pools, arrays, disks);
  const status = collectionStatus(disks.length > 0 || arrays.length > 0 || mounts.length > 0, issues);
  return {
    collectedAt: new Date().toISOString(),
    status,
    capabilities: {
      backend: "mdadm",
      canCreatePool: true,
      canDeletePool: true,
      canApplyConfiguration: false
    },
    metrics,
    pools,
    arrays,
    disks,
    mounts,
    issues
  };
}

function systemCommandRunner(dependencies: SystemManagementDependencies): SystemCommandRunner {
  return dependencies.commandRunner ?? new NodeSystemCommandRunner();
}

async function runJson<T>(
  source: string,
  runner: SystemCommandRunner,
  command: string,
  args: string[]
): Promise<CommandResult<T>> {
  const result = await runText(source, runner, command, args);
  if (!result.value) {
    return { value: null, issue: result.issue };
  }

  try {
    return { value: JSON.parse(result.value) as T, issue: result.issue };
  } catch (error) {
    return {
      value: null,
      issue: {
        source,
        message: `Invalid JSON from ${command}: ${safeSystemMessage(error)}`
      }
    };
  }
}

async function runText(
  source: string,
  runner: SystemCommandRunner,
  command: string,
  args: string[]
): Promise<CommandResult<string>> {
  try {
    return { value: await runner.run(command, args), issue: null };
  } catch (error) {
    return {
      value: null,
      issue: {
        source,
        message: safeSystemMessage(error)
      }
    };
  }
}

async function mapNetworkInterface(
  name: string,
  link: Record<string, unknown> | null,
  addressRecord: Record<string, unknown> | null,
  defaultRouteDevices: Set<string>
): Promise<SystemNetworkInterface> {
  const flags = stringArrayField(link, "flags");
  const operState = stringField(link, "operstate");
  const addresses = recordsFrom(recordField(addressRecord, "addr_info")).map(mapNetworkAddress);
  return {
    id: name,
    index: numberField(link, "ifindex"),
    name,
    kind: networkInterfaceKind(name, link),
    state: networkInterfaceState(flags, operState, addresses.length > 0),
    operState,
    flags,
    mac: stringField(link, "address"),
    mtu: numberField(link, "mtu"),
    speedMbps: await readInterfaceSpeed(name),
    addresses,
    hasDefaultRoute: defaultRouteDevices.has(name)
  };
}

async function readInterfaceSpeed(name: string): Promise<number | null> {
  if (!name || name.includes("/")) {
    return null;
  }

  try {
    const raw = await readFile(`/sys/class/net/${name}/speed`, "utf8");
    const speed = Number(raw.trim());
    return Number.isFinite(speed) && speed > 0 ? speed : null;
  } catch {
    return null;
  }
}

function mapNetworkAddress(row: Record<string, unknown>): SystemNetworkAddress {
  const family = networkFamily(stringField(row, "family"));
  const address = stringField(row, "local") ?? "";
  const prefixLength = numberField(row, "prefixlen");
  return {
    family,
    address,
    prefixLength,
    cidr: address && prefixLength !== null ? `${address}/${prefixLength}` : null,
    scope: stringField(row, "scope"),
    label: stringField(row, "label")
  };
}

function mapRoute(row: Record<string, unknown>): SystemNetworkRoute {
  const destination = stringField(row, "dst") ?? "default";
  const gateway = stringField(row, "gateway");
  return {
    family: networkFamily(stringField(row, "family") ?? inferRouteFamily(destination, gateway)),
    destination,
    gateway,
    device: stringField(row, "dev"),
    preferredSource: stringField(row, "prefsrc"),
    protocol: stringField(row, "protocol") ?? stringField(row, "proto"),
    scope: stringField(row, "scope")
  };
}

function networkFamily(value: string | null): "inet" | "inet6" | "unknown" {
  if (value === "inet" || value === "inet6") {
    return value;
  }
  return "unknown";
}

function inferRouteFamily(destination: string, gateway: string | null): "inet" | "inet6" | "unknown" {
  if (destination.includes(":") || gateway?.includes(":")) {
    return "inet6";
  }
  if (destination.includes(".") || gateway?.includes(".") || destination === "default") {
    return "inet";
  }
  return "unknown";
}

function networkInterfaceKind(name: string, link: Record<string, unknown> | null): SystemNetworkInterfaceKind {
  const linkType = stringField(link, "link_type");
  const linkInfo = asRecord(recordField(link, "linkinfo"));
  const infoKind = stringField(linkInfo, "info_kind");
  if (linkType === "loopback" || name === "lo") {
    return "loopback";
  }
  if (infoKind === "bridge" || name.startsWith("br")) {
    return "bridge";
  }
  if (infoKind === "bond" || name.startsWith("bond")) {
    return "bond";
  }
  if (infoKind === "vlan" || name.includes(".")) {
    return "vlan";
  }
  if (name.startsWith("wl") || name.startsWith("wlan")) {
    return "wireless";
  }
  if (
    name.startsWith("veth") ||
    name.startsWith("docker") ||
    name.startsWith("virbr") ||
    name.startsWith("tun") ||
    name.startsWith("tap")
  ) {
    return "virtual";
  }
  if (linkType === "ether") {
    return "ethernet";
  }
  return "unknown";
}

function networkInterfaceState(flags: string[], operState: string | null, hasAddress: boolean): SystemNetworkInterfaceState {
  if ((flags.includes("LOWER_UP") || operState === "UP") && hasAddress) {
    return "connected";
  }
  if (flags.includes("UP") || flags.includes("LOWER_UP") || operState === "UP") {
    return "up";
  }
  if (operState === "DOWN") {
    return "down";
  }
  return "unknown";
}

async function collectMdadmArrays(
  runner: SystemCommandRunner,
  scanArrays: MdadmScanArray[]
): Promise<[SystemRaidArray[], SystemCollectionIssue[]]> {
  const details = await Promise.all(
    scanArrays.map(async (scanArray) => {
      const result = await runText(`mdadm detail ${scanArray.path}`, runner, "mdadm", [
        "--detail",
        scanArray.path
      ]);
      if (!result.value) {
        return {
          array: fallbackRaidArray(scanArray),
          issue: result.issue
        };
      }
      return {
        array: parseMdadmDetail(scanArray, result.value),
        issue: null
      };
    })
  );

  return [details.map((detail) => detail.array), compactIssues(details.map((detail) => detail.issue))];
}

function parseMdadmScan(stdout: string): MdadmScanArray[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ARRAY "))
    .map((line) => {
      const [path, ...tokens] = line.replace(/^ARRAY\s+/u, "").split(/\s+/u);
      const fields = keyValueTokens(tokens);
      return {
        path: path ?? "",
        name: fields.get("name") ?? null,
        uuid: fields.get("UUID") ?? null
      };
    })
    .filter((array) => array.path);
}

function parseMdadmDetail(scanArray: MdadmScanArray, stdout: string): SystemRaidArray {
  const fields = new Map<string, string>();
  const memberDevices = new Set<string>();
  for (const line of stdout.split("\n")) {
    const fieldMatch = line.match(/^\s*([^:]+?)\s*:\s*(.+)$/u);
    if (fieldMatch) {
      fields.set(fieldMatch[1]!.trim(), fieldMatch[2]!.trim());
    }
    const memberMatch = line.match(/\s(\/dev\/\S+)\s*$/u);
    if (memberMatch) {
      memberDevices.add(memberMatch[1]!);
    }
  }

  return {
    id: scanArray.path,
    name: fields.get("Name") ?? scanArray.name ?? scanArray.path.split("/").pop() ?? scanArray.path,
    path: scanArray.path,
    level: fields.get("Raid Level") ?? null,
    state: fields.get("State") ?? null,
    uuid: fields.get("UUID") ?? scanArray.uuid,
    sizeBytes: mdadmSizeBytes(fields.get("Array Size") ?? null),
    activeDevices: integerFromText(fields.get("Active Devices") ?? null),
    totalDevices: integerFromText(fields.get("Raid Devices") ?? fields.get("Total Devices") ?? null),
    failedDevices: integerFromText(fields.get("Failed Devices") ?? null),
    spareDevices: integerFromText(fields.get("Spare Devices") ?? null),
    memberDevices: [...memberDevices]
  };
}

function fallbackRaidArray(scanArray: MdadmScanArray): SystemRaidArray {
  return {
    id: scanArray.path,
    name: scanArray.name ?? scanArray.path.split("/").pop() ?? scanArray.path,
    path: scanArray.path,
    level: null,
    state: null,
    uuid: scanArray.uuid,
    sizeBytes: null,
    activeDevices: null,
    totalDevices: null,
    failedDevices: null,
    spareDevices: null,
    memberDevices: []
  };
}

async function collectSmartSummaries(
  runner: SystemCommandRunner,
  scanValue: unknown
): Promise<[Map<string, SystemSmartSummary>, SystemCollectionIssue[]]> {
  const smartByDevice = new Map<string, SystemSmartSummary>();
  const devices = recordsFrom(recordField(asRecord(scanValue), "devices"));
  const results = await Promise.all(
    devices.map(async (device) => {
      const name = stringField(device, "name");
      if (!name) {
        return null;
      }
      const type = stringField(device, "type");
      const args = type && type !== "auto" ? ["--all", "--json", "-d", type, name] : ["--all", "--json", name];
      const result = await runJson<unknown>(`SMART ${name}`, runner, "smartctl", args);
      if (!result.value) {
        smartByDevice.set(name, {
          health: "error",
          available: null,
          enabled: null,
          protocol: null,
          firmwareVersion: null,
          temperatureCelsius: null,
          temperatureMinCelsius: null,
          temperatureMaxCelsius: null,
          powerOnHours: null,
          powerCycleCount: null,
          errorCount: null,
          selfTestStatus: null,
          percentageUsed: null,
          availableSparePercent: null,
          availableSpareThresholdPercent: null,
          unsafeShutdowns: null,
          criticalWarning: null,
          dataUnitsRead: null,
          dataUnitsWritten: null,
          hostReadCommands: null,
          hostWriteCommands: null,
          controllerBusyMinutes: null,
          warningTemperatureTimeMinutes: null,
          criticalTemperatureTimeMinutes: null,
          errorLogEntries: null,
          attributes: [],
          selfTests: [],
          message: result.issue?.message ?? null
        });
        return result.issue;
      }
      smartByDevice.set(name, mapSmartSummary(result.value));
      return result.issue;
    })
  );

  return [smartByDevice, compactIssues(results)];
}

function mapSmartSummary(value: unknown): SystemSmartSummary {
  const record = asRecord(value);
  const smartStatus = asRecord(recordField(record, "smart_status"));
  const smartPassed = booleanField(smartStatus, "passed");
  const health: SystemSmartHealth =
    smartPassed === true ? "passed" : smartPassed === false ? "failed" : "unknown";
  const temperature = asRecord(recordField(record, "temperature"));
  const powerOnTime = asRecord(recordField(record, "power_on_time"));
  const ataErrorLog = asRecord(recordField(record, "ata_smart_error_log"));
  const ataErrorSummary = asRecord(recordField(ataErrorLog, "summary"));
  const nvmeLog = asRecord(recordField(record, "nvme_smart_health_information_log"));
  const nvmeTemperature = numberField(nvmeLog, "temperature");
  const currentTemperature = numberField(temperature, "current") ?? nvmeTemperature;
  const nvmeMediaErrors = numberField(nvmeLog, "media_errors");
  const ataErrors = numberField(ataErrorSummary, "count");
  const smartSupport = asRecord(recordField(record, "smart_support"));
  const device = asRecord(recordField(record, "device"));
  const ataSmartData = asRecord(recordField(record, "ata_smart_data"));
  const selfTestStatus = asRecord(recordField(ataSmartData, "self_test", "status"));

  return {
    health,
    available: booleanField(smartSupport, "available"),
    enabled: booleanField(smartSupport, "enabled"),
    protocol: stringField(device, "protocol"),
    firmwareVersion: stringField(record, "firmware_version"),
    temperatureCelsius: celsiusTemperature(currentTemperature),
    temperatureMinCelsius: celsiusTemperature(
      numberField(temperature, "min") ?? numberField(temperature, "lifetime_min")
    ),
    temperatureMaxCelsius: celsiusTemperature(
      numberField(temperature, "max") ?? numberField(temperature, "lifetime_max")
    ),
    powerOnHours: numberField(powerOnTime, "hours"),
    powerCycleCount: numberField(record, "power_cycle_count") ?? numberField(nvmeLog, "power_cycles"),
    errorCount: ataErrors ?? nvmeMediaErrors,
    selfTestStatus: stringField(selfTestStatus, "string"),
    percentageUsed: numberField(nvmeLog, "percentage_used"),
    availableSparePercent: numberField(nvmeLog, "available_spare"),
    availableSpareThresholdPercent: numberField(nvmeLog, "available_spare_threshold"),
    unsafeShutdowns: numberField(nvmeLog, "unsafe_shutdowns"),
    criticalWarning: numberField(nvmeLog, "critical_warning"),
    dataUnitsRead: numberField(nvmeLog, "data_units_read"),
    dataUnitsWritten: numberField(nvmeLog, "data_units_written"),
    hostReadCommands: numberField(nvmeLog, "host_reads"),
    hostWriteCommands: numberField(nvmeLog, "host_writes"),
    controllerBusyMinutes: numberField(nvmeLog, "controller_busy_time"),
    warningTemperatureTimeMinutes: numberField(nvmeLog, "warning_temp_time"),
    criticalTemperatureTimeMinutes: numberField(nvmeLog, "critical_comp_time"),
    errorLogEntries: numberField(nvmeLog, "num_err_log_entries"),
    attributes: mapSmartAttributes(recordField(record, "ata_smart_attributes", "table")),
    selfTests: mapSmartSelfTests(recordField(record, "ata_smart_self_test_log", "standard", "table")),
    message: stringField(record, "smartctl", "exit_status") ?? null
  };
}

function celsiusTemperature(value: number | null): number | null {
  return value !== null && value > 200 ? Math.round(value - 273.15) : value;
}

function mapSmartAttributes(value: unknown): SystemSmartAttribute[] {
  return recordsFrom(value).map((attribute) => {
    const raw = asRecord(recordField(attribute, "raw"));
    const id = numberField(attribute, "id");
    return {
      id,
      name: stringField(attribute, "name") ?? (id === null ? "SMART attribute" : `SMART ${id}`),
      current: numberField(attribute, "value"),
      worst: numberField(attribute, "worst"),
      threshold: numberField(attribute, "thresh"),
      raw: stringField(raw, "string") ?? stringFromNumberField(raw, "value"),
      flags: stringField(asRecord(recordField(attribute, "flags")), "string"),
      whenFailed: stringField(attribute, "when_failed")
    };
  });
}

function mapSmartSelfTests(value: unknown): SystemSmartSelfTest[] {
  return recordsFrom(value).map((test) => ({
    number: numberField(test, "num"),
    type: stringField(asRecord(recordField(test, "type")), "string"),
    status: stringField(asRecord(recordField(test, "status")), "string"),
    remainingPercent: numberField(test, "remaining_percent"),
    lifetimeHours: numberField(test, "lifetime_hours"),
    firstErrorLba: numberField(test, "lba")
  }));
}

function mapStorageDisk(
  device: Record<string, unknown>,
  smartByDevice: Map<string, SystemSmartSummary>
): SystemStorageDisk {
  const name = stringField(device, "name") ?? "";
  const path = stringField(device, "path") ?? (name ? `/dev/${name}` : "");
  const partitions = recordsFrom(recordField(device, "children"))
    .filter((child) => stringField(child, "type") === "part")
    .map((child) => mapStoragePartition(child, name));
  return {
    id: path || name,
    name,
    path,
    model: stringField(device, "model"),
    serial: stringField(device, "serial"),
    transport: stringField(device, "tran"),
    rotational: booleanFromNumberField(device, "rota"),
    sizeBytes: numberField(device, "size"),
    mountpoints: mountpointsFrom(device),
    partitions,
    smart: smartSummaryForDisk(path, name, smartByDevice)
  };
}

function smartSummaryForDisk(
  path: string,
  name: string,
  smartByDevice: Map<string, SystemSmartSummary>
): SystemSmartSummary {
  const nvmeControllerPath = path.match(/^\/dev\/(nvme\d+)n\d+$/u)?.[1];
  return smartByDevice.get(path)
    ?? smartByDevice.get(name)
    ?? (nvmeControllerPath ? smartByDevice.get(`/dev/${nvmeControllerPath}`) : undefined)
    ?? unknownSmart();
}

function mapStoragePartition(
  device: Record<string, unknown>,
  parent: string | null
): SystemStoragePartition {
  const name = stringField(device, "name") ?? "";
  const path = stringField(device, "path") ?? (name ? `/dev/${name}` : "");
  return {
    id: path || name,
    name,
    path,
    parent,
    filesystem: stringField(device, "fstype"),
    label: stringField(device, "label"),
    uuid: stringField(device, "uuid"),
    sizeBytes: numberField(device, "size"),
    mountpoints: mountpointsFrom(device)
  };
}

function flattenMounts(rows: Record<string, unknown>[]): SystemStorageMount[] {
  return rows.flatMap((row) => {
    const mount = mapMount(row);
    return [mount, ...flattenMounts(recordsFrom(recordField(row, "children")))];
  });
}

function mapMount(row: Record<string, unknown>): SystemStorageMount {
  const source = stringField(row, "source") ?? "";
  const target = stringField(row, "target") ?? "";
  return {
    id: `${source}:${target}`,
    source,
    target,
    filesystem: stringField(row, "fstype"),
    totalBytes: numberField(row, "size"),
    usedBytes: numberField(row, "used"),
    availableBytes: numberField(row, "avail"),
    usedPercent: percentFractionField(row, "use%")
  };
}

function mapStoragePool(array: SystemRaidArray, mounts: SystemStorageMount[]): SystemStoragePool {
  const mount = mounts.find((candidate) => storageDevicePathsEqual(candidate.source, array.path)) ?? null;
  return {
    id: mount?.target ? path.basename(mount.target) : array.name,
    name: array.name,
    raidPath: array.path,
    raidLevel: array.level,
    status: storagePoolStatus(array),
    mountpoint: mount?.target ?? null,
    filesystem: mount?.filesystem ?? null,
    totalBytes: mount?.totalBytes ?? array.sizeBytes,
    usedBytes: mount?.usedBytes ?? null,
    availableBytes: mount?.availableBytes ?? null,
    usedPercent: mount?.usedPercent ?? null,
    memberDevices: array.memberDevices
  };
}

function storageDevicePathsEqual(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    // Test doubles and offline arrays may not have device nodes to resolve.
    return false;
  }
}

function storagePoolStatus(array: SystemRaidArray): SystemStoragePool["status"] {
  if ((array.failedDevices ?? 0) > 0) {
    return "warning";
  }
  const state = array.state?.toLowerCase() ?? "";
  if (state.includes("clean") || state.includes("active")) {
    return "ready";
  }
  if (state.includes("inactive") || state.includes("stopped")) {
    return "offline";
  }
  return "unknown";
}

function storageMetrics(
  pools: SystemStoragePool[],
  arrays: SystemRaidArray[],
  disks: SystemStorageDisk[]
): SystemStorageSummary["metrics"] {
  const poolTotals = sumNullable(pools.map((pool) => pool.totalBytes));
  const diskTotals = sumNullable(disks.map((disk) => disk.sizeBytes));
  const poolUsed = sumNullable(pools.map((pool) => pool.usedBytes));
  const poolAvailable = sumNullable(pools.map((pool) => pool.availableBytes));
  return {
    pools: pools.length,
    arrays: arrays.length,
    disks: disks.length,
    totalBytes: poolTotals ?? diskTotals,
    usedBytes: poolUsed,
    availableBytes: poolAvailable,
    smartPassed: disks.filter((disk) => disk.smart.health === "passed").length,
    smartFailed: disks.filter((disk) => disk.smart.health === "failed" || disk.smart.health === "error").length,
    smartUnknown: disks.filter((disk) => disk.smart.health === "unknown").length
  };
}

function unknownSmart(): SystemSmartSummary {
  return {
    health: "unknown",
    available: null,
    enabled: null,
    protocol: null,
    firmwareVersion: null,
    temperatureCelsius: null,
    temperatureMinCelsius: null,
    temperatureMaxCelsius: null,
    powerOnHours: null,
    powerCycleCount: null,
    errorCount: null,
    selfTestStatus: null,
    percentageUsed: null,
    availableSparePercent: null,
    availableSpareThresholdPercent: null,
    unsafeShutdowns: null,
    criticalWarning: null,
    dataUnitsRead: null,
    dataUnitsWritten: null,
    hostReadCommands: null,
    hostWriteCommands: null,
    controllerBusyMinutes: null,
    warningTemperatureTimeMinutes: null,
    criticalTemperatureTimeMinutes: null,
    errorLogEntries: null,
    attributes: [],
    selfTests: [],
    message: null
  };
}

function collectionStatus(hasData: boolean, issues: SystemCollectionIssue[]): SystemCollectionStatus {
  if (!hasData) {
    return "unavailable";
  }
  return issues.length ? "partial" : "ready";
}

function mountpointsFrom(record: Record<string, unknown>): string[] {
  const mountpoints = recordField(record, "mountpoints");
  if (Array.isArray(mountpoints)) {
    return mountpoints.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }
  const mountpoint = stringField(record, "mountpoint");
  return mountpoint ? [mountpoint] : [];
}

function mdadmSizeBytes(value: string | null): number | null {
  const parsed = integerFromText(value);
  return parsed === null ? null : parsed * 1024;
}

function integerFromText(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = value.match(/\d+/u);
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function keyValueTokens(tokens: string[]): Map<string, string> {
  return new Map(
    tokens
      .map((token) => {
        const [key, ...value] = token.split("=");
        return key ? ([key, value.join("=")] as const) : null;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null)
  );
}

function compactIssues(issues: Array<SystemCollectionIssue | null | undefined>): SystemCollectionIssue[] {
  return issues.filter((issue): issue is SystemCollectionIssue => Boolean(issue));
}

function recordsFrom(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(record: Record<string, unknown> | null, ...keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return current;
}

function stringField(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  const value = recordField(record, ...keys);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(record: Record<string, unknown> | null, ...keys: string[]): number | null {
  const value = recordField(record, ...keys);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringFromNumberField(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  const value = numberField(record, ...keys);
  return value === null ? null : String(value);
}

function booleanField(record: Record<string, unknown> | null, ...keys: string[]): boolean | null {
  const value = recordField(record, ...keys);
  return typeof value === "boolean" ? value : null;
}

function stringArrayField(record: Record<string, unknown> | null, ...keys: string[]): string[] {
  const value = recordField(record, ...keys);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function booleanFromNumberField(record: Record<string, unknown>, key: string): boolean | null {
  const raw = recordField(record, key);
  if (typeof raw === "boolean") {
    return raw;
  }
  const value = numberField(record, key);
  return value === null ? null : value !== 0;
}

function percentFractionField(record: Record<string, unknown>, key: string): number | null {
  const raw = recordField(record, key);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1 ? raw / 100 : raw;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = Number(raw.replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed / 100 : null;
}

function sumNullable(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number");
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

function hasName(entry: [string | null, Record<string, unknown>]): entry is [string, Record<string, unknown>] {
  return Boolean(entry[0]);
}

function errorStdout(error: unknown): string {
  const candidate = error as { stdout?: unknown };
  return typeof candidate.stdout === "string" ? candidate.stdout : "";
}

function safeSystemMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/(psk|password|secret|token)\s*[:=]\s*[^\s,;}]+/giu, "$1=[redacted]")
    .slice(0, 500);
}
