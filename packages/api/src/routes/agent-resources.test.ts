import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentSkill,
  createMcpClient,
  createSession,
  getAgentMcpServer,
  openCyberOsDb,
  updateSessionResourceTrust,
  type CyberOsDatabase
} from "@cyberos/db";
import { registerMcp } from "@cyberos/mcp";
import { loadCyberOsRuntime } from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { registerAgentResourceRoutes } from "./agent-resources.js";
import { removeAgentMcpCredentials } from "../lib/agent-mcp-service.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-agent-resource-routes-"));
  await mkdir(path.join(tempDir, "data"), { recursive: true });
  await mkdir(path.join(tempDir, "state"), { recursive: true });
  db = openCyberOsDb(path.join(tempDir, "state", "cyberos.sqlite"));
});

afterEach(async () => {
  if (db.open) db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("agent MCP settings routes", () => {
  it("restores a credential file when the database mutation fails", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const secretsDir = testConfig().paths.mcpSecretsDir;
    const credentialPath = path.join(secretsDir, `${id}.json`);
    await mkdir(secretsDir, { recursive: true });
    await writeFile(credentialPath, JSON.stringify({ bearerToken: "secret-token" }), { mode: 0o600 });

    await expect(removeAgentMcpCredentials(secretsDir, id, () => {
      throw new Error("database unavailable");
    })).rejects.toThrow(/database unavailable/u);

    await expect(readFile(credentialPath, "utf8")).resolves.toContain("secret-token");
  });

  it("defaults the built-in MCP to enabled and removes the legacy endpoint", async () => {
    const server = createServer();
    const response = await server.inject({ method: "GET", url: "/api/settings/mcp" });
    const legacy = await server.inject({ method: "GET", url: "/api/settings/agent-mcp" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ settings: { builtIn: { enabled: true }, servers: [], generation: 1 } });
    expect(legacy.statusCode).toBe(404);
    await server.close();
  });

  it("validates server slugs, masks credentials, and resets trust after authentication changes", async () => {
    const server = createServer();
    const reserved = await createServerRequest(server, { name: "cyberos" });
    const invalid = await createServerRequest(server, { name: "Home Assistant" });
    expect(reserved.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);

    const created = await createServerRequest(server, { name: "home-assistant" });
    expect(created.statusCode).toBe(201);
    const entry = created.json().server as { id: string };

    const unknownCredential = await server.inject({
      method: "PUT",
      url: `/api/settings/mcp/servers/${entry.id}/credentials`,
      payload: { bearerToken: "secret-token", unexpected: "leak", confirmed: true }
    });
    expect(unknownCredential.statusCode).toBe(400);

    const saved = await server.inject({
      method: "PUT",
      url: `/api/settings/mcp/servers/${entry.id}/credentials`,
      payload: { bearerToken: "secret-token", confirmed: true }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("secret-token");
    expect(saved.json().server).toMatchObject({ credentialsConfigured: true, credentialHeaderNames: ["Authorization"] });
    const credentialPath = path.join(testConfig().paths.mcpSecretsDir, `${entry.id}.json`);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(credentialPath, "utf8")).toContain("secret-token");

    const changed = await server.inject({
      method: "PATCH",
      url: `/api/settings/mcp/servers/${entry.id}`,
      payload: { authMode: "headers", confirmed: true }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().server).toMatchObject({
      authMode: "headers",
      enabled: false,
      testStatus: "untested",
      credentialsConfigured: false,
      credentialHeaderNames: []
    });
    expect(getAgentMcpServer(db, entry.id)?.trustedAt).toBeNull();
    await expect(stat(credentialPath)).rejects.toMatchObject({ code: "ENOENT" });
    await server.close();
  });

  it("rejects dangerous custom headers and enablement before a successful test", async () => {
    const server = createServer();
    const created = await createServerRequest(server, { name: "private-tools", authMode: "headers" });
    const id = created.json().server.id as string;

    const header = await server.inject({
      method: "PUT",
      url: `/api/settings/mcp/servers/${id}/credentials`,
      payload: { headers: { Host: "attacker", "X-Token": "secret" }, confirmed: true }
    });
    const enabled = await server.inject({
      method: "PATCH",
      url: `/api/settings/mcp/servers/${id}`,
      payload: { enabled: true, confirmed: true }
    });

    expect(header.statusCode).toBe(400);
    expect(enabled.statusCode).toBe(400);
    expect(enabled.json().error).toMatch(/pass a connection test/u);
    await server.close();
  });

  it("discovers tools over authenticated MCP Streamable HTTP before enablement", async () => {
    const external = Fastify();
    const client = createMcpClient(db, {
      name: "External MCP test",
      kind: "local",
      scopes: ["cyberos:catalog:read"]
    });
    registerMcp(external, { db, config: testConfig() }, { enabled: true });
    const address = await external.listen({ host: "127.0.0.1", port: 0 });
    const server = createServer();
    try {
      const created = await createServerRequest(server, {
        name: "local-cyberos",
        url: `${address}/mcp`
      });
      const id = created.json().server.id as string;
      const credentials = await server.inject({
        method: "PUT",
        url: `/api/settings/mcp/servers/${id}/credentials`,
        payload: { bearerToken: client.token, confirmed: true }
      });
      expect(credentials.statusCode).toBe(200);

      const tested = await server.inject({
        method: "POST",
        url: `/api/settings/mcp/servers/${id}/test`,
        payload: {}
      });
      expect(tested.statusCode).toBe(200);
      expect(tested.json().server).toMatchObject({
        enabled: false,
        testStatus: "ready",
        credentialsConfigured: true
      });
      expect(tested.json().server.toolCount).toBeGreaterThan(0);

      const enabled = await server.inject({
        method: "PATCH",
        url: `/api/settings/mcp/servers/${id}`,
        payload: { enabled: true, confirmed: true }
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json().server.enabled).toBe(true);
    } finally {
      await server.close();
      await external.close();
    }
  });
});

describe("agent Skills settings routes", () => {
  it("keeps global Skills separate from read-only project Skills and reports session trust", async () => {
    const projectSkillDir = path.join(tempDir, "data", "project", ".agents", "skills", "project-review");
    await mkdir(projectSkillDir, { recursive: true });
    await writeFile(
      path.join(projectSkillDir, "SKILL.md"),
      "---\nname: project-review\ndescription: Review this project\n---\n"
    );
    createAgentSkill(db, {
      name: "global-review",
      description: "Review every project",
      version: null,
      sourceType: "git",
      sourceUrl: "https://example.com/skills.git",
      sourceRef: "main",
      sourceSubdirectory: null,
      sourceStoragePoolId: null,
      sourcePath: null,
      resolvedCommit: "a".repeat(40),
      digest: "b".repeat(64),
      enabled: true,
      diagnostics: []
    });
    const session = createSession(db, { currentPath: "project" });
    const server = createServer();

    const untrusted = await server.inject({
      method: "GET",
      url: `/api/settings/skills?sessionId=${encodeURIComponent(session.id)}`
    });
    expect(untrusted.json()).toMatchObject({
      settings: {
        global: [{ name: "global-review", enabled: true }],
        project: {
          sessionId: session.id,
          path: "project",
          trusted: false,
          skills: [{ name: "project-review", valid: true }]
        }
      }
    });

    updateSessionResourceTrust(db, { sessionId: session.id, trusted: true });
    const trusted = await server.inject({
      method: "GET",
      url: `/api/settings/skills?sessionId=${encodeURIComponent(session.id)}`
    });
    expect(trusted.json().settings.project).toMatchObject({ trusted: true });
    await server.close();
  });
});

function testConfig() {
  return loadCyberOsRuntime({ CYBEROS_ROOT: tempDir }, tempDir);
}

function createServer() {
  const server = Fastify();
  registerAgentResourceRoutes(server, {
    config: testConfig(),
    db,
    monitoring: {} as ApiRouteContext["monitoring"]
  });
  return server;
}

async function createServerRequest(
  server: ReturnType<typeof Fastify>,
  overrides: Record<string, unknown>
) {
  return await server.inject({
    method: "POST",
    url: "/api/settings/mcp/servers",
    payload: {
      name: "home-assistant",
      description: "Local automation",
      url: "http://127.0.0.1:8123/mcp",
      timeoutSeconds: 30,
      exposure: "codemode",
      authMode: "bearer",
      allowInsecureHttp: true,
      confirmed: true,
      ...overrides
    }
  });
}
