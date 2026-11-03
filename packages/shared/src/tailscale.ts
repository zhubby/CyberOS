import type { TailscaleStatus } from "./generated/hostd.js";
export type {
  TailscaleStatus, TailscalePeer, TailscaleSettings, TailscaleSettingsPatch,
  TailscaleSettingsInput, TailscaleAction, TailscaleActionInput,
  TailscaleLoginInput, TailscaleLoginMethod, TailscaleServiceInput,
  TailscaleApplyTransaction, TailscaleTransactionState
} from "./generated/hostd.js";

type Check = (value: unknown) => boolean;
const text: Check = (v) => typeof v === "string" && v.length <= 4096;
const flag: Check = (v) => typeof v === "boolean";
const list: Check = (v) => Array.isArray(v) && v.length <= 1024 && v.every(text);
const nullable = (check: Check): Check => (v) => v === null || check(v);
const count: Check = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const timestamp: Check = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const link: Check = (v) => {
  if (typeof v !== "string" || v.length > 4096) return false;
  try { const url = new URL(v); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
};
function exact(value: unknown, shape: Record<string, Check>): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === Object.keys(shape).length
    && Object.entries(shape).every(([key, check]) => Object.hasOwn(value, key) && check((value as Record<string, unknown>)[key]));
}
const settings: Check = (v) => exact(v, {
  hostname: text, acceptDns: flag, acceptRoutes: flag, exitNodeId: text,
  exitNodeAllowLanAccess: flag, advertisedRoutes: list, advertiseExitNode: flag
});
const service: Check = (v) => exact(v, { installed: flag, active: flag, autoStart: flag, state: text });
const peer: Check = (v) => exact(v, {
  id: text, hostname: text, dnsName: text, os: text, ips: list, online: flag, active: flag,
  directAddress: nullable(text), relay: nullable(text), rxBytes: count, txBytes: count,
  lastSeen: nullable(timestamp), exitNodeOption: flag
});
const transaction: Check = (v) => exact(v, {
  id: (id) => typeof id === "string" && /^[a-f0-9-]{36}$/iu.test(id), deadlineAt: timestamp,
  state: (state) => ["pending", "confirmed", "rolled_back", "conflict"].includes(String(state)), error: nullable(text)
});

export function parseTailscaleStatus(value: unknown): TailscaleStatus | null {
  return exact(value, {
    collectedAt: timestamp, available: flag, service, version: nullable(text), backendState: text,
    revision: (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v), controlUrl: link, loginUrl: nullable(link),
    hostname: text, dnsName: text, ips: list, account: nullable(text), tailnet: nullable(text), keyExpiry: nullable(timestamp),
    settings, peers: (v) => Array.isArray(v) && v.length <= 1000 && v.every(peer), peersTruncated: flag,
    primaryRoutes: list, exitNodeApproved: nullable(flag), ipv4Forwarding: flag, ipv6Forwarding: flag,
    health: list, transaction: nullable(transaction), error: nullable(text)
  }) ? value as TailscaleStatus : null;
}

export function unavailableTailscaleStatus(error: string | null): TailscaleStatus {
  return {
    collectedAt: new Date().toISOString(), available: false,
    service: { installed: false, active: false, autoStart: false, state: "unknown" }, version: null,
    backendState: "Unavailable", revision: "0".repeat(64), controlUrl: "https://controlplane.tailscale.com", loginUrl: null,
    hostname: "", dnsName: "", ips: [], account: null, tailnet: null, keyExpiry: null,
    settings: { hostname: "", acceptDns: true, acceptRoutes: false, exitNodeId: "", exitNodeAllowLanAccess: false, advertisedRoutes: [], advertiseExitNode: false },
    peers: [], peersTruncated: false, primaryRoutes: [], exitNodeApproved: null, ipv4Forwarding: false, ipv6Forwarding: false,
    health: [], transaction: null, error
  };
}
