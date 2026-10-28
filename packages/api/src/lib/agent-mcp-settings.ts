import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { createCatalogDescriptors } from "@cyberos/capabilities";
import {
  createMcpClient,
  findMcpClientByToken,
  getAgentMcpSettings,
  listMcpClients,
  revokeMcpClient,
  rotateMcpClientToken,
  saveAgentMcpSettings,
  updateMcpClientScopes,
  type CyberOsDatabase
} from "@cyberos/db";
import type { PublicAgentMcpSettings, CyberOsConfig } from "@cyberos/shared";

export function publicAgentMcpSettings(db: CyberOsDatabase, config: CyberOsConfig): PublicAgentMcpSettings {
  const stored = getAgentMcpSettings(db);
  const enabled = stored?.enabled ?? config.mcp.piEnabled;
  const available = config.mcp.enabled;
  const paired = available ? hasPairedPiClient(db, config) : false;
  return {
    enabled,
    available,
    paired,
    status: !available ? "unavailable" : enabled ? (paired ? "ready" : "attention") : "disabled",
    updatedAt: stored?.updatedAt ?? new Date(0).toISOString()
  };
}

export function configureAgentMcp(db: CyberOsDatabase, config: CyberOsConfig, enabled: boolean): PublicAgentMcpSettings {
  if (enabled) {
    ensurePairedPiClient(db, config);
  }
  saveAgentMcpSettings(db, enabled);
  return publicAgentMcpSettings(db, config);
}

export function reconcileAgentMcp(db: CyberOsDatabase, config: CyberOsConfig): PublicAgentMcpSettings {
  const stored = getAgentMcpSettings(db);
  const enabled = stored?.enabled ?? config.mcp.piEnabled;
  if (config.mcp.enabled && enabled) ensurePairedPiClient(db, config);
  return publicAgentMcpSettings(db, config);
}

function hasPairedPiClient(db: CyberOsDatabase, config: CyberOsConfig): boolean {
  const token = readValidPiToken(config.mcp.piTokenFile);
  if (!token) return false;
  return findMcpClientByToken(db, token)?.kind === "pi";
}

function ensurePairedPiClient(db: CyberOsDatabase, config: CyberOsConfig): void {
  const tokenFile = config.mcp.piTokenFile;
  if (!path.isAbsolute(tokenFile)) {
    throw new Error("CyberOS Pi MCP token file is not configured with an absolute path");
  }

  const now = new Date().toISOString();
  const activeClients = listMcpClients(db).filter((client) =>
    client.kind === "pi" && !client.revokedAt && (!client.expiresAt || client.expiresAt > now)
  );
  if (activeClients.length > 1) {
    throw new Error("Multiple active Pi MCP clients require operator repair");
  }

  const existing = activeClients[0] ?? null;
  const installedToken = readValidPiToken(tokenFile);
  const desiredScopes = piClientScopes(config);
  if (existing && installedToken && findMcpClientByToken(db, installedToken)?.id === existing.id) {
    if (!sameScopes(existing.scopes, desiredScopes)) updateMcpClientScopes(db, existing.id, desiredScopes);
    return;
  }

  let createdClientId: string | null = null;
  let token: string;
  if (existing) {
    if (!sameScopes(existing.scopes, desiredScopes)) updateMcpClientScopes(db, existing.id, desiredScopes);
    token = rotateMcpClientToken(db, existing.id).token;
  } else {
    const created = createMcpClient(db, {
      name: "Built-in Pi",
      kind: "pi",
      scopes: desiredScopes
    });
    createdClientId = created.id;
    token = created.token;
  }

  try {
    installPiToken(tokenFile, token);
  } catch (error) {
    if (createdClientId) revokeMcpClient(db, createdClientId);
    throw error;
  }
}

function piClientScopes(config: CyberOsConfig): string[] {
  return [...new Set(createCatalogDescriptors().flatMap((descriptor) => descriptor.requiredScopes))]
    .filter((scope) => scope !== "cyberos:admin:shell" || config.mcp.shellEnabled)
    .sort();
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function readValidPiToken(tokenFile: string | undefined): string | null {
  if (!tokenFile || !existsSync(tokenFile)) return null;
  try {
    const tokenStat = statSync(tokenFile);
    if (!tokenStat.isFile() || (tokenStat.mode & 0o077) !== 0) return null;
    const token = readFileSync(tokenFile, "utf8").trim();
    return /^cyberos_mcp_[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
  } catch {
    return null;
  }
}

function installPiToken(tokenFile: string, token: string): void {
  const tokenDir = path.dirname(tokenFile);
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  chmodSync(tokenDir, 0o700);
  const temporary = `${tokenFile}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, tokenFile);
    chmodSync(tokenFile, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
