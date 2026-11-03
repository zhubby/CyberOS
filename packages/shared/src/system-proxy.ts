import type { SystemProxySettingsRecord } from "./types.js";

export function normalizeSystemProxySettings(input: unknown, updatedAt: string): SystemProxySettingsRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Proxy settings must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.protocol !== "string" || !["http", "https", "socks5"].includes(value.protocol)) throw new Error("Proxy protocol must be HTTP, HTTPS or SOCKS5");
  if (value.host !== null && typeof value.host !== "string") throw new Error("Proxy address must be text");
  const host = typeof value.host === "string" ? value.host.trim() || null : null;
  const port = value.port;
  if (host === null && port === null) return { protocol: value.protocol as SystemProxySettingsRecord["protocol"], host, port, updatedAt };
  if (!host || /[\s/@?#%\\]/u.test(host) || host.length > 253) throw new Error("Proxy address must be a hostname or IP address without a URL or port");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Proxy port must be an integer between 1 and 65535");
  let normalizedHost: string;
  try {
    if (host.includes("[") || host.includes("]")) {
      if (!host.startsWith("[") || !host.endsWith("]") || !host.includes(":")) throw new Error();
    }
    const address = host.replace(/^\[|\]$/gu, "");
    const url = new URL(`http://${address.includes(":") ? `[${address}]` : address}/`);
    normalizedHost = url.hostname.replace(/^\[|\]$/gu, "");
    if (normalizedHost.length > 253) throw new Error();
    if (!normalizedHost.includes(":") && !/^[a-z0-9.-]+$/iu.test(normalizedHost)) throw new Error();
  } catch {
    throw new Error("Proxy address must be a hostname or IP address without a URL or port");
  }
  return { protocol: value.protocol as SystemProxySettingsRecord["protocol"], host: normalizedHost, port, updatedAt };
}

export function systemProxyUrl(settings: SystemProxySettingsRecord): string {
  if (!settings.host || settings.port === null) throw new Error("System proxy is not configured");
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  return `${settings.protocol}://${host}:${settings.port}`;
}
