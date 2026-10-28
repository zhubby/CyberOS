import type { DockerCreateInput, DockerHostAccessGrant } from "@cyberos/shared";

export type DockerCreateKind = "container" | "volume" | "network";

export type DockerCreateForm = {
  kind: DockerCreateKind;
  name: string;
  image: string;
  platform: string;
  pullPolicy: "missing" | "always" | "never";
  start: boolean;
  hostname: string;
  user: string;
  workingDir: string;
  entrypoint: string;
  command: string;
  environment: Array<{ key: string; value: string }>;
  labels: Array<{ key: string; value: string }>;
  tty: boolean;
  openStdin: boolean;
  init: boolean;
  stopSignal: string;
  stopTimeoutSeconds: string;
  cpuLimit: string;
  cpuShares: string;
  cpusetCpus: string;
  memoryLimitBytes: string;
  memoryReservationBytes: string;
  memorySwapBytes: string;
  pidsLimit: string;
  shmSizeBytes: string;
  readonlyRootfs: boolean;
  privileged: boolean;
  privilegedAcknowledged: boolean;
  hostAccess: DockerHostAccessGrant[];
  mounts: Array<{ type: "volume" | "bind" | "tmpfs"; source: string; rootId: string; target: string; readOnly: boolean; noCopy: boolean; sizeBytes: string; mode: string }>;
  networkMode: "bridge" | "host" | "none" | "custom";
  networkName: string;
  networkAliases: string;
  ipv4Address: string;
  ipv6Address: string;
  macAddress: string;
  ports: Array<{ containerPort: string; protocol: "tcp" | "udp" | "sctp"; hostIp: string; hostPort: string }>;
  publishAllPorts: boolean;
  dns: string;
  dnsSearch: string;
  extraHosts: Array<{ hostname: string; address: string }>;
  restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
  restartMaxRetries: string;
  autoRemove: boolean;
  driver: "bridge" | "macvlan" | "ipvlan";
  parent: string;
  driverMode: string;
  internal: boolean;
  enableIpv4: boolean;
  enableIpv6: boolean;
  ipam: Array<{ subnet: string; ipRange: string; gateway: string; auxAddresses: string }>;
};

export function initialDockerCreateForm(kind: DockerCreateKind = "container"): DockerCreateForm {
  return {
    kind, name: "", image: "", platform: "", pullPolicy: "missing", start: true, hostname: "", user: "", workingDir: "",
    entrypoint: "", command: "", environment: [], labels: [], tty: false, openStdin: false, init: false, stopSignal: "",
    stopTimeoutSeconds: "10", cpuLimit: "", cpuShares: "", cpusetCpus: "", memoryLimitBytes: "", memoryReservationBytes: "",
    memorySwapBytes: "", pidsLimit: "", shmSizeBytes: "", readonlyRootfs: false, privileged: false, privilegedAcknowledged: false, hostAccess: [],
    mounts: [], networkMode: "bridge", networkName: "", networkAliases: "", ipv4Address: "", ipv6Address: "", macAddress: "",
    ports: [], publishAllPorts: false, dns: "", dnsSearch: "", extraHosts: [], restartPolicy: "no", restartMaxRetries: "",
    autoRemove: false, driver: "bridge", parent: "", driverMode: "bridge", internal: false, enableIpv4: true, enableIpv6: false,
    ipam: []
  };
}

export function validateDockerCreateStep(step: number, form: DockerCreateForm): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(form.name.trim())) return "A valid resource name is required";
  if (form.kind === "volume") {
    return step >= 1 && hasDuplicateKeys(form.labels) ? "Volume labels must be unique" : null;
  }
  if (form.kind === "network") {
    if (step >= 1 && form.driver !== "bridge" && !form.parent.trim()) return "A parent interface is required";
    if (step >= 2 && !form.enableIpv4 && !form.enableIpv6) return "Enable IPv4 or IPv6";
    if (step >= 1 && hasDuplicateKeys(form.labels)) return "Network labels must be unique";
    if (form.ipam.some((entry) => !entry.subnet.trim() && (entry.ipRange.trim() || entry.gateway.trim() || entry.auxAddresses.trim()))) return "Each IPAM range, gateway, or auxiliary address requires a subnet";
    return null;
  }
  if (step >= 1 && !form.image.trim()) return "An image is required";
  if (step >= 2 && hasDuplicateKeys(form.environment)) return "Environment variable names must be unique";
  if (step >= 2 && form.environment.some((entry) => entry.key.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.key.trim()))) return "Environment variable names are invalid";
  if (step >= 2 && hasDuplicateKeys(form.labels)) return "Container labels must be unique";
  if (step >= 2) {
    try {
      parseDockerArguments(form.entrypoint);
      parseDockerArguments(form.command);
    } catch (error) {
      return error instanceof Error ? error.message : "Entrypoint and command syntax is invalid";
    }
  }
  if (step >= 2 && !validInteger(form.stopTimeoutSeconds, 0, 86_400)) return "Stop timeout must be an integer from 0 to 86400";
  if (step >= 3 && !validNumber(form.cpuLimit, 0.01, 1_024)) return "CPU limit must be between 0.01 and 1024";
  if (step >= 3 && !validInteger(form.cpuShares, 2, 262_144)) return "CPU shares must be an integer from 2 to 262144";
  if (step >= 3 && !validInteger(form.memoryLimitBytes, 4 * 1_024 ** 2)) return "Memory limit must be at least 4194304 bytes";
  if (step >= 3 && !validInteger(form.memoryReservationBytes, 4 * 1_024 ** 2)) return "Memory reservation must be at least 4194304 bytes";
  if (step >= 3 && form.memoryLimitBytes && form.memoryReservationBytes && Number(form.memoryReservationBytes) > Number(form.memoryLimitBytes)) return "Memory reservation cannot exceed the memory limit";
  if (step >= 3 && !validInteger(form.memorySwapBytes, -1)) return "Memory swap must be -1 or a positive integer";
  if (step >= 3 && form.memoryLimitBytes && form.memorySwapBytes && Number(form.memorySwapBytes) !== -1 && Number(form.memorySwapBytes) < Number(form.memoryLimitBytes)) return "Memory swap must be -1 or at least the memory limit";
  if (step >= 3 && !validInteger(form.pidsLimit, -1, 1_000_000)) return "PID limit must be an integer from -1 to 1000000";
  if (step >= 3 && !validInteger(form.shmSizeBytes, 65_536)) return "Shared memory must be at least 65536 bytes";
  if (step >= 3 && form.restartPolicy === "on-failure" && !validInteger(form.restartMaxRetries, 0, 1_000_000)) return "Restart retries must be an integer from 0 to 1000000";
  if (step >= 3 && form.autoRemove && form.restartPolicy !== "no") return "Auto-remove requires restart policy no";
  if (step >= 4 && form.mounts.some((mount) => !mount.target.startsWith("/") || mount.target.includes("/../") || mount.target.endsWith("/.."))) return "Mount targets must be normalized absolute paths";
  if (step >= 4 && new Set(form.mounts.map((mount) => mount.target.trim())).size !== form.mounts.length) return "Mount targets must be unique";
  if (step >= 4 && form.mounts.some((mount) => mount.type !== "tmpfs" && !mount.source.trim())) return "Volume and bind mounts require a source";
  if (step >= 4 && form.mounts.some((mount) => mount.type === "bind" && !mount.rootId)) return "Bind mounts require a NAS root";
  if (step >= 4 && form.mounts.some((mount) => mount.type === "tmpfs" && (!validInteger(mount.sizeBytes, 1_024) || mount.mode.trim() && !/^[0-7]{1,4}$/u.test(mount.mode.trim())))) return "tmpfs size or mode is invalid";
  if (step >= 5 && form.networkMode === "custom" && !form.networkName.trim()) return "Select a Docker network";
  if (step >= 5 && (form.networkMode === "host" || form.networkMode === "none") && (form.ports.length || form.publishAllPorts)) return "This network mode cannot publish ports";
  if (step >= 5 && form.ports.some((port) => !port.containerPort.trim() || !validInteger(port.containerPort, 1, 65_535) || !validInteger(port.hostPort, 1, 65_535))) return "Container and host ports must be integers from 1 to 65535";
  if (step >= 5 && form.ports.some((port) => port.hostIp.trim() && !port.hostPort.trim())) return "Host IP requires a host port";
  if (step >= 5 && form.extraHosts.some((entry) => !entry.hostname.trim() || !entry.address.trim())) return "Extra hosts require both a hostname and address";
  if (step >= 6 && form.privileged && !form.privilegedAcknowledged) return "Acknowledge privileged mode to continue";
  if (step >= 6 && form.hostAccess.length && (form.privileged || form.networkMode === "host")) return "Host Access conflicts with privileged or host network mode";
  return null;
}

export function dockerCreateInput(form: DockerCreateForm): DockerCreateInput {
  const map = (rows: Array<{ key: string; value: string }>) => Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));
  const numberOrUndefined = (value: string) => value.trim() ? Number(value) : undefined;
  if (form.kind === "volume") return { targetType: "volume", name: form.name.trim(), ...(form.labels.length ? { labels: map(form.labels) } : {}) };
  if (form.kind === "network") {
    const ipam = form.ipam.filter((entry) => [entry.subnet, entry.ipRange, entry.gateway, entry.auxAddresses].some((value) => value.trim())).map((entry) => ({
      ...(entry.subnet ? { subnet: entry.subnet.trim() } : {}), ...(entry.ipRange ? { ipRange: entry.ipRange.trim() } : {}),
      ...(entry.gateway ? { gateway: entry.gateway.trim() } : {}),
      ...(entry.auxAddresses ? { auxAddresses: map(entry.auxAddresses.split(",").map((value) => { const [key, address] = value.split("="); return { key: key ?? "", value: address?.trim() ?? "" }; })) } : {})
    }));
    const labels = map(form.labels);
    const base = { targetType: "network" as const, name: form.name.trim(), driver: form.driver, internal: form.internal, enableIpv4: form.enableIpv4, enableIpv6: form.enableIpv6, ...(ipam.length ? { ipam } : {}), ...(Object.keys(labels).length ? { labels } : {}) };
    return (form.driver === "bridge" ? base : { ...base, parent: form.parent.trim(), mode: form.driverMode as "bridge" | "private" | "vepa" | "passthru" | "l2" | "l3" | "l3s" }) as DockerCreateInput;
  }
  const environment = map(form.environment); const labels = map(form.labels);
  const customNetwork = form.networkMode === "custom";
  const mounts = form.mounts.filter((mount) => mount.target.trim()).map((mount) => mount.type === "bind"
    ? { type: "bind" as const, rootId: mount.rootId, sourcePath: mount.source, target: mount.target.trim(), readOnly: mount.readOnly }
    : mount.type === "volume" ? { type: "volume" as const, source: mount.source, target: mount.target.trim(), readOnly: mount.readOnly, noCopy: mount.noCopy }
      : { type: "tmpfs" as const, target: mount.target.trim(), readOnly: mount.readOnly, ...(numberOrUndefined(mount.sizeBytes) !== undefined ? { sizeBytes: numberOrUndefined(mount.sizeBytes) } : {}), ...(parseTmpfsMode(mount.mode) !== undefined ? { mode: parseTmpfsMode(mount.mode) } : {}) });
  return {
    targetType: "container", name: form.name.trim(), image: form.image.trim(), pullPolicy: form.pullPolicy, start: form.start,
    ...(form.platform.trim() ? { platform: form.platform.trim() } : {}), ...(form.hostname.trim() ? { hostname: form.hostname.trim() } : {}),
    ...(form.user.trim() ? { user: form.user.trim() } : {}), ...(form.workingDir.trim() ? { workingDir: form.workingDir.trim() } : {}),
    ...(form.entrypoint.trim() ? { entrypoint: parseDockerArguments(form.entrypoint) } : {}), ...(form.command.trim() ? { command: parseDockerArguments(form.command) } : {}),
    ...(Object.keys(environment).length ? { environment } : {}), ...(Object.keys(labels).length ? { labels } : {}), tty: form.tty, openStdin: form.openStdin, init: form.init,
    ...(form.stopSignal.trim() ? { stopSignal: form.stopSignal.trim() } : {}), ...(numberOrUndefined(form.stopTimeoutSeconds) !== undefined ? { stopTimeoutSeconds: numberOrUndefined(form.stopTimeoutSeconds) } : {}),
    ...(numberOrUndefined(form.cpuLimit) !== undefined ? { cpuLimit: numberOrUndefined(form.cpuLimit) } : {}), ...(numberOrUndefined(form.cpuShares) !== undefined ? { cpuShares: numberOrUndefined(form.cpuShares) } : {}),
    ...(form.cpusetCpus.trim() ? { cpusetCpus: form.cpusetCpus.trim() } : {}), ...(numberOrUndefined(form.memoryLimitBytes) !== undefined ? { memoryLimitBytes: numberOrUndefined(form.memoryLimitBytes) } : {}),
    ...(numberOrUndefined(form.memoryReservationBytes) !== undefined ? { memoryReservationBytes: numberOrUndefined(form.memoryReservationBytes) } : {}), ...(numberOrUndefined(form.memorySwapBytes) !== undefined ? { memorySwapBytes: numberOrUndefined(form.memorySwapBytes) } : {}),
    ...(numberOrUndefined(form.pidsLimit) !== undefined ? { pidsLimit: numberOrUndefined(form.pidsLimit) } : {}), ...(numberOrUndefined(form.shmSizeBytes) !== undefined ? { shmSizeBytes: numberOrUndefined(form.shmSizeBytes) } : {}),
    readonlyRootfs: form.readonlyRootfs, privileged: form.privileged, privilegedAcknowledged: form.privilegedAcknowledged, ...(mounts.length ? { mounts } : {}),
    ...(form.hostAccess.length ? { hostAccess: form.hostAccess } : {}),
    network: { mode: form.networkMode, ...(customNetwork ? { networkName: form.networkName.trim(), ...(form.networkAliases.trim() ? { aliases: form.networkAliases.split(",").map((value) => value.trim()).filter(Boolean) } : {}), ...(form.ipv4Address.trim() ? { ipv4Address: form.ipv4Address.trim() } : {}), ...(form.ipv6Address.trim() ? { ipv6Address: form.ipv6Address.trim() } : {}), ...(form.macAddress.trim() ? { macAddress: form.macAddress.trim() } : {}) } : {}) },
    ...(form.ports.length ? { ports: form.ports.filter((port) => port.containerPort.trim()).map((port) => ({ containerPort: Number(port.containerPort), protocol: port.protocol, ...(port.hostIp.trim() ? { hostIp: port.hostIp.trim() } : {}), ...(port.hostPort.trim() ? { hostPort: Number(port.hostPort) } : {}) })) } : {}),
    publishAllPorts: form.publishAllPorts, ...(form.dns.trim() ? { dns: form.dns.split(",").map((value) => value.trim()).filter(Boolean) } : {}), ...(form.dnsSearch.trim() ? { dnsSearch: form.dnsSearch.split(",").map((value) => value.trim()).filter(Boolean) } : {}),
    ...(form.extraHosts.length ? { extraHosts: form.extraHosts.filter((entry) => entry.hostname.trim()).map((entry) => ({ hostname: entry.hostname.trim(), address: entry.address.trim() })) } : {}), restartPolicy: form.restartPolicy,
    ...(form.restartPolicy === "on-failure" && numberOrUndefined(form.restartMaxRetries) !== undefined ? { restartMaxRetries: numberOrUndefined(form.restartMaxRetries) } : {}), autoRemove: form.autoRemove
  } as DockerCreateInput;
}

export function parseDockerArguments(value: string): string[] {
  const result: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of value.trim()) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "\\") escaped = true;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) {
        result.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (escaped) token += "\\";
  if (quote) throw new Error("Entrypoint and command quotes must be closed");
  if (tokenStarted) result.push(token);
  return result;
}

function hasDuplicateKeys(rows: Array<{ key: string; value: string }>): boolean {
  const keys = rows.map((row) => row.key.trim()).filter(Boolean);
  return new Set(keys).size !== keys.length;
}

function parseTmpfsMode(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^[0-7]{1,4}$/u.test(trimmed) ? Number.parseInt(trimmed, 8) : Number.NaN;
}

function validInteger(value: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  if (!value.trim()) return true;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

function validNumber(value: string, minimum: number, maximum: number): boolean {
  if (!value.trim()) return true;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum;
}
