import cors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { getDockerSettings } from "@sigmaos/db";
import type { ServerDependencies } from "./context.js";
import { registerErrorHandler } from "./errors.js";
import { DockerComposeService } from "./lib/docker-compose.js";
import { effectiveDockerConfig } from "./lib/settings.js";
import { registerApiRoutes } from "./routes/index.js";

export type { ServerDependencies } from "./context.js";

export async function buildServer({ buildInfo, config, db, docker, vm, shares, system, terminal, videoTranscoder, vodPlayer, photostaffMap }: ServerDependencies): Promise<FastifyInstance> {
  if (!isLoopbackHost(config.api.host)) {
    throw new Error("SigmaOS API must bind to a loopback host");
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

  registerErrorHandler(server);
  await server.register(fastifyWebsocket);
  const compose = docker?.compose ?? new DockerComposeService(
    () => effectiveDockerConfig(config, getDockerSettings(db)).docker,
    db
  );
  const dockerRuntime = { ...docker, compose };
  registerApiRoutes(server, {
    ...(buildInfo ? { buildInfo } : {}),
    config,
    db,
    docker: dockerRuntime,
    ...(vm ? { vm } : {}),
    ...(shares ? { shares } : {}),
    ...(system ? { system } : {}),
    ...(terminal ? { terminal } : {}),
    ...(videoTranscoder ? { videoTranscoder } : {}),
    ...(vodPlayer ? { vodPlayer } : {}),
    ...(photostaffMap ? { photostaffMap } : {})
  });

  server.addHook("onReady", async () => {
    await compose.reconcileAll().catch((error) => {
      server.log.error({ err: error }, "Failed to reconcile managed Docker Compose Apps");
    });
  });

  return server;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}
