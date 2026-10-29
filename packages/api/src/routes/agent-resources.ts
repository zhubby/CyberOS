import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  createAgentMcpServer,
  createAgentSkill,
  deleteAgentMcpServer,
  deleteAgentSkill,
  getAgentMcpServer,
  getAgentResourceGeneration,
  getAgentSkill,
  getSession,
  listAgentMcpServers,
  listAgentSkills,
  updateAgentMcpServer,
  updateAgentSkill
} from "@cyberos/db";
import { resolveSafeExistingPath } from "@cyberos/storage-tools";
import type {
  AgentMcpAuthMode,
  AgentMcpExposure,
  AgentMcpServerRecord,
  AgentSkillRecord,
  PublicAgentMcpConfiguration,
  PublicAgentSkillsConfiguration
} from "@cyberos/shared";
import { validateMcpEndpoint } from "@cyberos/shared/mcp-network";
import type { ApiRouteContext } from "../context.js";
import {
  publicAgentMcpServer,
  removeAgentMcpCredentials,
  testAgentMcpServer,
  validateCredentials,
  writeAgentMcpCredentials,
  type AgentMcpCredentials
} from "../lib/agent-mcp-service.js";
import { configureAgentMcp, publicAgentMcpSettings } from "../lib/agent-mcp-settings.js";
import {
  createAgentSkillStagingRoot,
  inspectProjectAgentSkills,
  installPreparedAgentSkill,
  prepareGitAgentSkill,
  prepareZipAgentSkill,
  removeInstalledAgentSkill
} from "../lib/agent-skills.js";
import {
  resolveScopedExistingPath,
  resolveStoragePoolScope,
  StorageScopeError
} from "../lib/storage-scope.js";

const MCP_EXPOSURES = new Set<AgentMcpExposure>(["codemode", "deferred", "direct"]);
const MCP_AUTH_MODES = new Set<AgentMcpAuthMode>(["none", "bearer", "headers"]);

interface McpServerBody {
  name?: unknown;
  description?: unknown;
  url?: unknown;
  timeoutSeconds?: unknown;
  exposure?: unknown;
  authMode?: unknown;
  enabled?: unknown;
  allowInsecureHttp?: unknown;
  confirmed?: unknown;
}

export function registerAgentResourceRoutes(
  server: FastifyInstance,
  { config, db, system }: ApiRouteContext
): void {
  const secretsDir = config.paths.mcpSecretsDir;
  const skillsDir = config.paths.piSkillsDir;

  server.get("/api/settings/mcp", async (_request, reply) => {
    const response: PublicAgentMcpConfiguration = {
      builtIn: publicAgentMcpSettings(db, config),
      servers: await Promise.all(listAgentMcpServers(db).map((entry) => publicAgentMcpServer(entry, secretsDir))),
      generation: getAgentResourceGeneration(db)
    };
    reply.send({ settings: response });
  });

  server.post<{ Body: McpServerBody }>("/api/settings/mcp/servers", async (request, reply) => {
    if (request.body?.confirmed !== true) {
      reply.status(400).send({ error: "Adding an MCP server requires security confirmation" });
      return;
    }
    try {
      const input = await parseMcpServerInput(request.body);
      const created = createAgentMcpServer(db, input);
      reply.status(201).send({ server: await publicAgentMcpServer(created, secretsDir) });
    } catch (error) {
      reply.status(400).send({ error: errorMessage(error) });
    }
  });

  server.patch<{ Params: { id: string }; Body: McpServerBody }>(
    "/api/settings/mcp/servers/:id",
    async (request, reply) => {
      if (request.body?.confirmed !== true) {
        reply.status(400).send({ error: "Changing an MCP server requires security confirmation" });
        return;
      }
      if (request.params.id === "builtin") {
        if (typeof request.body.enabled !== "boolean" || hasUnknownFields(request.body, ["enabled", "confirmed"])) {
          reply.status(400).send({ error: "The built-in MCP only supports the enabled setting" });
          return;
        }
        if (request.body.enabled && !config.mcp.enabled) {
          reply.status(409).send({ error: "CyberOS MCP is unavailable" });
          return;
        }
        try {
          reply.send({ server: configureAgentMcp(db, config, request.body.enabled) });
        } catch (error) {
          request.log.error({ err: error }, "Built-in MCP configuration failed");
          reply.status(500).send({ error: "Built-in MCP configuration failed" });
        }
        return;
      }

      const existing = getAgentMcpServer(db, request.params.id);
      if (!existing) {
        reply.status(404).send({ error: "MCP server not found" });
        return;
      }
      try {
        const next = await mergeMcpServerInput(existing, request.body, secretsDir);
        const updated = next.authMode === existing.authMode
          ? updateAgentMcpServer(db, existing.id, next)
          : await removeAgentMcpCredentials(secretsDir, existing.id, () =>
            updateAgentMcpServer(db, existing.id, next));
        reply.send({ server: await publicAgentMcpServer(updated!, secretsDir) });
      } catch (error) {
        reply.status(400).send({ error: errorMessage(error) });
      }
    }
  );

  server.delete<{ Params: { id: string }; Body: { confirmed?: boolean } }>(
    "/api/settings/mcp/servers/:id",
    async (request, reply) => {
      if (request.params.id === "builtin") {
        reply.status(405).send({ error: "The built-in MCP cannot be deleted" });
        return;
      }
      if (request.body?.confirmed !== true) {
        reply.status(400).send({ error: "Deleting an MCP server requires confirmation" });
        return;
      }
      if (hasUnknownFields(request.body, ["confirmed"])) {
        reply.status(400).send({ error: "MCP server deletion contains unknown fields" });
        return;
      }
      if (!getAgentMcpServer(db, request.params.id)) {
        reply.status(404).send({ error: "MCP server not found" });
        return;
      }
      await removeAgentMcpCredentials(secretsDir, request.params.id, () => {
        if (!deleteAgentMcpServer(db, request.params.id)) throw new Error("MCP server was not deleted");
      });
      reply.status(204).send();
    }
  );

  server.put<{ Params: { id: string }; Body: AgentMcpCredentials & { confirmed?: boolean } }>(
    "/api/settings/mcp/servers/:id/credentials",
    async (request, reply) => {
      const existing = getAgentMcpServer(db, request.params.id);
      if (!existing) {
        reply.status(404).send({ error: "MCP server not found" });
        return;
      }
      if (request.body?.confirmed !== true) {
        reply.status(400).send({ error: "Changing MCP credentials requires security confirmation" });
        return;
      }
      if (hasUnknownFields(request.body, ["bearerToken", "headers", "confirmed"])) {
        reply.status(400).send({ error: "MCP credentials contain unknown fields" });
        return;
      }
      try {
        const { confirmed: _confirmed, ...credentials } = request.body;
        const credentialHeaderNames = validateCredentials(existing.authMode, credentials);
        const updated = updateAgentMcpServer(db, existing.id, resetMcpTrust({
          ...toMcpInput(existing),
          credentialHeaderNames
        }));
        await writeAgentMcpCredentials(secretsDir, existing.id, existing.authMode, credentials);
        reply.send({ server: await publicAgentMcpServer(updated!, secretsDir) });
      } catch (error) {
        reply.status(400).send({ error: errorMessage(error) });
      }
    }
  );

  server.delete<{ Params: { id: string }; Body: { confirmed?: boolean } }>(
    "/api/settings/mcp/servers/:id/credentials",
    async (request, reply) => {
      const existing = getAgentMcpServer(db, request.params.id);
      if (!existing) {
        reply.status(404).send({ error: "MCP server not found" });
        return;
      }
      if (request.body?.confirmed !== true) {
        reply.status(400).send({ error: "Deleting MCP credentials requires confirmation" });
        return;
      }
      if (hasUnknownFields(request.body, ["confirmed"])) {
        reply.status(400).send({ error: "MCP credential deletion contains unknown fields" });
        return;
      }
      const updated = await removeAgentMcpCredentials(secretsDir, existing.id, () =>
        updateAgentMcpServer(db, existing.id, resetMcpTrust({
          ...toMcpInput(existing),
          credentialHeaderNames: []
        })));
      reply.send({ server: await publicAgentMcpServer(updated!, secretsDir) });
    }
  );

  server.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/settings/mcp/servers/:id/test",
    async (request, reply) => {
      if (hasUnknownFields(request.body, [])) {
        reply.status(400).send({ error: "MCP connection test contains unknown fields" });
        return;
      }
      const existing = getAgentMcpServer(db, request.params.id);
      if (!existing) {
        reply.status(404).send({ error: "MCP server not found" });
        return;
      }
      const testedAt = new Date().toISOString();
      try {
        const result = await testAgentMcpServer(existing, secretsDir);
        const updated = updateAgentMcpServer(db, existing.id, {
          ...toMcpInput(existing),
          enabled: false,
          testStatus: "ready",
          toolCount: result.toolCount,
          lastTestedAt: testedAt,
          lastError: null,
          trustedAt: testedAt
        });
        reply.send({ server: await publicAgentMcpServer(updated!, secretsDir) });
      } catch (error) {
        const message = publicConnectionError(error);
        const updated = updateAgentMcpServer(db, existing.id, {
          ...toMcpInput(existing),
          enabled: false,
          testStatus: "error",
          toolCount: 0,
          lastTestedAt: testedAt,
          lastError: message,
          trustedAt: null
        });
        reply.status(409).send({ error: message, server: await publicAgentMcpServer(updated!, secretsDir) });
      }
    }
  );

  server.get<{ Querystring: { sessionId?: string } }>("/api/settings/skills", async (request, reply) => {
    try {
      const project = await loadProjectSkills(request.query.sessionId, config.paths.dataRoot, db);
      const response: PublicAgentSkillsConfiguration = {
        global: listAgentSkills(db),
        project,
        generation: getAgentResourceGeneration(db)
      };
      reply.send({ settings: response });
    } catch (error) {
      reply.status(400).send({ error: errorMessage(error) });
    }
  });

  server.post<{
    Body: { storagePoolId?: string; path?: string; replaceId?: string; confirmed?: boolean };
  }>("/api/settings/skills/import", async (request, reply) => {
    if (request.body?.confirmed !== true) {
      reply.status(400).send({ error: "Installing a Skill requires security confirmation" });
      return;
    }
    if (hasUnknownFields(request.body, ["storagePoolId", "path", "replaceId", "confirmed"])) {
      reply.status(400).send({ error: "Skill import contains unknown fields" });
      return;
    }
    let stagingRoot: string | null = null;
    try {
      const storagePoolId = requiredText(request.body.storagePoolId, "Storage pool");
      const sourcePath = requiredText(request.body.path, "Skill ZIP path");
      const scope = await resolveStoragePoolScope(config.paths.dataRoot, system, storagePoolId);
      const source = await resolveScopedExistingPath(scope, sourcePath);
      stagingRoot = await createAgentSkillStagingRoot(config.paths.piAgentStateDir);
      const prepared = await prepareZipAgentSkill(source.realPath, stagingRoot);
      const existing = request.body.replaceId ? getAgentSkill(db, request.body.replaceId) : null;
      if (request.body.replaceId && !existing) throw new Error("Skill to replace was not found");
      const id = existing?.id ?? randomUUID();
      await installPreparedAgentSkill(skillsDir, id, prepared.directory, () => {
        const input = {
          name: prepared.name,
          description: prepared.description,
          version: prepared.version,
          sourceType: "zip" as const,
          sourceUrl: null,
          sourceRef: null,
          sourceSubdirectory: null,
          sourceStoragePoolId: storagePoolId,
          sourcePath: source.relativePath,
          resolvedCommit: null,
          digest: prepared.digest,
          enabled: false,
          diagnostics: prepared.diagnostics
        };
        if (existing) updateAgentSkill(db, id, input);
        else createAgentSkill(db, input, id);
      });
      reply.status(existing ? 200 : 201).send({ skill: getAgentSkill(db, id) });
    } catch (error) {
      reply.status(storageErrorStatus(error)).send({ error: errorMessage(error) });
    } finally {
      if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
    }
  });

  server.post<{
    Body: { url?: string; ref?: string; subdirectory?: string; replaceId?: string; confirmed?: boolean };
  }>("/api/settings/skills/install-git", async (request, reply) => {
    if (request.body?.confirmed !== true) {
      reply.status(400).send({ error: "Installing a Skill requires security confirmation" });
      return;
    }
    if (hasUnknownFields(request.body, ["url", "ref", "subdirectory", "replaceId", "confirmed"])) {
      reply.status(400).send({ error: "Skill Git install contains unknown fields" });
      return;
    }
    let stagingRoot: string | null = null;
    try {
      const url = requiredText(request.body.url, "Skill Git URL");
      stagingRoot = await createAgentSkillStagingRoot(config.paths.piAgentStateDir);
      const prepared = await prepareGitAgentSkill({
        url,
        ref: request.body.ref ?? null,
        subdirectory: request.body.subdirectory ?? null,
        stagingRoot
      });
      const existing = request.body.replaceId ? getAgentSkill(db, request.body.replaceId) : null;
      if (request.body.replaceId && !existing) throw new Error("Skill to replace was not found");
      const id = existing?.id ?? randomUUID();
      await installPreparedAgentSkill(skillsDir, id, prepared.directory, () => {
        const input = skillInputFromGit(prepared, url, request.body.ref, request.body.subdirectory);
        if (existing) updateAgentSkill(db, id, input);
        else createAgentSkill(db, input, id);
      });
      reply.status(existing ? 200 : 201).send({ skill: getAgentSkill(db, id) });
    } catch (error) {
      reply.status(400).send({ error: errorMessage(error) });
    } finally {
      if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
    }
  });

  server.patch<{ Params: { id: string }; Body: { enabled?: boolean; confirmed?: boolean } }>(
    "/api/settings/skills/:id",
    async (request, reply) => {
      if (request.body?.confirmed !== true || typeof request.body.enabled !== "boolean") {
        reply.status(400).send({ error: "Changing Skill availability requires security confirmation" });
        return;
      }
      if (hasUnknownFields(request.body, ["enabled", "confirmed"])) {
        reply.status(400).send({ error: "Skill settings contain unknown fields" });
        return;
      }
      const existing = getAgentSkill(db, request.params.id);
      if (!existing) {
        reply.status(404).send({ error: "Skill not found" });
        return;
      }
      const updated = updateAgentSkill(db, existing.id, { ...toSkillInput(existing), enabled: request.body.enabled });
      reply.send({ skill: updated });
    }
  );

  server.delete<{ Params: { id: string }; Body: { confirmed?: boolean } }>(
    "/api/settings/skills/:id",
    async (request, reply) => {
      if (request.body?.confirmed !== true) {
        reply.status(400).send({ error: "Deleting a Skill requires confirmation" });
        return;
      }
      if (hasUnknownFields(request.body, ["confirmed"])) {
        reply.status(400).send({ error: "Skill deletion contains unknown fields" });
        return;
      }
      if (!getAgentSkill(db, request.params.id)) {
        reply.status(404).send({ error: "Skill not found" });
        return;
      }
      await removeInstalledAgentSkill(skillsDir, request.params.id, () => {
        if (!deleteAgentSkill(db, request.params.id)) throw new Error("Skill was not deleted");
      });
      reply.status(204).send();
    }
  );

  server.post<{ Params: { id: string }; Body: { confirmed?: boolean } }>(
    "/api/settings/skills/:id/update",
    async (request, reply) => {
      const existing = getAgentSkill(db, request.params.id);
      if (!existing) {
        reply.status(404).send({ error: "Skill not found" });
        return;
      }
      if (existing.sourceType !== "git" || !existing.sourceUrl) {
        reply.status(409).send({ error: "Only Git-installed Skills can be updated" });
        return;
      }
      if (request.body?.confirmed !== true) {
        reply.status(400).send({ error: "Updating a Skill requires security confirmation" });
        return;
      }
      if (hasUnknownFields(request.body, ["confirmed"])) {
        reply.status(400).send({ error: "Skill update contains unknown fields" });
        return;
      }
      let stagingRoot: string | null = null;
      try {
        stagingRoot = await createAgentSkillStagingRoot(config.paths.piAgentStateDir);
        const prepared = await prepareGitAgentSkill({
          url: existing.sourceUrl,
          ref: existing.sourceRef,
          subdirectory: existing.sourceSubdirectory,
          stagingRoot
        });
        await installPreparedAgentSkill(skillsDir, existing.id, prepared.directory, () => {
          updateAgentSkill(db, existing.id, skillInputFromGit(
            prepared,
            existing.sourceUrl!,
            existing.sourceRef,
            existing.sourceSubdirectory
          ));
        });
        reply.send({ skill: getAgentSkill(db, existing.id) });
      } catch (error) {
        reply.status(400).send({ error: errorMessage(error) });
      } finally {
        if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
      }
    }
  );
}

async function parseMcpServerInput(body: McpServerBody) {
  if (hasUnknownFields(body, [
    "name", "description", "url", "timeoutSeconds", "exposure", "authMode",
    "enabled", "allowInsecureHttp", "confirmed"
  ])) throw new Error("MCP server contains unknown fields");
  const name = requiredMcpServerName(body.name);
  const description = optionalText(body.description, "MCP server description", 1_024);
  const url = requiredText(body.url, "MCP server URL", 2_048);
  const timeoutSeconds = integerInRange(body.timeoutSeconds ?? 30, "MCP timeout", 1, 300);
  const exposure = body.exposure ?? "codemode";
  if (!MCP_EXPOSURES.has(exposure as AgentMcpExposure)) throw new Error("MCP exposure mode is invalid");
  const authMode = body.authMode ?? "none";
  if (!MCP_AUTH_MODES.has(authMode as AgentMcpAuthMode)) throw new Error("MCP authentication mode is invalid");
  const allowInsecureHttp = body.allowInsecureHttp === true;
  if (body.allowInsecureHttp !== undefined && typeof body.allowInsecureHttp !== "boolean") {
    throw new Error("MCP plaintext HTTP confirmation must be a boolean");
  }
  if (body.enabled === true) throw new Error("New MCP servers must be tested before they can be enabled");
  await validateMcpEndpoint(url, allowInsecureHttp);
  return {
    name,
    description,
    url,
    timeoutSeconds,
    exposure: exposure as AgentMcpExposure,
    authMode: authMode as AgentMcpAuthMode,
    credentialHeaderNames: [],
    enabled: false,
    allowInsecureHttp,
    testStatus: "untested" as const,
    toolCount: 0,
    lastTestedAt: null,
    lastError: null,
    trustedAt: null
  };
}

async function mergeMcpServerInput(
  existing: AgentMcpServerRecord,
  body: McpServerBody,
  secretsDir: string
) {
  if (hasUnknownFields(body, [
    "name", "description", "url", "timeoutSeconds", "exposure", "authMode",
    "enabled", "allowInsecureHttp", "confirmed"
  ])) throw new Error("MCP server contains unknown fields");
  const next = {
    ...toMcpInput(existing),
    name: body.name === undefined ? existing.name : requiredMcpServerName(body.name),
    description: body.description === undefined
      ? existing.description
      : optionalText(body.description, "MCP server description", 1_024),
    url: body.url === undefined ? existing.url : requiredText(body.url, "MCP server URL", 2_048),
    timeoutSeconds: body.timeoutSeconds === undefined
      ? existing.timeoutSeconds
      : integerInRange(body.timeoutSeconds, "MCP timeout", 1, 300),
    exposure: body.exposure === undefined ? existing.exposure : body.exposure as AgentMcpExposure,
    authMode: body.authMode === undefined ? existing.authMode : body.authMode as AgentMcpAuthMode,
    allowInsecureHttp: body.allowInsecureHttp === undefined
      ? existing.allowInsecureHttp
      : requireBoolean(body.allowInsecureHttp, "MCP plaintext HTTP confirmation"),
    enabled: body.enabled === undefined
      ? existing.enabled
      : requireBoolean(body.enabled, "MCP enabled")
  };
  if (!MCP_EXPOSURES.has(next.exposure)) throw new Error("MCP exposure mode is invalid");
  if (!MCP_AUTH_MODES.has(next.authMode)) throw new Error("MCP authentication mode is invalid");
  await validateMcpEndpoint(next.url, next.allowInsecureHttp);

  const trustChanged = next.url !== existing.url
    || next.authMode !== existing.authMode
    || next.allowInsecureHttp !== existing.allowInsecureHttp;
  if (next.authMode !== existing.authMode) next.credentialHeaderNames = [];
  const candidate = trustChanged ? resetMcpTrust(next) : next;
  if (candidate.enabled) {
    const publicEntry = await publicAgentMcpServer(existing, secretsDir);
    if (candidate.testStatus !== "ready" || !candidate.trustedAt) {
      throw new Error("MCP server must pass a connection test before it can be enabled");
    }
    if (candidate.authMode !== "none" && !publicEntry.credentialsConfigured) {
      throw new Error("MCP server credentials must be configured before it can be enabled");
    }
  }
  return candidate;
}

function toMcpInput(server: AgentMcpServerRecord) {
  return {
    name: server.name,
    description: server.description,
    url: server.url,
    timeoutSeconds: server.timeoutSeconds,
    exposure: server.exposure,
    authMode: server.authMode,
    credentialHeaderNames: server.credentialHeaderNames,
    enabled: server.enabled,
    allowInsecureHttp: server.allowInsecureHttp,
    testStatus: server.testStatus,
    toolCount: server.toolCount,
    lastTestedAt: server.lastTestedAt,
    lastError: server.lastError,
    trustedAt: server.trustedAt
  };
}

function resetMcpTrust<T extends ReturnType<typeof toMcpInput>>(input: T): T {
  return {
    ...input,
    enabled: false,
    testStatus: "untested",
    toolCount: 0,
    lastTestedAt: null,
    lastError: null,
    trustedAt: null
  };
}

function toSkillInput(skill: AgentSkillRecord) {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    sourceType: skill.sourceType,
    sourceUrl: skill.sourceUrl,
    sourceRef: skill.sourceRef,
    sourceSubdirectory: skill.sourceSubdirectory,
    sourceStoragePoolId: skill.sourceStoragePoolId,
    sourcePath: skill.sourcePath,
    resolvedCommit: skill.resolvedCommit,
    digest: skill.digest,
    enabled: skill.enabled,
    diagnostics: skill.diagnostics
  };
}

function skillInputFromGit(
  prepared: Awaited<ReturnType<typeof prepareGitAgentSkill>>,
  url: string,
  ref: string | null | undefined,
  subdirectory: string | null | undefined
) {
  return {
    name: prepared.name,
    description: prepared.description,
    version: prepared.version,
    sourceType: "git" as const,
    sourceUrl: url,
    sourceRef: ref?.trim() || null,
    sourceSubdirectory: subdirectory?.trim() || null,
    sourceStoragePoolId: null,
    sourcePath: null,
    resolvedCommit: prepared.resolvedCommit,
    digest: prepared.digest,
    enabled: false,
    diagnostics: prepared.diagnostics
  };
}

async function loadProjectSkills(
  sessionId: string | undefined,
  dataRoot: string,
  db: ApiRouteContext["db"]
): Promise<PublicAgentSkillsConfiguration["project"]> {
  if (!sessionId) return { sessionId: null, path: null, trusted: false, skills: [] };
  const session = getSession(db, sessionId);
  if (!session) throw new Error("Agent session not found");
  const project = await resolveSafeExistingPath(dataRoot, session.currentPath);
  const projectSkillsDir = path.join(project.realPath, ".agents", "skills");
  const skills = await inspectProjectAgentSkills(projectSkillsDir);
  return {
    sessionId: session.id,
    path: project.relativePath,
    trusted: session.piResourcesTrusted === true,
    skills
  };
}

function requiredText(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} must contain between 1 and ${maximum} safe characters`);
  }
  return value.trim();
}

function requiredMcpServerName(value: unknown): string {
  const name = requiredText(value, "MCP server name", 63);
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(name)
    || name.includes("--")
    || name === "cyberos"
    || name === "builtin"
  ) {
    throw new Error("MCP server name must be a unique lowercase slug; cyberos and builtin are reserved");
  }
  return name;
}

function optionalText(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} cannot exceed ${maximum} safe characters`);
  }
  return value.trim();
}

function integerInRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function hasUnknownFields(body: object | null | undefined, fields: readonly string[]): boolean {
  const allowed = new Set(fields);
  return Object.keys(body ?? {}).some((key) => !allowed.has(key));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicConnectionError(error: unknown): string {
  const message = errorMessage(error);
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function storageErrorStatus(error: unknown): number {
  return error instanceof StorageScopeError ? error.statusCode : 400;
}
