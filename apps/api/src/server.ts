import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";
import { deleteExpiredDockerComposeHostAccessDrafts, deleteExpiredDockerCreateDrafts, getDockerSettings } from "@zos/db";
import { MonitoringReader } from "@zos/monitoring";
import type { ServerDependencies } from "./context.js";
import { DEFAULT_MONITORING_CONFIG } from "@zos/shared";
import { registerErrorHandler } from "./errors.js";
import { DockerComposeService } from "./lib/docker-compose.js";
import { effectiveDockerConfig } from "./lib/settings.js";
import { registerApiRoutes } from "./routes/index.js";
import { FileBatchRunner } from "./lib/file-batch-runner.js";
import { DockerHostAccessPolicy, reconcileRunningDockerHostAccess } from "./lib/docker-host-access.js";
import { DockerHostAccessControlClient } from "./lib/docker-host-access-control.js";
import { dockerEngine } from "./lib/docker-service.js";

export type { ServerDependencies } from "./context.js";

export async function buildServer({ buildInfo, config, db, monitoring: monitoringDependency, docker, vm, shares, system, terminal, videoTranscoder, vodPlayer, photostaffMap, hostAccess }: ServerDependencies): Promise<FastifyInstance> {
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
  deleteExpiredDockerCreateDrafts(db);
  deleteExpiredDockerComposeHostAccessDrafts(db);
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
  registerApiRoutes(server, {
    ...(buildInfo ? { buildInfo } : {}),
    config,
    db,
    monitoring,
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

  server.addHook("onReady", async () => {
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
    await fileBatches.stop();
    monitoring.close();
  });

  return server;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}
