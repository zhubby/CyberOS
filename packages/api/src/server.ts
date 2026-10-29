import cors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";
import {
  deleteExpiredDockerComposeHostAccessDrafts,
  deleteExpiredMcpResourceTokens,
  deleteExpiredMcpTransferTokens,
  expireCapabilityApprovals,
  getDockerSettings,
  getMonitoringAlertSummary,
  getShareSettings,
  getVmSettings,
  listDockerComposeAppSummaries,
  listDockerOperations,
  listDockerRegistryCredentials,
  listVmOperations
} from "@cyberos/db";
import { MonitoringReader } from "@cyberos/monitoring";
import type { ApiRouteContext, ServerDependencies } from "./context.js";
import type { MonitoringQueryRequest } from "@cyberos/shared";
import { CapabilityError, type JsonValue } from "@cyberos/capabilities";
import { registerErrorHandler } from "./errors.js";
import { DockerComposeService } from "./lib/docker-compose.js";
import { defaultShareSettings, effectiveDockerConfig, effectiveVmConfig } from "./lib/settings.js";
import { registerApiRoutes } from "./routes/index.js";
import { FileBatchRunner } from "./lib/file-batch-runner.js";
import { DockerHostAccessPolicy, reconcileRunningDockerHostAccess } from "./lib/docker-host-access.js";
import { DockerHostAccessControlClient } from "./lib/docker-host-access-control.js";
import { dockerEngine } from "./lib/docker-service.js";
import { collectDockerSummary } from "./lib/docker-service.js";
import { registerMcp, type McpRuntimeDependencies } from "@cyberos/mcp";
import { recoverCapabilityRuns } from "@cyberos/capability-runtime";
import { collectSystemNetwork, collectSystemNetworkTraffic, collectSystemStorage } from "./lib/system-management.js";
import { SystemNetworkManagerRuntime } from "./lib/network-manager.js";
import { SystemEthernetManagerRuntime } from "./lib/ethernet-manager.js";
import { collectShareSummary } from "./lib/share-service.js";
import { collectVmSummary } from "./lib/vm-service.js";
import { resolveVodPlayerRuntime } from "./lib/vod-player.js";
import { MonitoringEventBroker } from "./lib/monitoring-events.js";
import { createCapabilityAdapters } from "./lib/capability-adapters.js";
import {
  createMcpResourceResponder,
  createPhotoMediaMcpResource,
  McpResourceError
} from "./lib/mcp-resources.js";
import { reconcileAgentMcp } from "./lib/agent-mcp-settings.js";

export type { ServerDependencies } from "./context.js";

export async function buildServer({ buildInfo, config, db, monitoring: monitoringDependency, monitoringEvents: monitoringEventsDependency, docker, vm, shares, system, terminal, videoTranscoder, vodPlayer, photosMap, hostAccess, tvMode }: ServerDependencies): Promise<FastifyInstance> {
  if (!isLoopbackHost(config.api.host)) {
    throw new Error("CyberOS API must bind to a loopback host");
  }
  const server = Fastify({
    forceCloseConnections: true,
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });

  if (config.api.allowedOrigins?.length) {
    await server.register(cors, {
      origin: config.api.allowedOrigins
    });
  }

  await server.register(rateLimit, {
    max: 240,
    timeWindow: "1 minute"
  });
  await server.register(fastifyMultipart, {
    limits: {
      fields: 0,
      files: 1,
      fileSize: 16 * 1024 * 1024,
      parts: 1
    }
  });

  registerErrorHandler(server);
  await server.register(fastifyWebsocket);
  reconcileAgentMcp(db, config);
  const expireHostAccessDrafts = () => {
    deleteExpiredDockerComposeHostAccessDrafts(db);
    deleteExpiredMcpResourceTokens(db);
    deleteExpiredMcpTransferTokens(db);
    expireCapabilityApprovals(db);
  };
  expireHostAccessDrafts();
  const hostAccessRuntime = hostAccess ?? {
    policy: new DockerHostAccessPolicy(db, {
      runtimeRoot: path.join(config.paths.runDir, "host-access"),
      dataRoot: config.paths.dataRoot
    }),
    control: new DockerHostAccessControlClient()
  };
  const compose = docker?.compose ?? new DockerComposeService(
    () => effectiveDockerConfig(config, getDockerSettings(db)).docker,
    db,
    config.paths.appsRoot,
    hostAccessRuntime.policy,
    hostAccessRuntime.control
  );
  const dockerRuntime = { ...docker, compose };
  const fileBatches = new FileBatchRunner({ config, db, ...(system ? { system } : {}), log: server.log });
  const monitoring = monitoringDependency ?? new MonitoringReader(
    config.paths.metricsDatabasePath,
    config.monitoring
  );
  const monitoringEvents = monitoringEventsDependency ?? new MonitoringEventBroker({
    socketPath: process.env.CYBEROS_MONITORING_EVENTS_SOCKET
      ?? (config.environment === "production"
        ? path.join(config.paths.runDir, "monitoring-events.sock")
        : path.join(config.paths.stateDir, "monitoring-events.sock")),
    log: server.log
  });
  await monitoringEvents.start();
  const resourceBaseUrl = `http://127.0.0.1:${config.api.port}`;
  const capabilityAdapters = createCapabilityAdapters(server, {
    resourceBaseUrl,
    ...(system ? { system } : {})
  });
  const capabilityRuntime = { db, config, adapters: capabilityAdapters };
  const routeContext: ApiRouteContext = {
    ...(buildInfo ? { buildInfo } : {}),
    config,
    db,
    monitoring,
    monitoringEvents,
    docker: dockerRuntime,
    ...(vm ? { vm } : {}),
    ...(shares ? { shares } : {}),
    ...(system ? { system } : {}),
    ...(terminal ? { terminal } : {}),
    ...(videoTranscoder ? { videoTranscoder } : {}),
    ...(vodPlayer ? { vodPlayer } : {}),
    ...(photosMap ? { photosMap } : {}),
    fileBatches,
    hostAccess: hostAccessRuntime,
    capabilityRuntime,
    ...(tvMode ? { tvMode } : {})
  };
  registerApiRoutes(server, routeContext);
  const mcpNetworkManager = system?.networkManager ?? new SystemNetworkManagerRuntime({
    ...(system?.commandRunner ? { commandRunner: system.commandRunner } : {}),
    hostdSocketPath: config.hostd.socketPath
  });
  const mcpEthernetManager = system?.ethernetManager ?? new SystemEthernetManagerRuntime(config.hostd.socketPath);
  const readAdapters = {
    "cyberos.monitoring.overview": () => asJsonValue({
      ...monitoring.overview(),
      catalog: monitoring.catalog(),
      alerts: getMonitoringAlertSummary(db)
    }),
    "cyberos.monitoring.query": (input: JsonValue) => asJsonValue(
      monitoring.query(input as unknown as MonitoringQueryRequest)
    ),
    "cyberos.network.status": async () => {
      const [network, traffic, wifi, ethernet] = await Promise.all([
        collectSystemNetwork({
          ...system,
          networkManager: mcpNetworkManager,
          ethernetManager: mcpEthernetManager
        }),
        collectSystemNetworkTraffic(system),
        mcpNetworkManager.getStatus(),
        mcpEthernetManager.getStatus()
      ]);
      return asJsonValue({ network, traffic, wifi, ethernet });
    },
    "cyberos.storage.status": async () => {
      const shareSettings = getShareSettings(db) ?? defaultShareSettings(config);
      const [storage, sharesSummary] = await Promise.all([
        collectSystemStorage(system),
        collectShareSummary(shareSettings, shares)
      ]);
      return asJsonValue({ storage, shares: sharesSummary });
    },
    "cyberos.docker.status": async () => {
      const effectiveConfig = effectiveDockerConfig(config, getDockerSettings(db));
      return asJsonValue({
        summary: await collectDockerSummary(effectiveConfig, dockerRuntime),
        apps: listDockerComposeAppSummaries(db),
        operations: listDockerOperations(db, { limit: 100 }),
        registries: listDockerRegistryCredentials(db).map((registry) => ({
          id: registry.id,
          name: registry.name,
          serverAddress: registry.serverAddress,
          username: registry.username,
          credentialConfigured: Boolean(registry.password),
          updatedAt: registry.updatedAt
        })),
        hostAccess: hostAccessRuntime.policy.catalog()
      });
    },
    "cyberos.vm.status": async () => asJsonValue({
      summary: await collectVmSummary(effectiveVmConfig(config, getVmSettings(db)), vm),
      operations: listVmOperations(db, { limit: 100 })
    }),
    "cyberos.vod.status": async () => asJsonValue({ status: await resolveVodPlayerRuntime({ config, db, ...(vodPlayer ? { vodPlayer } : {}) }).getStatus() }),
    "cyberos.photos.media": async (input: JsonValue, executionContext, dependencies) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new CapabilityError("INVALID_ARGUMENT", "Photo media request is invalid");
      }
      const request = input as Record<string, JsonValue>;
      if (typeof request.assetId !== "string" || typeof request.variant !== "string") {
        throw new CapabilityError("INVALID_ARGUMENT", "assetId and variant are required");
      }
      if (!["thumbnail", "preview", "original", "video"].includes(request.variant)) {
        throw new CapabilityError("INVALID_ARGUMENT", "Photo media variant is invalid");
      }
      if (!dependencies.transferBaseUrl) {
        throw new CapabilityError("NOT_READY", "Resource URL is unavailable", { retryable: true });
      }
      try {
        return await createPhotoMediaMcpResource({
          db,
          config,
          ...(system ? { system } : {}),
          clientId: executionContext.subject.clientId,
          baseUrl: dependencies.transferBaseUrl,
          assetId: request.assetId,
          variant: request.variant as "thumbnail" | "preview" | "original" | "video"
        });
      } catch (error) {
        if (error instanceof McpResourceError) {
          if (error.statusCode === 409) throw new CapabilityError("CONFLICT", error.message);
          if (error.statusCode >= 500) throw new CapabilityError("NOT_READY", error.message, { retryable: true });
          throw new CapabilityError("INVALID_ARGUMENT", error.message);
        }
        throw error;
      }
    }
  } satisfies NonNullable<McpRuntimeDependencies["readAdapters"]>;
  registerMcp(server, {
    ...capabilityRuntime,
    readAdapters,
    resourceResponder: createMcpResourceResponder(routeContext),
    ...(buildInfo ? { buildInfo } : {})
  }, {
    enabled: config.mcp.enabled,
    allowedHosts: config.mcp.allowedHosts,
    allowedOrigins: config.mcp.allowedOrigins,
    maxConcurrentPerClient: config.mcp.maxConcurrentPerClient
  });
  const hostAccessDraftCleanup = setInterval(() => {
    try {
      expireHostAccessDrafts();
    } catch (error) {
      server.log.error({ err: error }, "Failed to expire Docker Host Access drafts");
    }
  }, 60_000);
  hostAccessDraftCleanup.unref();

  server.addHook("onReady", async () => {
    const recoveredRuns = await recoverCapabilityRuns(capabilityRuntime);
    if (recoveredRuns.expired > 0 || recoveredRuns.interrupted > 0 || recoveredRuns.resumed > 0) {
      server.log.info(recoveredRuns, "Recovered capability runs");
    }
    fileBatches.start();
    const currentDockerConfig = effectiveDockerConfig(config, getDockerSettings(db)).docker;
    const engine = currentDockerConfig.enabled ? dockerEngine(currentDockerConfig, dockerRuntime) : null;
    if (engine) {
      await engine.getInfo().then((info) => {
        hostAccessRuntime.policy.setRuntimeCompatibility({
          ...(info.rootless !== undefined ? { rootless: info.rootless } : {}),
          ...(info.userNamespace !== undefined ? { userNamespace: info.userNamespace } : {})
        });
      }).catch((error) => {
        server.log.error({ err: error }, "Failed to detect Docker Host Access runtime compatibility");
      });
    }
    await compose.reconcileAll().catch((error) => {
      server.log.error({ err: error }, "Failed to reconcile managed Docker Compose Apps");
    });
    if (engine && hostAccessRuntime.control) {
      await reconcileRunningDockerHostAccess(
        engine,
        hostAccessRuntime.control
      ).then((result) => {
        for (const failure of result.failures) {
          server.log.error(failure, "Failed to reconcile running Docker Host Access grant");
        }
      }).catch((error) => {
        server.log.error({ err: error }, "Failed to inspect running Docker Host Access grants");
      });
    }
  });

  server.addHook("onClose", async () => {
    clearInterval(hostAccessDraftCleanup);
    await fileBatches.stop();
    monitoring.close();
    await monitoringEvents.close();
  });

  return server;
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}
