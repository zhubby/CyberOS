import type { SigmaDatabase } from "@sigmaos/db";
import type { PublicBuildInfo, SigmaConfig } from "@sigmaos/shared";
import type { DockerComposeRuntime } from "./lib/docker-compose.js";
import type { DockerEngineRuntime } from "./lib/docker-client.js";
import type { DockerDaemonRuntime } from "./lib/docker-daemon.js";
import type { ShareManagementDependencies } from "./lib/share-service.js";
import type { SystemManagementDependencies } from "./lib/system-management.js";
import type { SystemPowerRuntime } from "./lib/power-management.js";
import type { SystemOperationsRuntime } from "./lib/operations-management.js";
import type { TerminalRuntime } from "./lib/terminal.js";
import type { VideoTranscoder } from "./lib/video-cache.js";
import type { VodPlayerRuntime } from "./lib/vod-player.js";
import type { VmRuntimeDependencies } from "./lib/vm-service.js";

export interface ApiRouteContext {
  config: SigmaConfig;
  db: SigmaDatabase;
  buildInfo?: PublicBuildInfo;
  docker?: {
    engine?: DockerEngineRuntime;
    compose?: DockerComposeRuntime;
    daemon?: DockerDaemonRuntime;
  };
  vm?: VmRuntimeDependencies;
  shares?: ShareManagementDependencies;
  system?: SystemManagementDependencies & {
    power?: SystemPowerRuntime;
    operations?: SystemOperationsRuntime;
  };
  terminal?: TerminalRuntime;
  videoTranscoder?: VideoTranscoder;
  vodPlayer?: VodPlayerRuntime;
}

export type ServerDependencies = ApiRouteContext;
