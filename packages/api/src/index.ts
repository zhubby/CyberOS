import { existsSync } from "node:fs";
import path from "node:path";
import { ensureNasRoots, openZosDb } from "@zos/db";
import { loadConfig } from "@zos/shared";
import { loadBuildInfo } from "./lib/build-info.js";
import { createSystemCommandRunner } from "./lib/system-management.js";
import { createTerminalRuntime } from "./lib/termux-client.js";
import { createVodPlayerRuntime } from "./lib/vod-player.js";
import { ffmpegVideoTranscoder } from "./lib/video-cache.js";
import { buildServer } from "./server.js";
import { registerWebApp } from "./web-static.js";

const config = loadConfig();
const db = openZosDb(config.databasePath);
const buildInfo = await loadBuildInfo();
ensureNasRoots(db, config.nasRoots);

const server = await buildServer({
  config,
  db,
  buildInfo,
  system: {
    commandRunner: createSystemCommandRunner(config.hostd.socketPath)
  },
  terminal: createTerminalRuntime(config.terminal),
  videoTranscoder: ffmpegVideoTranscoder,
  vodPlayer: createVodPlayerRuntime(config.vodPlayer)
});
const webDist = resolveWebDist();
const docsDist = resolveDocsDist();

if (existsSync(webDist)) {
  await registerWebApp(server, webDist, docsDist);
}

await server.listen({ host: config.api.host, port: config.api.port });

let shutdownPromise: Promise<void> | null = null;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdownPromise ??= shutdown(signal);
    void shutdownPromise.catch((error) => {
      server.log.error({ err: error, signal }, "Failed to shut down ZOS API cleanly");
      process.exitCode = 1;
    });
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  server.log.info({ signal }, "Stopping ZOS API");
  try {
    await server.close();
  } finally {
    db.close();
  }
}

function resolveWebDist(): string {
  if (process.env.ZOS_WEB_DIST) {
    return process.env.ZOS_WEB_DIST;
  }

  const candidates = [
    path.resolve(process.cwd(), "packages/web/dist"),
    path.resolve(process.cwd(), "../web/dist")
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function resolveDocsDist(): string | undefined {
  const configured = process.env.ZOS_DOCS_DIST;
  const candidates = [
    configured,
    path.resolve(process.cwd(), "docs/dist"),
    path.resolve(process.cwd(), "../docs/dist"),
    "/usr/lib/zos/docs/dist"
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}
