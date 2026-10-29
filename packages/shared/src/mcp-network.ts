import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

const BLOCKED_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.azure.com"
]);

export type AddressClass = "loopback" | "private" | "public" | "blocked";

export interface ValidatedMcpEndpoint {
  url: URL;
  addresses: string[];
  addressClasses: AddressClass[];
}

export interface SecureMcpFetch {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export type McpAddressResolver = (hostname: string) => Promise<LookupAddress[]>;

export async function validateMcpEndpoint(
  rawUrl: string,
  allowInsecureHttp: boolean,
  resolve: McpAddressResolver = resolveAllAddresses
): Promise<ValidatedMcpEndpoint> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("MCP server URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MCP server URL must use HTTPS or explicitly allowed private HTTP");
  }
  if (url.username || url.password) throw new Error("MCP server URL must not contain credentials");
  if (url.hash) throw new Error("MCP server URL must not contain a fragment");
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname)) throw new Error("MCP server hostname is blocked");

  const addresses = await resolveAddresses(hostname, resolve);
  const addressClasses = addresses.map(classifyAddress);
  if (addressClasses.includes("blocked")) {
    throw new Error("MCP server resolves to a blocked network address");
  }
  if (url.protocol === "http:") {
    if (!allowInsecureHttp) throw new Error("Private HTTP MCP servers require plaintext-risk confirmation");
    if (addressClasses.some((value) => value === "public")) {
      throw new Error("Public MCP servers must use HTTPS");
    }
  }
  return { url, addresses, addressClasses };
}

export async function createSecureMcpFetch(
  rawUrl: string,
  allowInsecureHttp: boolean,
  resolve: McpAddressResolver = resolveAllAddresses
): Promise<SecureMcpFetch> {
  const endpoint = await validateMcpEndpoint(rawUrl, allowInsecureHttp, resolve);
  const dispatcher = new Agent({
    connect: {
      lookup: ((hostname, options, callback) => {
        void secureLookup(
          hostname,
          options,
          endpoint.url.protocol,
          allowInsecureHttp,
          endpoint.addresses,
          resolve,
          callback
        );
      }) as LookupFunction
    }
  });

  return {
    async fetch(input, init) {
      const target = new URL(input);
      if (target.origin !== endpoint.url.origin) {
        throw new Error("MCP request attempted to leave the configured server origin");
      }
      const response = await undiciFetch(target, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        redirect: "manual",
        dispatcher
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("MCP server redirects are not allowed");
      }
      return response as unknown as Response;
    },
    async close() {
      await dispatcher.close();
    }
  };
}

async function secureLookup(
  hostname: string,
  options: Parameters<LookupFunction>[1],
  protocol: string,
  allowInsecureHttp: boolean,
  expectedAddresses: readonly string[],
  resolve: McpAddressResolver,
  callback: Parameters<LookupFunction>[2]
): Promise<void> {
  try {
    const records = await resolve(normalizedHostname(hostname));
    if (records.length === 0) throw new Error("MCP server hostname did not resolve");
    const classes = records.map((record) => classifyAddress(record.address));
    if (classes.includes("blocked")) throw new Error("MCP server resolves to a blocked network address");
    if (!sameAddressSet(records.map((record) => record.address), expectedAddresses)) {
      throw new Error("MCP server DNS resolution changed after validation");
    }
    if (protocol === "http:" && (!allowInsecureHttp || classes.includes("public"))) {
      throw new Error("Public MCP servers must use HTTPS");
    }
    const normalizedOptions = typeof options === "object" && options !== null ? options : {};
    if ("all" in normalizedOptions && normalizedOptions.all) {
      callback(null, records);
    } else {
      const selected = records.find((record) => !normalizedOptions.family || record.family === normalizedOptions.family)
        ?? records[0]!;
      callback(null, selected.address, selected.family);
    }
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)), "", 0);
  }
}

function sameAddressSet(current: readonly string[], expected: readonly string[]): boolean {
  const currentSet = new Set(current.map(normalizedAddress));
  const expectedSet = new Set(expected.map(normalizedAddress));
  return currentSet.size === expectedSet.size
    && [...currentSet].every((address) => expectedSet.has(address));
}

function normalizedAddress(address: string): string {
  return address.toLowerCase().split("%")[0]!;
}

async function resolveAddresses(hostname: string, resolve: McpAddressResolver): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  let records: LookupAddress[];
  try {
    records = await resolve(hostname);
  } catch {
    throw new Error("MCP server hostname could not be resolved");
  }
  if (records.length === 0) throw new Error("MCP server hostname did not resolve");
  return records.map((record) => record.address);
}

async function resolveAllAddresses(hostname: string): Promise<LookupAddress[]> {
  return await lookup(hostname, { all: true, verbatim: true });
}

function normalizedHostname(value: string): string {
  return value.replace(/^\[|\]$/gu, "").toLowerCase().replace(/\.$/u, "");
}

function classifyAddress(address: string): AddressClass {
  if (address.includes(":")) return classifyIpv6(address);
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return "blocked";
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (
    a === 0
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224
  ) return "blocked";
  return "public";
}

function classifyIpv6(address: string): AddressClass {
  const normalized = address.toLowerCase().split("%")[0]!;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  if (mapped) return classifyAddress(mapped[1]!);
  const value = ipv6BigInt(normalized);
  if (value === null) return "blocked";
  if (value === 1n) return "loopback";
  if (value === 0n) return "blocked";
  const prefix8 = Number(value >> 120n);
  const prefix10 = Number(value >> 118n);
  const prefix32 = Number(value >> 96n);
  if (prefix8 === 0xfc || prefix8 === 0xfd) return "private";
  if (prefix10 === 0x3fa || prefix8 === 0xff || prefix32 === 0x20010db8) return "blocked";
  if (normalized === "fd00:ec2::254") return "blocked";
  return "public";
}

function ipv6BigInt(address: string): bigint | null {
  if (!address || address.split("::").length > 2) return null;
  let source = address;
  const ipv4Match = /(\d+\.\d+\.\d+\.\d+)$/u.exec(source);
  if (ipv4Match) {
    const octets = ipv4Match[1]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((value) => value < 0 || value > 255)) return null;
    source = `${source.slice(0, ipv4Match.index)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [leftRaw, rightRaw = ""] = source.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((source.includes("::") && missing < 1) || (!source.includes("::") && missing !== 0)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  return parts.reduce((result, part) => (result << 16n) | BigInt(parseInt(part, 16)), 0n);
}

export type McpDispatcher = Dispatcher;
