import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  agentMcpCredentialHeaders,
  validateAgentMcpCredentials,
  type AgentMcpCredentials,
  type AgentMcpServerRecord,
  type PublicAgentMcpServer
} from "@cyberos/shared";
import { createSecureMcpFetch } from "@cyberos/shared/mcp-network";

export {
  agentMcpCredentialHeaders as credentialHeaders,
  validateAgentMcpCredentials as validateCredentials
};
export type { AgentMcpCredentials };

export function agentMcpCredentialPath(secretsDir: string, serverId: string): string {
  if (!/^[a-f0-9-]{36}$/iu.test(serverId)) throw new Error("Invalid MCP server identifier");
  return path.join(secretsDir, `${serverId}.json`);
}

export async function publicAgentMcpServer(
  server: AgentMcpServerRecord,
  secretsDir: string
): Promise<PublicAgentMcpServer> {
  return {
    ...server,
    credentialsConfigured: await hasValidCredentials(secretsDir, server)
  };
}

export async function readAgentMcpCredentials(
  secretsDir: string,
  server: Pick<AgentMcpServerRecord, "id" | "authMode">
): Promise<AgentMcpCredentials> {
  if (server.authMode === "none") return {};
  const credentialPath = agentMcpCredentialPath(secretsDir, server.id);
  let raw: string;
  try {
    const metadata = await stat(credentialPath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error("MCP credential file permissions must be 0600");
    }
    raw = await readFile(credentialPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value = JSON.parse(raw) as unknown;
  validateAgentMcpCredentials(server.authMode, value);
  const credentials = value as AgentMcpCredentials;
  return credentials;
}

export async function writeAgentMcpCredentials(
  secretsDir: string,
  serverId: string,
  authMode: AgentMcpServerRecord["authMode"],
  credentials: AgentMcpCredentials
): Promise<string[]> {
  const headerNames = validateAgentMcpCredentials(authMode, credentials);
  const credentialPath = agentMcpCredentialPath(secretsDir, serverId);
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  await chmod(secretsDir, 0o700);
  const temporary = `${credentialPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, credentialPath);
    await chmod(credentialPath, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return headerNames;
}

export async function removeAgentMcpCredentials<T>(
  secretsDir: string,
  serverId: string,
  persist: () => T
): Promise<T> {
  const credentialPath = agentMcpCredentialPath(secretsDir, serverId);
  const removedPath = `${credentialPath}.delete-${randomUUID()}`;
  const existing = await stat(credentialPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) await rename(credentialPath, removedPath);
  let result: T;
  try {
    result = persist();
  } catch (error) {
    if (existing) await rename(removedPath, credentialPath);
    throw error;
  }
  await rm(removedPath, { force: true, recursive: true });
  return result;
}

export async function testAgentMcpServer(
  server: AgentMcpServerRecord,
  secretsDir: string
): Promise<{ toolCount: number }> {
  const credentials = await readAgentMcpCredentials(secretsDir, server);
  if (server.authMode !== "none" && !(await hasCredentialFile(secretsDir, server.id))) {
    throw new Error("MCP credentials are not configured");
  }
  const headers = agentMcpCredentialHeaders(server.authMode, credentials);
  const secureNetwork = await createSecureMcpFetch(server.url, server.allowInsecureHttp);
  const transport = new StreamableHttpTransport({
    url: server.url,
    headers,
    fetch: secureNetwork.fetch,
    maxMessageBytes: 4 * 1024 * 1024
  });
  const client = new McpClient({
    name: "CyberOS settings test",
    version: "2.0.0",
    requestTimeoutMs: server.timeoutSeconds * 1_000
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools({ timeoutMs: server.timeoutSeconds * 1_000 });
    return { toolCount: tools.length };
  } finally {
    await client.close().catch(() => undefined);
    await secureNetwork.close().catch(() => undefined);
  }
}

async function hasCredentialFile(secretsDir: string, serverId: string): Promise<boolean> {
  try {
    const metadata = await stat(agentMcpCredentialPath(secretsDir, serverId));
    return metadata.isFile() && (metadata.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

async function hasValidCredentials(
  secretsDir: string,
  server: Pick<AgentMcpServerRecord, "id" | "authMode">
): Promise<boolean> {
  if (server.authMode === "none") return true;
  if (!(await hasCredentialFile(secretsDir, server.id))) return false;
  try {
    await readAgentMcpCredentials(secretsDir, server);
    return true;
  } catch {
    return false;
  }
}
