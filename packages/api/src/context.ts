import type { CyberOsDatabase } from "@cyberos/db";
import type { CapabilityRuntimeDependencies } from "@cyberos/capability-runtime";
import type { MonitoringReader } from "@cyberos/monitoring";
import type { PublicBuildInfo, CyberOsConfig } from "@cyberos/shared";
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
import type { PhotosMapArchiveRuntime } from "./lib/photos-map.js";
import type { FileBatchRuntime } from "./lib/file-batch-runner.js";
import type { DockerHostAccessRuntime } from "./lib/docker-host-access.js";
import type { MonitoringEventBroker } from "./lib/monitoring-events.js";

export interface ApiRouteContext {
  config: CyberOsConfig;
  db: CyberOsDatabase;
  monitoring: MonitoringReader;
  monitoringEvents?: MonitoringEventBroker;
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
  photosMap?: PhotosMapArchiveRuntime;
  fileBatches?: FileBatchRuntime;
  hostAccess?: DockerHostAccessRuntime;
  capabilityRuntime?: CapabilityRuntimeDependencies;
}

export type ServerDependencies = Omit<ApiRouteContext, "monitoring" | "monitoringEvents"> & {
  monitoring?: MonitoringReader;
  monitoringEvents?: MonitoringEventBroker;
};
