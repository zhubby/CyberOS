import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { createCatalogDescriptors } from "@zos/capabilities";
import {
  createMcpClient,
  listMcpClients,
  openZosDb,
  revokeMcpClient,
  rotateMcpClientToken,
  type McpClientKind,
  type ZosDatabase
} from "@zos/db";
import { loadConfig } from "@zos/shared";

const arguments_ = process.argv.slice(2);

if (process.getuid?.() !== 0 && process.env.ZOS_MCP_ALLOW_NON_ROOT !== "1") {
  fail("zos-mcp must run as root");
}

const config = loadConfig();
const db = openZosDb(config.databasePath);
try {
  dispatch(db, arguments_);
} finally {
  db.close();
}

function dispatch(database: ZosDatabase, args: string[]): void {
  const [group, action] = args;
  if (group === "client" && action === "create") return createClient(database, args.slice(2));
  if (group === "client" && action === "list") return listClients(database);
  if (group === "client" && action === "rotate") return rotateClient(database, args.slice(2));
  if (group === "client" && action === "revoke") return revokeClient(database, args.slice(2));
  if (group === "tls" && action === "init") return initializeTls(database, args.slice(2));
  usage();
}

function createClient(database: ZosDatabase, args: string[]): void {
  const name = option(args, "--name");
  const kind = parseKind(option(args, "--kind") ?? "lan");
  if (kind === "pi" && listMcpClients(database).some((client) => client.kind === "pi" && !client.revokedAt)) {
    fail("an active Pi client already exists; rotate or revoke it first");
  }
  const defaultScopes = kind === "pi" ? allPiScopes() : ["zos:catalog:read"];
  const scopes = option(args, "--scopes")?.split(",").map((scope) => scope.trim()).filter(Boolean) ?? defaultScopes;
  validateScopes(scopes);
  const expiresAt = parseExpiry(option(args, "--expires"));
  const client = createMcpClient(database, { name: name ?? `${kind} client`, kind, scopes, expiresAt });
  if (kind === "pi") {
    try {
      installPiToken(client.token);
    } catch (error) {
      revokeMcpClient(database, client.id);
      removeInstalledPiToken();
      throw error;
    }
  }
  const caPath = path.join(config.rootDir ?? "/zos", "config", "mcp-tls", "ca.crt");
  printJson({
    id: client.id,
    name: client.name,
    kind: client.kind,
    url: kind === "lan" ? `https://${os.hostname()}:8443/mcp` : `http://127.0.0.1:${config.api.port}/mcp`,
    token: client.token,
    tokenNotice: "This token is shown once. Store it in the MCP client now.",
    scopes: client.scopes,
    expiresAt: client.expiresAt,
    caPath: existsSync(caPath) ? caPath : null,
    ...(kind === "pi" ? { tokenFile: config.mcp?.piTokenFile } : {})
  });
}

function listClients(database: ZosDatabase): void {
  printJson({
    clients: listMcpClients(database).map((client) => ({
      id: client.id,
      name: client.name,
      kind: client.kind,
      tokenPrefix: client.tokenPrefix,
      scopes: client.scopes,
      expiresAt: client.expiresAt,
      revokedAt: client.revokedAt,
      lastUsedAt: client.lastUsedAt,
      createdAt: client.createdAt
    }))
  });
}

function rotateClient(database: ZosDatabase, args: string[]): void {
  const clientId = args[0];
  if (!clientId) fail("client rotate requires a client id");
  const existing = listMcpClients(database).find((client) => client.id === clientId && !client.revokedAt);
  if (!existing) fail("active MCP client not found");
  const previousPiToken = existing.kind === "pi" ? readInstalledPiToken() : null;
  const rotated = rotateMcpClientToken(database, clientId);
  if (rotated.client.kind === "pi") {
    try {
      installPiToken(rotated.token);
    } catch (error) {
      try {
        rotateMcpClientToken(database, clientId, previousPiToken!);
        installPiToken(previousPiToken!);
      } catch (rollbackError) {
        throw new Error("Pi token rotation failed and automatic rollback also failed; repair the paired credential before restarting Pi", {
          cause: rollbackError
        });
      }
      throw error;
    }
  }
  printJson({
    id: rotated.client.id,
    token: rotated.token,
    tokenNotice: "This token is shown once. The previous token is no longer valid."
  });
}

function revokeClient(database: ZosDatabase, args: string[]): void {
  const clientId = args[0];
  if (!clientId) fail("client revoke requires a client id");
  const client = listMcpClients(database).find((candidate) => candidate.id === clientId && !candidate.revokedAt);
  if (!revokeMcpClient(database, clientId)) fail("active MCP client not found");
  if (client?.kind === "pi" && config.mcp?.piTokenFile && existsSync(config.mcp.piTokenFile)) {
    unlinkSync(config.mcp.piTokenFile);
  }
  printJson({ id: clientId, revoked: true, pendingRunsExpired: true });
}

function initializeTls(database: ZosDatabase, args: string[]): void {
  const activeLanClient = listMcpClients(database).some((client) => client.kind === "lan" && !client.revokedAt);
  if (!activeLanClient) fail("create at least one LAN client before enabling TLS");
  const hostname = option(args, "--hostname") ?? os.hostname();
  if (!/^[a-zA-Z0-9.-]+$/u.test(hostname)) fail("hostname contains unsupported characters");
  const port = parsePort(option(args, "--port") ?? "8443");
  const providedCert = option(args, "--cert");
  const providedKey = option(args, "--key");
  const providedCa = option(args, "--ca");
  if (Boolean(providedCert) !== Boolean(providedKey)) fail("--cert and --key must be provided together");
  if (providedCa && !providedCert) fail("--ca can only be used with --cert and --key");
  if (providedCert && providedKey) validateProvidedTls(hostname, providedCert, providedKey, providedCa);
  const rootDir = config.rootDir ?? "/zos";
  const tlsDir = path.join(rootDir, "config", "mcp-tls");
  mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  const caKey = path.join(tlsDir, "ca.key");
  const caCert = path.join(tlsDir, "ca.crt");
  const serverKey = path.join(tlsDir, "server.key");
  const serverCsr = path.join(tlsDir, "server.csr");
  const serverCert = path.join(tlsDir, "server.crt");
  const serial = path.join(tlsDir, "ca.srl");
  const extensionFile = path.join(tlsDir, "server.ext");
  const privateCa = !providedCert;
  const managedCa = privateCa || Boolean(providedCa);
  const createdTargets = privateCa
    ? [caKey, caCert, serverKey, serverCsr, serverCert, serial, extensionFile]
    : [serverKey, serverCert, ...(managedCa ? [caCert] : [])];
  assertFreshTargets(createdTargets);
  let result: Record<string, unknown> | null = null;
  try {
    if (providedCert && providedKey) {
      copyFileSync(providedCert, serverCert);
      copyFileSync(providedKey, serverKey);
      if (providedCa) copyFileSync(providedCa, caCert);
    } else {
      runOpenSsl(["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650", "-subj", "/CN=ZOS MCP Private CA", "-keyout", caKey, "-out", caCert]);
      runOpenSsl(["req", "-newkey", "rsa:3072", "-nodes", "-sha256", "-subj", `/CN=${hostname}`, "-keyout", serverKey, "-out", serverCsr]);
      const subjectAltName = isIP(hostname) === 4 ? `IP:${hostname}` : `DNS:${hostname}`;
      writeFileSync(extensionFile, `subjectAltName=${subjectAltName}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n`, { mode: 0o600 });
      runOpenSsl(["x509", "-req", "-sha256", "-days", "825", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-extfile", extensionFile, "-out", serverCert]);
    }
    if (privateCa) chmodSync(caKey, 0o600);
    chmodSync(serverKey, 0o600);
    if (managedCa) chmodSync(caCert, 0o644);
    chmodSync(serverCert, 0o644);
    const caFingerprint = managedCa ? certificateFingerprint(caCert) : null;
    const serverFingerprint = certificateFingerprint(serverCert);
    installNginxMcpSite({ hostname, port, serverCert, serverKey });
    result = {
      url: `https://${hostname}:${port}/mcp`,
      caPath: managedCa ? caCert : null,
      caFingerprint,
      certificateFingerprint: serverFingerprint,
      certificateSource: privateCa ? "zos-private-ca" : "provided",
      enabled: config.mcp?.externalEnabled === true,
      nextStep: config.mcp?.externalEnabled === true
        ? "Restart zos-api.service, then test the paired client."
        : "Set [mcp].external_enabled = true and restart zos-api.service before using the LAN endpoint."
    };
  } catch (error) {
    removeFiles(createdTargets);
    throw error;
  } finally {
    removeFiles([serverCsr, extensionFile]);
  }
  if (existsSync(serial)) chmodSync(serial, 0o600);
  printJson(result);
}

function installNginxMcpSite(input: { hostname: string; port: number; serverCert: string; serverKey: string }): void {
  const availableDir = process.env.ZOS_NGINX_AVAILABLE_DIR ?? "/etc/nginx/sites-available";
  const enabledDir = process.env.ZOS_NGINX_ENABLED_DIR ?? "/etc/nginx/sites-enabled";
  mkdirSync(availableDir, { recursive: true });
  mkdirSync(enabledDir, { recursive: true });
  const sitePath = path.join(availableDir, "zos-mcp.conf");
  const linkPath = path.join(enabledDir, "zos-mcp.conf");
  const previousSite = existsSync(sitePath) ? readFileSync(sitePath) : null;
  const previousLink = existsSync(linkPath) ? readlinkSync(linkPath) : null;
  try {
    writeFileSync(sitePath, nginxMcpConfig(input), { mode: 0o644 });
    if (existsSync(linkPath)) unlinkSync(linkPath);
    symlinkSync(sitePath, linkPath);
    if (process.env.ZOS_MCP_SKIP_NGINX_TEST !== "1") {
      execFileSync("nginx", ["-t"], { stdio: "inherit" });
      execFileSync("systemctl", ["reload", "nginx"], { stdio: "inherit" });
    }
  } catch (error) {
    if (existsSync(linkPath)) unlinkSync(linkPath);
    if (previousSite) writeFileSync(sitePath, previousSite, { mode: 0o644 });
    else if (existsSync(sitePath)) unlinkSync(sitePath);
    if (previousLink) symlinkSync(previousLink, linkPath);
    throw error;
  }
}

function nginxMcpConfig(input: { hostname: string; port: number; serverCert: string; serverKey: string }): string {
  return `server {
    listen ${input.port} ssl;
    listen [::]:${input.port} ssl;
    server_name ${input.hostname};

    ssl_certificate ${input.serverCert};
    ssl_certificate_key ${input.serverKey};
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 1m;

    location = /mcp {
        proxy_pass http://127.0.0.1:${config.api.port}/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header X-ZOS-MCP-External 1;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host:${input.port};
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }

    location ^~ /mcp-transfer/ {
        proxy_pass http://127.0.0.1:${config.api.port};
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header X-ZOS-MCP-External 1;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host:${input.port};
    }

    location / { return 404; }
}
`;
}

function validateScopes(scopes: string[]): void {
  const known = new Set(createCatalogDescriptors().flatMap((descriptor) => descriptor.requiredScopes));
  const unknown = scopes.filter((scope) => !known.has(scope));
  if (unknown.length > 0) fail(`unknown scopes: ${unknown.join(", ")}`);
}

function allPiScopes(): string[] {
  return [...new Set(createCatalogDescriptors().flatMap((descriptor) => descriptor.requiredScopes))]
    .filter((scope) => scope !== "zos:admin:shell")
    .sort();
}

function installPiToken(token: string): void {
  const tokenFile = config.mcp?.piTokenFile;
  if (!tokenFile) fail("MCP Pi token file is not configured");
  const tokenDir = path.dirname(tokenFile);
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  const temporary = `${tokenFile}.tmp-${process.pid}`;
  writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, tokenFile);
  chmodSync(tokenFile, 0o600);
  if (process.getuid?.() === 0 && process.env.ZOS_MCP_SKIP_CHOWN !== "1") {
    execFileSync("chown", ["zos:zos", tokenDir, tokenFile], { stdio: "ignore" });
    chmodSync(tokenDir, 0o700);
  }
}

function readInstalledPiToken(): string {
  const tokenFile = config.mcp?.piTokenFile;
  if (!tokenFile || !existsSync(tokenFile)) {
    fail("the installed Pi token file is missing; refusing a non-atomic rotation");
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!/^zos_mcp_[A-Za-z0-9_-]{43}$/u.test(token)) {
    fail("the installed Pi token file is invalid; refusing a non-atomic rotation");
  }
  return token;
}

function removeInstalledPiToken(): void {
  const tokenFile = config.mcp?.piTokenFile;
  if (!tokenFile || !existsSync(tokenFile)) return;
  try {
    unlinkSync(tokenFile);
  } catch {
    // The database credential has already been revoked, so a leftover token is unusable.
  }
}

function parseKind(value: string): McpClientKind {
  if (value === "pi" || value === "local" || value === "lan") return value;
  fail("--kind must be pi, local, or lan");
}

function parseExpiry(value: string | undefined): string | null {
  if (!value || value === "never") return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) fail("--expires must be a future ISO date or 'never'");
  return parsed.toISOString();
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) fail("--port must be between 1 and 65535");
  return parsed;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function assertFreshTargets(targets: string[]): void {
  const existing = targets.filter(existsSync);
  if (existing.length > 0) fail(`TLS files already exist; refusing to overwrite: ${existing.join(", ")}`);
}

function validateProvidedTls(hostname: string, certificate: string, privateKey: string, caCertificate?: string): void {
  assertRegularFile(certificate, "certificate");
  assertRegularFile(privateKey, "private key");
  if (caCertificate) assertRegularFile(caCertificate, "CA certificate");
  try {
    execFileSync("openssl", ["x509", "-in", certificate, "-noout", "-checkend", "0"], { stdio: "ignore" });
    const parsedCertificate = new X509Certificate(readFileSync(certificate));
    const matchingIdentity = isIP(hostname) === 4
      ? parsedCertificate.checkIP(hostname)
      : parsedCertificate.checkHost(hostname);
    if (!matchingIdentity) throw new Error("certificate identity mismatch");
    const certificateKey = execFileSync("openssl", ["x509", "-in", certificate, "-pubkey", "-noout"], { encoding: "utf8" });
    const privateKeyPublic = execFileSync("openssl", ["pkey", "-in", privateKey, "-pubout"], { encoding: "utf8" });
    if (certificateKey !== privateKeyPublic) fail("provided certificate and private key do not match");
    if (caCertificate) execFileSync("openssl", ["x509", "-in", caCertificate, "-noout"], { stdio: "ignore" });
  } catch {
    fail("provided TLS material is invalid, expired, or does not match --hostname");
  }
}

function assertRegularFile(filePath: string, label: string): void {
  try {
    if (!statSync(filePath).isFile()) fail(`provided ${label} is not a regular file`);
  } catch {
    fail(`provided ${label} is not readable: ${filePath}`);
  }
}

function certificateFingerprint(filePath: string): string {
  return execFileSync("openssl", ["x509", "-in", filePath, "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" }).trim();
}

function removeFiles(files: readonly string[]): void {
  for (const file of files) {
    if (existsSync(file)) unlinkSync(file);
  }
}

function runOpenSsl(args: string[]): void {
  execFileSync("openssl", args, { stdio: "ignore" });
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): never {
  fail("usage: zos-mcp client create|list|rotate|revoke ... | zos-mcp tls init [--hostname HOST] [--port PORT] [--cert FILE --key FILE [--ca FILE]]");
}

function fail(message: string): never {
  process.stderr.write(`zos-mcp: ${message}\n`);
  process.exit(1);
}
