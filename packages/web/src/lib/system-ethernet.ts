import type { SystemEthernetConfig, SystemEthernetStatus } from "@cyberos/shared";

export type SystemEthernetTone = "ready" | "warning" | "offline" | "neutral";

export function parseSystemEthernetStatus(raw: string): SystemEthernetStatus | null {
  try {
    const value = JSON.parse(raw) as Partial<SystemEthernetStatus>;
    if (value.backend !== "NetworkManager" && value.backend !== "systemd-networkd" && value.backend !== "unknown") return null;
    if (typeof value.hostdReady !== "boolean" || !Array.isArray(value.devices) || !Array.isArray(value.warnings)) return null;
    return value as SystemEthernetStatus;
  } catch {
    return null;
  }
}

export function systemEthernetDeviceTone(state: string, reconnecting = false): SystemEthernetTone {
  if (reconnecting) return "warning";
  if (state === "connected") return "ready";
  if (state === "up") return "warning";
  if (state === "down" || state === "disabled" || state === "unavailable") return "offline";
  return "neutral";
}

export function validateSystemEthernetConfig(config: SystemEthernetConfig): string[] {
  return [
    ...validateFamily(config.ipv4, 4),
    ...validateFamily(config.ipv6, 6)
  ];
}

export function hasSystemEthernetMetricConflict(
  configs: Array<SystemEthernetConfig | null>
): boolean {
  for (const family of ["ipv4", "ipv6"] as const) {
    const metrics = configs
      .filter((config): config is SystemEthernetConfig => Boolean(
        config?.enabled && config[family].mode !== "disabled" && config[family].useDefaultRoute
      ))
      .map((config) => config[family].routeMetric);
    if (new Set(metrics).size !== metrics.length) return true;
  }
  return false;
}

function validateFamily(
  config: SystemEthernetConfig["ipv4"] | SystemEthernetConfig["ipv6"],
  family: 4 | 6
): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(config.routeMetric) || config.routeMetric < 1 || config.routeMetric > 65_535) {
    errors.push(`ipv${family}.metric`);
  }
  if (config.mode === "static") {
    if (!validIp(config.address ?? "", family)) errors.push(`ipv${family}.address`);
    const limit = family === 4 ? 32 : 128;
    if (!Number.isInteger(config.prefixLength) || config.prefixLength! < 0 || config.prefixLength! > limit) {
      errors.push(`ipv${family}.prefixLength`);
    }
    if (config.useDefaultRoute && !validIp(config.gateway ?? "", family)) errors.push(`ipv${family}.gateway`);
    if (config.gateway && !validIp(config.gateway, family)) errors.push(`ipv${family}.gateway`);
  }
  if (config.dnsMode === "manual" && (config.dns.length === 0 || config.dns.length > 3)) {
    errors.push(`ipv${family}.dns`);
  }
  if (config.dns.some((address) => !validIp(address, family))) errors.push(`ipv${family}.dns`);
  return [...new Set(errors)];
}

export function validIp(value: string, family: 4 | 6): boolean {
  const trimmed = value.trim();
  if (family === 4) {
    const parts = trimmed.split(".");
    return parts.length === 4 && parts.every((part) =>
      /^(?:0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255
    );
  }
  if (!trimmed.includes(":") || !/^[0-9a-f:.]+$/iu.test(trimmed)) return false;
  try {
    return new URL(`http://[${trimmed}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

export function ethernetTransactionSeconds(deadlineAt: string | null, now = Date.now()): number {
  if (!deadlineAt) return 0;
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
