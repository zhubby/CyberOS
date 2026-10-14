import { lstat, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { getNasRoot, getRootReadiness } from "@zos/db";
import { resolveSafeExistingPath } from "@zos/nas-tools";
import { getUnsupportedDockerResource, parseDockerImageReference } from "@zos/shared";
import type {
  DockerContainerCreateInput,
  DockerCreateResult,
  DockerNetworkCreateInput,
  DockerOperationProposal,
  DockerSummary,
  DockerVolumeCreateInput
} from "@zos/shared";
import type { ApiRouteContext } from "../context.js";
import type {
  DockerCreateContainerInput as EngineContainerInput,
  DockerCreateNetworkInput as EngineNetworkInput,
  DockerCreateVolumeInput as EngineVolumeInput,
  DockerEngineRuntime
} from "./docker-client.js";
import { collectSystemNetwork } from "./system-management.js";

const MAX_STRING = 4_096;
const MAX_ITEMS = 128;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const LABEL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/u;
const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)?$/u;
const CONTAINER_KEYS = [
  "sessionId", "action", "targetType", "name", "image", "platform", "pullPolicy", "start", "hostname", "user",
  "workingDir", "entrypoint", "command", "environment", "labels", "tty", "openStdin", "init", "stopSignal",
  "stopTimeoutSeconds", "cpuLimit", "cpuShares", "cpusetCpus", "memoryLimitBytes", "memoryReservationBytes",
  "memorySwapBytes", "pidsLimit", "shmSizeBytes", "readonlyRootfs", "privileged", "privilegedAcknowledged",
  "mounts", "network", "ports", "publishAllPorts", "dns", "dnsSearch", "extraHosts", "restartPolicy",
  "restartMaxRetries", "autoRemove"
] as const;
const VOLUME_KEYS = ["sessionId", "action", "targetType", "name", "labels"] as const;
const NETWORK_KEYS = [
  "sessionId", "action", "targetType", "name", "driver", "parent", "mode", "internal", "enableIpv4", "enableIpv6",
  "ipam", "labels"
] as const;

export class DockerCreateValidationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "DockerCreateValidationError";
  }
}

export class DockerCreateExecutionError extends Error {
  constructor(readonly phase: "pull" | "create", readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DockerCreateExecutionError";
  }
}

type PreparedDockerCreate =
  | {
      kind: "container";
      input: DockerContainerCreateInput;
      engineInput: Omit<EngineContainerInput, "labels"> & { labels: Record<string, string> };
      proposal: DockerOperationProposal;
      audit: Record<string, unknown>;
    }
  | {
      kind: "volume";
      input: DockerVolumeCreateInput;
      engineInput: Omit<EngineVolumeInput, "labels"> & { labels: Record<string, string> };
      proposal: DockerOperationProposal;
      audit: Record<string, unknown>;
    }
  | {
      kind: "network";
      input: DockerNetworkCreateInput;
      engineInput: Omit<EngineNetworkInput, "labels"> & { labels: Record<string, string> };
      proposal: DockerOperationProposal;
      audit: Record<string, unknown>;
    };

export async function prepareDockerCreate(
  body: unknown,
  context: ApiRouteContext,
  summary: DockerSummary
): Promise<PreparedDockerCreate> {
  const source = record(body, "Docker create request");
  if (source.action !== "create") {
    throw new DockerCreateValidationError("Docker create action is required");
  }
  if (source.targetType === "container") {
    return prepareContainer(source, context, summary);
  }
  if (source.targetType === "volume") {
    return prepareVolume(source, summary);
  }
  if (source.targetType === "network") {
    return prepareNetwork(source, context, summary);
  }
  throw new DockerCreateValidationError("Docker create target must be container, volume, or network");
}

export async function executeDockerCreate(
  prepared: PreparedDockerCreate,
  engine: DockerEngineRuntime,
  operationId: string,
  getRegistryAuth?: () => string | undefined
): Promise<DockerCreateResult> {
  const managedLabels = {
    ...prepared.engineInput.labels,
    "io.zos.managed": "true",
    "io.zos.operation": operationId
  };

  if (prepared.kind === "volume") {
    const created = await createPhase(() => engine.createVolume({ ...prepared.engineInput, labels: managedLabels }));
    return {
      kind: "volume",
      id: created.name,
      name: created.name,
      created: true,
      warnings: [],
      partialSuccess: false
    };
  }

  if (prepared.kind === "network") {
    const created = await createPhase(() => engine.createNetwork({ ...prepared.engineInput, labels: managedLabels }));
    return {
      kind: "network",
      id: created.id,
      name: prepared.input.name,
      created: true,
      warnings: created.warning ? [created.warning] : [],
      partialSuccess: false
    };
  }

  const policy = prepared.input.pullPolicy ?? "missing";
  let pulled = false;
  const pullImage = () => {
    const registryAuth = getRegistryAuth?.();
    return engine.pullImage({ image: prepared.engineInput.image, ...(registryAuth ? { registryAuth } : {}) });
  };
  if (policy === "always") {
    await pullPhase(pullImage);
    pulled = true;
  } else {
    const exists = await pullPhase(() => engine.imageExists(prepared.engineInput.image));
    if (policy === "never" && !exists) {
      throw new DockerCreateValidationError("Docker image is not available locally");
    }
    if (policy === "missing" && !exists) {
      await pullPhase(pullImage);
      pulled = true;
    }
  }

  const created = await createPhase(() => engine.createContainer({ ...prepared.engineInput, labels: managedLabels }));
  if (prepared.input.start === false) {
    return {
      kind: "container",
      id: created.id,
      name: prepared.input.name,
      created: true,
      pulled,
      started: false,
      warnings: created.warnings,
      partialSuccess: false
    };
  }

  try {
    await engine.startContainer(created.id);
    return {
      kind: "container",
      id: created.id,
      name: prepared.input.name,
      created: true,
      pulled,
      started: true,
      warnings: created.warnings,
      partialSuccess: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "container",
      id: created.id,
      name: prepared.input.name,
      created: true,
      pulled,
      started: false,
      warnings: created.warnings,
      partialSuccess: true,
      phase: "start",
      error: message
    };
  }
}

async function pullPhase<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new DockerCreateExecutionError("pull", error);
  }
}

async function createPhase<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new DockerCreateExecutionError("create", error);
  }
}

async function prepareContainer(
  source: Record<string, unknown>,
  context: ApiRouteContext,
  summary: DockerSummary
): Promise<Extract<PreparedDockerCreate, { kind: "container" }>> {
  allowed(source, CONTAINER_KEYS);
  const name = resourceName(source.name, "Container name");
  if (summary.containers.some((container) => container.name === name)) {
    throw new DockerCreateValidationError("Docker container already exists", 409);
  }
  const image = imageReference(requiredString(source.image, "Image", 512));
  const platform = optionalString(source.platform, "Platform", 64);
  if (platform && !PLATFORM_PATTERN.test(platform)) {
    throw new DockerCreateValidationError("Platform must use os/architecture[/variant] format");
  }
  if (platform) {
    requireApiVersion(summary, "1.32", "Platform selection");
  }
  const labels = stringMap(source.labels, "Labels", true);
  const environment = stringMap(source.environment, "Environment");
  if (Object.keys(environment).some((key) => !ENVIRONMENT_KEY_PATTERN.test(key))) {
    throw new DockerCreateValidationError("Environment contains an invalid variable name");
  }
  const entrypoint = stringArray(source.entrypoint, "Entrypoint");
  const command = stringArray(source.command, "Command");
  const mounts = await containerMounts(source.mounts, context, summary);
  const network = containerNetwork(source.network, summary);
  const ports = portBindings(source.ports);
  const publishAllPorts = boolean(source.publishAllPorts, "Publish all ports", false);
  const endpointConfigured = Boolean(
    network.aliases?.length || network.ipv4Address || network.ipv6Address || network.macAddress || network.networkName
  );
  if ((network.mode === "host" || network.mode === "none") && (ports.length || publishAllPorts || endpointConfigured)) {
    throw new DockerCreateValidationError("Host and none network modes cannot use ports or endpoint settings");
  }
  if (network.macAddress) {
    requireApiVersion(summary, "1.44", "Endpoint MAC address");
  }
  if (network.ipv4Address || network.ipv6Address) {
    requireApiVersion(summary, "1.22", "Static network address");
  }
  if (mounts.input.some((mount) => mount.type === "tmpfs")) {
    requireApiVersion(summary, "1.22", "tmpfs mounts");
  }

  const restartPolicy = enumValue(source.restartPolicy, "Restart policy", ["no", "always", "unless-stopped", "on-failure"], "no");
  const autoRemove = boolean(source.autoRemove, "Auto remove", false);
  if (autoRemove && restartPolicy !== "no") {
    throw new DockerCreateValidationError("Auto remove cannot be combined with a restart policy");
  }
  const privileged = boolean(source.privileged, "Privileged", false);
  if (privileged && source.privilegedAcknowledged !== true) {
    throw new DockerCreateValidationError("Privileged mode requires explicit acknowledgement");
  }

  const memoryLimitBytes = optionalInteger(source.memoryLimitBytes, "Memory limit", 4 * 1_024 ** 2, Number.MAX_SAFE_INTEGER);
  const memoryReservationBytes = optionalInteger(source.memoryReservationBytes, "Memory reservation", 4 * 1_024 ** 2, Number.MAX_SAFE_INTEGER);
  const memorySwapBytes = optionalInteger(source.memorySwapBytes, "Memory swap", -1, Number.MAX_SAFE_INTEGER);
  if (memoryLimitBytes && memoryReservationBytes && memoryReservationBytes > memoryLimitBytes) {
    throw new DockerCreateValidationError("Memory reservation cannot exceed the memory limit");
  }
  if (memoryLimitBytes && memorySwapBytes !== undefined && memorySwapBytes !== -1 && memorySwapBytes < memoryLimitBytes) {
    throw new DockerCreateValidationError("Memory swap must be -1 or at least the memory limit");
  }
  const cpuLimit = optionalNumber(source.cpuLimit, "CPU limit", 0.01, 1_024);
  const cpusetCpus = optionalString(source.cpusetCpus, "CPU set", 128);
  if (cpusetCpus && !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(cpusetCpus)) {
    throw new DockerCreateValidationError("CPU set must contain CPU numbers or ranges");
  }
  const hostname = optionalString(source.hostname, "Hostname", 253);
  if (hostname && !HOSTNAME_PATTERN.test(hostname)) {
    throw new DockerCreateValidationError("Hostname is invalid");
  }
  const workingDir = optionalString(source.workingDir, "Working directory", 4_096);
  if (workingDir) {
    absoluteContainerPath(workingDir, "Working directory");
  }
  const stopSignal = optionalString(source.stopSignal, "Stop signal", 32);
  if (stopSignal && !/^(?:SIG)?[A-Z0-9]+$/u.test(stopSignal)) {
    throw new DockerCreateValidationError("Stop signal is invalid");
  }
  const dns = ipArray(source.dns, "DNS servers");
  const dnsSearch = stringArray(source.dnsSearch, "DNS search domains").map((value) => {
    if (!HOSTNAME_PATTERN.test(value)) {
      throw new DockerCreateValidationError("DNS search domain is invalid");
    }
    return value;
  });
  const extraHosts = extraHostEntries(source.extraHosts);
  const user = optionalString(source.user, "User", 256);
  const stopTimeoutSeconds = optionalInteger(source.stopTimeoutSeconds, "Stop timeout", 0, 86_400);
  const cpuShares = optionalInteger(source.cpuShares, "CPU shares", 2, 262_144);
  const pidsLimit = optionalInteger(source.pidsLimit, "PID limit", -1, 1_000_000);
  const shmSizeBytes = optionalInteger(source.shmSizeBytes, "Shared memory size", 65_536, 2 ** 40);
  const restartMaxRetries = optionalInteger(source.restartMaxRetries, "Restart retries", 0, 1_000_000);
  const unavailable = getUnsupportedDockerResource({
    cpuLimit, cpuShares, cpusetCpus, memoryLimitBytes,
    memoryReservationBytes, memorySwapBytes, pidsLimit
  }, summary.engine.resourceCapabilities);
  if (unavailable) {
    throw new DockerCreateValidationError(`Host resource control is unsupported or unknown: ${unavailable[0]}`);
  }
  if (restartMaxRetries !== undefined && restartPolicy !== "on-failure") {
    throw new DockerCreateValidationError("Restart retries require the on-failure restart policy");
  }
  const tty = boolean(source.tty, "TTY", false);
  const openStdin = boolean(source.openStdin, "Open stdin", false);
  const init = boolean(source.init, "Init", false);
  const readonlyRootfs = boolean(source.readonlyRootfs, "Read-only root filesystem", false);
  const start = boolean(source.start, "Start after create", true);
  const pullPolicy = enumValue(source.pullPolicy, "Pull policy", ["missing", "always", "never"], "missing");
  if (init) {
    requireApiVersion(summary, "1.37", "Init process");
  }
  if (stopTimeoutSeconds !== undefined) {
    requireApiVersion(summary, "1.25", "Stop timeout");
  }
  if (pidsLimit !== undefined) {
    requireApiVersion(summary, "1.23", "PID limit");
  }

  const input: DockerContainerCreateInput = {
    name,
    image,
    ...(platform ? { platform } : {}),
    pullPolicy,
    start,
    ...(hostname ? { hostname } : {}),
    ...(user ? { user } : {}),
    ...(workingDir ? { workingDir } : {}),
    ...(entrypoint.length ? { entrypoint } : {}),
    ...(command.length ? { command } : {}),
    ...(Object.keys(environment).length ? { environment } : {}),
    ...(Object.keys(labels).length ? { labels } : {}),
    tty,
    openStdin,
    init,
    ...(stopSignal ? { stopSignal } : {}),
    ...(stopTimeoutSeconds !== undefined ? { stopTimeoutSeconds } : {}),
    ...(cpuLimit !== undefined ? { cpuLimit } : {}),
    ...(cpuShares !== undefined ? { cpuShares } : {}),
    ...(cpusetCpus ? { cpusetCpus } : {}),
    ...(memoryLimitBytes !== undefined ? { memoryLimitBytes } : {}),
    ...(memoryReservationBytes !== undefined ? { memoryReservationBytes } : {}),
    ...(memorySwapBytes !== undefined ? { memorySwapBytes } : {}),
    ...(pidsLimit !== undefined ? { pidsLimit } : {}),
    ...(shmSizeBytes !== undefined ? { shmSizeBytes } : {}),
    readonlyRootfs,
    privileged,
    privilegedAcknowledged: privileged,
    ...(mounts.input.length ? { mounts: mounts.input } : {}),
    network,
    ...(ports.length ? { ports } : {}),
    publishAllPorts,
    ...(dns.length ? { dns } : {}),
    ...(dnsSearch.length ? { dnsSearch } : {}),
    ...(extraHosts.input.length ? { extraHosts: extraHosts.input } : {}),
    restartPolicy,
    ...(restartMaxRetries !== undefined ? { restartMaxRetries } : {}),
    autoRemove
  };

  const engineInput: Extract<PreparedDockerCreate, { kind: "container" }>["engineInput"] = {
    name,
    image,
    ...(platform ? { platform } : {}),
    ...(input.hostname ? { hostname: input.hostname } : {}),
    ...(input.user ? { user: input.user } : {}),
    ...(input.workingDir ? { workingDir: input.workingDir } : {}),
    ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    labels,
    tty,
    openStdin,
    init,
    ...(input.stopSignal ? { stopSignal: input.stopSignal } : {}),
    ...(input.stopTimeoutSeconds !== undefined ? { stopTimeout: input.stopTimeoutSeconds } : {}),
    ...(input.cpuLimit !== undefined ? { nanoCpus: Math.round(input.cpuLimit * 1_000_000_000) } : {}),
    ...(input.cpuShares !== undefined ? { cpuShares: input.cpuShares } : {}),
    ...(input.cpusetCpus ? { cpusetCpus: input.cpusetCpus } : {}),
    ...(input.memoryLimitBytes !== undefined ? { memory: input.memoryLimitBytes } : {}),
    ...(input.memoryReservationBytes !== undefined ? { memoryReservation: input.memoryReservationBytes } : {}),
    ...(input.memorySwapBytes !== undefined ? { memorySwap: input.memorySwapBytes } : {}),
    ...(input.pidsLimit !== undefined ? { pidsLimit: input.pidsLimit } : {}),
    ...(input.shmSizeBytes !== undefined ? { shmSize: input.shmSizeBytes } : {}),
    readOnlyRootfs: readonlyRootfs,
    privileged,
    ...(mounts.engine.length ? { mounts: mounts.engine } : {}),
    networkMode: network.mode === "custom" ? (network.networkName as string) : network.mode,
    ...(network.mode === "custom" && network.networkName ? { networkName: network.networkName } : {}),
    ...(network.aliases?.length ? { networkAliases: network.aliases } : {}),
    ...(network.ipv4Address ? { ipv4Address: network.ipv4Address } : {}),
    ...(network.ipv6Address ? { ipv6Address: network.ipv6Address } : {}),
    ...(network.macAddress ? { macAddress: network.macAddress } : {}),
    ...(ports.length ? { ports: ports.map((port) => ({ ...port, protocol: port.protocol ?? "tcp" })) } : {}),
    publishAllPorts,
    ...(dns.length ? { dns } : {}),
    ...(dnsSearch.length ? { dnsSearch } : {}),
    ...(extraHosts.engine.length ? { extraHosts: extraHosts.engine } : {}),
    restartPolicy,
    ...(restartMaxRetries !== undefined ? { restartMaximumRetryCount: restartMaxRetries } : {}),
    autoRemove
  };

  return {
    kind: "container",
    input,
    engineInput,
    proposal: {
      action: "create",
      targetType: "container",
      containerName: name,
      risk: privileged ? "high" : "medium",
      summary: `Create Docker container ${name} from ${image}`
    },
    audit: {
      image,
      pullPolicy,
      start,
      privileged,
      environmentKeys: Object.keys(environment).sort(),
      labelKeys: Object.keys(labels).sort(),
      entrypointArguments: entrypoint.length,
      commandArguments: command.length,
      mountTypes: mounts.input.map((mount) => mount.type),
      portCount: ports.length,
      networkMode: network.mode
    }
  };
}

function prepareVolume(
  source: Record<string, unknown>,
  summary: DockerSummary
): Extract<PreparedDockerCreate, { kind: "volume" }> {
  allowed(source, VOLUME_KEYS);
  const name = resourceName(source.name, "Volume name");
  if (summary.volumes.some((volume) => volume.name === name)) {
    throw new DockerCreateValidationError("Docker volume already exists", 409);
  }
  const labels = stringMap(source.labels, "Labels", true);
  const input: DockerVolumeCreateInput = { name, ...(Object.keys(labels).length ? { labels } : {}) };
  return {
    kind: "volume",
    input,
    engineInput: { name, labels },
    proposal: {
      action: "create",
      targetType: "volume",
      volumeName: name,
      risk: "low",
      summary: `Create Docker volume ${name}`
    },
    audit: { driver: "local", labelKeys: Object.keys(labels).sort() }
  };
}

async function prepareNetwork(
  source: Record<string, unknown>,
  context: ApiRouteContext,
  summary: DockerSummary
): Promise<Extract<PreparedDockerCreate, { kind: "network" }>> {
  allowed(source, NETWORK_KEYS);
  const name = resourceName(source.name, "Network name");
  if (summary.networks.some((network) => network.name === name)) {
    throw new DockerCreateValidationError("Docker network already exists", 409);
  }
  const driver = enumValue(source.driver, "Network driver", ["bridge", "macvlan", "ipvlan"], "bridge");
  const labels = stringMap(source.labels, "Labels", true);
  const parent = optionalString(source.parent, "Parent interface", 64);
  let mode: DockerNetworkCreateInput extends infer _ ? string | undefined : never;
  if (driver === "bridge") {
    if (parent || source.mode !== undefined) {
      throw new DockerCreateValidationError("Bridge networks do not accept parent or driver mode");
    }
  } else {
    if (!parent) {
      throw new DockerCreateValidationError("Parent interface is required for macvlan and ipvlan networks");
    }
    const network = await collectSystemNetwork(context.system);
    const available = network.interfaces.some((item) => item.name === parent && item.kind !== "loopback");
    if (!available) {
      throw new DockerCreateValidationError("Parent interface is not available on this host");
    }
    mode = driver === "macvlan"
      ? enumValue(source.mode, "Macvlan mode", ["bridge", "private", "vepa", "passthru"], "bridge")
      : enumValue(source.mode, "Ipvlan mode", ["l2", "l3", "l3s"], "l2");
  }
  const enableIpv4 = boolean(source.enableIpv4, "Enable IPv4", true);
  const enableIpv6 = boolean(source.enableIpv6, "Enable IPv6", false);
  if (!enableIpv4) {
    requireApiVersion(summary, "1.48", "Disabling IPv4");
  }
  if (!enableIpv4 && !enableIpv6) {
    throw new DockerCreateValidationError("At least one network address family must be enabled");
  }
  const ipam = ipamConfigs(source.ipam, enableIpv4, enableIpv6);
  const internal = boolean(source.internal, "Internal network", false);
  const base = {
    name,
    internal,
    enableIpv4,
    enableIpv6,
    ...(ipam.length ? { ipam } : {}),
    ...(Object.keys(labels).length ? { labels } : {})
  };
  const input: DockerNetworkCreateInput = driver === "bridge"
    ? { ...base, driver }
    : driver === "macvlan"
      ? { ...base, driver, parent: parent as string, mode: mode as "bridge" | "private" | "vepa" | "passthru" }
      : { ...base, driver, parent: parent as string, mode: mode as "l2" | "l3" | "l3s" };
  const options = driver === "bridge"
    ? {}
    : {
        parent: parent as string,
        [driver === "macvlan" ? "macvlan_mode" : "ipvlan_mode"]: mode as string
      };
  return {
    kind: "network",
    input,
    engineInput: {
      name,
      driver,
      options,
      internal,
      enableIPv4: enableIpv4,
      enableIPv6: enableIpv6,
      ...(ipam.length
        ? {
            ipam: {
              driver: "default",
              configs: ipam.map((config) => ({
                ...(config.subnet ? { subnet: config.subnet } : {}),
                ...(config.ipRange ? { ipRange: config.ipRange } : {}),
                ...(config.gateway ? { gateway: config.gateway } : {}),
                ...(config.auxAddresses ? { auxiliaryAddresses: config.auxAddresses } : {})
              }))
            }
          }
        : {}),
      labels
    },
    proposal: {
      action: "create",
      targetType: "network",
      networkName: name,
      risk: driver === "bridge" ? "medium" : "high",
      summary: `Create Docker ${driver} network ${name}`
    },
    audit: {
      driver,
      internal,
      enableIpv4,
      enableIpv6,
      ipamEntries: ipam.length,
      auxAddressKeys: ipam.flatMap((config) => Object.keys(config.auxAddresses ?? {})).sort(),
      labelKeys: Object.keys(labels).sort()
    }
  };
}

async function containerMounts(value: unknown, context: ApiRouteContext, summary: DockerSummary) {
  const items = array(value, "Mounts");
  const targets = new Set<string>();
  const input: NonNullable<DockerContainerCreateInput["mounts"]> = [];
  const engine: NonNullable<EngineContainerInput["mounts"]> = [];
  for (const [index, raw] of items.entries()) {
    const mount = record(raw, `Mount ${index + 1}`);
    const type = enumValue(mount.type, `Mount ${index + 1} type`, ["bind", "volume", "tmpfs"]);
    const target = absoluteContainerPath(requiredString(mount.target, `Mount ${index + 1} target`, 4_096), "Mount target");
    if (targets.has(target)) {
      throw new DockerCreateValidationError("Container mount targets must be unique");
    }
    targets.add(target);
    const readOnly = boolean(mount.readOnly, "Mount read-only", type === "bind");
    if (type === "bind") {
      allowed(mount, ["type", "rootId", "sourcePath", "target", "readOnly"]);
      const rootId = requiredString(mount.rootId, "Bind root", 128);
      const sourcePath = requiredString(mount.sourcePath, "Bind source path", 4_096);
      const root = getNasRoot(context.db, rootId);
      if (!root) {
        throw new DockerCreateValidationError("Bind source NAS root is unavailable");
      }
      if (root.mountPolicy === "required" && getRootReadiness(context.db, root.id)?.status !== "ready") {
        throw new DockerCreateValidationError("Bind source NAS root is not ready");
      }
      const safe = await resolveSafeExistingPath(root.path, sourcePath);
      const info = await lstat(safe.realPath);
      if (!info.isFile() && !info.isDirectory()) {
        throw new DockerCreateValidationError("Bind source must be a regular file or directory");
      }
      const configuredSocket = await canonicalSocketPath(context.config.docker.socketPath);
      if (isDockerSocketPath(safe.realPath, configuredSocket)) {
        throw new DockerCreateValidationError("The Docker socket cannot be mounted into a container");
      }
      input.push({ type, rootId, sourcePath: safe.relativePath, target, readOnly });
      engine.push({ type, source: safe.realPath, target, readOnly });
      continue;
    }
    if (type === "volume") {
      allowed(mount, ["type", "source", "target", "readOnly", "noCopy"]);
      const source = resourceName(mount.source, "Volume mount source");
      if (!summary.volumes.some((volume) => volume.name === source)) {
        throw new DockerCreateValidationError(`Docker volume ${source} does not exist`);
      }
      const noCopy = boolean(mount.noCopy, "Volume no-copy", false);
      input.push({ type, source, target, readOnly, noCopy });
      engine.push({ type, source, target, readOnly, noCopy });
      continue;
    }
    allowed(mount, ["type", "target", "readOnly", "sizeBytes", "mode"]);
    const sizeBytes = optionalInteger(mount.sizeBytes, "Tmpfs size", 1_024, 2 ** 40);
    const mode = optionalInteger(mount.mode, "Tmpfs mode", 0, 0o7777);
    input.push({ type, target, readOnly, ...(sizeBytes !== undefined ? { sizeBytes } : {}), ...(mode !== undefined ? { mode } : {}) });
    engine.push({ type, target, readOnly, ...(sizeBytes !== undefined ? { sizeBytes } : {}), ...(mode !== undefined ? { mode } : {}) });
  }
  return { input, engine };
}

function isDockerSocketPath(sourcePath: string, configuredSocket: string): boolean {
  const normalized = path.posix.normalize(sourcePath);
  const sockets = ["/run/docker.sock", "/var/run/docker.sock", path.posix.normalize(configuredSocket)];
  return sockets.some((socket) => normalized === socket || socket.startsWith(`${normalized}/`));
}

async function canonicalSocketPath(socketPath: string): Promise<string> {
  try {
    return await realpath(socketPath);
  } catch {
    const parent = path.dirname(socketPath);
    const canonicalParent = await realpath(parent).catch(() => parent);
    return path.join(canonicalParent, path.basename(socketPath));
  }
}

function containerNetwork(value: unknown, summary: DockerSummary): NonNullable<DockerContainerCreateInput["network"]> {
  if (value === undefined) {
    return { mode: "bridge" };
  }
  const source = record(value, "Container network");
  allowed(source, ["mode", "networkName", "aliases", "ipv4Address", "ipv6Address", "macAddress"]);
  const mode = enumValue(source.mode, "Container network mode", ["bridge", "host", "none", "custom"], "bridge");
  const networkName = optionalString(source.networkName, "Network name", 128);
  if (mode === "custom") {
    if (!networkName || !summary.networks.some((network) => network.name === networkName)) {
      throw new DockerCreateValidationError("Selected Docker network does not exist");
    }
  } else if (networkName) {
    throw new DockerCreateValidationError("Network name is only valid for a custom network");
  }
  const aliases = stringArray(source.aliases, "Network aliases").map((alias) => {
    if (!HOSTNAME_PATTERN.test(alias)) {
      throw new DockerCreateValidationError("Network alias is invalid");
    }
    return alias;
  });
  const ipv4Address = optionalIp(source.ipv4Address, "Static IPv4 address", 4);
  const ipv6Address = optionalIp(source.ipv6Address, "Static IPv6 address", 6);
  const macAddress = optionalString(source.macAddress, "Endpoint MAC address", 17);
  if (macAddress && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(macAddress)) {
    throw new DockerCreateValidationError("Endpoint MAC address is invalid");
  }
  if (mode !== "custom" && (aliases.length || ipv4Address || ipv6Address || macAddress)) {
    throw new DockerCreateValidationError("Endpoint settings require a custom network");
  }
  return {
    mode,
    ...(networkName ? { networkName } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(ipv4Address ? { ipv4Address } : {}),
    ...(ipv6Address ? { ipv6Address } : {}),
    ...(macAddress ? { macAddress } : {})
  };
}

function portBindings(value: unknown): NonNullable<DockerContainerCreateInput["ports"]> {
  const items = array(value, "Ports");
  const seen = new Set<string>();
  return items.map((raw, index) => {
    const source = record(raw, `Port ${index + 1}`);
    allowed(source, ["containerPort", "protocol", "hostIp", "hostPort"]);
    const containerPort = integer(source.containerPort, "Container port", 1, 65_535);
    const protocol = enumValue(source.protocol, "Port protocol", ["tcp", "udp", "sctp"], "tcp");
    const hostIp = optionalIp(source.hostIp, "Host IP");
    const hostPort = optionalInteger(source.hostPort, "Host port", 1, 65_535);
    if (hostIp && hostPort === undefined) {
      throw new DockerCreateValidationError("Host IP requires a host port");
    }
    const key = `${containerPort}/${protocol}/${hostIp ?? ""}/${hostPort ?? ""}`;
    if (seen.has(key)) {
      throw new DockerCreateValidationError("Port bindings must be unique");
    }
    seen.add(key);
    return { containerPort, protocol, ...(hostIp ? { hostIp } : {}), ...(hostPort !== undefined ? { hostPort } : {}) };
  });
}

function extraHostEntries(value: unknown) {
  const items = array(value, "Extra hosts");
  const names = new Set<string>();
  const input: NonNullable<DockerContainerCreateInput["extraHosts"]> = [];
  const engine: string[] = [];
  for (const [index, raw] of items.entries()) {
    const source = record(raw, `Extra host ${index + 1}`);
    allowed(source, ["hostname", "address"]);
    const hostname = requiredString(source.hostname, "Extra host name", 253);
    if (!HOSTNAME_PATTERN.test(hostname) || names.has(hostname)) {
      throw new DockerCreateValidationError("Extra host names must be valid and unique");
    }
    const address = requiredString(source.address, "Extra host address", 64);
    if (address !== "host-gateway" && isIP(address) === 0) {
      throw new DockerCreateValidationError("Extra host address must be an IP address or host-gateway");
    }
    names.add(hostname);
    input.push({ hostname, address });
    engine.push(`${hostname}:${address}`);
  }
  return { input, engine };
}

function ipamConfigs(value: unknown, enableIpv4: boolean, enableIpv6: boolean): NonNullable<DockerNetworkCreateInput["ipam"]> {
  const items = array(value, "IPAM configurations");
  const subnets = new Set<string>();
  const parsedSubnets: Array<{ family: number; prefix: number; bytes: number[] }> = [];
  const parsedRanges: Array<{ family: number; prefix: number; bytes: number[] }> = [];
  return items.map((raw, index) => {
    const source = record(raw, `IPAM configuration ${index + 1}`);
    allowed(source, ["subnet", "ipRange", "gateway", "auxAddresses"]);
    const subnet = optionalString(source.subnet, "IPAM subnet", 128);
    const parsedSubnet = subnet ? parseCidr(subnet, "IPAM subnet") : null;
    if (subnet && subnets.has(subnet)) {
      throw new DockerCreateValidationError("IPAM subnets must be unique");
    }
    if (subnet) {
      subnets.add(subnet);
    }
    if (parsedSubnet && parsedSubnets.some((existing) => cidrOverlaps(existing, parsedSubnet))) {
      throw new DockerCreateValidationError("IPAM subnets must not overlap");
    }
    if (parsedSubnet) {
      parsedSubnets.push(parsedSubnet);
    }
    if (parsedSubnet?.family === 4 && !enableIpv4 || parsedSubnet?.family === 6 && !enableIpv6) {
      throw new DockerCreateValidationError("IPAM subnet uses a disabled address family");
    }
    const ipRange = optionalString(source.ipRange, "IPAM range", 128);
    const parsedRange = ipRange ? parseCidr(ipRange, "IPAM range") : null;
    if (parsedRange && (!parsedSubnet || parsedRange.family !== parsedSubnet.family || parsedRange.prefix < parsedSubnet.prefix || !cidrContains(parsedSubnet, parsedRange.bytes))) {
      throw new DockerCreateValidationError("IPAM range must stay inside its subnet");
    }
    if (parsedRange && parsedRanges.some((existing) => cidrOverlaps(existing, parsedRange))) {
      throw new DockerCreateValidationError("IPAM ranges must not overlap");
    }
    if (parsedRange) {
      parsedRanges.push(parsedRange);
    }
    const gateway = optionalIp(source.gateway, "IPAM gateway");
    if (gateway && (!parsedSubnet || isIP(gateway) !== parsedSubnet.family || !cidrContains(parsedSubnet, ipBytes(gateway)))) {
      throw new DockerCreateValidationError("IPAM gateway must stay inside its subnet");
    }
    const auxAddresses = stringMap(source.auxAddresses, "IPAM auxiliary addresses");
    for (const address of Object.values(auxAddresses)) {
      if (!parsedSubnet || isIP(address) !== parsedSubnet.family || !cidrContains(parsedSubnet, ipBytes(address))) {
        throw new DockerCreateValidationError("IPAM auxiliary addresses must stay inside their subnet");
      }
    }
    return {
      ...(subnet ? { subnet } : {}),
      ...(ipRange ? { ipRange } : {}),
      ...(gateway ? { gateway } : {}),
      ...(Object.keys(auxAddresses).length ? { auxAddresses } : {})
    };
  });
}

function parseCidr(value: string, field: string) {
  const [address, rawPrefix, ...rest] = value.split("/");
  const family = isIP(address ?? "");
  const prefix = Number(rawPrefix);
  const bits = family === 4 ? 32 : family === 6 ? 128 : 0;
  if (rest.length || !family || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new DockerCreateValidationError(`${field} must be a valid CIDR`);
  }
  return { family, prefix, bytes: ipBytes(address as string) };
}

function cidrContains(cidr: { prefix: number; bytes: number[] }, address: number[]) {
  if (cidr.bytes.length !== address.length) {
    return false;
  }
  const wholeBytes = Math.floor(cidr.prefix / 8);
  const remainingBits = cidr.prefix % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (cidr.bytes[index] !== address[index]) {
      return false;
    }
  }
  if (!remainingBits) {
    return true;
  }
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((cidr.bytes[wholeBytes] ?? 0) & mask) === ((address[wholeBytes] ?? 0) & mask);
}

function cidrOverlaps(left: { family: number; prefix: number; bytes: number[] }, right: { family: number; prefix: number; bytes: number[] }) {
  return left.family === right.family && (cidrContains(left, right.bytes) || cidrContains(right, left.bytes));
}

function ipBytes(value: string): number[] {
  if (isIP(value) === 4) {
    return value.split(".").map(Number);
  }
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) {
    return [];
  }
  const parseHalf = (half: string) => half ? half.split(":").flatMap((part) => {
    if (part.includes(".")) {
      const bytes = part.split(".").map(Number);
      return [((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0), ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)];
    }
    return [Number.parseInt(part, 16)];
  }) : [];
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  const groups = halves.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill(0), ...right] : left;
  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function requireApiVersion(summary: DockerSummary, minimum: string, feature: string) {
  const current = summary.engine.negotiatedApiVersion;
  if (!current || compareVersions(current, minimum) < 0) {
    throw new DockerCreateValidationError(`${feature} requires Docker API ${minimum} or newer`);
  }
}

function compareVersions(left: string, right: string) {
  const [leftMajor = 0, leftMinor = 0] = left.split(".").map(Number);
  const [rightMajor = 0, rightMinor = 0] = right.split(".").map(Number);
  return leftMajor === rightMajor ? leftMinor - rightMinor : leftMajor - rightMajor;
}

function imageReference(value: string) {
  if (!parseDockerImageReference(value)) {
    throw new DockerCreateValidationError("Docker image reference is invalid");
  }
  if (value.includes("@")) {
    return value;
  }
  const lastSlash = value.lastIndexOf("/");
  const lastColon = value.lastIndexOf(":");
  return lastColon > lastSlash ? value : `${value}:latest`;
}

function absoluteContainerPath(value: string, field: string) {
  if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.includes("\0")) {
    throw new DockerCreateValidationError(`${field} must be a normalized absolute container path`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new DockerCreateValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function allowed(source: Record<string, unknown>, keys: readonly string[]) {
  const accepted = new Set(keys);
  const unknown = Object.keys(source).find((key) => !accepted.has(key));
  if (unknown) {
    throw new DockerCreateValidationError(`Unsupported Docker create field: ${unknown}`);
  }
}

function array(value: unknown, field: string): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new DockerCreateValidationError(`${field} must be an array with at most ${MAX_ITEMS} entries`);
  }
  return value;
}

function requiredString(value: unknown, field: string, maximum = MAX_STRING) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new DockerCreateValidationError(`${field} is required and must be at most ${maximum} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, maximum = MAX_STRING): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return requiredString(value, field, maximum);
}

function resourceName(value: unknown, field: string) {
  const name = requiredString(value, field, 128);
  if (!NAME_PATTERN.test(name)) {
    throw new DockerCreateValidationError(`${field} is invalid`);
  }
  return name;
}

function boolean(value: unknown, field: string, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new DockerCreateValidationError(`${field} must be a boolean`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DockerCreateValidationError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function optionalInteger(value: unknown, field: string, minimum: number, maximum: number) {
  return value === undefined ? undefined : integer(value, field, minimum, maximum);
}

function optionalNumber(value: unknown, field: string, minimum: number, maximum: number) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new DockerCreateValidationError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function enumValue<const T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
  fallback?: T
): T {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new DockerCreateValidationError(`${field} is invalid`);
  }
  return value as T;
}

function stringArray(value: unknown, field: string) {
  const values = array(value, field).map((item) => requiredString(item, field));
  if (new Set(values).size !== values.length) {
    throw new DockerCreateValidationError(`${field} entries must be unique`);
  }
  return values;
}

function ipArray(value: unknown, field: string) {
  return stringArray(value, field).map((item) => {
    if (!isIP(item)) {
      throw new DockerCreateValidationError(`${field} must contain valid IP addresses`);
    }
    return item;
  });
}

function optionalIp(value: unknown, field: string, family?: 4 | 6) {
  const result = optionalString(value, field, 64);
  if (result && (!isIP(result) || family && isIP(result) !== family)) {
    throw new DockerCreateValidationError(`${field} must be a valid${family ? ` IPv${family}` : " IP"} address`);
  }
  return result;
}

function stringMap(value: unknown, field: string, labels = false): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const source = record(value, field);
  if (Object.keys(source).length > MAX_ITEMS) {
    throw new DockerCreateValidationError(`${field} may contain at most ${MAX_ITEMS} entries`);
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!key || key.length > 128 || key.includes("\0") || labels && !LABEL_KEY_PATTERN.test(key)) {
      throw new DockerCreateValidationError(`${field} contains an invalid key`);
    }
    if (labels && key.toLowerCase().startsWith("io.zos.")) {
      throw new DockerCreateValidationError("Labels in the io.zos.* namespace are reserved");
    }
    if (typeof raw !== "string" || raw.length > MAX_STRING || raw.includes("\0")) {
      throw new DockerCreateValidationError(`${field} values must be strings of at most ${MAX_STRING} characters`);
    }
    result[key] = raw;
  }
  return result;
}
