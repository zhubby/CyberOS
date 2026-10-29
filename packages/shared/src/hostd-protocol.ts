import type {
  HostdEthernetApplyTransaction,
  HostdEthernetStatus,
  HostdDockerDaemonSnapshot,
  HostdDockerDaemonUpdateResult,
  HostdBluetoothManagerResult,
  HostdNetworkInspectionResult as GeneratedNetworkInspectionResult,
  HostdNetworkMutationResult,
  HostdNetworkProfileInspection as GeneratedNetworkProfileInspection,
  HostdNetworkScanResult as GeneratedNetworkScanResult,
  HostdOperation,
  HostdRequestContract,
  HostdResultContract
} from "./generated/hostd.js";
import type {
  DockerDaemonConfigSnapshot,
  DockerDaemonConfigUpdateResult,
  SystemEthernetApplyTransaction,
  SystemEthernetConfig,
  SystemEthernetStatus,
  SystemWifiBand,
  SystemWifiScanResult,
  SystemWifiSecurity,
  BluetoothStatus
} from "./types.js";
import { parseIscsiSummary, type IscsiSummary } from "./iscsi.js";

export type { HostdOperation, HostdRequestContract, HostdResultContract } from "./generated/hostd.js";

export type HostdRequest<Operation extends HostdOperation> =
  Operation extends HostdOperation
    ? Extract<HostdRequestContract, { operation: Operation }>["payload"]
    : never;
export type HostdNetworkMutationRequest = Exclude<HostdRequest<"network.manager">, {
  action: "ping" | "inspect" | "scan" | "ethernet_status" | "ethernet_save" | "ethernet_apply" | "ethernet_confirm" | "ethernet_rollback";
}>;

type HostdOperationResult<Operation extends HostdOperation> =
  Operation extends HostdOperation
    ? Extract<HostdResultContract, { operation: Operation }>["result"]
    : never;
type HostdShareApplyResult = HostdOperationResult<"shares.apply">;
type HostdStorageCommandResult = HostdOperationResult<"storage.command">;
type HostdStorageOperationResult = HostdOperationResult<"storage.operation">;
type HostdPowerResult = HostdOperationResult<"system.power">;
type HostdOpsResult = HostdOperationResult<"system.ops">;
type HostdTvResult = HostdOperationResult<"system.tv">;

type HostdNetworkProfileInspection = Omit<GeneratedNetworkProfileInspection, "security" | "mode" | "band"> & {
  security: SystemWifiSecurity;
  mode: "client" | "hotspot";
  band: SystemWifiBand;
};

export type HostdNetworkInspectionResult = Omit<GeneratedNetworkInspectionResult, "profiles"> & {
  profiles: HostdNetworkProfileInspection[];
};

type HostdNetworkResult<Request> = Request extends { action: "ping" }
  ? { ready: true }
  : Request extends { action: "inspect" }
    ? HostdNetworkInspectionResult
    : Request extends { action: "scan" }
      ? GeneratedNetworkScanResult & SystemWifiScanResult
      : Request extends { action: "ethernet_status" | "ethernet_save" }
        ? HostdEthernetStatus & SystemEthernetStatus
        : Request extends { action: "ethernet_apply" | "ethernet_confirm" | "ethernet_rollback" }
          ? HostdEthernetApplyTransaction & SystemEthernetApplyTransaction
          : HostdNetworkMutationResult;

type HostdDockerResult<Request> = Request extends { action: "read" }
  ? HostdDockerDaemonSnapshot & DockerDaemonConfigSnapshot
  : HostdDockerDaemonUpdateResult & DockerDaemonConfigUpdateResult;

type HostdStorageResult<Request> = Request extends { action: infer Action }
  ? Extract<HostdStorageOperationResult, { action: Action }>
  : never;

export type HostdResult<Operation extends HostdOperation, Request extends HostdRequest<Operation>> =
  Operation extends "shares.apply" ? HostdShareApplyResult
    : Operation extends "storage.command" ? HostdStorageCommandResult
      : Operation extends "storage.operation" ? HostdStorageResult<Request>
        : Operation extends "iscsi.manager" ? IscsiSummary
            : Operation extends "docker.daemon" ? HostdDockerResult<Request>
              : Operation extends "network.manager" ? HostdNetworkResult<Request>
                : Operation extends "bluetooth.manager" ? HostdBluetoothManagerResult
                : Operation extends "system.power" ? HostdPowerResult
                : Operation extends "system.ops" ? HostdOpsResult
                  : Operation extends "system.tv" ? HostdTvResult
                : never;

export function parseHostdResult<
  Operation extends HostdOperation,
  Request extends HostdRequest<Operation>
>(operation: Operation, request: Request, value: unknown): HostdResult<Operation, Request> | null {
  let parsed: unknown = null;
  switch (operation) {
    case "shares.apply":
      parsed = parseShareResult(value);
      break;
    case "storage.command":
      parsed = parseStorageCommandResult(value);
      break;
    case "storage.operation":
      parsed = parseStorageOperationResult(request, value);
      break;
    case "iscsi.manager":
      parsed = parseIscsiSummary(value);
      break;
    case "docker.daemon":
      parsed = parseDockerResult(request, value);
      break;
    case "network.manager":
      parsed = parseNetworkResult(request, value);
      break;
    case "bluetooth.manager":
      parsed = parseBluetoothStatus(value);
      break;
    case "system.power":
      parsed = parsePowerResult(request, value);
      break;
    case "system.ops":
      parsed = parseOpsResult(request, value);
      break;
    case "system.tv":
      parsed = parseTvResult(request, value);
      break;
  }
  return parsed as HostdResult<Operation, Request> | null;
}

export function parseBluetoothStatus(value: unknown): BluetoothStatus | null {
  if (!isRecordWithKeys(value, ["collectedAt", "backend", "available", "adapters", "devices", "scan", "challenge", "error"])) return null;
  if (typeof value.collectedAt !== "string" || (value.backend !== "BlueZ" && value.backend !== "unknown")
    || typeof value.available !== "boolean" || !Array.isArray(value.adapters) || !value.adapters.every(isBluetoothAdapter)
    || !Array.isArray(value.devices) || !value.devices.every(isBluetoothDevice)
    || !isBluetoothScan(value.scan) || (value.challenge !== null && !isBluetoothChallenge(value.challenge))
    || !isNullableString(value.error)) return null;
  return value as unknown as BluetoothStatus;
}

function isBluetoothAdapter(value: unknown): boolean {
  if (!isRecordWithKeys(value, ["id", "address", "name", "alias", "state", "powered", "discovering", "defaultAdapter"])) return false;
  return typeof value.id === "string" && /^adapter-[a-z0-9_.:-]{1,64}$/u.test(value.id)
    && isBluetoothAddress(value.address) && typeof value.name === "string" && typeof value.alias === "string"
    && ["powered", "off", "unavailable"].includes(String(value.state)) && typeof value.powered === "boolean"
    && typeof value.discovering === "boolean" && typeof value.defaultAdapter === "boolean";
}

function isBluetoothDevice(value: unknown): boolean {
  if (!isRecordWithKeys(value, ["adapterId", "address", "name", "alias", "type", "rssi", "paired", "trusted", "connected", "servicesResolved", "lastSeenAt"])) return false;
  return typeof value.adapterId === "string" && /^adapter-[a-z0-9_.:-]{1,64}$/u.test(value.adapterId)
    && isBluetoothAddress(value.address) && isNullableString(value.name) && isNullableString(value.alias)
    && ["unknown", "phone", "computer", "headset", "speaker", "keyboard", "mouse", "gamepad", "wearable"].includes(String(value.type))
    && (value.rssi === null || isIntegerInRange(value.rssi, -127, 20)) && typeof value.paired === "boolean"
    && typeof value.trusted === "boolean" && typeof value.connected === "boolean"
    && typeof value.servicesResolved === "boolean" && isNullableString(value.lastSeenAt);
}

function isBluetoothScan(value: unknown): boolean {
  return isRecordWithKeys(value, ["active", "adapterId", "startedAt", "endsAt"])
    && typeof value.active === "boolean" && (value.adapterId === null || typeof value.adapterId === "string")
    && isNullableString(value.startedAt) && isNullableString(value.endsAt);
}

function isBluetoothChallenge(value: unknown): boolean {
  if (!isRecordWithKeys(value, ["id", "adapterId", "deviceAddress", "kind", "pin", "passkey", "entered", "expiresAt"])) return false;
  const kind = String(value.kind);
  const pin = value.pin;
  const passkey = value.passkey;
  const entered = value.entered;
  const shapeMatchesKind = kind === "pin_display"
    ? typeof pin === "string" && /^[a-z0-9]{1,16}$/iu.test(pin) && passkey === null && entered === null
    : kind === "passkey_display"
      ? pin === null && isIntegerInRange(passkey, 0, 999999) && isIntegerInRange(entered, 0, 6)
      : pin === null && entered === null && (kind === "numeric_comparison" ? isIntegerInRange(passkey, 0, 999999) : passkey === null);
  return typeof value.id === "string" && /^[a-f0-9-]{16,64}$/iu.test(value.id)
    && typeof value.adapterId === "string" && /^adapter-[a-z0-9_.:-]{1,64}$/u.test(value.adapterId)
    && isBluetoothAddress(value.deviceAddress)
    && ["pin", "numeric_comparison", "confirmation", "pin_display", "passkey_display"].includes(String(value.kind))
    && shapeMatchesKind
    && isRfc3339Timestamp(value.expiresAt);
}

function isBluetoothAddress(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(value);
}

function parseShareResult(value: unknown): HostdShareApplyResult | null {
  if (!isRecordWithKeys(value, ["appliedAt", "files", "services"]) || typeof value.appliedAt !== "string") return null;
  if (!isStringArray(value.files) || !isStringArray(value.services)) return null;
  return value as HostdShareApplyResult;
}

function parseStorageCommandResult(value: unknown): HostdStorageCommandResult | null {
  return isRecordWithKeys(value, ["stdout"]) && typeof value.stdout === "string"
    ? { stdout: value.stdout }
    : null;
}

function parseStorageOperationResult(request: unknown, value: unknown): HostdStorageOperationResult | null {
  if (!isRecord(request) || !isRecord(value) || request.action !== value.action) return null;
  if (value.action === "create_pool") {
    if (!isRecordWithKeys(value, ["action", "name", "raidLevel", "devices", "filesystem", "mountpoint", "mdDevice", "uuid"])) return null;
    return typeof value.name === "string" && typeof value.raidLevel === "string" && isStringArray(value.devices)
      && typeof value.filesystem === "string" && typeof value.mountpoint === "string"
      && typeof value.mdDevice === "string" && typeof value.uuid === "string"
      ? value as HostdStorageOperationResult : null;
  }
  if (value.action === "delete_pool") {
    if (!isRecordWithKeys(value, ["action", "name", "mountpoint", "mdDevice", "devices"])) return null;
    return typeof value.name === "string" && typeof value.mountpoint === "string"
      && typeof value.mdDevice === "string" && isStringArray(value.devices)
      ? value as HostdStorageOperationResult : null;
  }
  return null;
}

function parseDockerResult(request: unknown, value: unknown): HostdDockerDaemonSnapshot | HostdDockerDaemonUpdateResult | null {
  if (!isRecord(request)) return null;
  if (request.action === "read") return parseDockerSnapshot(value);
  if (request.action !== "update" || !isRecordWithKeys(value, ["snapshot", "restarted", "rollback", "error"])) return null;
  const snapshot = parseDockerSnapshot(value.snapshot);
  if (!snapshot || typeof value.restarted !== "boolean" || !isRollback(value.rollback) || !isNullableString(value.error)) return null;
  return { snapshot, restarted: value.restarted, rollback: value.rollback, error: value.error };
}

function parseDockerSnapshot(value: unknown): HostdDockerDaemonSnapshot | null {
  if (!isRecordWithKeys(value, ["path", "content", "revision", "exists", "restartPending"])) return null;
  return value.path === "/etc/docker/daemon.json" && typeof value.content === "string"
    && typeof value.revision === "string" && typeof value.exists === "boolean"
    && typeof value.restartPending === "boolean" ? value as HostdDockerDaemonSnapshot : null;
}

function parseNetworkResult(request: unknown, value: unknown): unknown {
  if (!isRecord(request)) return null;
  if (request.action === "ping") {
    return isRecordWithKeys(value, ["ready"]) && value.ready === true ? { ready: true } : null;
  }
  if (request.action === "inspect") return parseNetworkInspection(value);
  if (request.action === "scan") return parseNetworkScan(value);
  if (request.action === "ethernet_status" || request.action === "ethernet_save") return parseEthernetStatus(value);
  if (request.action === "ethernet_apply" || request.action === "ethernet_confirm" || request.action === "ethernet_rollback") {
    return parseEthernetTransaction(value);
  }
  if (!isRecordWithKeys(value, ["rollback", "message"]) || !isRollback(value.rollback) || !isNullableString(value.message)) return null;
  return { rollback: value.rollback, message: value.message };
}

function parseNetworkInspection(value: unknown): HostdNetworkInspectionResult | null {
  if (!isRecordWithKeys(value, ["profiles", "recovery"]) || !Array.isArray(value.profiles) || !isRecord(value.recovery)) return null;
  if (!value.profiles.every(isNetworkProfile) || !Object.values(value.recovery).every(isRecoveryEntry)) return null;
  return value as HostdNetworkInspectionResult;
}

function parseEthernetStatus(value: unknown): SystemEthernetStatus | null {
  if (!isRecordWithKeys(value, ["collectedAt", "backend", "hostdReady", "devices", "transaction", "warnings"])) return null;
  if (typeof value.collectedAt !== "string" || value.backend !== "NetworkManager" || value.hostdReady !== true
    || !Array.isArray(value.devices) || !value.devices.every(isEthernetDevice)
    || (value.transaction !== null && !parseEthernetTransaction(value.transaction)) || !isStringArray(value.warnings)) return null;
  return value as unknown as SystemEthernetStatus;
}

function isEthernetDevice(value: unknown): boolean {
  if (!isRecordWithKeys(value, [
    "id", "name", "permanentMac", "mac", "driver", "speedMbps", "carrier", "state", "addresses",
    "ipv4Gateway", "ipv6Gateway", "activeProfileId", "activeProfileName", "managementState", "activeConfig",
    "desiredConfig", "revision", "needsApply", "warnings"
  ])) return false;
  return typeof value.id === "string" && /^[0-9a-f]{12}$/u.test(value.id) && typeof value.name === "string"
    && typeof value.permanentMac === "string" && typeof value.mac === "string" && isNullableString(value.driver)
    && (value.speedMbps === null || isIntegerInRange(value.speedMbps, 1, 4_294_967_295)) && typeof value.carrier === "boolean"
    && ["connected", "up", "down", "disabled", "unavailable"].includes(String(value.state))
    && Array.isArray(value.addresses) && value.addresses.every(isEthernetAddress)
    && isNullableString(value.ipv4Gateway) && isNullableString(value.ipv6Gateway)
    && isNullableString(value.activeProfileId) && isNullableString(value.activeProfileName)
    && ["managed", "pending", "external", "external_unsupported"].includes(String(value.managementState))
    && (value.activeConfig === null || isEthernetConfig(value.activeConfig))
    && (value.desiredConfig === null || isEthernetConfig(value.desiredConfig))
    && typeof value.revision === "string" && typeof value.needsApply === "boolean" && isStringArray(value.warnings);
}

function isEthernetAddress(value: unknown): boolean {
  if (!isRecordWithKeys(value, ["family", "address", "prefixLength", "cidr", "scope", "label"])) return false;
  return ["inet", "inet6", "unknown"].includes(String(value.family)) && typeof value.address === "string"
    && (value.prefixLength === null || isIntegerInRange(value.prefixLength, 0, 128))
    && isNullableString(value.cidr) && isNullableString(value.scope) && isNullableString(value.label);
}

function isEthernetConfig(value: unknown): value is SystemEthernetConfig {
  if (!isRecordWithKeys(value, ["enabled", "ipv4", "ipv6"]) || typeof value.enabled !== "boolean") return false;
  return isEthernetFamily(value.ipv4, 4) && isEthernetFamily(value.ipv6, 6);
}

function isEthernetFamily(value: unknown, family: 4 | 6): boolean {
  if (!isRecordWithKeys(value, ["mode", "address", "prefixLength", "gateway", "dnsMode", "dns", "useDefaultRoute", "routeMetric"])) return false;
  const modes = family === 4 ? ["disabled", "dhcp", "static"] : ["disabled", "automatic", "static"];
  return modes.includes(String(value.mode)) && isNullableString(value.address)
    && (value.prefixLength === null || isIntegerInRange(value.prefixLength, 0, family === 4 ? 32 : 128))
    && isNullableString(value.gateway) && (value.dnsMode === "automatic" || value.dnsMode === "manual")
    && isStringArray(value.dns) && value.dns.length <= 3 && typeof value.useDefaultRoute === "boolean"
    && isIntegerInRange(value.routeMetric, 1, 65_535);
}

function parseEthernetTransaction(value: unknown): SystemEthernetApplyTransaction | null {
  if (!isRecordWithKeys(value, ["id", "status", "deviceIds", "createdAt", "deadlineAt", "rollback", "error"])) return null;
  return typeof value.id === "string"
    && ["applying", "awaiting_confirmation", "confirmed", "rolling_back", "rolled_back", "failed"].includes(String(value.status))
    && isStringArray(value.deviceIds) && typeof value.createdAt === "string" && isNullableString(value.deadlineAt)
    && isRollback(value.rollback) && isNullableString(value.error) ? value as unknown as SystemEthernetApplyTransaction : null;
}

function isNetworkProfile(value: unknown): value is HostdNetworkProfileInspection {
  if (!isRecordWithKeys(value, ["id", "name", "ssid", "device", "security", "mode", "band", "channel", "autoconnect", "credentialConfigured", "revision"])) return false;
  return [value.id, value.name, value.ssid, value.revision].every((item) => typeof item === "string")
    && isNullableString(value.device) && isWifiSecurity(value.security)
    && (value.mode === "client" || value.mode === "hotspot") && isWifiBand(value.band)
    && (value.channel === null || isIntegerInRange(value.channel, 0, 65_535)) && typeof value.autoconnect === "boolean"
    && typeof value.credentialConfigured === "boolean";
}

function isRecoveryEntry(value: unknown): boolean {
  return isRecordWithKeys(value, ["restoreProfileId", "hotspotProfileId"])
    && isNullableString(value.restoreProfileId) && typeof value.hotspotProfileId === "string";
}

function parseNetworkScan(value: unknown): GeneratedNetworkScanResult & SystemWifiScanResult | null {
  if (!isRecordWithKeys(value, ["device", "scannedAt", "accessPoints"]) || typeof value.device !== "string"
    || typeof value.scannedAt !== "string" || !Array.isArray(value.accessPoints) || !value.accessPoints.every(isAccessPoint)) return null;
  return value as unknown as GeneratedNetworkScanResult & SystemWifiScanResult;
}

function isAccessPoint(value: unknown): boolean {
  if (!isRecordWithKeys(value, ["active", "ssid", "bssid", "channel", "frequencyMHz", "signal", "band", "security", "savedProfileId"])) return false;
  return typeof value.active === "boolean" && typeof value.ssid === "string" && typeof value.bssid === "string"
    && isIntegerInRange(value.channel, 0, 65_535)
    && isIntegerInRange(value.frequencyMHz, 0, 4_294_967_295)
    && isIntegerInRange(value.signal, -2_147_483_648, 2_147_483_647)
    && (value.band === "2.4" || value.band === "5") && isWifiSecurity(value.security)
    && isNullableString(value.savedProfileId);
}

function parsePowerResult(request: unknown, value: unknown): HostdPowerResult | null {
  if (!isRecord(request) || !isRecordWithKeys(value, ["action", "accepted"])) return null;
  return value.action === request.action && (value.action === "reboot" || value.action === "shutdown") && value.accepted === true
    ? value as HostdPowerResult : null;
}

function parseOpsResult(request: unknown, value: unknown): HostdOpsResult | null {
  if (!isRecord(request) || !isRecordWithKeys(value, ["task", "accepted"])) return null;
  return value.task === request.task && (value.task === "health" || value.task === "maintenance")
    && value.accepted === true ? value as HostdOpsResult : null;
}

function parseTvResult(request: unknown, value: unknown): HostdTvResult | null {
  if (!isRecord(request) || !isRecordWithKeys(value, ["enabled", "applied"])) return null;
  return typeof request.enabled === "boolean" && value.enabled === request.enabled && value.applied === true
    ? value as HostdTvResult : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRfc3339Timestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isRollback(value: unknown): value is "not_required" | "succeeded" | "failed" {
  return value === "not_required" || value === "succeeded" || value === "failed";
}

function isWifiBand(value: unknown): value is SystemWifiBand {
  return value === "auto" || value === "2.4" || value === "5";
}

function isWifiSecurity(value: unknown): value is SystemWifiSecurity {
  return value === "open" || value === "wpa2" || value === "wpa3" || value === "unsupported";
}
