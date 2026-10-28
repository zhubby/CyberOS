import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CapabilityError, capabilityErrorShape, capabilityResult, type JsonValue } from "@cyberos/capabilities";
import {
  authenticateMcpClient,
  consumeMcpResourceToken,
  consumeMcpTransferToken,
  getNasRoot,
  type McpResourceRecord
} from "@cyberos/db";
import { assertNoSymlinkPathSegments, resolveSafeExistingPath } from "@cyberos/nas-tools";
import { catalogForClient, createClientRuntime, invokeCapability, type ClientRuntime, type McpRuntimeDependencies } from "./runtime.js";

export interface McpRegistrationOptions {
  enabled: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  maxConcurrentPerClient?: number;
  rateLimitPerClientPerMinute?: number;
}

const outputSchema = z.object({
  schemaVersion: z.literal("1.0"),
  data: z.json(),
  warnings: z.array(z.string()),
  page: z.object({ nextCursor: z.string().nullable(), limit: z.number().int() }).nullable(),
  runId: z.string().nullable(),
  traceId: z.string()
});

export function registerMcp(server: FastifyInstance, dependencies: McpRuntimeDependencies, options: McpRegistrationOptions): void {
  if (!options.enabled) return;
  const allowedHosts = options.allowedHosts?.length ? options.allowedHosts : ["localhost", "127.0.0.1", "[::1]"];
  const allowedOrigins = options.allowedOrigins?.length ? options.allowedOrigins : ["localhost", "127.0.0.1", "[::1]"];
  const validateHost = hostHeaderValidation(allowedHosts);
  const validateOrigin = originValidation(allowedOrigins);
  const active = new Map<string, number>();
  const clientRates = new Map<string, { startedAt: number; count: number }>();
  const maxConcurrent = options.maxConcurrentPerClient ?? 4;
  const rateLimitPerClient = options.rateLimitPerClientPerMinute ?? 120;

  const guards = [
    async (request: FastifyRequest, reply: FastifyReply) => validateHost(request, reply),
    async (request: FastifyRequest, reply: FastifyReply) => validateOrigin(request, reply)
  ];

  server.post("/mcp", {
    bodyLimit: 1024 * 1024,
    preHandler: guards,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (request.headers["x-cyberos-mcp-external"] === "1") {
      if (dependencies.config.mcp?.externalEnabled !== true) {
        reply.status(403).send({ error: "external_mcp_disabled" });
        return;
      }
      if (request.headers["x-forwarded-proto"] !== "https") {
        reply.status(403).send({ error: "https_required" });
        return;
      }
    }
    const token = bearerToken(request.headers.authorization);
    const client = token ? authenticateMcpClient(dependencies.db, token) : null;
    if (!client) {
      reply.header("www-authenticate", "Bearer").status(401).send({ error: "invalid_token" });
      return;
    }
    const now = Date.now();
    const currentRate = clientRates.get(client.id);
    if (!currentRate || now - currentRate.startedAt >= 60_000) {
      clientRates.set(client.id, { startedAt: now, count: 1 });
    } else if (currentRate.count >= rateLimitPerClient) {
      reply.status(429).send({ error: "rate_limited" });
      return;
    } else {
      currentRate.count += 1;
    }
    const count = active.get(client.id) ?? 0;
    if (count >= maxConcurrent) {
      reply.status(429).send({ error: "rate_limited" });
      return;
    }
    active.set(client.id, count + 1);
    const external = request.headers["x-cyberos-mcp-external"] === "1";
    const forwardedHost = request.headers["x-forwarded-host"];
    const externalHost = typeof forwardedHost === "string" ? forwardedHost : Array.isArray(forwardedHost) ? forwardedHost[0] : undefined;
    const transferBaseUrl = external
      ? externalHost ? `https://${externalHost}` : undefined
      : `http://127.0.0.1:${dependencies.config.api.port}`;
    const runtime = createClientRuntime({ ...dependencies, ...(transferBaseUrl ? { transferBaseUrl } : {}) }, client);
    const handler = createMcpHandler(() => createMcpServer(runtime), {
      legacy: "stateless",
      responseMode: "auto",
      maxRequestBodySize: 1024 * 1024,
      onerror: (error) => request.log.error({ err: error, clientId: client.id }, "MCP request failed")
    });
    const nodeHandler = toNodeHandler(handler, {
      maxRequestBodySize: 1024 * 1024,
      onerror: (error) => request.log.error({ err: error, clientId: client.id }, "MCP adapter failed")
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      active.set(client.id, Math.max(0, (active.get(client.id) ?? 1) - 1));
      void handler.close();
    };
    reply.raw.once("close", close);
    try {
      reply.hijack();
      await nodeHandler(
        request.raw as unknown as Parameters<typeof nodeHandler>[0],
        reply.raw,
        request.body
      );
    } finally {
      close();
    }
  });

  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.status(405).send({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Stateless MCP accepts POST only" },
      id: null
    });
  };
  server.get("/mcp", { preHandler: guards }, methodNotAllowed);
  server.delete("/mcp", { preHandler: guards }, methodNotAllowed);

  server.get<{ Params: { token: string } }>("/mcp-transfer/:token", { preHandler: guards }, async (request, reply) => {
    const external = request.headers["x-cyberos-mcp-external"] === "1";
    if (external && (dependencies.config.mcp?.externalEnabled !== true || request.headers["x-forwarded-proto"] !== "https")) {
      reply.status(403).send({ error: "https_required" });
      return;
    }
    const token = bearerToken(request.headers.authorization);
    const client = token ? authenticateMcpClient(dependencies.db, token) : null;
    if (!client) {
      reply.header("www-authenticate", "Bearer").status(401).send({ error: "invalid_token" });
      return;
    }
    const transfer = consumeMcpTransferToken(dependencies.db, {
      token: request.params.token,
      clientId: client.id
    });
    if (!transfer) {
      reply.status(404).send({ error: "transfer_not_found" });
      return;
    }
    const root = getNasRoot(dependencies.db, transfer.rootId);
    if (!root) {
      reply.status(404).send({ error: "root_not_found" });
      return;
    }
    let file: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const safe = await resolveSafeExistingPath(root.path, transfer.relativePath);
      file = await open(safe.realPath, "r");
      const current = await file.stat();
      if (!current.isFile() || current.size !== transfer.sizeBytes || current.mtime.toISOString() !== transfer.modifiedAt) {
        await file.close();
        file = null;
        reply.status(409).send({ error: "resource_changed" });
        return;
      }
      reply.header("content-type", transfer.mimeType);
      reply.header("content-length", String(transfer.sizeBytes));
      reply.header("cache-control", "private, no-store");
      reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safe.relativePath.split("/").at(-1) ?? "download")}`);
      const stream = file.createReadStream();
      file = null;
      return reply.send(stream);
    } catch {
      if (file) await file.close().catch(() => undefined);
      reply.status(404).send({ error: "file_not_found" });
    }
  });

  server.get<{ Params: { token: string } }>("/mcp-resource/:token", { preHandler: guards }, async (request, reply) => {
    const external = request.headers["x-cyberos-mcp-external"] === "1";
    if (external && (dependencies.config.mcp?.externalEnabled !== true || request.headers["x-forwarded-proto"] !== "https")) {
      reply.status(403).send({ error: "https_required" });
      return;
    }
    const credential = bearerToken(request.headers.authorization);
    const client = credential ? authenticateMcpClient(dependencies.db, credential) : null;
    if (!client) {
      reply.header("www-authenticate", "Bearer").status(401).send({ error: "invalid_token" });
      return;
    }
    const resource = consumeMcpResourceToken(dependencies.db, {
      token: request.params.token,
      clientId: client.id
    });
    if (!resource) {
      reply.status(404).send({ error: "resource_not_found" });
      return;
    }
    if (!dependencies.resourceResponder && resource.kind !== "file") {
      reply.status(503).send({ error: "resource_handler_unavailable" });
      return;
    }
    try {
      return dependencies.resourceResponder
        ? await dependencies.resourceResponder(resource, request, reply)
        : await serveFallbackFileResource(dependencies, resource, reply);
    } catch (error) {
      request.log.warn({ err: error, clientId: client.id, kind: resource.kind }, "MCP resource download failed");
      if (reply.sent) return reply;
      const shaped = resourceErrorShape(error);
      reply.status(shaped.statusCode).send({ error: shaped.code });
    }
  });
}

function createMcpServer(runtime: ClientRuntime): McpServer {
  const server = new McpServer({ name: "cyberos", version: "2.0.0" }, {
    maxToolInputElements: 2_000,
    instructions: "Use rootId and root-relative paths. Mutations require approval in the first-party CyberOS UI. Secrets must be entered in CyberOS, never in tool arguments."
  });

  server.registerTool("cyberos.catalog.get", {
    title: "List CyberOS capabilities",
    description: "Return the scoped capability catalog and runtime availability.",
    inputSchema: z.fromJSONSchema(runtime.registry.get("cyberos.catalog.get")!.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => wrapTool(async (traceId) => capabilityResult({ data: await catalogForClient(runtime) }, traceId)));

  for (const descriptor of runtime.registry.listForScopes(runtime.context.subject.scopes)) {
    if (descriptor.id === "cyberos.catalog.get") continue;
    server.registerTool(descriptor.id, {
      title: descriptor.title,
      description: `${descriptor.description} Approval: ${descriptor.approval}.`,
      inputSchema: z.fromJSONSchema(descriptor.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
      outputSchema,
      annotations: descriptor.annotations,
      _meta: {
        "cyberos/risk": descriptor.risk,
        "cyberos/approval": descriptor.approval,
        "cyberos/scopes": descriptor.requiredScopes
      }
    }, async (input) => wrapTool(async () => invokeCapability(runtime, descriptor.id, input as JsonValue)));
  }

  registerResources(server, runtime);
  registerPrompts(server);
  return server;
}

function registerResources(server: McpServer, runtime: ClientRuntime): void {
  server.registerResource("CyberOS capability catalog", "cyberos://catalog", {
    title: "CyberOS capability catalog",
    description: "Scoped capabilities and runtime availability",
    mimeType: "application/json"
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await catalogForClient(runtime)) }] }));

  if (runtime.context.subject.scopes.has("cyberos:system:read")) {
    server.registerResource("CyberOS system status", "cyberos://system/status", {
      title: "CyberOS system status",
      mimeType: "application/json"
    }, async (uri) => resourceFromCapability(uri, runtime, "cyberos.system.status", {}));
  }
  if (runtime.context.subject.scopes.has("cyberos:roots:read")) {
    server.registerResource("CyberOS NAS root", new ResourceTemplate("cyberos://roots/{id}", { list: undefined }), {
      title: "CyberOS NAS root",
      mimeType: "application/json"
    }, async (uri, variables) => resourceFromCapability(uri, runtime, "cyberos.roots.list", { rootId: String(variables.id) }));
  }
  if (runtime.context.subject.scopes.has("cyberos:runs:read")) {
    server.registerResource("CyberOS capability run", new ResourceTemplate("cyberos://runs/{id}", { list: undefined }), {
      title: "CyberOS capability run",
      mimeType: "application/json"
    }, async (uri, variables) => resourceFromCapability(uri, runtime, "cyberos.runs.get", { runId: String(variables.id) }));
  }
  if (
    runtime.context.subject.scopes.has("cyberos:files:read")
    && runtime.registry.get("cyberos.files.read")?.approval === "none"
  ) {
    server.registerResource("CyberOS bounded text file", new ResourceTemplate("cyberos://files/{rootId}/{+path}", { list: undefined }), {
      title: "CyberOS bounded text file",
      description: "A bounded UTF-8 preview addressed by NAS root and root-relative path",
      mimeType: "text/plain"
    }, async (uri, variables) => resourceFromCapability(uri, runtime, "cyberos.files.read", {
      rootId: String(variables.rootId),
      path: String(variables.path),
      maxBytes: 128 * 1024
    }));
  }
  if (runtime.context.subject.scopes.has("cyberos:photos:read")) {
    server.registerResource("CyberOS photo record", new ResourceTemplate("cyberos://photos/{id}", { list: undefined }), {
      title: "CyberOS photo record",
      description: "A non-sensitive photo catalog record; media bytes are not embedded",
      mimeType: "application/json"
    }, async (uri, variables) => resourceFromCapability(uri, runtime, "cyberos.photos.query", {
      assetId: String(variables.id)
    }));
  }
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt("cyberos.diagnose", {
    title: "Diagnose CyberOS",
    description: "Inspect status, readiness, monitoring, and recent runs without changing the NAS."
  }, () => ({ messages: [{ role: "user", content: { type: "text", text: "Diagnose the current CyberOS state. Start with cyberos.system.status and cyberos.roots.list, then inspect only the relevant read capabilities. Report evidence and do not propose changes until the cause is clear." } }] }));
  server.registerPrompt("cyberos.organize", {
    title: "Organize NAS files",
    description: "Plan a reversible file organization workflow."
  }, () => ({ messages: [{ role: "user", content: { type: "text", text: "Inspect the selected NAS root using bounded reads and search. Produce a proposed organization with an explicit diff. Submit mutations only through approval-gated CyberOS proposal tools." } }] }));
  server.registerPrompt("cyberos.restore", {
    title: "Restore from backup",
    description: "Guide a staged restore workflow."
  }, () => ({ messages: [{ role: "user", content: { type: "text", text: "Inspect backup status and select a snapshot. Restore only to staging through an approval-gated proposal, verify the staged result, and never overwrite the live destination directly." } }] }));
}

async function resourceFromCapability(uri: URL, runtime: ClientRuntime, capabilityId: string, input: JsonValue) {
  const result = await invokeCapability(runtime, capabilityId, input);
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result) }] };
}

async function wrapTool(operation: (traceId: string) => Promise<ReturnType<typeof capabilityResult>>) {
  const traceId = randomUUID();
  try {
    const result = await operation(traceId);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    const capabilityError = error instanceof CapabilityError
      ? error
      : new CapabilityError("INTERNAL", "Capability invocation failed", { cause: error });
    const shape = capabilityErrorShape(capabilityError, traceId);
    const result = capabilityResult({ data: { error: JSON.parse(JSON.stringify(shape)) as JsonValue } }, traceId);
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(shape) }], structuredContent: result };
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  return match?.[1] ?? null;
}

function resourceErrorShape(error: unknown): { statusCode: number; code: string } {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { statusCode?: unknown; code?: unknown };
    if (
      typeof candidate.statusCode === "number" && candidate.statusCode >= 400 && candidate.statusCode <= 599 &&
      typeof candidate.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(candidate.code)
    ) {
      return { statusCode: candidate.statusCode, code: candidate.code };
    }
  }
  return { statusCode: 404, code: "resource_not_found" };
}

async function serveFallbackFileResource(
  dependencies: McpRuntimeDependencies,
  resource: McpResourceRecord,
  reply: FastifyReply
): Promise<unknown> {
  if (!resource.descriptor || typeof resource.descriptor !== "object" || Array.isArray(resource.descriptor)) {
    throw { statusCode: 400, code: "invalid_resource" };
  }
  const descriptor = resource.descriptor as Record<string, JsonValue>;
  if (typeof descriptor.rootId !== "string" || typeof descriptor.path !== "string") {
    throw { statusCode: 400, code: "invalid_resource" };
  }
  const root = getNasRoot(dependencies.db, descriptor.rootId);
  if (!root) throw { statusCode: 404, code: "root_not_found" };
  const safe = await resolveSafeExistingPath(root.path, descriptor.path);
  await assertNoSymlinkPathSegments(safe.rootRealPath, safe.absolutePath);
  const file = await open(safe.realPath, "r");
  const current = await file.stat();
  const revision = createHash("sha256").update(JSON.stringify({
    relativePath: safe.relativePath,
    sizeBytes: current.size,
    modifiedAt: current.mtime.toISOString()
  }), "utf8").digest("hex");
  if (!current.isFile() || revision !== resource.revision) {
    await file.close();
    throw { statusCode: 409, code: "resource_changed" };
  }
  reply.header("content-type", resource.mimeType);
  reply.header("content-length", String(current.size));
  reply.header("cache-control", "private, no-store");
  reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(resource.fileName)}`);
  return reply.send(file.createReadStream());
}
