import { stat } from "node:fs/promises";
import net from "node:net";
import { resolveSafeExistingPath } from "@cyberos/storage-tools";
import type {
  DlnaMediaType,
  ShareDefinitionConfig,
  ShareProtocolConfig,
  ShareSettingsRecord
} from "@cyberos/shared";

export interface ShareStoragePool {
  id: string;
  path: string;
}

export type ShareSettingsInput = Partial<Omit<ShareSettingsRecord, "account" | "shares" | "updatedAt">> & {
  account?: {
    username?: string;
    password?: string;
    clearPassword?: boolean;
  };
  shares?: ShareDefinitionInput[];
};

type ShareDefinitionInput = Partial<Omit<ShareDefinitionConfig, "protocols">> & {
  protocols?: Partial<{
    smb: Partial<ShareProtocolConfig["smb"]>;
    webdav: Partial<ShareProtocolConfig["webdav"]>;
    ftp: Partial<ShareProtocolConfig["ftp"]>;
    nfs: Partial<ShareProtocolConfig["nfs"]>;
    dlna: Partial<ShareProtocolConfig["dlna"]>;
  }>;
};

const DLNA_MEDIA_TYPES = ["audio", "video", "pictures"] as const satisfies DlnaMediaType[];
const SHARE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const SHARE_USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;

export async function normalizeShareSettingsInput(
  input: ShareSettingsInput | undefined,
  existing: ShareSettingsRecord,
  storagePools: ShareStoragePool[]
): Promise<ShareSettingsRecord> {
  const storagePoolById = new Map(storagePools.map((pool) => [pool.id, pool]));
  const accountInput = recordFrom(input?.account);
  const username = normalizeText(accountInput.username) ?? existing.account.username;
  validateUsername(username);
  const password =
    accountInput.clearPassword === true
      ? null
      : typeof accountInput.password === "string" && accountInput.password.length > 0
        ? accountInput.password
        : existing.account.password;
  if (typeof password === "string") {
    validateSecret(password);
  }

  const shares = await Promise.all((input?.shares ?? existing.shares).map((share, index) =>
    normalizeShareDefinition(share, index, storagePoolById)
  ));
  validateUnique(shares.map((share) => share.id), "Share id must be unique");
  validateAuthCoverage(input?.enabled ?? existing.enabled, shares, password);
  validateFtpCapacity(shares);
  validatePortConflicts(shares);
  validateWebDavPrefixes(shares);

  return {
    enabled: input?.enabled ?? existing.enabled,
    account: {
      username,
      password
    },
    shares,
    updatedAt: new Date().toISOString()
  };
}

async function normalizeShareDefinition(
  value: ShareDefinitionInput,
  index: number,
  storagePools: Map<string, ShareStoragePool>
): Promise<ShareDefinitionConfig> {
  const id = normalizeText(value.id) ?? `share-${index + 1}`;
  if (!SHARE_ID_PATTERN.test(id)) {
    throw new Error(`Share id is invalid: ${id}`);
  }
  const name = normalizeDisplayText(value.name) ?? id;
  const storagePoolId = normalizeText(value.storagePoolId);
  if (!storagePoolId) {
    throw new Error(`Share ${id} is missing a storage pool`);
  }
  const storagePool = storagePools.get(storagePoolId);
  if (!storagePool) {
    throw new Error(`Storage pool ${storagePoolId} is not mounted`);
  }

  const sharePath = normalizeText(value.path) ?? ".";
  const safe = await resolveSafeExistingPath(storagePool.path, sharePath);
  const targetStat = await stat(safe.realPath);
  if (!targetStat.isDirectory()) {
    throw new Error(`Share ${id} path must be a directory`);
  }

  return {
    id,
    name,
    storagePoolId: storagePool.id,
    path: safe.relativePath,
    description: normalizeDisplayText(value.description) ?? "",
    protocols: normalizeProtocols(value.protocols, id, name)
  };
}

function normalizeProtocols(
  value: ShareDefinitionInput["protocols"],
  id: string,
  name: string
): ShareProtocolConfig {
  const protocols = recordFrom(value);
  const smb = recordFrom(protocols.smb);
  const webdav = recordFrom(protocols.webdav);
  const ftp = recordFrom(protocols.ftp);
  const nfs = recordFrom(protocols.nfs);
  const dlna = recordFrom(protocols.dlna);
  const nfsCidrs = normalizeStringArray(nfs.allowedCidrs);
  const webdavPathPrefix = normalizePathPrefix(normalizeText(webdav.pathPrefix) ?? `/shares/${id}`);
  const ftpPassivePortStart = normalizePort(ftp.passivePortStart, 50000, "FTP passive port start");
  const ftpPassivePortEnd = normalizePort(ftp.passivePortEnd, 50100, "FTP passive port end");
  if (ftpPassivePortStart > ftpPassivePortEnd) {
    throw new Error("FTP passive port start must be lower than or equal to the end port");
  }

  const config: ShareProtocolConfig = {
    smb: {
      enabled: normalizeBoolean(smb.enabled, false),
      readOnly: normalizeBoolean(smb.readOnly, true),
      browseable: normalizeBoolean(smb.browseable, true),
      allowGuest: normalizeBoolean(smb.allowGuest, false)
    },
    webdav: {
      enabled: normalizeBoolean(webdav.enabled, false),
      readOnly: normalizeBoolean(webdav.readOnly, true),
      allowGuest: normalizeBoolean(webdav.allowGuest, false),
      port: normalizePort(webdav.port, 8088, "WebDAV port"),
      pathPrefix: webdavPathPrefix
    },
    ftp: {
      enabled: normalizeBoolean(ftp.enabled, false),
      readOnly: normalizeBoolean(ftp.readOnly, true),
      allowGuest: normalizeBoolean(ftp.allowGuest, false),
      port: normalizePort(ftp.port, 2121, "FTP port"),
      passivePortStart: ftpPassivePortStart,
      passivePortEnd: ftpPassivePortEnd
    },
    nfs: {
      enabled: normalizeBoolean(nfs.enabled, false),
      readOnly: normalizeBoolean(nfs.readOnly, true),
      allowedCidrs: nfsCidrs,
      rootSquash: normalizeBoolean(nfs.rootSquash, true)
    },
    dlna: {
      enabled: normalizeBoolean(dlna.enabled, false),
      mediaTypes: normalizeDlnaMediaTypes(dlna.mediaTypes),
      bindInterface: normalizeOptionalIdentifier(dlna.bindInterface),
      bindAddress: normalizeOptionalAddress(dlna.bindAddress),
      friendlyName: normalizeDisplayText(dlna.friendlyName) ?? name
    }
  };

  if (config.nfs.enabled && config.nfs.allowedCidrs.length === 0) {
    throw new Error(`NFS share ${id} requires at least one allowed CIDR`);
  }
  if (config.nfs.enabled && !config.nfs.rootSquash) {
    throw new Error("NFS shares require root squashing to protect managed storage");
  }
  for (const cidr of config.nfs.allowedCidrs) {
    validateCidr(cidr);
  }
  if (config.dlna.enabled && !config.dlna.bindInterface && !config.dlna.bindAddress) {
    throw new Error(`DLNA share ${id} requires a bind interface or bind address`);
  }
  return config;
}

function validateAuthCoverage(enabled: boolean, shares: ShareDefinitionConfig[], password: string | null): void {
  if (!enabled) {
    return;
  }
  const needsPassword = shares.some((share) =>
    (share.protocols.smb.enabled && !share.protocols.smb.allowGuest) ||
    (share.protocols.webdav.enabled && !share.protocols.webdav.allowGuest) ||
    (share.protocols.ftp.enabled && !share.protocols.ftp.allowGuest)
  );
  if (needsPassword && !password) {
    throw new Error("Share account password is required for authenticated SMB, WebDAV, or FTP shares");
  }
}

function validatePortConflicts(shares: ShareDefinitionConfig[]): void {
  const ports = new Map<number, string>();
  for (const share of shares) {
    for (const [enabled, port, label] of [
      [share.protocols.webdav.enabled, share.protocols.webdav.port, `WebDAV ${share.id}`],
      [share.protocols.ftp.enabled, share.protocols.ftp.port, `FTP ${share.id}`]
    ] as const) {
      if (!enabled) {
        continue;
      }
      const existing = ports.get(port);
      if (existing) {
        throw new Error(`${label} port conflicts with ${existing}`);
      }
      ports.set(port, label);
    }
  }
}

function validateFtpCapacity(shares: ShareDefinitionConfig[]): void {
  const ftpShares = shares.filter((share) => share.protocols.ftp.enabled);
  if (ftpShares.length > 1) {
    throw new Error("FTP currently supports one enabled share because vsftpd has a single local root");
  }
}

function validateWebDavPrefixes(shares: ShareDefinitionConfig[]): void {
  validateUnique(
    shares.filter((share) => share.protocols.webdav.enabled).map((share) => share.protocols.webdav.pathPrefix),
    "WebDAV path prefix must be unique"
  );
}

function validateCidr(value: string): void {
  const [address, prefixRaw] = value.split("/");
  const family = net.isIP(address ?? "");
  const prefix = Number(prefixRaw);
  if (!family || !Number.isInteger(prefix)) {
    throw new Error(`Invalid CIDR: ${value}`);
  }
  const maxPrefix = family === 4 ? 32 : 128;
  if (prefix <= 0 || prefix > maxPrefix) {
    throw new Error(`CIDR prefix must be between 1 and ${maxPrefix}: ${value}`);
  }
}

function validateUsername(username: string): void {
  if (!SHARE_USERNAME_PATTERN.test(username)) {
    throw new Error("Share account username must be a lowercase system-safe name");
  }
  if (username === "root" || username === "cyberos") {
    throw new Error("Share account must not use a privileged system identity");
  }
}

function validateSecret(value: string): void {
  if (value.includes("\0") || value.includes("\n") || value.length > 256) {
    throw new Error("Share account password contains unsupported characters");
  }
}

function validateUnique(values: string[], message: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(message);
    }
    seen.add(value);
  }
}

function normalizePort(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return port;
}

function normalizePathPrefix(value: string): string {
  const prefix = value.startsWith("/") ? value : `/${value}`;
  const normalized = prefix.replace(/\/+/gu, "/").replace(/\/$/u, "") || "/";
  if (!/^\/[A-Za-z0-9/_-]*$/u.test(normalized) || normalized.includes("/../") || normalized === "/..") {
    throw new Error("WebDAV path prefix must contain only URL path characters");
  }
  return normalized;
}

function normalizeDlnaMediaTypes(value: unknown): DlnaMediaType[] {
  if (!Array.isArray(value)) {
    return [...DLNA_MEDIA_TYPES];
  }
  const mediaTypes = value.filter((item): item is DlnaMediaType => DLNA_MEDIA_TYPES.includes(item as DlnaMediaType));
  if (!mediaTypes.length) {
    throw new Error("DLNA requires at least one media type");
  }
  return [...new Set(mediaTypes)];
}

function normalizeOptionalIdentifier(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  if (!/^[A-Za-z0-9_.:-]+$/u.test(text)) {
    throw new Error("Interface names may only contain letters, numbers, dots, colons, underscores, or hyphens");
  }
  return text;
}

function normalizeOptionalAddress(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  if (!net.isIP(text)) {
    throw new Error(`Invalid bind address: ${text}`);
  }
  return text;
}

function normalizeDisplayText(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  if (text.includes("\n") || text.includes("\0")) {
    throw new Error("Share text fields cannot contain line breaks");
  }
  return text.slice(0, 160);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeText).filter((item): item is string => item !== null);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function recordFrom(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
