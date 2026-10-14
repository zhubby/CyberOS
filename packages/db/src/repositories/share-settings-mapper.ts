import type {
  DlnaMediaType,
  ShareDefinitionConfig,
  ShareProtocolConfig,
  ShareSettingsRecord
} from "@zos/shared";
import { DLNA_MEDIA_TYPES } from "./settings-constants.js";
import type { DbSystemSettingRow } from "./repository-rows.js";

export function mapShareSettings(row: DbSystemSettingRow): ShareSettingsRecord {
  const parsed = JSON.parse(row.value_json) as Partial<ShareSettingsRecord>;
  return normalizeShareSettings(parsed, normalizeString(parsed.updatedAt) ?? row.updated_at);
}

export function normalizeShareSettings(
  settings: Partial<ShareSettingsRecord>,
  updatedAt: string
): ShareSettingsRecord {
  const account = recordFrom(settings.account);
  return {
    enabled: normalizeBoolean(settings.enabled, false),
    account: {
      username: normalizeString(account.username) ?? "zos-share",
      password: normalizeNullableString(account.password)
    },
    shares: normalizeShareDefinitions(settings.shares),
    updatedAt
  };
}

function normalizeShareDefinitions(shares: unknown): ShareDefinitionConfig[] {
  if (!Array.isArray(shares)) {
    return [];
  }

  return shares
    .map((share, index) => normalizeShareDefinition(share, index))
    .filter((share): share is ShareDefinitionConfig => share !== null);
}

function normalizeShareDefinition(value: unknown, index: number): ShareDefinitionConfig | null {
  const share = recordFrom(value);
  const rootId = normalizeString(share.rootId);
  const sharePath = normalizeString(share.path);
  if (!rootId || !sharePath) {
    return null;
  }
  const id = normalizeString(share.id) ?? `share-${index + 1}`;
  const name = normalizeString(share.name) ?? id;
  return {
    id,
    name,
    rootId,
    path: sharePath,
    description: normalizeString(share.description) ?? "",
    protocols: normalizeShareProtocolConfig(share.protocols, name)
  };
}

function normalizeShareProtocolConfig(value: unknown, shareName: string): ShareProtocolConfig {
  const protocols = recordFrom(value);
  const smb = recordFrom(protocols.smb);
  const webdav = recordFrom(protocols.webdav);
  const ftp = recordFrom(protocols.ftp);
  const nfs = recordFrom(protocols.nfs);
  const dlna = recordFrom(protocols.dlna);
  return {
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
      port: normalizePositiveInteger(webdav.port) ?? 8088,
      pathPrefix: normalizeString(webdav.pathPrefix) ?? `/shares/${shareSlug(shareName)}`
    },
    ftp: {
      enabled: normalizeBoolean(ftp.enabled, false),
      readOnly: normalizeBoolean(ftp.readOnly, true),
      allowGuest: normalizeBoolean(ftp.allowGuest, false),
      port: normalizePositiveInteger(ftp.port) ?? 2121,
      passivePortStart: normalizePositiveInteger(ftp.passivePortStart) ?? 50000,
      passivePortEnd: normalizePositiveInteger(ftp.passivePortEnd) ?? 50100
    },
    nfs: {
      enabled: normalizeBoolean(nfs.enabled, false),
      readOnly: normalizeBoolean(nfs.readOnly, true),
      allowedCidrs: normalizeStringArray(nfs.allowedCidrs),
      rootSquash: normalizeBoolean(nfs.rootSquash, true)
    },
    dlna: {
      enabled: normalizeBoolean(dlna.enabled, false),
      mediaTypes: normalizeDlnaMediaTypes(dlna.mediaTypes),
      bindInterface: normalizeNullableString(dlna.bindInterface),
      bindAddress: normalizeNullableString(dlna.bindAddress),
      friendlyName: normalizeString(dlna.friendlyName) ?? shareName
    }
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeString).filter((item): item is string => item !== null);
}

function normalizeDlnaMediaTypes(value: unknown): DlnaMediaType[] {
  if (!Array.isArray(value)) {
    return [...DLNA_MEDIA_TYPES];
  }
  const mediaTypes = value.filter((item): item is DlnaMediaType => DLNA_MEDIA_TYPES.includes(item as DlnaMediaType));
  return mediaTypes.length ? mediaTypes : [...DLNA_MEDIA_TYPES];
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeString(value);
}

function recordFrom(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function shareSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "share"
  );
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}
