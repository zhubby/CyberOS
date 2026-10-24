import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";
import {
  deleteExpiredDockerComposeHostAccessDrafts,
  deleteExpiredDockerCreateDrafts,
  deleteExpiredMcpTransferTokens,
  expireCapabilityApprovals,
  getDockerSettings,
  getMonitoringAlertSummary,
  getShareSettings,
  listDockerComposeAppSummaries,
  listDockerOperations,
  listDockerRegistryCredentials,
  listVmOperations
} from "@zos/db";
import { MonitoringReader } from "@zos/monitoring";
import type { ServerDependencies } from "./context.js";
import { DEFAULT_MONITORING_CONFIG, type MonitoringQueryRequest } from "@zos/shared";
import type { JsonValue } from "@zos/capabilities";
import { registerErrorHandler } from "./errors.js";
import { DockerComposeService } from "./lib/docker-compose.js";
import { defaultShareSettings, effectiveDockerConfig } from "./lib/settings.js";
import { registerApiRoutes } from "./routes/index.js";
import { FileBatchRunner } from "./lib/file-batch-runner.js";
import { DockerHostAccessPolicy, reconcileRunningDockerHostAccess } from "./lib/docker-host-access.js";
import { DockerHostAccessControlClient } from "./lib/docker-host-access-control.js";
import { dockerEngine } from "./lib/docker-service.js";
import { collectDockerSummary } from "./lib/docker-service.js";
import { registerMcp } from "@zos/mcp";
import { recoverCapabilityRuns } from "@zos/capability-runtime";
import { collectSystemNetwork, collectSystemNetworkTraffic, collectSystemStorage } from "./lib/system-management.js";
import { SystemNetworkManagerRuntime } from "./lib/network-manager.js";
import { SystemEthernetManagerRuntime } from "./lib/ethernet-manager.js";
import { collectShareSummary } from "./lib/share-service.js";
import { collectVmSummary } from "./lib/vm-service.js";
import { createVodPlayerRuntime } from "./lib/vod-player.js";
import { MonitoringEventBroker } from "./lib/monitoring-events.js";

export type { ServerDependencies } from "./context.js";

export async function buildServer({ buildInfo, config, db, monitoring: monitoringDependency, monitoringEvents: monitoringEventsDependency, docker, vm, shares, system, terminal, videoTranscoder, vodPlayer, photostaffMap, hostAccess }: ServerDependencies): Promise<FastifyInstance> {
  if (!isLoopbackHost(config.api.host)) {
    throw new Error("ZOS API must bind to a loopback host");
  }
  const server = Fastify({
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

  registerErrorHandler(server);
  await server.register(fastifyWebsocket);
  const expireHostAccessDrafts = () => {
    deleteExpiredDockerCreateDrafts(db);
    deleteExpiredDockerComposeHostAccessDrafts(db);
    deleteExpiredMcpTransferTokens(db);
    expireCapabilityApprovals(db);
  };
  expireHostAccessDrafts();
  const hostAccessRuntime = hostAccess ?? {
    policy: new DockerHostAccessPolicy(db),
    control: new DockerHostAccessControlClient()
  };
  const compose = docker?.compose ?? new DockerComposeService(
    () => effectiveDockerConfig(config, getDockerSettings(db)).docker,
    db,
    config.paths?.appsRoot ?? config.appsRoot,
    hostAccessRuntime.policy,
    hostAccessRuntime.control
  );
  const dockerRuntime = { ...docker, compose };
  const fileBatches = new FileBatchRunner({ config, db, ...(system ? { system } : {}), log: server.log });
  const monitoring = monitoringDependency ?? new MonitoringReader(
    config.metricsDatabasePath ?? path.join(config.dataDir, "metrics.sqlite"),
    config.monitoring ?? DEFAULT_MONITORING_CONFIG
  );
  const monitoringEvents = monitoringEventsDependency ?? new MonitoringEventBroker({
    socketPath: process.env.ZOS_MONITORING_EVENTS_SOCKET
      ?? (config.environment === "production"
        ? path.join(config.paths?.runDir ?? "/run/zos", "monitoring-events.sock")
        : path.join(config.dataDir, "monitoring-events.sock")),
    log: server.log
  });
  await monitoringEvents.start();
  registerApiRoutes(server, {
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
    ...(photostaffMap ? { photostaffMap } : {}),
    fileBatches,
    hostAccess: hostAccessRuntime
  });
  const mcpNetworkManager = system?.networkManager ?? new SystemNetworkManagerRuntime({
    ...(system?.commandRunner ? { commandRunner: system.commandRunner } : {}),
    hostdSocketPath: config.hostd.socketPath
  });
  const mcpEthernetManager = system?.ethernetManager ?? new SystemEthernetManagerRuntime(config.hostd.socketPath);
  const mcpVodPlayer = vodPlayer ?? createVodPlayerRuntime(config.vodPlayer);
  const readAdapters = {
    "zos.monitoring.overview": () => asJsonValue({
      ...monitoring.overview(),
      catalog: monitoring.catalog(),
      alerts: getMonitoringAlertSummary(db)
    }),
    "zos.monitoring.query": (input: JsonValue) => asJsonValue(
      monitoring.query(input as unknown as MonitoringQueryRequest)
    ),
    "zos.network.status": async () => {
      const [network, traffic, wifi, ethernet] = await Promise.all([
        collectSystemNetwork({
          ...system,
          networkManager: mcpNetworkManager,
          ethernetManager: mcpEthernetManager,
          mutationPolicy: config.hostd.mutationPolicy ?? "mutable"
        }),
        collectSystemNetworkTraffic(system),
        mcpNetworkManager.getStatus(),
        mcpEthernetManager.getStatus()
      ]);
      return asJsonValue({ network, traffic, wifi, ethernet });
    },
    "zos.storage.status": async () => {
      const shareSettings = getShareSettings(db) ?? defaultShareSettings(config);
      const [storage, sharesSummary] = await Promise.all([
        collectSystemStorage({
          ...system,
          mutationPolicy: config.hostd.mutationPolicy ?? "mutable"
        }),
        collectShareSummary(shareSettings, {
          ...shares,
          mutationPolicy: config.hostd.mutationPolicy ?? "mutable"
        })
      ]);
      return asJsonValue({ storage, shares: sharesSummary });
    },
    "zos.docker.status": async () => {
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
    "zos.vm.status": async () => asJsonValue({
      summary: await collectVmSummary(config, vm),
      operations: listVmOperations(db, { limit: 100 })
    }),
    "zos.vod.status": async () => asJsonValue({ status: await mcpVodPlayer.getStatus() })
  } satisfies Readonly<Record<string, (input: JsonValue) => JsonValue | Promise<JsonValue>>>;
  registerMcp(server, { db, config, readAdapters, ...(buildInfo ? { buildInfo } : {}) }, {
    enabled: config.mcp?.enabled ?? false,
    ...(config.mcp?.allowedHosts ? { allowedHosts: config.mcp.allowedHosts } : {}),
    ...(config.mcp?.allowedOrigins ? { allowedOrigins: config.mcp.allowedOrigins } : {}),
    ...(config.mcp?.maxConcurrentPerClient ? { maxConcurrentPerClient: config.mcp.maxConcurrentPerClient } : {})
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
    const recoveredRuns = await recoverCapabilityRuns({ db, config });
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
