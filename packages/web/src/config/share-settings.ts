import type { DlnaMediaType, ShareProtocol } from "@zos/shared";
import type { NasRoot, ShareSettings, ShareSettingsInput } from "../api.js";

export const SHARE_PROTOCOLS = ["smb", "webdav", "ftp", "nfs", "dlna"] as const satisfies readonly ShareProtocol[];
export const DLNA_MEDIA_TYPES = ["audio", "video", "pictures"] as const satisfies readonly DlnaMediaType[];

export interface ShareAccountFormState {
  username: string;
  password: string;
  clearPassword: boolean;
  passwordConfigured: boolean;
}

export interface SmbShareFormState {
  enabled: boolean;
  readOnly: boolean;
  browseable: boolean;
  allowGuest: boolean;
}

export interface WebDavShareFormState {
  enabled: boolean;
  readOnly: boolean;
  allowGuest: boolean;
  port: string;
  pathPrefix: string;
}

export interface FtpShareFormState {
  enabled: boolean;
  readOnly: boolean;
  allowGuest: boolean;
  port: string;
  passivePortStart: string;
  passivePortEnd: string;
}

export interface NfsShareFormState {
  enabled: boolean;
  readOnly: boolean;
  allowedCidrs: string;
  rootSquash: boolean;
}

export interface DlnaShareFormState {
  enabled: boolean;
  mediaTypes: DlnaMediaType[];
  bindInterface: string;
  bindAddress: string;
  friendlyName: string;
}

export interface ShareProtocolFormState {
  smb: SmbShareFormState;
  webdav: WebDavShareFormState;
  ftp: FtpShareFormState;
  nfs: NfsShareFormState;
  dlna: DlnaShareFormState;
}

export interface ShareDefinitionFormState {
  id: string;
  name: string;
  rootId: string;
  path: string;
  description: string;
  protocols: ShareProtocolFormState;
}

export interface ShareSettingsFormState {
  enabled: boolean;
  account: ShareAccountFormState;
  shares: ShareDefinitionFormState[];
  updatedAt: string;
}

export type ShareFormValidationCode =
  | "noRoots"
  | "invalidUsername"
  | "missingPassword"
  | "invalidId"
  | "duplicateId"
  | "missingRoot"
  | "missingPath"
  | "absolutePath"
  | "escapingPath"
  | "invalidWebDavPort"
  | "invalidFtpPort"
  | "invalidFtpPassiveRange"
  | "multipleFtp"
  | "nfsMissingCidrs"
  | "invalidNfsCidr"
  | "dlnaMissingBind"
  | "dlnaMissingMediaTypes";

export interface ShareFormValidationIssue {
  code: ShareFormValidationCode;
  shareName?: string;
  value?: string;
}

const DEFAULT_UPDATED_AT = new Date(0).toISOString();
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;
const SHARE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;

export function shareSettingsToForm(settings: ShareSettings | null, roots: NasRoot[] = []): ShareSettingsFormState {
  return {
    enabled: settings?.enabled ?? false,
    account: {
      username: settings?.account.username ?? "zos-share",
      password: "",
      clearPassword: false,
      passwordConfigured: settings?.account.passwordConfigured ?? false
    },
    shares: (settings?.shares ?? []).map((share) => ({
      id: share.id,
      name: share.name,
      rootId: share.rootId || roots[0]?.id || "",
      path: share.path || ".",
      description: share.description,
      protocols: {
        smb: { ...share.protocols.smb },
        webdav: {
          ...share.protocols.webdav,
          port: String(share.protocols.webdav.port)
        },
        ftp: {
          ...share.protocols.ftp,
          port: String(share.protocols.ftp.port),
          passivePortStart: String(share.protocols.ftp.passivePortStart),
          passivePortEnd: String(share.protocols.ftp.passivePortEnd)
        },
        nfs: {
          ...share.protocols.nfs,
          allowedCidrs: share.protocols.nfs.allowedCidrs.join(", ")
        },
        dlna: {
          ...share.protocols.dlna,
          bindInterface: share.protocols.dlna.bindInterface ?? "",
          bindAddress: share.protocols.dlna.bindAddress ?? ""
        }
      }
    })),
    updatedAt: settings?.updatedAt ?? DEFAULT_UPDATED_AT
  };
}

export function createShareFormState(roots: NasRoot[], existingShares: readonly ShareDefinitionFormState[] = []): ShareDefinitionFormState {
  const id = nextShareId(existingShares);
  const index = Number(id.match(/\d+$/u)?.[0] ?? existingShares.length + 1);
  const name = `Share ${index}`;
  return {
    id,
    name,
    rootId: roots[0]?.id ?? "",
    path: ".",
    description: "",
    protocols: defaultShareProtocols(id, name)
  };
}

export function defaultShareProtocols(id = "share-1", name = "Share 1"): ShareProtocolFormState {
  return {
    smb: {
      enabled: false,
      readOnly: true,
      browseable: true,
      allowGuest: false
    },
    webdav: {
      enabled: false,
      readOnly: true,
      allowGuest: false,
      port: "8088",
      pathPrefix: `/shares/${id}`
    },
    ftp: {
      enabled: false,
      readOnly: true,
      allowGuest: false,
      port: "2121",
      passivePortStart: "50000",
      passivePortEnd: "50100"
    },
    nfs: {
      enabled: false,
      readOnly: true,
      allowedCidrs: "",
      rootSquash: true
    },
    dlna: {
      enabled: false,
      mediaTypes: ["audio", "video", "pictures"],
      bindInterface: "",
      bindAddress: "",
      friendlyName: name
    }
  };
}

export function shareFormToInput(form: ShareSettingsFormState): ShareSettingsInput {
  const account: ShareSettingsInput["account"] = {
    username: form.account.username.trim() || "zos-share"
  };
  if (form.account.password.length > 0) {
    account.password = form.account.password;
  } else if (form.account.clearPassword) {
    account.clearPassword = true;
  }

  return {
    enabled: form.enabled,
    account,
    shares: form.shares.map((share, index) => {
      const id = share.id.trim() || `share-${index + 1}`;
      const name = share.name.trim() || id;
      return {
        id,
        name,
        rootId: share.rootId.trim(),
        path: share.path.trim() || ".",
        description: share.description.trim(),
        protocols: {
          smb: { ...share.protocols.smb },
          webdav: {
            enabled: share.protocols.webdav.enabled,
            readOnly: share.protocols.webdav.readOnly,
            allowGuest: share.protocols.webdav.allowGuest,
            port: parseIntegerField(share.protocols.webdav.port, 8088),
            pathPrefix: normalizePathPrefix(share.protocols.webdav.pathPrefix, id)
          },
          ftp: {
            enabled: share.protocols.ftp.enabled,
            readOnly: share.protocols.ftp.readOnly,
            allowGuest: share.protocols.ftp.allowGuest,
            port: parseIntegerField(share.protocols.ftp.port, 2121),
            passivePortStart: parseIntegerField(share.protocols.ftp.passivePortStart, 50000),
            passivePortEnd: parseIntegerField(share.protocols.ftp.passivePortEnd, 50100)
          },
          nfs: {
            enabled: share.protocols.nfs.enabled,
            readOnly: share.protocols.nfs.readOnly,
            allowedCidrs: splitDelimited(share.protocols.nfs.allowedCidrs),
            rootSquash: share.protocols.nfs.rootSquash
          },
          dlna: {
            enabled: share.protocols.dlna.enabled,
            mediaTypes: share.protocols.dlna.mediaTypes,
            bindInterface: nullableText(share.protocols.dlna.bindInterface),
            bindAddress: nullableText(share.protocols.dlna.bindAddress),
            friendlyName: share.protocols.dlna.friendlyName.trim() || name
          }
        }
      };
    })
  };
}

export function validateShareForm(form: ShareSettingsFormState, roots: NasRoot[]): ShareFormValidationIssue[] {
  const issues: ShareFormValidationIssue[] = [];
  if (roots.length === 0) {
    issues.push({ code: "noRoots" });
  }
  if (!USERNAME_PATTERN.test(form.account.username.trim())) {
    issues.push({ code: "invalidUsername", value: form.account.username });
  }
  if (form.enabled && hasAuthenticatedProtocols(form) && !form.account.passwordConfigured && form.account.password.length === 0) {
    issues.push({ code: "missingPassword" });
  }

  const seenIds = new Set<string>();
  let ftpCount = 0;
  for (const share of form.shares) {
    const id = share.id.trim();
    const shareName = share.name.trim() || id || "share";
    if (!SHARE_ID_PATTERN.test(id)) {
      issues.push({ code: "invalidId", shareName, value: id });
    }
    if (seenIds.has(id)) {
      issues.push({ code: "duplicateId", shareName, value: id });
    }
    seenIds.add(id);
    if (!share.rootId || !roots.some((root) => root.id === share.rootId)) {
      issues.push({ code: "missingRoot", shareName });
    }
    const sharePath = share.path.trim();
    if (!sharePath) {
      issues.push({ code: "missingPath", shareName });
    }
    if (sharePath.startsWith("/")) {
      issues.push({ code: "absolutePath", shareName, value: sharePath });
    }
    if (sharePath === ".." || sharePath.startsWith("../") || sharePath.includes("/../")) {
      issues.push({ code: "escapingPath", shareName, value: sharePath });
    }

    if (!isValidPortField(share.protocols.webdav.port)) {
      issues.push({ code: "invalidWebDavPort", shareName, value: share.protocols.webdav.port });
    }
    if (!isValidPortField(share.protocols.ftp.port)) {
      issues.push({ code: "invalidFtpPort", shareName, value: share.protocols.ftp.port });
    }
    const passiveStart = parseOptionalInteger(share.protocols.ftp.passivePortStart);
    const passiveEnd = parseOptionalInteger(share.protocols.ftp.passivePortEnd);
    if (!isPortNumber(passiveStart) || !isPortNumber(passiveEnd) || passiveStart > passiveEnd) {
      issues.push({ code: "invalidFtpPassiveRange", shareName });
    }
    if (share.protocols.ftp.enabled) {
      ftpCount += 1;
    }

    const cidrs = splitDelimited(share.protocols.nfs.allowedCidrs);
    if (share.protocols.nfs.enabled && cidrs.length === 0) {
      issues.push({ code: "nfsMissingCidrs", shareName });
    }
    for (const cidr of cidrs) {
      if (!isValidCidr(cidr)) {
        issues.push({ code: "invalidNfsCidr", shareName, value: cidr });
      }
    }
    if (share.protocols.dlna.enabled && !share.protocols.dlna.bindInterface.trim() && !share.protocols.dlna.bindAddress.trim()) {
      issues.push({ code: "dlnaMissingBind", shareName });
    }
    if (share.protocols.dlna.enabled && share.protocols.dlna.mediaTypes.length === 0) {
      issues.push({ code: "dlnaMissingMediaTypes", shareName });
    }
  }
  if (ftpCount > 1) {
    issues.push({ code: "multipleFtp" });
  }
  return issues;
}

export function enabledProtocolCount(form: ShareSettingsFormState): number {
  return form.enabled
    ? form.shares.reduce((count, share) => count + enabledProtocolsForShare(share).length, 0)
    : 0;
}

export function enabledProtocolsForShare(share: ShareDefinitionFormState): ShareProtocol[] {
  return SHARE_PROTOCOLS.filter((protocol) => share.protocols[protocol].enabled);
}

export function authenticatedProtocolCount(form: ShareSettingsFormState): number {
  if (!form.enabled) {
    return 0;
  }
  return form.shares.reduce(
    (count, share) =>
      count +
      Number(share.protocols.smb.enabled && !share.protocols.smb.allowGuest) +
      Number(share.protocols.webdav.enabled && !share.protocols.webdav.allowGuest) +
      Number(share.protocols.ftp.enabled && !share.protocols.ftp.allowGuest),
    0
  );
}

export function toggleDlnaMediaType(mediaTypes: DlnaMediaType[], mediaType: DlnaMediaType): DlnaMediaType[] {
  return mediaTypes.includes(mediaType)
    ? mediaTypes.filter((item) => item !== mediaType)
    : [...mediaTypes, mediaType];
}

function hasAuthenticatedProtocols(form: ShareSettingsFormState): boolean {
  return authenticatedProtocolCount(form) > 0;
}

function nextShareId(existingShares: readonly ShareDefinitionFormState[]): string {
  const ids = new Set(existingShares.map((share) => share.id.trim()));
  for (let index = existingShares.length + 1; index < existingShares.length + 200; index += 1) {
    const id = `share-${index}`;
    if (!ids.has(id)) {
      return id;
    }
  }
  return `share-${Date.now()}`;
}

function splitDelimited(value: string): string[] {
  return value
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntegerField(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

function parseOptionalInteger(value: string): number {
  return parseIntegerField(value, 0);
}

function isValidPortField(value: string): boolean {
  return isPortNumber(parseOptionalInteger(value));
}

function isPortNumber(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

function normalizePathPrefix(value: string, id: string): string {
  const trimmed = value.trim() || `/shares/${id}`;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isValidCidr(value: string): boolean {
  const [address, prefixRaw] = value.split("/");
  if (!address || !prefixRaw || value.split("/").length !== 2) {
    return false;
  }
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix)) {
    return false;
  }
  if (isIpv4(address)) {
    return prefix > 0 && prefix <= 32;
  }
  if (isIpv6(address)) {
    return prefix > 0 && prefix <= 128;
  }
  return false;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/u.test(part)) {
      return false;
    }
    const parsed = Number(part);
    return parsed >= 0 && parsed <= 255;
  });
}

function isIpv6(value: string): boolean {
  return value.includes(":") && /^[0-9a-f:]+$/iu.test(value);
}
