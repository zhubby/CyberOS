import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  SystemNetworkBackend,
  SystemWifiAccessPoint,
  SystemWifiConnectInput,
  SystemWifiDevice,
  SystemWifiHotspotActionInput,
  SystemWifiHotspotUpdateInput,
  SystemWifiOperationResult,
  SystemWifiProfile,
  SystemWifiProfileUpdateInput,
  SystemWifiRadioInput,
  SystemWifiScanInput,
  SystemWifiScanResult,
  SystemWifiSecurity,
  SystemWifiStatus,
  SystemWifiSummary,
  HostdNetworkMutationRequest,
  HostdRequest,
  HostdResult
} from "@zos/shared";
import type { SystemCommandRunner } from "./system-management.js";
import { HostdClient, HostdRequestError } from "./hostd-client.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5_000;
const HOSTD_TIMEOUT_MS = 35_000;

interface ManagedProfileInspection {
  id: string;
  name: string;
  ssid: string;
  device: string | null;
  security: SystemWifiSecurity;
  mode: "client" | "hotspot";
  band: "auto" | "2.4" | "5";
  channel: number | null;
  autoconnect: boolean;
  credentialConfigured: boolean;
  revision: string;
}

interface HostdInspection {
  profiles: ManagedProfileInspection[];
  recovery: Record<string, { restoreProfileId: string | null; hotspotProfileId: string }>;
}

interface HostdMutationResult {
  rollback: SystemWifiOperationResult["rollback"];
  message: string | null;
}

export interface NetworkManagerHostdClient {
  ping(): Promise<boolean>;
  inspect(): Promise<HostdInspection>;
  scan(input: SystemWifiScanInput): Promise<SystemWifiScanResult>;
  mutate(payload: HostdNetworkMutationRequest): Promise<HostdMutationResult>;
}

export interface NetworkManagerRuntime {
  getStatus(): Promise<SystemWifiStatus>;
  getSummary(): Promise<SystemWifiSummary>;
  scan(input: SystemWifiScanInput): Promise<SystemWifiScanResult>;
  connect(input: SystemWifiConnectInput): Promise<SystemWifiOperationResult>;
  disconnect(input: { device: string; confirmed: boolean }): Promise<SystemWifiOperationResult>;
  setRadio(input: SystemWifiRadioInput): Promise<SystemWifiOperationResult>;
  updateProfile(profileId: string, input: SystemWifiProfileUpdateInput): Promise<SystemWifiOperationResult>;
  deleteProfile(profileId: string, confirmed: boolean): Promise<SystemWifiOperationResult>;
  updateHotspot(input: SystemWifiHotspotUpdateInput): Promise<SystemWifiOperationResult>;
  startHotspot(input: SystemWifiHotspotActionInput): Promise<SystemWifiOperationResult>;
  stopHotspot(input: SystemWifiHotspotActionInput): Promise<SystemWifiOperationResult>;
  deleteHotspot(input: SystemWifiHotspotActionInput): Promise<SystemWifiOperationResult>;
}

export interface SystemNetworkManagerRuntimeOptions {
  commandRunner?: SystemCommandRunner;
  hostd?: NetworkManagerHostdClient;
  hostdSocketPath: string;
}

export class NetworkManagerRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly rollback: SystemWifiOperationResult["rollback"] = "not_required"
  ) {
    super(message);
    this.name = "NetworkManagerRequestError";
  }
}

class NodeNetworkCommandRunner implements SystemCommandRunner {
  async run(command: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    });
    return stdout;
  }
}

export class HostdNetworkManagerClient implements NetworkManagerHostdClient {
  private readonly client: HostdClient;

  constructor(socketPath: string) {
    this.client = new HostdClient(socketPath);
  }

  async ping(): Promise<boolean> {
    await this.request({ action: "ping" });
    return true;
  }

  inspect(): Promise<HostdInspection> {
    return this.request({ action: "inspect" });
  }

  scan(input: SystemWifiScanInput): Promise<SystemWifiScanResult> {
    return this.request({ action: "scan", input });
  }

  mutate(payload: HostdNetworkMutationRequest): Promise<HostdMutationResult> {
    return this.request(payload);
  }

  async request<Request extends HostdRequest<"network.manager">>(
    payload: Request
  ): Promise<HostdResult<"network.manager", Request>> {
    try {
      return await this.client.request("network.manager", payload, HOSTD_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof HostdRequestError) {
        throw new NetworkManagerRequestError(
          safeNetworkManagerMessage(error),
          error.statusCode,
          validRollback(error.details.rollback) ? error.details.rollback : "not_required"
        );
      }
      throw new NetworkManagerRequestError("hostd is unavailable", 503);
    }
  }
}

export class SystemNetworkManagerRuntime implements NetworkManagerRuntime {
  private readonly commandRunner: SystemCommandRunner;
  private readonly hostd: NetworkManagerHostdClient;

  constructor(options: SystemNetworkManagerRuntimeOptions) {
    this.commandRunner = options.commandRunner ?? new NodeNetworkCommandRunner();
    this.hostd = options.hostd ?? new HostdNetworkManagerClient(options.hostdSocketPath);
  }

  async getStatus(): Promise<SystemWifiStatus> {
    const [inspection, managementDevices] = await Promise.all([
      this.hostd.inspect().catch(() => null),
      collectDefaultRouteDevices(this.commandRunner)
    ]);
    return collectNetworkManagerStatus(this.commandRunner, inspection, managementDevices);
  }

  async getSummary(): Promise<SystemWifiSummary> {
    const [inspection, managementDevices] = await Promise.all([
      this.hostd.inspect().catch(() => null),
      collectDefaultRouteDevices(this.commandRunner)
    ]);
    const status = await collectNetworkManagerStatus(this.commandRunner, inspection, managementDevices);
    if (status.backend !== "NetworkManager") return { ...status, profiles: [] };
    const profiles = await collectWifiProfiles(this.commandRunner, inspection, status.devices);
    return { ...status, profiles };
  }

  async scan(input: SystemWifiScanInput): Promise<SystemWifiScanResult> {
    validateDevice(input.device);
    const result = await this.hostd.scan({ device: input.device });
    const summary = await this.getSummary();
    return {
      ...result,
      accessPoints: result.accessPoints.map((accessPoint) => ({
        ...accessPoint,
        savedProfileId:
          summary.profiles.find(
            (profile) => profile.ssid === accessPoint.ssid && compatibleSecurity(profile.security, accessPoint.security)
          )?.id ?? null
      }))
    };
  }

  connect(input: SystemWifiConnectInput): Promise<SystemWifiOperationResult> {
    validateDevice(input.device);
    return this.mutate({ action: "connect", input });
  }

  disconnect(input: { device: string; confirmed: boolean }): Promise<SystemWifiOperationResult> {
    validateDevice(input.device);
    return this.mutate({ action: "disconnect", input });
  }

  setRadio(input: SystemWifiRadioInput): Promise<SystemWifiOperationResult> {
    return this.mutate({ action: "radio", input });
  }

  updateProfile(profileId: string, input: SystemWifiProfileUpdateInput): Promise<SystemWifiOperationResult> {
    return this.mutate({ action: "update_profile", profileId, input });
  }

  deleteProfile(profileId: string, confirmed: boolean): Promise<SystemWifiOperationResult> {
    return this.mutate({ action: "delete_profile", profileId, confirmed });
  }

  updateHotspot(input: SystemWifiHotspotUpdateInput): Promise<SystemWifiOperationResult> {
    validateDevice(input.device);
    return this.mutate({ action: "update_hotspot", input });
  }

  startHotspot(input: SystemWifiHotspotActionInput): Promise<SystemWifiOperationResult> {
    validateDevice(input.device);
    return this.mutate({ action: "start_hotspot", input });
  }

  stopHotspot(input: SystemWifiHotspotActionInput): Promise<SystemWifiOperationResult> {
    validateDevice(input.device);
    return this.mutate({ action: "stop_hotspot", input });
  }

  deleteHotspot(input: SystemWifiHotspotActionInput): Promise<SystemWifiOperationResult> {
    validateDevice(input.device);
    return this.mutate({ action: "delete_hotspot", input });
  }

  private async mutate(payload: HostdNetworkMutationRequest): Promise<SystemWifiOperationResult> {
    const result = await this.hostd.mutate(payload);
    return {
      status: await this.getStatus(),
      rollback: result.rollback,
      message: result.message
    };
  }
}

export async function collectNetworkManagerStatus(
  runner: SystemCommandRunner,
  inspection: HostdInspection | null,
  managementDevices: Set<string> = new Set()
): Promise<SystemWifiStatus> {
  const collectedAt = new Date().toISOString();
  let general: string;
  try {
    general = await runner.run("nmcli", ["--terse", "--escape", "yes", "--fields", "RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI", "general"]);
  } catch {
    return unavailableWifiStatus(collectedAt, await detectFallbackBackend(runner), false);
  }
  if (!general.toLowerCase().includes("running")) {
    return unavailableWifiStatus(collectedAt, "unknown", inspection !== null);
  }
  const generalFields = splitNmcliLine(general.trim());
  const radioEnabled = generalFields.at(-1)?.toLowerCase() === "enabled";
  const output = await runner.run("nmcli", [
    "--terse",
    "--escape",
    "yes",
    "--fields",
    "DEVICE,TYPE,STATE,CONNECTION,CON-UUID",
    "device",
    "status"
  ]);
  const rows = output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(splitNmcliLine)
    .filter((fields) => fields[1] === "wifi" || fields[1] === "802-11-wireless");
  const activeAccessPoints = await collectActiveAccessPoints(runner);
  const hotspots = inspection?.profiles.filter((profile) => profile.mode === "hotspot") ?? [];
  const devices = await Promise.all(
    rows.map(async (fields): Promise<SystemWifiDevice> => {
      const name = fields[0] ?? "";
      const activeId = validUuid(fields[4]) ? fields[4]! : null;
      const hotspot = hotspots.find((profile) => profile.id === activeId);
      const accessPoint = activeAccessPoints.get(name) ?? null;
      return {
        id: name,
        name,
        mac: await deviceMac(name),
        driver: await deviceDriver(name),
        state: normalizeDeviceState(fields[2] ?? "", Boolean(hotspot)),
        mode: hotspot ? "hotspot" : activeId ? "client" : "idle",
        activeConnectionId: activeId,
        activeConnectionName: normalizedNullable(fields[3]),
        ssid: hotspot?.ssid ?? accessPoint?.ssid ?? null,
        signal: accessPoint?.signal ?? null,
        frequencyMHz: accessPoint?.frequencyMHz ?? null,
        channel: accessPoint?.channel ?? hotspot?.channel ?? null,
        managementPath: managementDevices.has(name),
        capabilities: await collectDeviceCapabilities(name, runner)
      };
    })
  );
  return {
    collectedAt,
    backend: "NetworkManager",
    radioEnabled,
    hostdReady: inspection !== null,
    devices,
    hotspots: hotspots.map((profile) => ({
      device: profile.device ?? "",
      profileId: profile.id,
      ssid: profile.ssid,
      band: profile.band,
      channel: profile.channel,
      autostart: profile.autoconnect,
      active: devices.some((device) => device.activeConnectionId === profile.id),
      credentialConfigured: profile.credentialConfigured,
      revision: profile.revision,
      restoreProfileId: profile.device ? inspection?.recovery[profile.device]?.restoreProfileId ?? null : null
    }))
  };
}

export function parseWifiScanOutput(output: string): SystemWifiAccessPoint[] {
  return output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(splitNmcliLine)
    .filter((fields) => fields.length >= 8 && fields[1])
    .map((fields) => {
      const channel = numeric(fields[4]) ?? 0;
      const frequencyMHz = parseNmcliFrequency(fields[5]) ?? 0;
      return {
        active: fields[0] === "*" || fields[0] === "yes",
        ssid: fields[1]!,
        bssid: fields[2]!,
        channel,
        frequencyMHz,
        signal: Math.min(100, Math.max(0, numeric(fields[6]) ?? 0)),
        band: wifiBand(frequencyMHz, channel),
        security: securityFromNmcli(fields[7] ?? ""),
        savedProfileId: null
      };
    });
}

export function safeNetworkManagerMessage(error: unknown): string {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "NetworkManager request failed";
  return message
    .replace(/(psk|password|secret|token)\s*[:=]\s*[^\s,;}]+/giu, "$1=[redacted]")
    .slice(0, 500);
}

async function collectWifiProfiles(
  runner: SystemCommandRunner,
  inspection: HostdInspection | null,
  devices: SystemWifiDevice[]
): Promise<SystemWifiProfile[]> {
  const output = await runner.run("nmcli", [
    "--terse",
    "--escape",
    "yes",
    "--fields",
    "NAME,UUID,TYPE,AUTOCONNECT,DEVICE,FILENAME",
    "connection",
    "show"
  ]);
  const managed = new Map((inspection?.profiles ?? []).map((profile) => [profile.id, profile]));
  const rows = output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(splitNmcliLine)
    .filter((fields) => (fields[2] === "wifi" || fields[2] === "802-11-wireless") && validUuid(fields[1]))
    .filter((fields) => managed.get(fields[1]!)?.mode !== "hotspot");
  const profiles = await Promise.all(
    rows.map(async (fields): Promise<SystemWifiProfile | null> => {
      const id = fields[1]!;
      const detail = managed.get(id);
      const external = detail ? null : await collectExternalWifiProfile(runner, id);
      if (external?.mode === "ap") return null;
      const device = normalizedNullable(fields[4]);
      return {
        id,
        name: detail?.name ?? fields[0] ?? id,
        ssid: detail?.ssid ?? external?.ssid ?? fields[0] ?? "",
        device: detail?.device ?? device,
        security: detail?.security ?? external?.security ?? "unsupported",
        autoconnect: detail?.autoconnect ?? fields[3] === "yes",
        active: devices.some((candidate) => candidate.activeConnectionId === id),
        managed: Boolean(detail),
        credentialConfigured: detail?.credentialConfigured ?? Boolean(external),
        revision: detail?.revision ?? null
      };
    })
  );
  return profiles.filter((profile): profile is SystemWifiProfile => profile !== null);
}

async function collectExternalWifiProfile(
  runner: SystemCommandRunner,
  profileId: string
): Promise<{ ssid: string; mode: string; security: SystemWifiSecurity } | null> {
  try {
    const output = await runner.run("nmcli", [
      "--get-values",
      "802-11-wireless.ssid,802-11-wireless.mode,802-11-wireless-security.key-mgmt",
      "connection",
      "show",
      "uuid",
      profileId
    ]);
    const [ssid = "", mode = "", keyManagement = ""] = output.split(/\r?\n/u);
    return {
      ssid: ssid || profileId,
      mode,
      security: securityFromKeyManagement(keyManagement)
    };
  } catch {
    return null;
  }
}

async function collectActiveAccessPoints(runner: SystemCommandRunner): Promise<Map<string, SystemWifiAccessPoint>> {
  try {
    const output = await runner.run("nmcli", [
      "--terse",
      "--escape",
      "yes",
      "--fields",
      "DEVICE,IN-USE,SSID,BSSID,CHAN,FREQ,SIGNAL,SECURITY",
      "device",
      "wifi",
      "list",
      "--rescan",
      "no"
    ]);
    const result = new Map<string, SystemWifiAccessPoint>();
    for (const fields of output.split(/\r?\n/u).filter(Boolean).map(splitNmcliLine)) {
      if (fields[1] !== "*" && fields[1] !== "yes") continue;
      const channel = numeric(fields[4]) ?? 0;
      const frequencyMHz = parseNmcliFrequency(fields[5]) ?? 0;
      result.set(fields[0]!, {
        active: true,
        ssid: fields[2] ?? "",
        bssid: fields[3] ?? "",
        channel,
        frequencyMHz,
        signal: Math.min(100, Math.max(0, numeric(fields[6]) ?? 0)),
        band: wifiBand(frequencyMHz, channel),
        security: securityFromNmcli(fields[7] ?? ""),
        savedProfileId: null
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

async function collectDeviceCapabilities(
  device: string,
  runner: SystemCommandRunner
): Promise<SystemWifiDevice["capabilities"]> {
  let accessPoint = false;
  const bands: Array<"2.4" | "5"> = [];
  try {
    const output = await runner.run("nmcli", [
      "--get-values",
      "WIFI-PROPERTIES.AP,WIFI-PROPERTIES.2GHZ,WIFI-PROPERTIES.5GHZ",
      "device",
      "show",
      device
    ]);
    const values = output.split(/\r?\n/u).map((value) => value.trim().toLowerCase());
    accessPoint = values[0] === "yes";
    if (values[1] === "yes") bands.push("2.4");
    if (values[2] === "yes") bands.push("5");
  } catch {
    // Keep the device visible when NetworkManager cannot expose capability fields.
  }
  return { accessPoint, bands, channels: await collectSupportedChannels(device, runner) };
}

async function collectSupportedChannels(device: string, runner: SystemCommandRunner): Promise<number[]> {
  try {
    const info = await runner.run("iw", ["dev", device, "info"]);
    const wiphy = /wiphy\s+(\d+)/u.exec(info)?.[1];
    if (!wiphy) return [];
    const phy = await runner.run("iw", ["phy", `phy${wiphy}`, "info"]);
    return [...phy.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])).filter((channel) => Number.isInteger(channel));
  } catch {
    return [];
  }
}

async function collectDefaultRouteDevices(runner: SystemCommandRunner): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await runner.run("ip", ["-j", "route"])) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter(isRecord)
        .filter((route) => route.dst === "default" && typeof route.dev === "string")
        .map((route) => route.dev as string)
    );
  } catch {
    return new Set();
  }
}

async function detectFallbackBackend(runner: SystemCommandRunner): Promise<SystemNetworkBackend> {
  try {
    const state = (await runner.run("systemctl", ["is-active", "systemd-networkd.service"])).trim();
    return state === "active" ? "systemd-networkd" : "unknown";
  } catch {
    return "unknown";
  }
}

async function deviceMac(device: string): Promise<string | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(`/sys/class/net/${device}/address`, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

async function deviceDriver(device: string): Promise<string | null> {
  try {
    return path.basename(await readlink(`/sys/class/net/${device}/device/driver`));
  } catch {
    return null;
  }
}

function unavailableWifiStatus(
  collectedAt: string,
  backend: SystemNetworkBackend,
  hostdReady: boolean
): SystemWifiStatus {
  return { collectedAt, backend, radioEnabled: null, hostdReady, devices: [], hotspots: [] };
}

function normalizeDeviceState(value: string, hotspot: boolean): SystemWifiDevice["state"] {
  if (hotspot) return "hotspot";
  const state = value.toLowerCase();
  if (state.includes("connecting") || state.includes("prepare") || state.includes("config")) return "connecting";
  if (state.includes("disconnected") || state.includes("unavailable")) return state.includes("unavailable") ? "unavailable" : "disconnected";
  if (state.includes("connected")) return "connected";
  return "disconnected";
}

function securityFromNmcli(value: string): SystemWifiSecurity {
  const normalized = value.toUpperCase();
  if (!normalized || normalized === "--") return "open";
  if (normalized.includes("WEP") || normalized.includes("802.1X")) return "unsupported";
  if (normalized.includes("SAE") && !normalized.includes("WPA2")) return "wpa3";
  return normalized.includes("WPA") ? "wpa2" : "unsupported";
}

function securityFromKeyManagement(value: string): SystemWifiSecurity {
  const normalized = value.toLowerCase();
  if (!normalized || normalized === "--") return "open";
  if (normalized.includes("wpa-psk")) return "wpa2";
  if (normalized.includes("sae")) return "wpa3";
  return "unsupported";
}

function compatibleSecurity(left: SystemWifiSecurity, right: SystemWifiSecurity): boolean {
  return left === right || (left === "wpa2" && right === "wpa3");
}

function splitNmcliLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ":") {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}

function numeric(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNmcliFrequency(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+)(?:\s+MHz)?\s*$/iu.exec(value);
  return match ? numeric(match[1]) : null;
}

function wifiBand(frequencyMHz: number, channel: number): "2.4" | "5" {
  return frequencyMHz >= 4900 || (frequencyMHz === 0 && channel > 14) ? "5" : "2.4";
}

function normalizedNullable(value: string | undefined): string | null {
  return value && value !== "--" ? value : null;
}

function validateDevice(device: string): void {
  if (!/^[a-zA-Z0-9_.:-]{1,32}$/u.test(device)) {
    throw new NetworkManagerRequestError("Invalid wireless device", 400);
  }
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function validRollback(value: unknown): value is SystemWifiOperationResult["rollback"] {
  return value === "not_required" || value === "succeeded" || value === "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
