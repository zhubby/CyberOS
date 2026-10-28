import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import {
  appendEvent,
  createDockerRegistryCredential,
  createDockerConsoleAuthorization,
  createDockerOperationRecord,
  consumeDockerConsoleAuthorization,
  deleteDockerRegistryCredential,
  deleteDockerComposeHostAccessDraft,
  DockerComposeAppConflictError,
  DockerComposeAppProjectKeyConflictError,
  DockerRegistryCredentialConflictError,
  getDockerSettings,
  getApproval,
  getDockerOperation,
  listDockerRegistryCredentials,
  listDockerOperations,
  markDockerConsoleAuthorizationFailed,
  updateDockerRegistryCredential,
  updateApprovalStatus,
  updateDockerOperationStatus,
  updateJobStatus,
  type DockerRegistryCredentialRecord
} from "@cyberos/db";
import type {
  DockerDaemonConfigUpdateInput,
  DockerDaemonStatus,
  DockerComposeAppCreateInput,
  DockerComposeAppDeleteInput,
  DockerComposeAppUpdateInput,
  DockerComposeAppValidateInput,
  DockerConsoleAuthorizationRecord,
  DockerContainerSummary,
  DockerCreateInput,
  DockerCreateResult,
  DockerImagePullInput,
  DockerImageRemoveInput,
  DockerOperationAction,
  DockerOperationProposal,
  DockerOperationTargetType,
  DockerRegistryCredentialCreateInput,
  DockerRegistryCredentialUpdateInput
} from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { effectiveDockerConfig } from "../lib/settings.js";
import {
  DockerCreateExecutionError,
  DockerCreateValidationError,
  bindPreparedDockerCreateHostAccess,
  executeDockerCreate,
  prepareDockerCreate
} from "../lib/docker-create.js";
import { DockerRequestError } from "../lib/docker-client.js";
import {
  DockerDaemonRequestError,
  safeDockerDaemonMessage,
  SystemDockerDaemonRuntime,
  validateDockerDaemonConfigUpdate
} from "../lib/docker-daemon.js";
import {
  DockerComposeMaterializationError,
  DockerComposeUnavailableError,
  DockerComposeValidationError
} from "../lib/docker-compose.js";
import { DockerHostAccessPolicy } from "../lib/docker-host-access.js";
import {
  dockerRegistryAuthHeader,
  DockerRegistryValidationError,
  findDockerRegistryCredential,
  normalizeDockerImageReference,
  normalizeDockerRegistryAddress,
  redactDockerRegistrySecrets,
  requiredRegistryText,
  toPublicDockerRegistryCredential
} from "../lib/docker-registry.js";
import { applyDockerOperation, dockerCompose, dockerEngine, collectDockerSummary, safeDockerMessage } from "../lib/docker-service.js";

type DockerActionProposalBody = {
  action?: Exclude<DockerOperationAction, "create">;
  targetType?: DockerOperationTargetType;
  containerId?: string;
  composeProjectId?: string;
  service?: string;
  shell?: string;
};

type DockerProposalBody = DockerActionProposalBody | ({ action: "create" } & DockerCreateInput);
type BuiltDockerProposal = DockerOperationProposal & {
  internalHostAccessDraft?: { id: string; revision: string };
};

const MAX_DOCKER_CREATE_BODY_BYTES = 256 * 1024;
const MAX_DOCKER_DAEMON_BODY_BYTES = 256 * 1024 + 4096;
const MAX_DOCKER_REGISTRY_BODY_BYTES = 64 * 1024;
const MAX_DOCKER_APP_BODY_BYTES = 512 * 1024;
const DOCKER_DAEMON_SAMPLE_MS = 1000;
const DOCKER_DAEMON_HEARTBEAT_MS = 15_000;

export function registerDockerRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { config, db, docker } = context;
  const currentConfig = () => effectiveDockerConfig(config, getDockerSettings(db));
  const daemon = docker?.daemon ?? new SystemDockerDaemonRuntime({ hostdSocketPath: config.hostd.socketPath });
  const compose = dockerCompose(currentConfig().docker, docker);
  const hostAccessPolicy = context.hostAccess?.policy ?? new DockerHostAccessPolicy(db);

  server.get("/api/docker/summary", async () => ({
    summary: await collectDockerSummary(currentConfig(), docker)
  }));

  server.get("/api/docker/host-access", async () => ({
    hostAccess: hostAccessPolicy.catalog()
  }));

  server.get("/api/docker/apps", async () => ({
    apps: await compose.listProjects(await composeAppContainers(currentConfig().docker, docker))
  }));

  server.get<{
    Params: { id: string };
  }>("/api/docker/apps/:id", async (request, reply) => {
    const app = await compose.getApp(
      request.params.id,
      await composeAppContainers(currentConfig().docker, docker)
    );
    if (!app) {
      reply.status(404).send({ error: "Docker Compose App not found" });
      return;
    }
    reply.send({ app });
  });

  server.post<{
    Body: DockerComposeAppValidateInput;
  }>("/api/docker/apps/validate", { bodyLimit: MAX_DOCKER_APP_BODY_BYTES }, async (request, reply) => {
    try {
      reply.send({ validation: await compose.validateApp(request.body) });
    } catch (error) {
      sendDockerComposeAppError(reply, error);
    }
  });

  server.post<{
    Body: DockerComposeAppCreateInput;
  }>("/api/docker/apps", { bodyLimit: MAX_DOCKER_APP_BODY_BYTES }, async (request, reply) => {
    try {
      reply.status(201).send({ app: await compose.createApp(request.body) });
    } catch (error) {
      sendDockerComposeAppError(reply, error);
    }
  });

  server.put<{
    Params: { id: string };
    Body: DockerComposeAppUpdateInput;
  }>("/api/docker/apps/:id", { bodyLimit: MAX_DOCKER_APP_BODY_BYTES }, async (request, reply) => {
    try {
      const app = await compose.updateApp(request.params.id, request.body);
      if (!app) {
        reply.status(404).send({ error: "Docker Compose App not found" });
        return;
      }
      reply.send({ app });
    } catch (error) {
      sendDockerComposeAppError(reply, error);
    }
  });

  server.delete<{
    Params: { id: string };
    Body: DockerComposeAppDeleteInput;
  }>("/api/docker/apps/:id", { bodyLimit: MAX_DOCKER_APP_BODY_BYTES }, async (request, reply) => {
    if (request.body?.confirmed !== true) {
      reply.status(400).send({ error: "Docker Compose App deletion requires confirmation" });
      return;
    }
    if (!currentConfig().docker.enabled) {
      reply.status(503).send({ error: "Docker management is disabled" });
      return;
    }
    try {
      const result = await compose.deleteApp(request.params.id, request.body, async (projectKey) => {
        const containers = await dockerEngine(currentConfig().docker, docker).listContainers();
        return containers.some((container) => container.composeProject === projectKey);
      });
      if (result === "not_found") {
        reply.status(404).send({ error: "Docker Compose App not found" });
        return;
      }
      if (result === "conflict") {
        reply.status(409).send({ error: "Docker Compose App changed in another request" });
        return;
      }
      if (result === "in_use") {
        reply.status(409).send({ error: "Remove the Compose App containers before deleting the App" });
        return;
      }
      reply.send({ deleted: true });
    } catch (error) {
      if (isDockerComposeAppError(error)) sendDockerComposeAppError(reply, error);
      else reply.status(503).send({ error: safeDockerMessage(error) });
    }
  });

  server.get("/api/docker/registries", async () => ({
    registries: listDockerRegistryCredentials(db).map(toPublicDockerRegistryCredential)
  }));

  server.post<{
    Body: DockerRegistryCredentialCreateInput;
  }>("/api/docker/registries", { bodyLimit: MAX_DOCKER_REGISTRY_BODY_BYTES }, async (request, reply) => {
    try {
      const credential = createDockerRegistryCredential(db, validateRegistryCreateInput(request.body));
      reply.status(201).send({ registry: toPublicDockerRegistryCredential(credential) });
    } catch (error) {
      sendDockerRegistryMutationError(reply, error);
    }
  });

  server.patch<{
    Params: { id: string };
    Body: DockerRegistryCredentialUpdateInput;
  }>("/api/docker/registries/:id", { bodyLimit: MAX_DOCKER_REGISTRY_BODY_BYTES }, async (request, reply) => {
    try {
      const credential = updateDockerRegistryCredential(db, request.params.id, validateRegistryUpdateInput(request.body));
      if (!credential) {
        reply.status(404).send({ error: "Docker registry credential not found" });
        return;
      }
      reply.send({ registry: toPublicDockerRegistryCredential(credential) });
    } catch (error) {
      sendDockerRegistryMutationError(reply, error);
    }
  });

  server.delete<{
    Params: { id: string };
  }>("/api/docker/registries/:id", async (request, reply) => {
    if (!deleteDockerRegistryCredential(db, request.params.id)) {
      reply.status(404).send({ error: "Docker registry credential not found" });
      return;
    }
    reply.send({ deleted: true });
  });

  server.post<{
    Body: DockerImagePullInput;
  }>("/api/docker/images/pull", { bodyLimit: MAX_DOCKER_REGISTRY_BODY_BYTES }, async (request, reply) => {
    const nextConfig = currentConfig();
    if (!nextConfig.docker.enabled) {
      reply.status(503).send({ error: "Docker management is disabled" });
      return;
    }
    const credentials = listDockerRegistryCredentials(db);
    try {
      const reference = normalizeDockerImageReference(request.body?.reference);
      const credential = findDockerRegistryCredential(credentials, reference);
      await dockerEngine(nextConfig.docker, docker).pullImage({
        image: reference,
        ...(credential ? { registryAuth: dockerRegistryAuthHeader(credential) } : {})
      });
      reply.send({ result: { reference } });
    } catch (error) {
      sendDockerImageError(reply, error, credentials);
    }
  });

  server.post<{
    Body: DockerImageRemoveInput;
  }>("/api/docker/images/remove", { bodyLimit: MAX_DOCKER_REGISTRY_BODY_BYTES }, async (request, reply) => {
    const nextConfig = currentConfig();
    if (!nextConfig.docker.enabled) {
      reply.status(503).send({ error: "Docker management is disabled" });
      return;
    }
    if (request.body?.confirmed !== true) {
      reply.status(400).send({ error: "Docker image removal requires confirmation" });
      return;
    }
    try {
      const reference = normalizeDockerImageReference(request.body.reference);
      reply.send({ result: await dockerEngine(nextConfig.docker, docker).removeImage(reference) });
    } catch (error) {
      sendDockerImageError(reply, error);
    }
  });

  server.get("/api/docker/daemon/config", async (_request, reply) => {
    try {
      reply.send({ config: await daemon.getConfig() });
    } catch (error) {
      sendDockerDaemonError(reply, error);
    }
  });

  server.put<{
    Body: DockerDaemonConfigUpdateInput;
  }>("/api/docker/daemon/config", { bodyLimit: MAX_DOCKER_DAEMON_BODY_BYTES }, async (request, reply) => {
    if ((config.hostd.mutationPolicy ?? "mutable") === "declarative") {
      reply.status(501).send({ error: "Docker daemon configuration is managed declaratively on this host" });
      return;
    }
    try {
      const input = validateDockerDaemonConfigUpdate(request.body);
      reply.send({ result: await daemon.updateConfig(input) });
    } catch (error) {
      sendDockerDaemonError(reply, error);
    }
  });

  server.get("/api/docker/daemon/events", async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    await streamDockerDaemonEvents(request.raw, raw, daemon);
  });

  server.get<{
    Querystring: { sessionId?: string };
  }>("/api/docker/operations", async (request) => ({
    operations: listDockerOperations(db, {
      ...(request.query.sessionId ? { sessionId: request.query.sessionId } : {}),
      limit: 100
    })
  }));

  server.get<{
    Params: { id: string };
  }>("/api/docker/containers/:id", async (request, reply) => {
    const nextConfig = currentConfig();
    if (!nextConfig.docker.enabled) {
      reply.status(503).send({ error: "Docker management is disabled" });
      return;
    }
    try {
      const summary = await collectDockerSummary(nextConfig, docker);
      const container = findContainer(summary.containers, request.params.id);
      if (!container) {
        reply.status(404).send({ error: "Docker container not found" });
        return;
      }
      const engine = dockerEngine(nextConfig.docker, docker);
      const details = engine.getContainerDetails
        ? await engine.getContainerDetails(container.id, container)
        : {
            ...container,
            command: null,
            entrypoint: [],
            environment: [],
            mounts: [],
            networks: [],
            restartPolicy: null,
            hostname: null,
            workingDir: null,
            labels: {}
          };
      reply.send({ container: details });
    } catch (error) {
      reply.status(502).send({ error: safeDockerMessage(error) });
    }
  });

  server.get<{
    Params: { id: string };
  }>("/api/docker/networks/:id", async (request, reply) => {
    const nextConfig = currentConfig();
    if (!nextConfig.docker.enabled) {
      reply.status(503).send({ error: "Docker management is disabled" });
      return;
    }
    try {
      reply.send({ network: await dockerEngine(nextConfig.docker, docker).getNetworkDetails(request.params.id) });
    } catch (error) {
      sendDockerInspectError(reply, error, "Docker network not found");
    }
  });

  server.get<{
    Params: { name: string };
  }>("/api/docker/volumes/:name", async (request, reply) => {
    const nextConfig = currentConfig();
    if (!nextConfig.docker.enabled) {
      reply.status(503).send({ error: "Docker management is disabled" });
      return;
    }
    try {
      reply.send({ volume: await dockerEngine(nextConfig.docker, docker).getVolumeDetails(request.params.name) });
    } catch (error) {
      sendDockerInspectError(reply, error, "Docker volume not found");
    }
  });

  server.post<{
    Params: { id: string };
    Body: { action?: DockerOperationAction };
  }>("/api/docker/containers/:id/actions", async (request, reply) => {
    const nextConfig = currentConfig();
    if (!nextConfig.docker.enabled) {
      reply.status(503).send({ error: "Docker management is disabled" });
      return;
    }
    const action = request.body?.action;
    if (!action || !isContainerAction(action)) {
      reply.status(400).send({ error: "Unsupported Docker container action" });
      return;
    }
    try {
      const summary = await collectDockerSummary(nextConfig, docker);
      const container = findContainer(summary.containers, request.params.id);
      if (!container) {
        reply.status(404).send({ error: "Docker container not found" });
        return;
      }
      const engine = dockerEngine(nextConfig.docker, docker);
      if (action === "start") {
        await engine.startContainer(container.id);
      } else if (action === "stop") {
        await engine.stopContainer(container.id);
      } else if (action === "restart") {
        await engine.restartContainer(container.id);
      } else {
        await engine.removeContainer(container.id);
      }
      reply.send({ action, containerId: container.id });
    } catch (error) {
      reply.status(502).send({ error: safeDockerMessage(error) });
    }
  });

  server.get<{
    Params: { id: string };
    Querystring: { tail?: string };
  }>("/api/docker/containers/:id/logs", async (request, reply) => {
    const nextConfig = currentConfig();
    if (!nextConfig.docker.enabled) {
      reply.status(503).send({ error: "Docker management is disabled" });
      return;
    }
    const tail = Number.parseInt(request.query.tail ?? "200", 10);
    try {
      const logs = await dockerEngine(nextConfig.docker, docker).getContainerLogs(
        request.params.id,
        Number.isInteger(tail) ? tail : 200
      );
      reply.send({ logs });
    } catch (error) {
      reply.status(502).send({ error: safeDockerMessage(error) });
    }
  });

  server.post<{
    Body: DockerProposalBody;
  }>("/api/docker/actions", { bodyLimit: MAX_DOCKER_CREATE_BODY_BYTES }, async (request, reply) => {
    const nextConfig = currentConfig();
    if (!nextConfig.docker.enabled) {
      reply.status(503).send({ error: "Docker management is disabled" });
      return;
    }

    try {
      if (request.body?.action === "create") {
        const summary = await collectDockerSummary(nextConfig, docker);
        if (summary.engine.status !== "ready") {
          throw new DockerCreateValidationError(summary.engine.error ?? "Docker engine is not ready", 503);
        }
        let prepared = await prepareDockerCreate(request.body, { ...context, config: nextConfig }, summary);
        let registryCredentials: DockerRegistryCredentialRecord[] = [];
        if (prepared.kind === "container" && prepared.input.hostAccess?.length) {
          const engine = dockerEngine(nextConfig.docker, docker);
          if (!engine.resolveImageId) {
            throw new DockerCreateValidationError("Docker image identity resolution is unavailable", 503);
          }
          registryCredentials = listDockerRegistryCredentials(db);
          const registryCredential = findDockerRegistryCredential(registryCredentials, prepared.engineInput.image);
          await engine.pullImage({
            image: prepared.engineInput.image,
            ...(registryCredential ? { registryAuth: dockerRegistryAuthHeader(registryCredential) } : {})
          });
          const imageDigest = await engine.resolveImageId(prepared.engineInput.image);
          const bound = bindPreparedDockerCreateHostAccess(
            prepared,
            context.hostAccess?.policy ?? hostAccessPolicy,
            randomUUID(),
            imageDigest
          );
          if (bound.kind !== "container") {
            throw new DockerCreateValidationError("Docker Host Access requires a container");
          }
          const manifest = bound.hostAccessManifest;
          if (!manifest || !bound.proposal.hostAccess) {
            throw new DockerCreateValidationError("Docker Host Access manifest is unavailable", 503);
          }
          const proxyCapabilities = manifest.grants
            .map((grant) => grant.capability)
            .filter((capability) => capability === "docker_metadata" || capability === "systemd_status");
          if (proxyCapabilities.length) {
            if (!context.hostAccess?.control) {
              throw new DockerCreateValidationError("Docker Host Access proxy is unavailable", 503);
            }
            await context.hostAccess.control.reconcile({
              scopeId: bound.input.name,
              capabilities: proxyCapabilities
            });
          }
          prepared = {
            ...bound,
            input: { ...bound.input, pullPolicy: "never" },
            engineInput: { ...bound.engineInput, image: imageDigest }
          };
        }

        const operation = createDockerOperationRecord(db, { proposal: prepared.proposal });
        const running = updateDockerOperationStatus(db, operation.id, "proposed", {
          request: prepared.audit,
          phase: "create",
          startedAt: new Date().toISOString()
        }) ?? operation;

        let result: DockerCreateResult;
        try {
          result = await executeDockerCreate(
            prepared,
            dockerEngine(nextConfig.docker, docker),
            operation.id,
            () => {
              registryCredentials = listDockerRegistryCredentials(db);
              const registryCredential = prepared.kind === "container"
                ? findDockerRegistryCredential(registryCredentials, prepared.engineInput.image)
                : null;
              return registryCredential ? dockerRegistryAuthHeader(registryCredential) : undefined;
            }
          );
        } catch (error) {
          const phase = error instanceof DockerCreateExecutionError ? error.phase : "pull";
          const responseError = redactDockerRegistrySecrets(error, registryCredentials);
          const auditError = phase === "pull" ? "Docker image preparation failed" : "Docker resource creation failed";
          try {
            const failed = updateDockerOperationStatus(db, operation.id, "failed", {
              phase,
              partialSuccess: false,
              error: auditError,
              failedAt: new Date().toISOString()
            });
            void failed;
          } catch (persistenceError) {
            request.log.error({ err: persistenceError, operationId: operation.id }, "Failed to persist Docker create failure");
          }
          reply.status(dockerCreateErrorStatus(error)).send({ error: responseError });
          return;
        }

        const publicResult = { ...result, ...(result.error ? { error: safeDockerMessage(result.error) } : {}) };
        const auditResult = dockerCreateAuditResult(result);
        try {
          if (result.partialSuccess) {
            const failed = updateDockerOperationStatus(db, operation.id, "failed", {
              result: auditResult,
              phase: result.phase ?? "start",
              partialSuccess: true,
              error: "Docker container was created but could not be started",
              failedAt: new Date().toISOString()
            });
            reply.status(202).send({ operation: failed, result: publicResult });
            return;
          }

          const applied = updateDockerOperationStatus(db, operation.id, "applied", {
            result: auditResult,
            phase: "create",
            appliedAt: new Date().toISOString()
          });
          reply.status(202).send({ operation: applied, result: publicResult });
        } catch (persistenceError) {
          request.log.error({ err: persistenceError, operationId: operation.id }, "Docker resource created but operation history could not be finalized");
          reply.status(202).send({
            operation: getDockerOperation(db, operation.id) ?? running,
            result: publicResult,
            warning: "Docker resource was created, but operation history could not be finalized"
          });
        }
        return;
      }

      const builtProposal = await buildDockerProposal(request.body ?? {}, { ...context, config: nextConfig });
      const { internalHostAccessDraft, ...proposal } = builtProposal;
      const operation = createDockerOperationRecord(db, { proposal });
      updateDockerOperationStatus(db, operation.id, "proposed", {
        startedAt: new Date().toISOString(),
        ...(internalHostAccessDraft ? { hostAccessDraftId: internalHostAccessDraft.id } : {})
      });
      try {
        if (proposal.action === "console") {
          const approved = updateDockerOperationStatus(db, operation.id, "approved", {
            approvedAt: new Date().toISOString()
          });
          reply.status(202).send({ operation: approved });
          return;
        }
        const registryCredentials = listDockerRegistryCredentials(db);
        const metadata = await applyDockerOperation(
          nextConfig,
          getDockerOperation(db, operation.id) ?? operation,
          proposal,
          docker,
          registryCredentials
        );
        const applied = updateDockerOperationStatus(db, operation.id, "applied", {
          ...metadata,
          appliedAt: new Date().toISOString()
        });
        reply.status(202).send({ operation: applied });
      } catch (error) {
        if (internalHostAccessDraft) {
          deleteDockerComposeHostAccessDraft(db, internalHostAccessDraft.id);
        }
        const message = redactDockerRegistrySecrets(error, listDockerRegistryCredentials(db));
        updateDockerOperationStatus(db, operation.id, "failed", {
          error: message,
          failedAt: new Date().toISOString()
        });
        reply.status(dockerCreateErrorStatus(error)).send({ error: message });
      }
    } catch (error) {
      reply.status(dockerCreateErrorStatus(error)).send({ error: safeDockerMessage(error) });
    }
  });

  server.post<{
    Body: { operationId?: string };
  }>("/api/docker/console-sessions", async (request, reply) => {
    const nextConfig = currentConfig();
    if (!nextConfig.docker.enabled) {
      reply.status(503).send({ error: "Docker management is disabled" });
      return;
    }

    const operation = getDockerOperation(db, request.body?.operationId ?? "");
    if (!operation || operation.action !== "console" || operation.status !== "approved") {
      reply.status(404).send({ error: "Console operation not found" });
      return;
    }
    const proposal = dockerProposalFromOperation(operation);
    if (!proposal?.containerId || !proposal.shell) {
      reply.status(400).send({ error: "Console operation is missing container or shell metadata" });
      return;
    }

    let authorization: DockerConsoleAuthorizationRecord;
    try {
      authorization = createDockerConsoleAuthorization(db, {
        operationId: operation.id,
        approvalId: operation.approvalId,
        containerId: proposal.containerId,
        shell: proposal.shell
      });
    } catch (error) {
      reply.status(404).send({ error: safeDockerMessage(error) });
      return;
    }
    updateDockerOperationStatus(db, operation.id, "approved", {
      consoleSessionId: authorization.id
    });

    reply.status(201).send({
      consoleSession: {
        id: authorization.id,
        operationId: operation.id,
        containerId: authorization.containerId,
        shell: authorization.shell,
        expiresAt: authorization.expiresAt,
        websocketUrl: `/api/docker/console/${authorization.id}`
      }
    });
  });

  server.get<{
    Params: { id: string };
  }>("/api/docker/console/:id", { websocket: true }, async (socket, request) => {
    const nextConfig = currentConfig();
    if (!nextConfig.docker.enabled) {
      sendSocket(socket, { type: "error", error: "Docker management is disabled" });
      socket.close();
      return;
    }

    const authorization = consumeDockerConsoleAuthorization(db, request.params.id);
    if (!authorization) {
      sendSocket(socket, { type: "error", error: "Console session is not available" });
      socket.close();
      return;
    }

    const engine = dockerEngine(nextConfig.docker, docker);
    let execId: string | null = null;
    try {
      execId = await engine.createExec(authorization.containerId, authorization.shell);
      const stream = await engine.startExec(execId);
      markConsoleStarted(context, authorization, execId);
      sendSocket(socket, { type: "ready" });
      stream.socket.on("data", (chunk: Buffer) => {
        sendSocket(socket, { type: "output", data: chunk.toString("utf8") });
      });
      stream.socket.on("close", () => {
        sendSocket(socket, { type: "exit" });
        socket.close();
      });
      stream.socket.on("error", (error) => {
        sendSocket(socket, { type: "error", error: safeDockerMessage(error) });
        socket.close();
      });
      socket.on("message", (raw: unknown) => {
        const message = parseSocketMessage(socketDataToString(raw));
        if (!message) {
          return;
        }
        if (message.type === "input") {
          stream.socket.write(message.data);
        }
        if (message.type === "resize" && execId) {
          void engine.resizeExec(execId, message.cols, message.rows).catch((error) => {
            sendSocket(socket, { type: "error", error: safeDockerMessage(error) });
          });
        }
      });
      socket.on("close", () => {
        stream.socket.destroy();
      });
    } catch (error) {
      const message = safeDockerMessage(error);
      markConsoleStartupFailed(context, authorization, message);
      sendSocket(socket, { type: "error", error: message });
      socket.close();
    }
  });
}

async function buildDockerProposal(
  body: DockerActionProposalBody,
  context: ApiRouteContext
): Promise<BuiltDockerProposal> {
  const { config, docker } = context;
  const action = body.action;
  if (!action) {
    throw new Error("Docker action is required");
  }

  if (isContainerAction(action) || action === "console") {
    const summary = await collectDockerSummary({ ...config, docker: config.docker }, docker);
    const container = findContainer(summary.containers, body.containerId);
    if (!container) {
      throw new Error("Docker container not found");
    }
    const shell = action === "console" ? validatedShell(config.docker.consoleShells, body.shell) : undefined;
    return {
      action,
      targetType: action === "console" ? "console" : "container",
      containerId: container.id,
      containerName: container.name,
      ...(shell ? { shell } : {}),
      risk: action === "console" || action === "remove" ? "high" : "medium",
      summary:
        action === "console"
          ? `Open Docker console for ${container.name} with ${shell}`
          : `${actionLabel(action)} Docker container ${container.name}`
    };
  }

  if (isComposeAction(action)) {
    if (!body.composeProjectId) {
      throw new Error("Compose project id is required");
    }
    const project = await dockerCompose(config.docker, docker).getProject(body.composeProjectId);
    if (!project) {
      throw new Error("Compose project is not configured");
    }
    const service = validatedComposeService(project.services, action, body.service);
    if (service && project.hostAccessState && project.hostAccessState !== "active") {
      throw new DockerComposeValidationError("Host Access changes or repairs require applying the entire Compose project");
    }
    const hostAccessDraft = action === "compose_up" && project.hostAccessState
      ? await prepareComposeHostAccessDraft(context, project.id)
      : null;
    return {
      action,
      targetType: "compose_project",
      composeProjectId: project.id,
      composeProjectName: project.name,
      composeRevision: project.revision,
      ...(service ? { service } : {}),
      ...(hostAccessDraft ? {
        hostAccess: hostAccessDraft.hostAccess,
        internalHostAccessDraft: {
          id: hostAccessDraft.draftId,
          revision: hostAccessDraft.draftRevision
        }
      } : {}),
      risk: action === "compose_down" || project.risk === "high" ? "high" : "medium",
      summary: `${actionLabel(action)} Docker Compose project ${project.name}${service ? ` service ${service}` : ""}`
    };
  }

  throw new Error("Unsupported Docker action");
}

async function prepareComposeHostAccessDraft(
  context: ApiRouteContext,
  projectId: string
): Promise<{
  draftId: string;
  draftRevision: string;
  hostAccess: NonNullable<DockerOperationProposal["hostAccess"]>;
}> {
  const compose = dockerCompose(context.config.docker, context.docker);
  if (!compose.prepareHostAccessDraft) {
    throw new DockerCreateValidationError("Compose Host Access draft is unavailable", 503);
  }
  return compose.prepareHostAccessDraft(
    projectId,
    dockerEngine(context.config.docker, context.docker),
    listDockerRegistryCredentials(context.db)
  );
}

function sendDockerComposeAppError(reply: FastifyReply, error: unknown): void {
  if (error instanceof DockerComposeValidationError) {
    reply.status(error.statusCode).send({ error: error.message, ...(error.issues.length ? { issues: error.issues } : {}) });
    return;
  }
  if (error instanceof DockerComposeAppConflictError || error instanceof DockerComposeAppProjectKeyConflictError) {
    reply.status(409).send({ error: error.message });
    return;
  }
  if (error instanceof DockerComposeUnavailableError) {
    reply.status(503).send({ error: error.message });
    return;
  }
  if (error instanceof DockerComposeMaterializationError) {
    reply.status(502).send({ error: error.message.slice(0, 500) });
    return;
  }
  reply.status(500).send({ error: "Unable to update Docker Compose App" });
}

function sendDockerInspectError(reply: FastifyReply, error: unknown, notFoundMessage: string): void {
  if (error instanceof DockerRequestError && error.statusCode === 404) {
    reply.status(404).send({ error: notFoundMessage });
    return;
  }
  reply.status(502).send({ error: safeDockerMessage(error) });
}

async function composeAppContainers(
  config: ReturnType<typeof effectiveDockerConfig>["docker"],
  docker: ApiRouteContext["docker"]
): Promise<DockerContainerSummary[] | null> {
  if (!config.enabled) return null;
  try {
    const engine = dockerEngine(config, docker);
    const containers = await engine.listContainers();
    if (!engine.getContainerDetails) return containers;
    return Promise.all(containers.map(async (container) => {
      if (!container.composeProject) return container;
      try {
        return await engine.getContainerDetails!(container.id, container);
      } catch {
        return container;
      }
    }));
  } catch {
    return null;
  }
}

function isDockerComposeAppError(error: unknown): boolean {
  return error instanceof DockerComposeValidationError ||
    error instanceof DockerComposeAppConflictError ||
    error instanceof DockerComposeAppProjectKeyConflictError ||
    error instanceof DockerComposeUnavailableError ||
    error instanceof DockerComposeMaterializationError;
}

function dockerCreateAuditResult(result: DockerCreateResult): Omit<DockerCreateResult, "error"> {
  const { error: _error, ...audit } = result;
  return audit;
}

function dockerCreateErrorStatus(error: unknown): number {
  if (error instanceof DockerCreateValidationError) {
    return error.statusCode;
  }
  const cause = error instanceof DockerCreateExecutionError ? error.cause : error;
  if (cause instanceof DockerRequestError && cause.statusCode === 409) {
    return 409;
  }
  if (error instanceof DockerCreateExecutionError) {
    return 502;
  }
  const statusCode = error instanceof Error && "statusCode" in error
    ? (error as { statusCode?: unknown }).statusCode
    : null;
  if (statusCode === 409 || statusCode === 503) return statusCode;
  return 400;
}

function validateRegistryCreateInput(body: unknown): DockerRegistryCredentialCreateInput {
  const source = registryRequestRecord(body);
  assertRegistryKeys(source, ["name", "serverAddress", "username", "password"]);
  return {
    name: requiredRegistryText(source.name, "Registry name", 128),
    serverAddress: normalizeDockerRegistryAddress(source.serverAddress),
    username: requiredRegistryUsername(source.username),
    password: requiredRegistryPassword(source.password)
  };
}

function validateRegistryUpdateInput(body: unknown): DockerRegistryCredentialUpdateInput {
  const source = registryRequestRecord(body);
  assertRegistryKeys(source, ["name", "serverAddress", "username", "password"]);
  const update: DockerRegistryCredentialUpdateInput = {};
  if (source.name !== undefined) {
    update.name = requiredRegistryText(source.name, "Registry name", 128);
  }
  if (source.serverAddress !== undefined) {
    update.serverAddress = normalizeDockerRegistryAddress(source.serverAddress);
  }
  if (source.username !== undefined) {
    update.username = requiredRegistryUsername(source.username);
  }
  if (source.password !== undefined) {
    if (typeof source.password !== "string") {
      throw new DockerRegistryValidationError("Registry password must be a string");
    }
    if (source.password.trim()) {
      update.password = requiredRegistryPassword(source.password);
    }
  }
  if (!Object.keys(update).length && source.password === undefined) {
    throw new DockerRegistryValidationError("At least one Registry field is required");
  }
  return update;
}

function registryRequestRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DockerRegistryValidationError("Docker registry request must be an object");
  }
  return body as Record<string, unknown>;
}

function assertRegistryKeys(source: Record<string, unknown>, allowed: readonly string[]): void {
  const unknownKey = Object.keys(source).find((key) => !allowed.includes(key));
  if (unknownKey) {
    throw new DockerRegistryValidationError(`Unknown Docker registry field: ${unknownKey}`);
  }
}

function requiredRegistryPassword(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DockerRegistryValidationError("Registry password is required");
  }
  if (value.length > 4096) {
    throw new DockerRegistryValidationError("Registry password is too long");
  }
  return value;
}

function requiredRegistryUsername(value: unknown): string {
  const username = requiredRegistryText(value, "Registry username", 255);
  if (username.includes(":") || Array.from(username).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new DockerRegistryValidationError("Registry username contains an invalid character");
  }
  return username;
}

function sendDockerRegistryMutationError(reply: FastifyReply, error: unknown): void {
  if (error instanceof DockerRegistryValidationError) {
    reply.status(400).send({ error: error.message });
    return;
  }
  if (error instanceof DockerRegistryCredentialConflictError) {
    reply.status(409).send({ error: error.message });
    return;
  }
  reply.status(500).send({ error: "Unable to update Docker registry credentials" });
}

function sendDockerImageError(
  reply: FastifyReply,
  error: unknown,
  credentials: DockerRegistryCredentialRecord[] = []
): void {
  if (error instanceof DockerRegistryValidationError) {
    reply.status(400).send({ error: error.message });
    return;
  }
  const statusCode = error instanceof DockerRequestError && (error.statusCode === 404 || error.statusCode === 409)
    ? error.statusCode
    : 502;
  reply.status(statusCode).send({ error: redactDockerRegistrySecrets(error, credentials) });
}

function dockerProposalFromOperation(operation: { metadata: Record<string, unknown> }): DockerOperationProposal | null {
  const proposal = operation.metadata.proposal;
  if (!proposal || typeof proposal !== "object" || !("action" in proposal)) {
    return null;
  }
  return proposal as DockerOperationProposal;
}

function findContainer(containers: DockerContainerSummary[], containerId: string | undefined): DockerContainerSummary | null {
  if (!containerId) {
    return null;
  }
  return (
    containers.find(
      (container) =>
        container.id === containerId ||
        container.shortId === containerId ||
        container.id.startsWith(containerId) ||
        container.name === containerId
    ) ?? null
  );
}

function validatedShell(shells: string[], requested: string | undefined): string {
  const shell = requested || shells[0];
  if (!shell || !shells.includes(shell)) {
    throw new Error("Docker console shell is not allowed");
  }
  return shell;
}

function validatedComposeService(
  services: string[],
  action: DockerOperationAction,
  requested: string | undefined
): string | undefined {
  const service = requested?.trim();
  if (!service) {
    return undefined;
  }
  if (action === "compose_down") {
    throw new Error("Compose down does not support a service target");
  }
  if (service.startsWith("-")) {
    throw new Error("Compose service name is not allowed");
  }
  if (!services.includes(service)) {
    throw new Error("Compose service is not part of the configured project");
  }
  return service;
}

function markConsoleStarted(
  { db }: ApiRouteContext,
  authorization: DockerConsoleAuthorizationRecord,
  execId: string
) {
  const applied = updateDockerOperationStatus(db, authorization.operationId, "applied", {
    consoleSessionId: authorization.id,
    execId,
    openedAt: new Date().toISOString()
  });
  if (!authorization.approvalId) return;
  const approval = getApproval(db, authorization.approvalId);
  if (!approval) {
    return;
  }
  updateApprovalStatus(db, approval.id, "applied", ["approved"]);
  updateJobStatus(db, approval.jobId, "completed", null, ["waiting_approval", "completed"]);
  appendEvent(db, {
    sessionId: approval.sessionId,
    jobId: approval.jobId,
    type: "job.completed",
    payload: {
      jobId: approval.jobId,
      approvalId: approval.id,
      dockerOperation: applied
    }
  });
}

function markConsoleStartupFailed(
  { db }: ApiRouteContext,
  authorization: DockerConsoleAuthorizationRecord,
  message: string
) {
  markDockerConsoleAuthorizationFailed(db, authorization.id);
  const failed = updateDockerOperationStatus(db, authorization.operationId, "failed", {
    error: message,
    failedAt: new Date().toISOString()
  });
  if (!authorization.approvalId) return;
  const approval = getApproval(db, authorization.approvalId);
  if (!approval) {
    return;
  }
  updateApprovalStatus(db, approval.id, "failed", ["approved", "applied"]);
  updateJobStatus(db, approval.jobId, "failed", message);
  appendEvent(db, {
    sessionId: approval.sessionId,
    jobId: approval.jobId,
    type: "job.failed",
    payload: {
      error: message,
      approvalId: approval.id,
      dockerOperation: failed
    }
  });
}

function isContainerAction(action: DockerOperationAction): boolean {
  return action === "start" || action === "stop" || action === "restart" || action === "remove";
}

function dockerDaemonStatusSignature(status: DockerDaemonStatus): string {
  return JSON.stringify({
    state: status.state,
    loadState: status.loadState,
    activeState: status.activeState,
    subState: status.subState,
    result: status.result
  });
}

interface DockerDaemonEventCloseSignal {
  on(event: "close", listener: () => void): unknown;
}

interface DockerDaemonEventOutput {
  write(chunk: string): unknown;
}

interface DockerDaemonEventStreamOptions {
  sampleMs?: number;
  heartbeatMs?: number;
}

export async function streamDockerDaemonEvents(
  closeSignal: DockerDaemonEventCloseSignal,
  output: DockerDaemonEventOutput,
  daemon: Pick<SystemDockerDaemonRuntime, "getStatus">,
  options: DockerDaemonEventStreamOptions = {}
): Promise<void> {
  const sampleMs = options.sampleMs ?? DOCKER_DAEMON_SAMPLE_MS;
  const heartbeatMs = options.heartbeatMs ?? DOCKER_DAEMON_HEARTBEAT_MS;
  let closed = false;
  let sampling = false;
  let lastSignature: string | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  closeSignal.on("close", () => {
    closed = true;
    if (statusTimer) clearInterval(statusTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });
  output.write("retry: 2000\n\n");

  const sample = async () => {
    if (closed || sampling) return;
    sampling = true;
    try {
      const status = await daemon.getStatus();
      const signature = dockerDaemonStatusSignature(status);
      if (!closed && signature !== lastSignature) {
        lastSignature = signature;
        output.write("event: docker.daemon.status\n");
        output.write(`data: ${JSON.stringify(status)}\n\n`);
      }
    } catch {
      const status: DockerDaemonStatus = {
        state: "failed",
        loadState: null,
        activeState: null,
        subState: null,
        result: "collection-error",
        collectedAt: new Date().toISOString()
      };
      const signature = dockerDaemonStatusSignature(status);
      if (!closed && signature !== lastSignature) {
        lastSignature = signature;
        output.write("event: docker.daemon.status\n");
        output.write(`data: ${JSON.stringify(status)}\n\n`);
      }
    } finally {
      sampling = false;
    }
  };

  await sample();
  if (closed) return;
  statusTimer = setInterval(() => void sample(), sampleMs);
  heartbeatTimer = setInterval(() => {
    if (!closed) output.write(": heartbeat\n\n");
  }, heartbeatMs);
}

function sendDockerDaemonError(reply: FastifyReply, error: unknown): void {
  const statusCode = error instanceof DockerDaemonRequestError ? error.statusCode : 503;
  reply.status(statusCode).send({
    error: safeDockerDaemonMessage(error),
    ...(error instanceof DockerDaemonRequestError && error.result ? { result: error.result } : {})
  });
}

function isComposeAction(action: DockerOperationAction): boolean {
  return action === "compose_up" || action === "compose_down" || action === "compose_pull" || action === "compose_restart";
}

function actionLabel(action: DockerOperationAction): string {
  switch (action) {
    case "compose_up":
      return "Deploy";
    case "compose_down":
      return "Stop";
    case "compose_pull":
      return "Pull images for";
    case "compose_restart":
      return "Restart";
    default:
      return action[0] ? `${action[0].toUpperCase()}${action.slice(1)}` : action;
  }
}

function sendSocket(socket: { send(data: string): void }, payload: Record<string, unknown>) {
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // The client may already be closed.
  }
}

function socketDataToString(raw: unknown): string {
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.filter(Buffer.isBuffer)).toString("utf8");
  }
  return String(raw);
}

function parseSocketMessage(raw: string):
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | null {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
    if (parsed.type === "input" && typeof parsed.data === "string") {
      return { type: "input", data: parsed.data };
    }
    if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
      return { type: "resize", cols: parsed.cols, rows: parsed.rows };
    }
  } catch {
    return null;
  }
  return null;
}
