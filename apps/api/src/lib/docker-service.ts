import type {
  DockerConfig,
  DockerContainerSummary,
  DockerImageSummary,
  DockerOperationProposal,
  DockerOperationRecord,
  DockerSummary,
  ZosConfig
} from "@zos/shared";
import type { DockerRegistryCredentialRecord } from "@zos/db";
import type { DockerComposeRuntime } from "./docker-compose.js";
import { DockerSocketClient, type DockerEngineRuntime } from "./docker-client.js";
import { SystemDockerDaemonRuntime, type DockerDaemonRuntime } from "./docker-daemon.js";
import { redactDockerRegistrySecrets } from "./docker-registry.js";

export interface DockerRuntimeDependencies {
  engine?: DockerEngineRuntime;
  compose?: DockerComposeRuntime;
  daemon?: DockerDaemonRuntime;
}

export function dockerEngine(config: DockerConfig, dependencies?: DockerRuntimeDependencies): DockerEngineRuntime {
  return (
    dependencies?.engine ??
    new DockerSocketClient({
      socketPath: config.socketPath,
      timeoutMs: config.operationTimeoutMs
    })
  );
}

export function dockerCompose(config: DockerConfig, dependencies?: DockerRuntimeDependencies): DockerComposeRuntime {
  if (!dependencies?.compose) {
    throw new Error(`Managed Docker Compose runtime is unavailable for ${config.composeCommand}`);
  }
  return dependencies.compose;
}

export async function collectDockerSummary(
  config: ZosConfig,
  dependencies?: DockerRuntimeDependencies
): Promise<DockerSummary> {
  const daemon = dependencies?.daemon ?? new SystemDockerDaemonRuntime({ hostdSocketPath: config.hostd.socketPath });
  const daemonStatus = await daemon.getStatus();
  const compose = dockerCompose(config.docker, dependencies);
  if (!config.docker.enabled) {
    const composeProjects = await compose.listProjects(null).catch(() => []);
    return { ...dockerUnavailableSummary(config.docker, "disabled", null, daemonStatus), composeProjects };
  }

  const engine = dockerEngine(config.docker, dependencies);
  try {
    const [info, containers, counts] = await Promise.all([
      engine.getInfo(),
      engine.listContainers(),
      engine.getCounts()
    ]);
    const composeProjects = await compose.listProjects(containers).catch(() => []);
    return {
      collectedAt: new Date().toISOString(),
      enabled: true,
      daemon: daemonStatus,
      engine: {
        status: "ready",
        ...info,
        error: null
      },
      metrics: {
        containers: {
          total: containers.length,
          running: containers.filter((container) => container.state === "running").length,
          paused: containers.filter((container) => container.state === "paused").length,
          stopped: containers.filter((container) => container.state === "exited" || container.state === "dead").length
        },
        images: counts.images,
        networks: counts.networks,
        volumes: counts.volumes,
        ...aggregateContainerStats(containers)
      },
      images: resolveDockerImageOccupancy(counts.imageDetails ?? [], containers),
      networks: counts.networkDetails ?? [],
      volumes: counts.volumeDetails ?? [],
      containers,
      composeProjects
    };
  } catch (error) {
    const composeProjects = await compose.listProjects(null).catch(() => []);
    return {
      ...dockerUnavailableSummary(config.docker, "unavailable", safeDockerMessage(error), daemonStatus),
      composeProjects
    };
  }
}

export function resolveDockerImageOccupancy(
  images: DockerImageSummary[],
  containers: DockerContainerSummary[]
): DockerImageSummary[] {
  const complete = containers.every((container) => Boolean(container.imageId));
  const counts = new Map<string, number>();
  for (const container of containers) {
    if (container.imageId) {
      const id = container.imageId.replace(/^sha256:/u, "");
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return images.map((image) => ({
    ...image,
    containerCount: complete
      ? counts.get(image.id.replace(/^sha256:/u, "")) ?? 0
      : image.containerCount
  }));
}

export async function applyDockerOperation(
  config: ZosConfig,
  operation: DockerOperationRecord,
  proposal: DockerOperationProposal,
  dependencies?: DockerRuntimeDependencies,
  registryCredentials: DockerRegistryCredentialRecord[] = []
): Promise<Record<string, unknown>> {
  if (!config.docker.enabled) {
    throw new Error("Docker management is disabled");
  }

  const engine = dockerEngine(config.docker, dependencies);
  const compose = dockerCompose(config.docker, dependencies);
  switch (proposal.action) {
    case "start":
      await engine.startContainer(requiredContainerId(proposal));
      return { action: proposal.action, containerId: proposal.containerId };
    case "stop":
      await engine.stopContainer(requiredContainerId(proposal));
      return { action: proposal.action, containerId: proposal.containerId };
    case "restart":
      await engine.restartContainer(requiredContainerId(proposal));
      return { action: proposal.action, containerId: proposal.containerId };
    case "remove":
      await engine.removeContainer(requiredContainerId(proposal));
      return { action: proposal.action, containerId: proposal.containerId };
    case "compose_up":
    case "compose_down":
    case "compose_pull":
    case "compose_restart": {
      const result = await compose.runProjectAction(proposal, registryCredentials, engine, operation.approvalId);
      return {
        action: proposal.action,
        composeProjectId: proposal.composeProjectId,
        service: proposal.service ?? null,
        output: redactDockerRegistrySecrets(result.output, registryCredentials, 16_000)
      };
    }
    case "console":
      return {
        action: proposal.action,
        containerId: requiredContainerId(proposal),
        shell: proposal.shell,
        operationId: operation.id
      };
    default:
      throw new Error("Unsupported Docker action");
  }
}

export function dockerUnavailableSummary(
  config: DockerConfig,
  status: DockerSummary["engine"]["status"],
  error: string | null,
  daemon: DockerSummary["daemon"] = {
    state: "failed",
    loadState: null,
    activeState: null,
    subState: null,
    result: "collection-error",
    collectedAt: new Date().toISOString()
  }
): DockerSummary {
  return {
    collectedAt: new Date().toISOString(),
    enabled: config.enabled,
    daemon,
    engine: {
      status,
      version: null,
      apiVersion: null,
      negotiatedApiVersion: null,
      operatingSystem: null,
      architecture: null,
      dockerRootDir: null,
      error
    },
    metrics: {
      containers: {
        total: 0,
        running: 0,
        paused: 0,
        stopped: 0
      },
      images: 0,
      networks: 0,
      volumes: 0,
      cpuPercent: null,
      memoryUsageBytes: null,
      memoryLimitBytes: null,
      memoryPercent: null
    },
    images: [],
    networks: [],
    volumes: [],
    containers: [],
    composeProjects: []
  };
}

export function safeDockerMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 500);
}

function aggregateContainerStats(containers: DockerContainerSummary[]) {
  const cpuValues = containers
    .map((container) => container.cpuPercent)
    .filter((value): value is number => typeof value === "number");
  const memoryUsageValues = containers
    .map((container) => container.memoryUsageBytes)
    .filter((value): value is number => typeof value === "number");
  const memoryLimitValues = containers
    .map((container) => container.memoryLimitBytes)
    .filter((value): value is number => typeof value === "number");
  const memoryUsageBytes = memoryUsageValues.reduce((sum, value) => sum + value, 0);
  const memoryLimitBytes = memoryLimitValues.reduce((sum, value) => sum + value, 0);
  return {
    cpuPercent: cpuValues.length ? cpuValues.reduce((sum, value) => sum + value, 0) : null,
    memoryUsageBytes: memoryUsageValues.length ? memoryUsageBytes : null,
    memoryLimitBytes: memoryLimitValues.length ? memoryLimitBytes : null,
    memoryPercent:
      memoryLimitBytes > 0 && memoryUsageValues.length ? (memoryUsageBytes / memoryLimitBytes) * 100 : null
  };
}

function requiredContainerId(proposal: DockerOperationProposal): string {
  if (!proposal.containerId) {
    throw new Error("Container id is required");
  }
  return proposal.containerId;
}
