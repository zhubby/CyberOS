import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  getRootReadiness,
  listNasRoots,
  type CyberOsDatabase
} from "@cyberos/db";
import type {
  DockerComposeServiceHostAccess,
  DockerHostAccessAvailability,
  DockerHostAccessCapability,
  DockerHostAccessCapabilityId,
  DockerHostAccessCatalog,
  DockerHostAccessCoverageId,
  DockerHostAccessCoverageReport,
  DockerHostAccessGrant,
  DockerHostAccessRisk,
  DockerHostAccessValidationIssue
} from "@cyberos/shared";
import type { DockerEngineRuntime } from "./docker-client.js";

export const DOCKER_HOST_ACCESS_POLICY_VERSION = "2026-10-19.1";
export const DOCKER_HOST_ACCESS_OVERRIDE_FILE = "cyberos-host-access.override.yaml";
export const DOCKER_HOST_ACCESS_LABEL_PREFIX = "io.cyberos.host-access.";
export const DOCKER_HOST_ACCESS_NAS_ANCHOR = ".cyberos-host-access-capacity";

const DEFAULT_RUNTIME_ROOT = "/run/cyberos/host-access";
const UNSUPPORTED_COVERAGE: DockerHostAccessCoverageId[] = [
  "journald",
  "smart_nvme",
  "rootfs_capacity",
  "low_level_kernel"
];
const CAPABILITY_IDS = new Set<DockerHostAccessCapabilityId>([
  "host_os_identity",
  "host_processes",
  "host_sys",
  "nas_capacity",
  "account_map",
  "docker_metadata",
  "systemd_status"
]);

type CapabilityDefinition = Omit<DockerHostAccessCapability, "availability">;

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  {
    id: "host_os_identity",
    risk: "low",
    transport: "bind",
    defaultTarget: "/host/etc",
    provides: ["host.os.identity", "host.timezone", "host.machine.identity"],
    requires: [],
    recommends: ["host_processes", "host_sys"],
    coverage: ["host_identity", "host_time"]
  },
  {
    id: "host_processes",
    risk: "high",
    transport: "bind",
    defaultTarget: "/host/proc",
    provides: ["host.processes", "host.cpu", "host.memory", "host.network.physical"],
    requires: [],
    recommends: ["host_sys"],
    coverage: ["host_processes", "host_cpu", "host_memory", "physical_network"]
  },
  {
    id: "host_sys",
    risk: "medium",
    transport: "bind",
    defaultTarget: "/host/sys",
    provides: ["host.sysfs", "host.cgroup"],
    requires: [],
    recommends: ["host_processes"],
    coverage: ["cgroup", "physical_network"]
  },
  {
    id: "nas_capacity",
    risk: "medium",
    transport: "bind",
    defaultTarget: "/host/nas",
    provides: ["storage.nas.capacity"],
    requires: [],
    recommends: [],
    coverage: ["nas_capacity"]
  },
  {
    id: "account_map",
    risk: "medium",
    transport: "bind",
    defaultTarget: "/host/etc",
    provides: ["host.accounts.map"],
    requires: [],
    recommends: ["host_os_identity"],
    coverage: ["account_map"]
  },
  {
    id: "docker_metadata",
    risk: "high",
    transport: "docker_proxy",
    defaultTarget: null,
    provides: ["containers.inventory", "containers.networks"],
    requires: [],
    recommends: ["host_processes", "host_sys"],
    coverage: ["docker_containers", "docker_networks"]
  },
  {
    id: "systemd_status",
    risk: "high",
    transport: "systemd_proxy",
    defaultTarget: null,
    provides: ["services.systemd.units"],
    requires: [],
    recommends: ["host_os_identity"],
    coverage: ["systemd_units"]
  }
];

export interface DockerHostAccessPolicyOptions {
  platform?: NodeJS.Platform;
  runtimeRoot?: string;
  daemonAvailable?: boolean;
  dockerProxyCompatible?: boolean;
  systemdProxyCompatible?: boolean;
  rootless?: boolean;
  userNamespace?: boolean;
}

export interface DockerHostAccessControlRuntime {
  reconcile(input: {
    scopeId: string;
    service?: string;
    capabilities: DockerHostAccessCapabilityId[];
  }): Promise<void>;
}

export interface DockerHostAccessRuntime {
  policy: DockerHostAccessPolicy;
  control?: DockerHostAccessControlRuntime;
}

export interface DockerHostAccessReconciliationResult {
  reconciled: number;
  failures: Array<{ containerId: string; error: string }>;
}

export interface DockerHostAccessMount {
  source: string;
  target: string;
  readOnly: true;
}

export interface DockerHostAccessManifest {
  service?: string;
  grants: DockerHostAccessGrant[];
  mounts: DockerHostAccessMount[];
  environment: Record<string, string>;
  capDrop: ["ALL"];
  securityOpt: ["no-new-privileges:true"];
  labels: Record<string, string>;
  fingerprint: string;
  coverage: DockerHostAccessCoverageReport;
}

export interface ResolveDockerHostAccessInput {
  grants: unknown;
  scopeId: string;
  revision: string;
  imageDigest: string;
  service?: string;
  serviceDefinition?: Record<string, unknown>;
  existingMountTargets?: string[];
}

export interface ResolveDockerComposeHostAccessInput {
  hostAccess: unknown;
  services: string[];
  projectKey: string;
  revision: string;
  imageDigests?: Record<string, string>;
  serviceDefinitions?: Record<string, Record<string, unknown>>;
  existingMountTargets?: Record<string, string[]>;
}

export interface ResolvedDockerComposeHostAccess {
  hostAccess: DockerComposeServiceHostAccess[];
  manifests: DockerHostAccessManifest[];
  coverage: DockerHostAccessCoverageReport;
  issues: DockerHostAccessValidationIssue[];
}

export class DockerHostAccessValidationError extends Error {
  constructor(readonly issues: DockerHostAccessValidationIssue[]) {
    super("Docker Host Access configuration is invalid");
    this.name = "DockerHostAccessValidationError";
  }
}

export class DockerHostAccessPolicy {
  private readonly platform: NodeJS.Platform;
  private readonly runtimeRoot: string;
  private detectedRootless = false;
  private detectedUserNamespace = false;

  constructor(private readonly db: CyberOsDatabase, private readonly options: DockerHostAccessPolicyOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runtimeRoot = options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT;
  }

  setRuntimeCompatibility(input: { rootless?: boolean; userNamespace?: boolean }): void {
    this.detectedRootless = input.rootless === true;
    this.detectedUserNamespace = input.userNamespace === true;
  }

  catalog(): DockerHostAccessCatalog {
    const roots = listNasRoots(this.db).map((root) => {
      const readiness = getRootReadiness(this.db, root.id);
      const ready = readiness?.status === "ready";
      return {
        rootId: root.id,
        name: root.name,
        availability: !ready
          ? unavailable("nas_root_not_ready")
          : capacityAnchorAvailable(path.join(root.path, DOCKER_HOST_ACCESS_NAS_ANCHOR))
            ? available()
            : unavailable("runtime_dependency_unavailable")
      };
    });
    return {
      policyVersion: DOCKER_HOST_ACCESS_POLICY_VERSION,
      capabilities: CAPABILITY_DEFINITIONS.map((definition) => ({
        ...definition,
        availability: this.capabilityAvailability(definition.id, roots.some((root) => root.availability.status !== "unavailable"))
      })),
      nasRoots: roots
    };
  }

  resolve(input: ResolveDockerHostAccessInput): DockerHostAccessManifest {
    const catalog = this.catalog();
    const { grants, issues } = this.normalizeGrants(input.grants, catalog, input.service);
    issues.push(...conflictingServiceIssues(input.serviceDefinition, input.service));
    const mounts = this.mountsForGrants(grants, input.scopeId, input.service);
    const targets = [...(input.existingMountTargets ?? [])];
    for (const mount of mounts) {
      const conflict = targets.find((target) => pathsOverlap(target, mount.target));
      if (conflict) {
        issues.push({
          code: "managed_mount_conflict",
          severity: "error",
          ...(input.service ? { service: input.service } : {}),
          field: conflict
        });
      }
      targets.push(mount.target);
    }
    if (issues.some((issue) => issue.severity === "error")) throw new DockerHostAccessValidationError(issues);

    const environment: Record<string, string> = {};
    if (grants.some((grant) => grant.capability === "docker_metadata")) {
      environment.DOCKER_HOST = "unix:///run/cyberos-host-access/docker.sock";
    }
    if (grants.some((grant) => grant.capability === "systemd_status")) {
      environment.DBUS_SYSTEM_BUS_ADDRESS = "unix:path=/run/cyberos-host-access/systemd.sock";
    }
    const fingerprinted = {
      policyVersion: DOCKER_HOST_ACCESS_POLICY_VERSION,
      scopeId: input.scopeId,
      revision: input.revision,
      imageDigest: input.imageDigest,
      service: input.service ?? null,
      grants,
      mounts,
      environment,
      security: { capDrop: ["ALL"], securityOpt: ["no-new-privileges:true"] },
      resources: this.resourceIdentities(grants)
    };
    const fingerprint = createHash("sha256").update(stableStringify(fingerprinted)).digest("base64url");
    const summary = grants.map((grant) => grant.capability === "nas_capacity"
      ? `${grant.capability}:${grant.rootId}`
      : grant.capability).join(",");
    return {
      ...(input.service ? { service: input.service } : {}),
      grants,
      mounts,
      environment,
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges:true"],
      labels: {
        [`${DOCKER_HOST_ACCESS_LABEL_PREFIX}policy`]: DOCKER_HOST_ACCESS_POLICY_VERSION,
        [`${DOCKER_HOST_ACCESS_LABEL_PREFIX}grants`]: summary,
        [`${DOCKER_HOST_ACCESS_LABEL_PREFIX}fingerprint`]: fingerprint
      },
      fingerprint,
      coverage: coverageReport(grants, catalog)
    };
  }

  resolveCompose(input: ResolveDockerComposeHostAccessInput): ResolvedDockerComposeHostAccess {
    const issues: DockerHostAccessValidationIssue[] = [];
    const raw = Array.isArray(input.hostAccess) ? input.hostAccess : [];
    if (input.hostAccess !== undefined && !Array.isArray(input.hostAccess)) {
      throw new DockerHostAccessValidationError([{ code: "unknown_service", severity: "error" }]);
    }
    const duplicateServices = duplicates(raw.map((entry) => isRecord(entry) && typeof entry.service === "string" ? entry.service : ""));
    const manifests: DockerHostAccessManifest[] = [];
    const normalized: DockerComposeServiceHostAccess[] = [];
    for (const entry of raw) {
      if (!isRecord(entry) || typeof entry.service !== "string" || !input.services.includes(entry.service)) {
        issues.push({ code: "unknown_service", severity: "error", ...(isRecord(entry) && typeof entry.service === "string" ? { service: entry.service } : {}) });
        continue;
      }
      if (duplicateServices.has(entry.service)) {
        issues.push({ code: "duplicate_capability", severity: "error", service: entry.service });
        continue;
      }
      try {
        const manifest = this.resolve({
          grants: entry.grants,
          scopeId: input.projectKey,
          revision: input.revision,
          imageDigest: input.imageDigests?.[entry.service] ?? "unresolved",
          service: entry.service,
          ...(input.serviceDefinitions?.[entry.service]
            ? { serviceDefinition: input.serviceDefinitions[entry.service] }
            : {}),
          ...(input.existingMountTargets?.[entry.service]
            ? { existingMountTargets: input.existingMountTargets[entry.service] }
            : {})
        });
        if (manifest.grants.length) {
          manifests.push(manifest);
          normalized.push({ service: entry.service, grants: manifest.grants });
        }
      } catch (error) {
        if (error instanceof DockerHostAccessValidationError) issues.push(...error.issues);
        else throw error;
      }
    }
    if (issues.some((issue) => issue.severity === "error")) throw new DockerHostAccessValidationError(issues);
    normalized.sort((left, right) => left.service.localeCompare(right.service));
    return {
      hostAccess: normalized,
      manifests,
      coverage: mergeCoverage(manifests.map((manifest) => manifest.coverage), this.catalog()),
      issues
    };
  }

  runtimeDependenciesAvailable(manifest: DockerHostAccessManifest, scopeId: string): boolean {
    const directory = path.join(
      this.runtimeRoot,
      "grants",
      safeSegment(scopeId),
      safeSegment(manifest.service ?? "container")
    );
    return manifest.grants.every((grant) => {
      const socket = grant.capability === "docker_metadata"
        ? "docker.sock"
        : grant.capability === "systemd_status"
          ? "systemd.sock"
          : null;
      if (!socket) return true;
      try {
        const metadata = lstatSync(path.join(directory, socket));
        return metadata.isSocket() && !metadata.isSymbolicLink();
      } catch {
        return false;
      }
    });
  }

  private normalizeGrants(
    value: unknown,
    catalog: DockerHostAccessCatalog,
    service?: string
  ): { grants: DockerHostAccessGrant[]; issues: DockerHostAccessValidationIssue[] } {
    if (!Array.isArray(value)) {
      throw new DockerHostAccessValidationError([{ code: "duplicate_capability", severity: "error", ...(service ? { service } : {}) }]);
    }
    const issues: DockerHostAccessValidationIssue[] = [];
    const grants: DockerHostAccessGrant[] = [];
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const candidate of value) {
      if (!isRecord(candidate) || typeof candidate.capability !== "string" || !CAPABILITY_IDS.has(candidate.capability as DockerHostAccessCapabilityId)) {
        issues.push({ code: "capability_unavailable", severity: "error", ...(service ? { service } : {}) });
        continue;
      }
      const capability = candidate.capability as DockerHostAccessCapabilityId;
      const rootId = capability === "nas_capacity" && typeof candidate.rootId === "string" ? candidate.rootId.trim() : undefined;
      const key = `${capability}\0${rootId ?? ""}`;
      if (seen.has(key)) {
        issues.push({ code: "duplicate_capability", severity: "error", ...(service ? { service } : {}), capability });
        continue;
      }
      seen.add(key);
      const definition = catalog.capabilities.find((entry) => entry.id === capability)!;
      if (definition.availability.status === "unavailable") {
        issues.push({
          code: "capability_unavailable",
          severity: "error",
          ...(service ? { service } : {}),
          capability,
          reasonCodes: definition.availability.reasonCodes
        });
      } else if (definition.availability.status === "degraded") {
        issues.push({
          code: "capability_unavailable",
          severity: "warning",
          ...(service ? { service } : {}),
          capability,
          reasonCodes: definition.availability.reasonCodes
        });
      }
      if (capability === "nas_capacity") {
        if (!rootId) {
          issues.push({ code: "missing_root", severity: "error", ...(service ? { service } : {}), capability });
          continue;
        }
        const root = catalog.nasRoots.find((entry) => entry.rootId === rootId);
        if (!root || root.availability.status === "unavailable") {
          issues.push({
            code: "root_unavailable",
            severity: "error",
            ...(service ? { service } : {}),
            capability,
            reasonCodes: root?.availability.reasonCodes ?? ["nas_root_not_ready"]
          });
          continue;
        }
      } else if ("rootId" in candidate) {
        issues.push({ code: "missing_root", severity: "error", ...(service ? { service } : {}), capability });
      }
      const defaultTarget = capability === "nas_capacity"
        ? path.posix.join(definition.defaultTarget!, rootId!)
        : definition.defaultTarget;
      const target = candidate.target === undefined ? defaultTarget : normalizeContainerTarget(candidate.target);
      if (candidate.target !== undefined && target === null) {
        issues.push({ code: "invalid_target", severity: "error", ...(service ? { service } : {}), capability, field: "target" });
        continue;
      }
      if (definition.transport !== "bind" && candidate.target !== undefined) {
        issues.push({ code: "invalid_target", severity: "error", ...(service ? { service } : {}), capability, field: "target" });
        continue;
      }
      const overlappingTarget = target ? targets.find((existing) => pathsOverlap(existing, target)) : undefined;
      if (target && overlappingTarget && !isSharedEtcTarget(capability, grants, target)) {
        issues.push({
          code: overlappingTarget === target ? "duplicate_target" : "managed_mount_conflict",
          severity: "error",
          ...(service ? { service } : {}),
          capability,
          field: overlappingTarget
        });
        continue;
      }
      if (target) targets.push(target);
      grants.push(capability === "nas_capacity"
        ? { capability, rootId: rootId!, ...(target !== defaultTarget ? { target: target! } : {}) }
        : { capability, ...(target !== defaultTarget && target ? { target } : {}) });
    }
    grants.sort(compareGrants);
    return { grants, issues };
  }

  private mountsForGrants(grants: DockerHostAccessGrant[], scopeId: string, service?: string): DockerHostAccessMount[] {
    const mounts: DockerHostAccessMount[] = [];
    let proxyDirectoryMounted = false;
    for (const grant of grants) {
      const definition = CAPABILITY_DEFINITIONS.find((entry) => entry.id === grant.capability)!;
      const target = grant.target ?? (grant.capability === "nas_capacity"
        ? path.posix.join(definition.defaultTarget!, grant.rootId)
        : definition.defaultTarget);
      switch (grant.capability) {
        case "host_os_identity":
          for (const source of ["/etc/os-release", "/etc/localtime", "/etc/machine-id"]) {
            mounts.push({ source, target: path.posix.join(target!, path.posix.basename(source)), readOnly: true });
          }
          break;
        case "account_map":
          for (const source of ["/etc/passwd", "/etc/group"]) {
            mounts.push({ source, target: path.posix.join(target!, path.posix.basename(source)), readOnly: true });
          }
          break;
        case "host_processes":
          mounts.push({ source: "/proc", target: target!, readOnly: true });
          break;
        case "host_sys":
          mounts.push({ source: "/sys", target: target!, readOnly: true });
          break;
        case "nas_capacity": {
          const root = listNasRoots(this.db).find((candidate) => candidate.id === grant.rootId);
          if (!root) throw new DockerHostAccessValidationError([{ code: "root_unavailable", severity: "error", capability: grant.capability }]);
          mounts.push({
            source: path.join(root.path, DOCKER_HOST_ACCESS_NAS_ANCHOR),
            target: target!,
            readOnly: true
          });
          break;
        }
        case "docker_metadata":
        case "systemd_status":
          if (!proxyDirectoryMounted) {
            mounts.push({
              source: path.join(this.runtimeRoot, "grants", safeSegment(scopeId), safeSegment(service ?? "container")),
              target: "/run/cyberos-host-access",
              readOnly: true
            });
            proxyDirectoryMounted = true;
          }
          break;
      }
    }
    return mounts.sort((left, right) => left.target.localeCompare(right.target) || left.source.localeCompare(right.source));
  }

  private resourceIdentities(grants: DockerHostAccessGrant[]): unknown[] {
    const roots = new Map(listNasRoots(this.db).map((root) => [root.id, root]));
    return grants.filter((grant) => grant.capability === "nas_capacity").map((grant) => {
      const root = roots.get(grant.rootId);
      const readiness = getRootReadiness(this.db, grant.rootId);
      return {
        capability: grant.capability,
        rootId: grant.rootId,
        path: root?.path ?? null,
        source: readiness?.source ?? null,
        uuid: readiness?.uuid ?? null,
        fstype: readiness?.fstype ?? null
      };
    });
  }

  private capabilityAvailability(id: DockerHostAccessCapabilityId, hasReadyRoot: boolean): DockerHostAccessAvailability {
    if (this.platform !== "linux") return unavailable("not_linux");
    const rootless = this.options.rootless ?? this.detectedRootless;
    const userNamespace = this.options.userNamespace ?? this.detectedUserNamespace;
    if ((id === "host_processes" || id === "host_sys") && rootless) return unavailable("rootless_docker");
    if ((id === "host_processes" || id === "host_sys") && userNamespace) return degraded("user_namespace_enabled");
    if (id === "nas_capacity") return hasReadyRoot ? available() : unavailable("no_ready_nas_root");
    if (id === "docker_metadata") {
      if (!this.daemonIsAvailable()) return unavailable("host_access_daemon_unavailable");
      return this.proxyCompatible("docker") ? available() : unavailable("docker_proxy_unverified");
    }
    if (id === "systemd_status") {
      if (!this.daemonIsAvailable()) return unavailable("host_access_daemon_unavailable");
      return this.proxyCompatible("systemd") ? available() : unavailable("systemd_proxy_unverified");
    }
    return available();
  }

  private daemonAvailability(): DockerHostAccessAvailability {
    return this.daemonIsAvailable() ? available() : unavailable("host_access_daemon_unavailable");
  }

  private daemonIsAvailable(): boolean {
    return this.options.daemonAvailable ?? existsSync(path.join(this.runtimeRoot, "control.sock"));
  }

  private proxyCompatible(proxy: "docker" | "systemd"): boolean {
    const configured = proxy === "docker" ? this.options.dockerProxyCompatible : this.options.systemdProxyCompatible;
    return configured ?? existsSync(path.join(this.runtimeRoot, `${proxy}-compatible`));
  }
}

export async function reconcileRunningDockerHostAccess(
  engine: DockerEngineRuntime,
  control: DockerHostAccessControlRuntime
): Promise<DockerHostAccessReconciliationResult> {
  const containers = await engine.listContainers();
  const failures: DockerHostAccessReconciliationResult["failures"] = [];
  let reconciled = 0;
  if (!engine.getContainerDetails) return { reconciled, failures };
  for (const container of containers.filter((candidate) => candidate.state === "running")) {
    try {
      const details = await engine.getContainerDetails(container.id, container);
      const labels = details.labels;
      if (
        labels["io.cyberos.managed"] !== "true" ||
        labels[`${DOCKER_HOST_ACCESS_LABEL_PREFIX}policy`] !== DOCKER_HOST_ACCESS_POLICY_VERSION ||
        !labels[`${DOCKER_HOST_ACCESS_LABEL_PREFIX}fingerprint`]
      ) {
        continue;
      }
      const capabilities = (labels[`${DOCKER_HOST_ACCESS_LABEL_PREFIX}grants`] ?? "")
        .split(",")
        .map((grant) => grant.split(":", 1)[0])
        .filter((capability): capability is "docker_metadata" | "systemd_status" => (
          capability === "docker_metadata" || capability === "systemd_status"
        ));
      if (!capabilities.length) continue;
      await control.reconcile({
        scopeId: details.composeProject ?? details.name,
        ...(details.composeService ? { service: details.composeService } : {}),
        capabilities
      });
      reconciled += 1;
    } catch (error) {
      failures.push({
        containerId: container.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { reconciled, failures };
}

function capacityAnchorAvailable(anchor: string): boolean {
  try {
    const metadata = lstatSync(anchor);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && readdirSync(anchor).length === 0;
  } catch {
    return false;
  }
}

export function normalizeContainerTarget(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) return null;
  const normalized = path.posix.normalize(value);
  if (normalized === "/" || normalized !== value.replace(/\/$/u, "") || normalized.split("/").includes("..")) return null;
  return normalized;
}

export function coverageReport(
  grants: DockerHostAccessGrant[],
  catalog: DockerHostAccessCatalog,
  runtime = false
): DockerHostAccessCoverageReport {
  const capabilities = new Map(catalog.capabilities.map((capability) => [capability.id, capability]));
  const covered = new Map<DockerHostAccessCoverageId, DockerHostAccessCapabilityId[]>();
  for (const grant of grants) {
    for (const coverage of capabilities.get(grant.capability)?.coverage ?? []) {
      covered.set(coverage, [...(covered.get(coverage) ?? []), grant.capability]);
    }
  }
  const items: DockerHostAccessCoverageReport["items"] = [...covered.entries()].map(([coverage, capabilityIds]) => {
    const availability = capabilityIds.map((id) => capabilities.get(id)!.availability);
    const unavailableItem = availability.find((item) => item.status === "unavailable");
    const degradedItem = availability.find((item) => item.status === "degraded");
    return {
      coverage,
      state: unavailableItem ? "unavailable" as const : degradedItem ? "degraded" as const : runtime ? "runtime" as const : "configured" as const,
      capabilities: [...new Set(capabilityIds)].sort(),
      reasonCodes: unavailableItem?.reasonCodes ?? degradedItem?.reasonCodes ?? []
    };
  });
  for (const coverage of UNSUPPORTED_COVERAGE) {
    items.push({ coverage, state: "unsupported", capabilities: [], reasonCodes: [] });
  }
  items.sort((left, right) => left.coverage.localeCompare(right.coverage));
  return { policyVersion: catalog.policyVersion, items };
}

function mergeCoverage(reports: DockerHostAccessCoverageReport[], catalog: DockerHostAccessCatalog): DockerHostAccessCoverageReport {
  if (!reports.length) return coverageReport([], catalog);
  const items = new Map<DockerHostAccessCoverageId, DockerHostAccessCoverageReport["items"][number]>();
  for (const report of reports) {
    for (const item of report.items) {
      const previous = items.get(item.coverage);
      if (!previous || previous.state === "unsupported") items.set(item.coverage, item);
      else items.set(item.coverage, {
        ...previous,
        capabilities: [...new Set([...previous.capabilities, ...item.capabilities])].sort(),
        reasonCodes: [...new Set([...previous.reasonCodes, ...item.reasonCodes])].sort()
      });
    }
  }
  return { policyVersion: catalog.policyVersion, items: [...items.values()].sort((a, b) => a.coverage.localeCompare(b.coverage)) };
}

function conflictingServiceIssues(
  serviceDefinition: Record<string, unknown> | undefined,
  service?: string
): DockerHostAccessValidationIssue[] {
  if (!serviceDefinition) return [];
  const issues: DockerHostAccessValidationIssue[] = [];
  const conflict = (field: string) => issues.push({ code: "conflicting_compose_field", severity: "error", ...(service ? { service } : {}), field });
  if (serviceDefinition.privileged === true) conflict("privileged");
  if (serviceDefinition.pid === "host") conflict("pid");
  if (serviceDefinition.network_mode === "host") conflict("network_mode");
  if (serviceDefinition.ipc === "host") conflict("ipc");
  for (const field of ["userns_mode", "uts", "cgroup", "cap_add", "cap_drop", "devices", "security_opt"] as const) {
    if (serviceDefinition[field] !== undefined) conflict(field);
  }
  return issues;
}

function compareGrants(left: DockerHostAccessGrant, right: DockerHostAccessGrant): number {
  return left.capability.localeCompare(right.capability)
    || (left.capability === "nas_capacity" ? left.rootId : "").localeCompare(right.capability === "nas_capacity" ? right.rootId : "")
    || (left.target ?? "").localeCompare(right.target ?? "");
}

function isSharedEtcTarget(capability: DockerHostAccessCapabilityId, grants: DockerHostAccessGrant[], target: string): boolean {
  if (target !== "/host/etc" || (capability !== "host_os_identity" && capability !== "account_map")) return false;
  return grants.some((grant) => grant.capability === (capability === "host_os_identity" ? "account_map" : "host_os_identity"));
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = path.posix.normalize(left);
  const normalizedRight = path.posix.normalize(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}/`)
    || normalizedRight.startsWith(`${normalizedLeft}/`);
}

function safeSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function duplicates(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    else seen.add(value);
  }
  return duplicate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function available(): DockerHostAccessAvailability {
  return { status: "available", reasonCodes: [] };
}

function degraded(reason: DockerHostAccessAvailability["reasonCodes"][number]): DockerHostAccessAvailability {
  return { status: "degraded", reasonCodes: [reason] };
}

function unavailable(reason: DockerHostAccessAvailability["reasonCodes"][number]): DockerHostAccessAvailability {
  return { status: "unavailable", reasonCodes: [reason] };
}

export function hostAccessRisk(capability: DockerHostAccessCapabilityId): DockerHostAccessRisk {
  return CAPABILITY_DEFINITIONS.find((definition) => definition.id === capability)!.risk;
}
