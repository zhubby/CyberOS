import type {
  SystemWifiAccessPoint,
  SystemWifiBand,
  SystemWifiDeviceState,
  SystemWifiSecurity,
  SystemWifiStatus
} from "@cyberos/shared";

export interface SystemWifiNetworkGroup {
  id: string;
  ssid: string;
  security: SystemWifiSecurity;
  strongest: SystemWifiAccessPoint;
  accessPoints: SystemWifiAccessPoint[];
}

export function groupSystemWifiAccessPoints(accessPoints: SystemWifiAccessPoint[]): SystemWifiNetworkGroup[] {
  const groups = new Map<string, SystemWifiAccessPoint[]>();
  for (const accessPoint of accessPoints) {
    if (!accessPoint.ssid) continue;
    const key = `${accessPoint.ssid}\0${accessPoint.security}`;
    const entries = groups.get(key) ?? [];
    entries.push(accessPoint);
    groups.set(key, entries);
  }
  return [...groups.entries()]
    .map(([id, entries]) => {
      const sorted = [...entries].sort((left, right) => right.signal - left.signal || left.bssid.localeCompare(right.bssid));
      return { id, ssid: sorted[0]!.ssid, security: sorted[0]!.security, strongest: sorted[0]!, accessPoints: sorted };
    })
    .sort((left, right) => Number(right.strongest.active) - Number(left.strongest.active) || right.strongest.signal - left.strongest.signal || left.ssid.localeCompare(right.ssid));
}

export function validSystemWifiSsid(value: string): boolean {
  const bytes = new TextEncoder().encode(value).byteLength;
  return bytes >= 1 && bytes <= 32 && !/[\0\r\n]/u.test(value);
}

export function validSystemWifiPassword(value: string): boolean {
  return /^[\x20-\x7e]{8,63}$/u.test(value) || /^[a-fA-F0-9]{64}$/u.test(value);
}

export function systemWifiDeviceTone(state: SystemWifiDeviceState): "ready" | "warning" | "offline" | "neutral" {
  if (state === "connected" || state === "hotspot") return "ready";
  if (state === "connecting") return "warning";
  if (state === "unavailable") return "offline";
  return "neutral";
}

export function parseSystemWifiStatus(value: string): SystemWifiStatus | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.devices) || !Array.isArray(parsed.hotspots)) return null;
    if (
      parsed.backend !== "NetworkManager" &&
      parsed.backend !== "systemd-networkd" &&
      parsed.backend !== "unknown"
    ) return null;
    if (parsed.radioEnabled !== null && typeof parsed.radioEnabled !== "boolean") return null;
    if (typeof parsed.hostdReady !== "boolean" || typeof parsed.collectedAt !== "string") return null;
    return parsed as unknown as SystemWifiStatus;
  } catch {
    return null;
  }
}

export function systemWifiChannels(
  channels: number[],
  band: SystemWifiBand
): number[] {
  if (band === "auto") return [];
  return [...new Set(channels)]
    .filter((channel) => band === "2.4" ? channel >= 1 && channel <= 14 : channel > 14)
    .sort((left, right) => left - right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
