import type { ZosDatabase } from "@zos/db";
import type { PublicBuildInfo, ZosConfig } from "@zos/shared";
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
import type { PhotostaffMapArchiveRuntime } from "./lib/photostaff-map.js";
import type { FileBatchRuntime } from "./lib/file-batch-runner.js";

export interface ApiRouteContext {
  config: ZosConfig;
  db: ZosDatabase;
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
  photostaffMap?: PhotostaffMapArchiveRuntime;
  fileBatches?: FileBatchRuntime;
}

export type ServerDependencies = ApiRouteContext;
