import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDownloadTask,
  createMcpClient,
  decideCapabilityApproval,
  ensureNasRoots,
  getCapabilityApprovalByRun,
  openZosDb,
  saveModelProviderSettings,
  transitionDownloadTask,
  type ZosDatabase
} from "@zos/db";
import { executeApprovedCapabilityRun } from "@zos/capability-runtime";
import type { ZosConfig } from "@zos/shared";
import { registerMcp } from "./server.js";

let tempDir: string;
let db: ZosDatabase;
let app: ReturnType<typeof Fastify>;
let token: string;
let clientId: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-mcp-"));
  await writeFile(path.join(tempDir, "hello.txt"), "hello from ZOS", "utf8");
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "primary", name: "Primary", path: tempDir }]);
  const client = createMcpClient(db, {
    name: "MCP test",
    kind: "local",
    scopes: [
      "zos:catalog:read", "zos:downloads:read", "zos:files:read", "zos:files:propose", "zos:index:read", "zos:photos:read",
      "zos:roots:read", "zos:settings:read", "zos:system:read", "zos:runs:read"
    ]
  });
  token = client.token;
  clientId = client.id;
  app = Fastify();
  registerMcp(app, { db, config: testConfig(tempDir) }, { enabled: true });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("MCP Streamable HTTP", () => {
  it("requires a paired bearer token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { host: "127.0.0.1" },
      payload: initializeRequest("2025-11-25")
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
  });

  it("rejects untrusted Host and Origin headers", async () => {
    const untrustedHost = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { host: "attacker.example", authorization: `Bearer ${token}` },
      payload: initializeRequest("2025-11-25")
    });
    expect(untrustedHost.statusCode).toBeGreaterThanOrEqual(400);

    const untrustedOrigin = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1",
        origin: "https://attacker.example",
        authorization: `Bearer ${token}`
      },
      payload: initializeRequest("2025-11-25")
    });
    expect(untrustedOrigin.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("rejects external MCP unless it is enabled and forwarded over HTTPS", async () => {
    const disabled = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1",
        "x-zos-mcp-external": "1",
        "x-forwarded-proto": "https",
        authorization: `Bearer ${token}`
      },
      payload: initializeRequest("2025-11-25")
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toEqual({ error: "external_mcp_disabled" });

    await app.close();
    app = Fastify();
    const config = testConfig(tempDir);
    config.mcp = {
      enabled: true,
      piEnabled: false,
      piTokenFile: path.join(tempDir, "pi.token"),
      legacyPiToolsEnabled: false,
      externalEnabled: true,
      shellEnabled: false,
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      allowedOrigins: ["localhost", "127.0.0.1", "[::1]"],
      maxConcurrentPerClient: 4
    };
    registerMcp(app, { db, config }, { enabled: true });
    await app.ready();
    const plaintext = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1",
        "x-zos-mcp-external": "1",
        "x-forwarded-proto": "http",
        authorization: `Bearer ${token}`
      },
      payload: initializeRequest("2025-11-25")
    });
    expect(plaintext.statusCode).toBe(403);
    expect(plaintext.json()).toEqual({ error: "https_required" });
  });

  it("rate limits each authenticated client independently", async () => {
    await app.close();
    app = Fastify();
    registerMcp(app, { db, config: testConfig(tempDir) }, {
      enabled: true,
      rateLimitPerClientPerMinute: 1
    });
    await app.ready();

    expect((await postMcp(initializeRequest("2025-11-25"))).statusCode).toBe(200);
    expect((await postMcp(initializeRequest("2025-11-25"))).statusCode).toBe(429);

    const other = createMcpClient(db, { name: "Other", kind: "local", scopes: ["zos:catalog:read"] });
    const independent = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${other.token}`,
        accept: "application/json, text/event-stream"
      },
      payload: initializeRequest("2025-11-25")
    });
    expect(independent.statusCode).toBe(200);
  });

  it("negotiates the Pi-era 2025 protocol", async () => {
    const response = await postMcp(initializeRequest("2025-11-25"));
    expect(response.statusCode).toBe(200);
    expect(parseMcpResponse(response.body)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "zos", version: "1.3.2" }
      }
    });
  });

  it("negotiates the 2026 protocol through server discovery", async () => {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "vitest-modern", version: "1.0.0" }, {
      versionNegotiation: { mode: { pin: "2026-07-28" } }
    });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", address), {
      authProvider: { token: async () => token }
    });
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "zos.files.read")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("filters tools by scope and reads root-relative files", async () => {
    const list = await postMcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "2025-11-25");
    expect(list.statusCode).toBe(200);
    const names = (parseMcpResponse(list.body).result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("zos.files.read");
    expect(names).not.toContain("zos.docker.manage-propose");

    const read = await postMcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "zos.files.read", arguments: { rootId: "primary", path: "hello.txt" } }
    }, "2025-11-25");
    expect(read.statusCode).toBe(200);
    const readPayload = parseMcpResponse(read.body);
    expect(readPayload.result.structuredContent).toMatchObject({
      schemaVersion: "1.0",
      data: { rootId: "primary", preview: { content: "hello from ZOS", truncated: false } }
    });
    expect(JSON.stringify(readPayload)).not.toContain(tempDir);
  });

  it("refuses NAS reads when a required mount is not ready", async () => {
    db.prepare("UPDATE nas_roots SET mount_policy = 'required' WHERE id = 'primary'").run();
    const read = await postMcp({
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: { name: "zos.files.read", arguments: { rootId: "primary", path: "hello.txt" } }
    }, "2025-11-25");

    const payload = parseMcpResponse(read.body);
    expect(payload.result).toMatchObject({
      isError: true,
      structuredContent: {
        data: { error: { code: "NOT_READY", retryable: true } }
      }
    });
  });

  it("exposes scoped resource templates and never returns model credentials", async () => {
    saveModelProviderSettings(db, {
      providerName: "openai",
      baseUrl: "https://user:password@example.test/v1?token=secret",
      model: "test-model",
      apiKey: "super-secret-api-key"
    });
    const templates = await postMcp({
      jsonrpc: "2.0",
      id: 30,
      method: "resources/templates/list",
      params: {}
    }, "2025-11-25");
    const templateUris = (parseMcpResponse(templates.body).result.resourceTemplates as Array<{ uriTemplate: string }>)
      .map((template) => template.uriTemplate);
    expect(templateUris).toContain("zos://files/{rootId}/{+path}");
    expect(templateUris).toContain("zos://photos/{id}");

    const settings = await postMcp({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "zos.settings.public", arguments: {} }
    }, "2025-11-25");
    const payload = parseMcpResponse(settings.body);
    expect(payload.result.structuredContent).toMatchObject({
      data: {
        model: {
          providerName: "openai",
          baseUrl: "https://example.test/v1",
          model: "test-model",
          apiKeyConfigured: true
        }
      }
    });
    expect(JSON.stringify(payload)).not.toMatch(/super-secret-api-key|user:password|token=secret/u);
  });

  it("redacts download credentials and host paths", async () => {
    const task = createDownloadTask(db, {
      url: "https://user:password@example.test/file.iso?token=secret",
      rootId: "primary",
      storagePoolId: "pool-1",
      targetDirectory: "Downloads",
      targetFileName: "file.iso",
      targetPath: "Downloads/file.iso"
    });
    transitionDownloadTask(db, {
      id: task.id,
      from: ["queued"],
      to: "failed",
      error: "permission denied: /secret/host/path",
      errorCode: "permission"
    });

    const response = await postMcp({
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: { name: "zos.downloads.list", arguments: {} }
    }, "2025-11-25");
    const body = response.body;
    expect(body).not.toMatch(/user:password|token=secret|\/secret\/host\/path/u);
    expect(parseMcpResponse(body).result.structuredContent).toMatchObject({
      data: { tasks: [{ url: "https://example.test/file.iso", error: "permission denied: [path]", partialPath: null }] }
    });
  });

  it("rejects non-POST transport methods", async () => {
    const response = await app.inject({ method: "GET", url: "/mcp", headers: { host: "127.0.0.1" } });
    expect(response.statusCode).toBe(405);
  });

  it("creates an immutable file proposal and executes it only after first-party approval", async () => {
    const proposed = await postMcp({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "zos.files.mutate-propose",
        arguments: {
          request: { operation: "move", rootId: "primary", sourcePath: "hello.txt", targetPath: "moved.txt" },
          idempotencyKey: "move-hello-0001"
        }
      }
    }, "2025-11-25");
    const payload = parseMcpResponse(proposed.body);
    const structured = payload.result.structuredContent as { runId: string; data: { state: string } };
    expect(structured.data.state).toBe("waiting_approval");
    await expect(readFile(path.join(tempDir, "hello.txt"), "utf8")).resolves.toBe("hello from ZOS");

    const approval = getCapabilityApprovalByRun(db, structured.runId)!;
    expect(decideCapabilityApproval(db, {
      approvalId: approval.id,
      expectedRevision: approval.revision,
      decision: "approved",
      decidedBy: "local-admin"
    })).not.toBeNull();
    const run = await executeApprovedCapabilityRun({ db, config: testConfig(tempDir) }, structured.runId);

    expect(run).toMatchObject({ state: "succeeded", clientId, capabilityId: "zos.files.mutate-propose" });
    await expect(readFile(path.join(tempDir, "moved.txt"), "utf8")).resolves.toBe("hello from ZOS");
    await expect(access(path.join(tempDir, "hello.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(run.result)).not.toContain(tempDir);
  });

  it("serves subject-bound file links exactly once", async () => {
    const linked = await postMcp({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "zos.files.resource-link",
        arguments: { rootId: "primary", path: "hello.txt" }
      }
    }, "2025-11-25");
    const data = (parseMcpResponse(linked.body).result.structuredContent as {
      data: { url: string; mimeType: string; oneTime: boolean };
    }).data;
    expect(data).toMatchObject({ mimeType: "text/plain", oneTime: true });
    const pathname = new URL(data.url).pathname;

    const other = createMcpClient(db, { name: "Other", kind: "local", scopes: ["zos:files:read"] });
    const forbidden = await app.inject({
      method: "GET",
      url: pathname,
      headers: { host: "127.0.0.1", authorization: `Bearer ${other.token}` }
    });
    expect(forbidden.statusCode).toBe(404);

    const download = await app.inject({
      method: "GET",
      url: pathname,
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` }
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("hello from ZOS");
    expect(download.headers["cache-control"]).toBe("private, no-store");

    const replay = await app.inject({
      method: "GET",
      url: pathname,
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` }
    });
    expect(replay.statusCode).toBe(404);
  });

  it("rejects a resource link when the file changed after issuance", async () => {
    const linked = await postMcp({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "zos.files.resource-link",
        arguments: { rootId: "primary", path: "hello.txt" }
      }
    }, "2025-11-25");
    const url = (parseMcpResponse(linked.body).result.structuredContent as {
      data: { url: string };
    }).data.url;
    await writeFile(path.join(tempDir, "hello.txt"), "replacement content is different", "utf8");

    const changed = await app.inject({
      method: "GET",
      url: new URL(url).pathname,
      headers: { host: "127.0.0.1", authorization: `Bearer ${token}` }
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: "resource_changed" });
  });
});

async function postMcp(payload: object, protocolVersion?: string) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {})
    },
    payload
  });
}

function initializeRequest(protocolVersion: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" }
    }
  };
}

interface McpTestResponse {
  jsonrpc: string;
  id: number;
  result: Record<string, unknown>;
}

function parseMcpResponse(body: string): McpTestResponse {
  if (!body.startsWith("event:")) return JSON.parse(body) as McpTestResponse;
  const data = body.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  if (!data) throw new Error("MCP SSE response did not contain a data event");
  return JSON.parse(data) as McpTestResponse;
}

function testConfig(root: string): ZosConfig {
  return {
    environment: "development",
    dataDir: root,
    databasePath: path.join(root, "zos.sqlite"),
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 100 },
    admin: { displayName: "Admin", authMode: "local-only" },
    model: { provider: "pi", piCommand: "pi", localEndpoint: null },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1_000, consoleShells: ["/bin/sh"] },
    hostd: { socketPath: path.join(root, "hostd.sock") },
    shares: { enabled: false, account: { username: "zos", password: null }, shares: [] },
    terminal: { user: "zos", termuxSocketPath: path.join(root, "termux.sock"), sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: path.join(root, "vod.sock"), statePath: path.join(root, "vod.json"), commandTimeoutMs: 1_000, startupTimeoutMs: 1_000, checkpointIntervalMs: 1_000, retryBaseDelayMs: 100, retryMaxDelayMs: 1_000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: "default", hwdec: "auto-safe", user: "zos" },
    nasRoots: [{ id: "primary", name: "Primary", path: root }]
  };
}
