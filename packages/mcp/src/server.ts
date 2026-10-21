import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CapabilityError, capabilityErrorShape, capabilityResult, type JsonValue } from "@zos/capabilities";
import { authenticateMcpClient, consumeMcpTransferToken, getNasRoot } from "@zos/db";
import { resolveSafeExistingPath } from "@zos/nas-tools";
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

const emptyInput = z.object({}).strict();
const rootsInput = z.object({ rootId: z.string().min(1).max(128).optional() }).strict();
const listFilesInput = z.object({
  rootId: z.string().min(1).max(128),
  path: z.string().max(4096).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(200).optional()
}).strict();
const pathInput = z.object({ rootId: z.string().min(1).max(128), path: z.string().min(1).max(4096) }).strict();
const readInput = pathInput.extend({ maxBytes: z.number().int().min(1).max(128 * 1024).optional() }).strict();
const searchInput = z.object({
  rootId: z.string().min(1).max(128),
  path: z.string().max(4096).optional(),
  query: z.string().min(1).max(500),
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional()
}).strict();
const limitInput = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict();
const indexStatusInput = z.object({ rootId: z.string().min(1).max(128).optional() }).strict();
const photosQueryInput = z.object({
  assetId: z.string().min(1).max(256).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional()
}).strict().refine((input) => !(input.assetId && input.cursor), "assetId cannot be combined with cursor");
const downloadsInput = z.object({
  statuses: z.array(z.enum(["queued", "running", "paused", "completed", "failed", "cancelled"])).max(6).optional(),
  limit: z.number().int().min(1).max(200).optional()
}).strict();
const alertsInput = z.object({
  status: z.enum(["firing", "resolved"]).optional(),
  limit: z.number().int().min(1).max(200).optional()
}).strict();
const terminalTabsInput = z.object({ rootId: z.string().min(1).max(128) }).strict();
const monitoringQueryInput = z.object({
  start: z.string().min(1).max(64),
  end: z.string().min(1).max(64),
  maxPoints: z.number().int().min(2).max(720).optional(),
  selectors: z.array(z.object({
    metric: z.string().min(1).max(256),
    labels: z.record(z.string().max(128), z.string().min(1).max(128)).optional(),
    transform: z.enum(["value", "rate"]).optional()
  }).strict()).min(1).max(12)
}).strict();
const runsListInput = z.object({ cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(200).optional() }).strict();
const runInput = z.object({ runId: z.string().uuid() }).strict();
const runWaitInput = runInput.extend({ timeoutMs: z.number().int().min(0).max(20_000).optional() }).strict();
const genericInput = z.object({ request: z.record(z.string(), z.json()), idempotencyKey: z.string().min(8).max(200).optional() }).strict();
const fileMutationInput = z.object({
  request: z.object({
    operation: z.enum(["mkdir", "move", "copy", "rename", "trash"]),
    rootId: z.string().min(1).max(128),
    sourcePath: z.string().min(1).max(4096).optional(),
    targetPath: z.string().min(1).max(4096).optional()
  }).strict(),
  idempotencyKey: z.string().min(8).max(200).optional()
}).strict();

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
    if (request.headers["x-zos-mcp-external"] === "1") {
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
    const external = request.headers["x-zos-mcp-external"] === "1";
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
    const external = request.headers["x-zos-mcp-external"] === "1";
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
}

function createMcpServer(runtime: ClientRuntime): McpServer {
  const server = new McpServer({ name: "zos", version: "1.3.2" }, {
    maxToolInputElements: 2_000,
    instructions: "Use rootId and root-relative paths. Mutations require approval in the first-party ZOS UI. Secrets must be entered in ZOS, never in tool arguments."
  });

  server.registerTool("zos.catalog.get", {
    title: "List ZOS capabilities",
    description: "Return the scoped capability catalog and runtime availability.",
    inputSchema: emptyInput,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => wrapTool(async (traceId) => capabilityResult({ data: await catalogForClient(runtime) }, traceId)));

  for (const descriptor of runtime.registry.listForScopes(runtime.context.subject.scopes)) {
    if (descriptor.id === "zos.catalog.get") continue;
    server.registerTool(descriptor.id, {
      title: descriptor.title,
      description: `${descriptor.description} Approval: ${descriptor.approval}.`,
      inputSchema: schemaForTool(descriptor.id, descriptor.risk === "read"),
      outputSchema,
      annotations: descriptor.annotations,
      _meta: {
        "zos/risk": descriptor.risk,
        "zos/approval": descriptor.approval,
        "zos/scopes": descriptor.requiredScopes
      }
    }, async (input) => wrapTool(async () => invokeCapability(runtime, descriptor.id, input as JsonValue)));
  }

  registerResources(server, runtime);
  registerPrompts(server);
  return server;
}

function registerResources(server: McpServer, runtime: ClientRuntime): void {
  server.registerResource("ZOS capability catalog", "zos://catalog", {
    title: "ZOS capability catalog",
    description: "Scoped capabilities and runtime availability",
    mimeType: "application/json"
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await catalogForClient(runtime)) }] }));

  if (runtime.context.subject.scopes.has("zos:system:read")) {
    server.registerResource("ZOS system status", "zos://system/status", {
      title: "ZOS system status",
      mimeType: "application/json"
    }, async (uri) => resourceFromCapability(uri, runtime, "zos.system.status", {}));
  }
  if (runtime.context.subject.scopes.has("zos:roots:read")) {
    server.registerResource("ZOS NAS root", new ResourceTemplate("zos://roots/{id}", { list: undefined }), {
      title: "ZOS NAS root",
      mimeType: "application/json"
    }, async (uri, variables) => resourceFromCapability(uri, runtime, "zos.roots.list", { rootId: String(variables.id) }));
  }
  if (runtime.context.subject.scopes.has("zos:runs:read")) {
    server.registerResource("ZOS capability run", new ResourceTemplate("zos://runs/{id}", { list: undefined }), {
      title: "ZOS capability run",
      mimeType: "application/json"
    }, async (uri, variables) => resourceFromCapability(uri, runtime, "zos.runs.get", { runId: String(variables.id) }));
  }
  if (
    runtime.context.subject.scopes.has("zos:files:read")
    && runtime.registry.get("zos.files.read")?.approval === "none"
  ) {
    server.registerResource("ZOS bounded text file", new ResourceTemplate("zos://files/{rootId}/{+path}", { list: undefined }), {
      title: "ZOS bounded text file",
      description: "A bounded UTF-8 preview addressed by NAS root and root-relative path",
      mimeType: "text/plain"
    }, async (uri, variables) => resourceFromCapability(uri, runtime, "zos.files.read", {
      rootId: String(variables.rootId),
      path: String(variables.path),
      maxBytes: 128 * 1024
    }));
  }
  if (runtime.context.subject.scopes.has("zos:photos:read")) {
    server.registerResource("ZOS photo record", new ResourceTemplate("zos://photos/{id}", { list: undefined }), {
      title: "ZOS photo record",
      description: "A non-sensitive photo catalog record; media bytes are not embedded",
      mimeType: "application/json"
    }, async (uri, variables) => resourceFromCapability(uri, runtime, "zos.photos.query", {
      assetId: String(variables.id)
    }));
  }
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt("zos.diagnose", {
    title: "Diagnose ZOS",
    description: "Inspect status, readiness, monitoring, and recent runs without changing the NAS."
  }, () => ({ messages: [{ role: "user", content: { type: "text", text: "Diagnose the current ZOS state. Start with zos.system.status and zos.roots.list, then inspect only the relevant read capabilities. Report evidence and do not propose changes until the cause is clear." } }] }));
  server.registerPrompt("zos.organize", {
    title: "Organize NAS files",
    description: "Plan a reversible file organization workflow."
  }, () => ({ messages: [{ role: "user", content: { type: "text", text: "Inspect the selected NAS root using bounded reads and search. Produce a proposed organization with an explicit diff. Submit mutations only through approval-gated ZOS proposal tools." } }] }));
  server.registerPrompt("zos.restore", {
    title: "Restore from backup",
    description: "Guide a staged restore workflow."
  }, () => ({ messages: [{ role: "user", content: { type: "text", text: "Inspect backup status and select a snapshot. Restore only to staging through an approval-gated proposal, verify the staged result, and never overwrite the live destination directly." } }] }));
}

async function resourceFromCapability(uri: URL, runtime: ClientRuntime, capabilityId: string, input: JsonValue) {
  const result = await invokeCapability(runtime, capabilityId, input);
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result) }] };
}

function schemaForTool(id: string, readOnly: boolean) {
  switch (id) {
    case "zos.roots.list": return rootsInput;
    case "zos.files.list": return listFilesInput;
    case "zos.files.stat": return pathInput;
    case "zos.files.read": return readInput;
    case "zos.files.resource-link": return pathInput;
    case "zos.files.search": return searchInput;
    case "zos.files.mutate": return fileMutationInput;
    case "zos.index.status": return indexStatusInput;
    case "zos.photos.query": return photosQueryInput;
    case "zos.downloads.list": return downloadsInput;
    case "zos.alerts.read": return alertsInput;
    case "zos.notifications.list": return z.object({ limit: z.number().int().min(1).max(100).optional() }).strict();
    case "zos.terminal.tabs": return terminalTabsInput;
    case "zos.monitoring.query": return monitoringQueryInput;
    case "zos.operations.list":
    case "zos.backup.status": return limitInput;
    case "zos.runs.get":
    case "zos.runs.cancel": return runInput;
    case "zos.runs.list": return runsListInput;
    case "zos.runs.wait": return runWaitInput;
    default: return readOnly ? emptyInput : genericInput;
  }
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
