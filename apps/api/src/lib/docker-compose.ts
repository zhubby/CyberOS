import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createDockerComposeApp,
  deleteDockerComposeApp,
  DockerComposeAppConflictError,
  getDockerComposeApp,
  getDockerComposeAppSummary,
  getRootReadiness,
  listDockerComposeApps,
  listDockerComposeAppSummaries,
  listNasRoots,
  markDockerComposeAppDeployed,
  restoreDockerComposeApp,
  updateDockerComposeApp,
  type DockerComposeAppEnvironmentRecord,
  type DockerComposeAppRecord,
  type DockerComposeAppSummaryRecord,
  type DockerRegistryCredentialRecord,
  type ZosDatabase
} from "@zos/db";
import type {
  DockerComposeAppCreateInput,
  DockerComposeAppDeleteInput,
  DockerComposeAppDetail,
  DockerComposeAppSummary,
  DockerComposeAppUpdateInput,
  DockerComposeAppValidateInput,
  DockerComposeAppValidationResult,
  DockerConfig,
  DockerContainerSummary,
  DockerOperationProposal
} from "@zos/shared";
import { isPathInside } from "@zos/nas-tools";
import { parseDocument } from "yaml";
import { dockerConfigAuths, redactDockerRegistrySecrets } from "./docker-registry.js";

export const DOCKER_APPS_ROOT = "/zos/apps";

const MANAGED_COMPOSE_FILE = "compose.yaml";
const MANAGED_ENV_FILE = ".env";
const MANAGED_MARKER_FILE = ".zos-app.json";
const PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_ENVIRONMENT_KEY_PATTERN = /^(?:COMPOSE_|DOCKER_)/u;
const MAX_NAME_LENGTH = 128;
const MAX_COMPOSE_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 256;

export class DockerComposeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerComposeValidationError";
  }
}

export class DockerComposeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerComposeUnavailableError";
  }
}

export class DockerComposeMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerComposeMaterializationError";
  }
}

export interface DockerComposeRuntime {
  listProjects(containers: DockerContainerSummary[] | null): Promise<DockerComposeAppSummary[]>;
  getProject(projectId: string, containers?: DockerContainerSummary[] | null): Promise<DockerComposeAppSummary | null>;
  getApp(projectId: string, containers?: DockerContainerSummary[] | null): Promise<DockerComposeAppDetail | null>;
  validateApp(input: DockerComposeAppValidateInput): Promise<DockerComposeAppValidationResult>;
  createApp(input: DockerComposeAppCreateInput): Promise<DockerComposeAppDetail>;
  updateApp(projectId: string, input: DockerComposeAppUpdateInput): Promise<DockerComposeAppDetail | null>;
  deleteApp(
    projectId: string,
    input: DockerComposeAppDeleteInput,
    isProjectInUse?: (projectKey: string) => Promise<boolean>
  ): Promise<"deleted" | "not_found" | "conflict" | "in_use">;
  reconcileAll(): Promise<void>;
  runProjectAction(
    proposal: DockerOperationProposal,
    registryCredentials?: DockerRegistryCredentialRecord[]
  ): Promise<{ output: string }>;
}

export class DockerComposeService implements DockerComposeRuntime {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly configSource: DockerConfig | (() => DockerConfig),
    private readonly db: ZosDatabase,
    private readonly appsRoot = DOCKER_APPS_ROOT
  ) {}

  async listProjects(containers: DockerContainerSummary[] | null): Promise<DockerComposeAppSummary[]> {
    return listDockerComposeAppSummaries(this.db).map((app) => publicSummary(app, containers, this.appsRoot));
  }

  async getProject(
    projectId: string,
    containers: DockerContainerSummary[] | null = null
  ): Promise<DockerComposeAppSummary | null> {
    const app = getDockerComposeAppSummary(this.db, projectId);
    return app ? publicSummary(app, containers, this.appsRoot) : null;
  }

  async getApp(
    projectId: string,
    containers: DockerContainerSummary[] | null = null
  ): Promise<DockerComposeAppDetail | null> {
    const app = getDockerComposeApp(this.db, projectId);
    return app ? publicDetail(app, containers, this.appsRoot) : null;
  }

  async validateApp(input: DockerComposeAppValidateInput): Promise<DockerComposeAppValidationResult> {
    requireRequestObject(input);
    const current = input.appId ? getDockerComposeApp(this.db, input.appId) : null;
    if (input.appId && !current) throw new DockerComposeValidationError("Docker Compose App not found");
    if (current && input.expectedRevision !== current.revision) {
      throw new DockerComposeAppConflictError("Docker Compose App changed in another request");
    }
    if (current && input.projectKey !== current.projectKey) {
      throw new DockerComposeValidationError("Project key cannot be changed after creation");
    }
    if (current) {
      const normalized = normalizeUpdateInput({
        name: current.name,
        composeContent: input.composeContent,
        environment: input.environment,
        expectedRevision: current.revision
      }, current);
      return validateComposeDefinition(this.currentConfig(), this.db, {
        projectKey: current.projectKey,
        composeContent: normalized.composeContent,
        environment: normalized.resolvedEnvironment
      }, this.appsRoot);
    }
    const normalized = normalizeCreateInput({ ...input, name: "Validation" } as DockerComposeAppCreateInput);
    return validateComposeDefinition(this.currentConfig(), this.db, normalized, this.appsRoot);
  }

  async createApp(input: DockerComposeAppCreateInput): Promise<DockerComposeAppDetail> {
    return this.serialized(async () => {
      requireRequestObject(input);
      const normalized = normalizeCreateInput(input);
      const validation = await validateComposeDefinition(this.currentConfig(), this.db, normalized, this.appsRoot);
      const app = createDockerComposeApp(this.db, { ...normalized, ...validation });
      try {
        await materializeApp(app, this.appsRoot);
      } catch (error) {
        deleteDockerComposeApp(this.db, app.id, app.revision);
        await removeMaterializedApp(app, this.appsRoot).catch(() => undefined);
        throw materializationError(error);
      }
      return publicDetail(app, null, this.appsRoot);
    });
  }

  async updateApp(projectId: string, input: DockerComposeAppUpdateInput): Promise<DockerComposeAppDetail | null> {
    return this.serialized(async () => {
      requireRequestObject(input);
      const current = getDockerComposeApp(this.db, projectId);
      if (!current) return null;
      const normalized = normalizeUpdateInput(input, current);
      const validation = await validateComposeDefinition(this.currentConfig(), this.db, {
        projectKey: current.projectKey,
        composeContent: normalized.composeContent,
        environment: normalized.resolvedEnvironment
      }, this.appsRoot);
      const updated = updateDockerComposeApp(this.db, projectId, input.expectedRevision, {
        name: normalized.name,
        composeContent: normalized.composeContent,
        environment: normalized.environment,
        ...validation
      });
      if (!updated) return null;
      try {
        await materializeApp(updated, this.appsRoot);
      } catch (error) {
        try {
          restoreDockerComposeApp(this.db, updated.revision, current);
          await materializeApp(current, this.appsRoot);
        } catch (rollbackError) {
          throw new DockerComposeMaterializationError(
            `${materializationError(error).message}; rollback failed: ${materializationError(rollbackError).message}`
          );
        }
        throw materializationError(error);
      }
      return publicDetail(updated, null, this.appsRoot);
    });
  }

  async deleteApp(
    projectId: string,
    input: DockerComposeAppDeleteInput,
    isProjectInUse?: (projectKey: string) => Promise<boolean>
  ): Promise<"deleted" | "not_found" | "conflict" | "in_use"> {
    return this.serialized(async () => {
      requireRequestObject(input);
      requiredText(input.expectedRevision, "Expected revision", 128);
      const app = getDockerComposeApp(this.db, projectId);
      if (!app) return "not_found";
      if (app.revision !== input.expectedRevision) return "conflict";
      if (isProjectInUse && await isProjectInUse(app.projectKey)) return "in_use";
      try {
        await removeMaterializedApp(app, this.appsRoot);
      } catch (error) {
        throw materializationError(error);
      }
      let result: "deleted" | "not_found" | "conflict";
      try {
        result = deleteDockerComposeApp(this.db, projectId, input.expectedRevision);
      } catch (error) {
        try {
          await materializeApp(app, this.appsRoot);
        } catch (rollbackError) {
          throw new DockerComposeMaterializationError(
            `Database deletion failed; runtime copy recovery failed: ${materializationError(rollbackError).message}`
          );
        }
        throw error;
      }
      if (result !== "deleted") {
        try {
          await materializeApp(app, this.appsRoot);
        } catch (error) {
          throw materializationError(error);
        }
      }
      return result;
    });
  }

  async reconcileAll(): Promise<void> {
    await this.serialized(async () => {
      const failures: string[] = [];
      for (const app of listDockerComposeApps(this.db)) {
        try {
          await materializeApp(app, this.appsRoot);
        } catch (error) {
          failures.push(`${app.projectKey}: ${materializationError(error).message}`);
        }
      }
      if (failures.length) {
        throw new DockerComposeMaterializationError(
          `Failed to reconcile ${failures.length} managed App${failures.length === 1 ? "" : "s"}: ${failures.join("; ")}`
        );
      }
    });
  }

  async runProjectAction(
    proposal: DockerOperationProposal,
    registryCredentials: DockerRegistryCredentialRecord[] = []
  ): Promise<{ output: string }> {
    return this.serialized(async () => {
      if (!proposal.composeProjectId || !proposal.composeRevision) {
        throw new DockerComposeValidationError("Compose App approval is missing its revision");
      }
      const app = getDockerComposeApp(this.db, proposal.composeProjectId);
      if (!app) throw new DockerComposeValidationError("Compose App is no longer available");
      if (app.revision !== proposal.composeRevision) {
        throw new DockerComposeAppConflictError("Compose App changed after approval was requested");
      }
      await materializeApp(app, this.appsRoot);
      const appDirectory = managedAppPath(this.appsRoot, app.projectKey);
      const dockerConfigDirectory = composeNeedsRegistryAuth(proposal)
        ? await createDockerConfig(registryCredentials)
        : null;
      try {
        const config = this.currentConfig();
        const output = await runCommand(
          config.composeCommand,
          composeCommandArgs(app, composeActionArgs(proposal)),
          appDirectory,
          config.operationTimeoutMs,
          composeProcessEnvironment(config, app.environment, dockerConfigDirectory)
        );
        if (proposal.action === "compose_up" && !proposal.service) {
          markDockerComposeAppDeployed(this.db, app.id, app.revision);
        }
        return { output: redactComposeSecrets(output, app.environment, registryCredentials) };
      } catch (error) {
        throw new Error(redactComposeSecrets(error, app.environment, registryCredentials));
      } finally {
        if (dockerConfigDirectory) await rm(dockerConfigDirectory, { recursive: true, force: true });
      }
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private currentConfig(): DockerConfig {
    return typeof this.configSource === "function" ? this.configSource() : this.configSource;
  }
}

function normalizeCreateInput(input: DockerComposeAppCreateInput) {
  const name = requiredText(input.name, "App name", MAX_NAME_LENGTH);
  const projectKey = requiredText(input.projectKey, "Project key", 63).toLowerCase();
  if (!PROJECT_KEY_PATTERN.test(projectKey)) {
    throw new DockerComposeValidationError("Project key must use lowercase letters, numbers, hyphens, or underscores");
  }
  const composeContent = requiredText(input.composeContent, "Compose content", MAX_COMPOSE_BYTES, false);
  return {
    name,
    projectKey,
    composeContent: composeContent.endsWith("\n") ? composeContent : `${composeContent}\n`,
    environment: normalizeEnvironment(input.environment, true) as DockerComposeAppEnvironmentRecord[]
  };
}

function normalizeUpdateInput(input: DockerComposeAppUpdateInput, current: DockerComposeAppRecord) {
  const name = requiredText(input.name, "App name", MAX_NAME_LENGTH);
  const composeContent = requiredText(input.composeContent, "Compose content", MAX_COMPOSE_BYTES, false);
  const environment = normalizeEnvironment(input.environment, false);
  const currentValues = new Map(current.environment.map((entry) => [entry.key, entry.value]));
  const resolvedEnvironment = environment.map((entry) => {
    if (entry.value !== undefined) return { key: entry.key, value: entry.value };
    const value = currentValues.get(entry.key);
    if (value === undefined) throw new DockerComposeAppConflictError(`Environment value for ${entry.key} is unavailable`);
    return { key: entry.key, value };
  });
  requiredText(input.expectedRevision, "Expected revision", 128);
  return {
    name,
    composeContent: composeContent.endsWith("\n") ? composeContent : `${composeContent}\n`,
    environment,
    resolvedEnvironment
  };
}

function normalizeEnvironment(
  input: Array<{ key: string; value?: string }> | undefined,
  requireValues: boolean
): Array<{ key: string; value?: string }> {
  if (!Array.isArray(input)) throw new DockerComposeValidationError("Environment must be an array");
  if (input.length > MAX_ENVIRONMENT_ENTRIES) throw new DockerComposeValidationError("Too many environment variables");
  const keys = new Set<string>();
  let totalBytes = 0;
  const normalized = input.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new DockerComposeValidationError(`Environment row ${index + 1} is invalid`);
    const key = requiredText(entry.key, `Environment key ${index + 1}`, 128);
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || RESERVED_ENVIRONMENT_KEY_PATTERN.test(key)) {
      throw new DockerComposeValidationError(`Environment key ${key} is not allowed`);
    }
    if (keys.has(key)) throw new DockerComposeValidationError(`Environment key ${key} is duplicated`);
    keys.add(key);
    if (requireValues && typeof entry.value !== "string") {
      throw new DockerComposeValidationError(`Environment value for ${key} is required`);
    }
    if (entry.value !== undefined) {
      if (typeof entry.value !== "string" || entry.value.includes("\0")) {
        throw new DockerComposeValidationError(`Environment value for ${key} is invalid`);
      }
      totalBytes += Buffer.byteLength(key) + Buffer.byteLength(entry.value);
      return { key, value: entry.value };
    }
    totalBytes += Buffer.byteLength(key);
    return { key };
  });
  if (totalBytes > MAX_ENVIRONMENT_BYTES) throw new DockerComposeValidationError("Environment is too large");
  return normalized;
}

async function validateComposeDefinition(
  config: DockerConfig,
  db: ZosDatabase,
  input: { projectKey: string; composeContent: string; environment: DockerComposeAppEnvironmentRecord[] },
  appsRoot: string
): Promise<DockerComposeAppValidationResult> {
  let root: Record<string, unknown>;
  try {
    const document = parseDocument(input.composeContent);
    if (document.errors.length) throw new DockerComposeValidationError(document.errors[0]!.message.slice(0, 500));
    root = objectValue(document.toJS({ maxAliasCount: 50 }) as unknown, "Compose document");
  } catch (error) {
    if (error instanceof DockerComposeValidationError) throw error;
    throw new DockerComposeValidationError("Compose YAML could not be parsed safely");
  }
  if ("include" in root || "name" in root) {
    throw new DockerComposeValidationError("Compose include and top-level name are managed by ZOS");
  }
  if (root.configs !== undefined || root.secrets !== undefined) {
    throw new DockerComposeValidationError("Local Compose configs and secrets are not supported");
  }
  const volumes = root.volumes === undefined ? {} : objectValue(root.volumes, "Compose volumes");
  for (const [volumeName, value] of Object.entries(volumes)) {
    if (value !== null && objectValue(value, `Volume ${volumeName}`).driver_opts !== undefined) {
      throw new DockerComposeValidationError(`Volume ${volumeName} uses unsupported driver options`);
    }
  }
  const services = objectValue(root.services, "Compose services");
  if (!Object.keys(services).length) throw new DockerComposeValidationError("Compose must define at least one service");
  const warnings = new Set<string>();
  for (const [serviceName, value] of Object.entries(services)) {
    const service = objectValue(value, `Service ${serviceName}`);
    if (
      service.build !== undefined ||
      service.develop !== undefined ||
      service.env_file !== undefined ||
      service.label_file !== undefined
    ) {
      throw new DockerComposeValidationError(`Service ${serviceName} references unsupported local files`);
    }
    if (service.extends && objectValue(service.extends, `Service ${serviceName} extends`).file !== undefined) {
      throw new DockerComposeValidationError(`Service ${serviceName} cannot extend a local file`);
    }
    await validateServiceVolumes(db, serviceName, service.volumes, appsRoot, warnings);
    collectServiceRisk(serviceName, service, warnings);
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "zos-compose-validate-"));
  try {
    await writeFile(path.join(tempDirectory, MANAGED_COMPOSE_FILE), input.composeContent, { mode: 0o600 });
    await writeFile(path.join(tempDirectory, MANAGED_ENV_FILE), renderEnvironment(input.environment), { mode: 0o600 });
    let output: string;
    try {
      output = await runCommand(
        config.composeCommand,
        composeCommandArgs({ projectKey: input.projectKey }, ["config", "--format", "json"]),
        tempDirectory,
        config.operationTimeoutMs,
        composeProcessEnvironment(config, input.environment),
        { maxOutputBytes: MAX_COMPOSE_BYTES * 4, stdoutOnlyOnSuccess: true }
      );
    } catch (error) {
      const message = redactEnvironmentSecrets(error, input.environment);
      if (composeCliUnavailable(error, message)) {
        throw new DockerComposeUnavailableError("Docker Compose CLI is unavailable");
      }
      throw new DockerComposeValidationError(message || "Docker Compose validation failed");
    }
    let resolved: Record<string, unknown>;
    try {
      resolved = objectValue(JSON.parse(output) as unknown, "Resolved Compose document");
    } catch (error) {
      if (error instanceof DockerComposeValidationError) throw error;
      throw new DockerComposeValidationError("Docker Compose returned an invalid validation result");
    }
    const resolvedServices = objectValue(resolved.services, "Resolved Compose services");
    for (const [serviceName, value] of Object.entries(resolvedServices)) {
      const service = objectValue(value, `Resolved service ${serviceName}`);
      await validateServiceVolumes(db, serviceName, service.volumes, appsRoot, warnings);
      collectServiceRisk(serviceName, service, warnings);
    }
    const validatedServices = Object.keys(resolvedServices);
    if (!validatedServices.length) throw new DockerComposeValidationError("Compose validation returned no services");
    return {
      services: Array.from(new Set(validatedServices)).sort(),
      warnings: Array.from(warnings),
      risk: warnings.size ? "high" : "medium"
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function validateServiceVolumes(
  db: ZosDatabase,
  serviceName: string,
  value: unknown,
  appsRoot: string,
  warnings: Set<string>
): Promise<void> {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new DockerComposeValidationError(`Service ${serviceName} volumes must be an array`);
  for (const volume of value) {
    let source: string | null = null;
    let bind = false;
    if (typeof volume === "string") {
      const separator = volume.indexOf(":");
      if (separator < 0) continue;
      source = volume.slice(0, separator);
      bind = source.startsWith("/") || source.startsWith(".") || source.includes("/");
    } else {
      const item = objectValue(volume, `Service ${serviceName} volume`);
      bind = item.type === "bind";
      source = typeof item.source === "string" ? item.source : null;
    }
    if (!bind) continue;
    if (!source) {
      throw new DockerComposeValidationError(`Service ${serviceName} uses a relative bind mount`);
    }
    if (!path.isAbsolute(source)) {
      if (source.includes("$")) continue;
      throw new DockerComposeValidationError(`Service ${serviceName} uses a relative bind mount`);
    }
    const resolvedSource = await resolvePotentialPath(source);
    const resolvedAppsRoot = await realpath(appsRoot).catch(() => path.resolve(appsRoot));
    if (isPathInside(resolvedAppsRoot, resolvedSource)) {
      throw new DockerComposeValidationError("Application data cannot be stored under /zos/apps");
    }
    let allowed = false;
    for (const root of listNasRoots(db)) {
      if (getRootReadiness(db, root.id)?.status !== "ready") continue;
      const resolvedRoot = await realpath(root.path).catch(() => path.resolve(root.path));
      if (isPathInside(resolvedRoot, resolvedSource)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) throw new DockerComposeValidationError(`Service ${serviceName} bind mount is outside a ready NAS root`);
    warnings.add(`Service ${serviceName} uses a NAS bind mount`);
  }
}

async function resolvePotentialPath(candidatePath: string): Promise<string> {
  let existingPath = path.resolve(candidatePath);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(existingPath), ...missingSegments);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(existingPath);
      if (parent === existingPath) throw error;
      missingSegments.unshift(path.basename(existingPath));
      existingPath = parent;
    }
  }
}

async function materializeApp(app: DockerComposeAppRecord, appsRoot: string): Promise<void> {
  await ensureManagedRoot(appsRoot);
  const appDirectory = managedAppPath(appsRoot, app.projectKey);
  const existing = await lstat(appDirectory).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new DockerComposeMaterializationError("Managed App path is not a directory");
    const marker = await readManagedMarker(appDirectory);
    if (!marker || marker.id !== app.id) throw new DockerComposeMaterializationError("Managed App directory is not owned by this App");
  } else {
    await mkdir(appDirectory, { mode: 0o750 });
  }
  await chmod(appDirectory, 0o750);
  await atomicWrite(
    path.join(appDirectory, MANAGED_MARKER_FILE),
    `${JSON.stringify({ id: app.id, projectKey: app.projectKey, revision: app.revision })}\n`,
    0o640
  );
  await atomicWrite(path.join(appDirectory, MANAGED_COMPOSE_FILE), app.composeContent, 0o640);
  await atomicWrite(path.join(appDirectory, MANAGED_ENV_FILE), renderEnvironment(app.environment), 0o600);
}

async function removeMaterializedApp(app: DockerComposeAppRecord, appsRoot: string): Promise<void> {
  const appDirectory = managedAppPath(appsRoot, app.projectKey);
  const stats = await lstat(appDirectory).catch(() => null);
  if (!stats) return;
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new DockerComposeMaterializationError("Managed App path is unsafe");
  const marker = await readManagedMarker(appDirectory);
  if (!marker || marker.id !== app.id) throw new DockerComposeMaterializationError("Managed App directory ownership cannot be verified");
  await rm(appDirectory, { recursive: true });
}

async function ensureManagedRoot(appsRoot: string): Promise<void> {
  await mkdir(appsRoot, { recursive: true, mode: 0o750 });
  const stats = await lstat(appsRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new DockerComposeMaterializationError("Docker Apps root is unsafe");
  await chmod(appsRoot, 0o750);
}

async function readManagedMarker(appDirectory: string): Promise<{ id?: string } | null> {
  const markerPath = path.join(appDirectory, MANAGED_MARKER_FILE);
  const stats = await lstat(markerPath).catch(() => null);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return null;
  try {
    return JSON.parse(await readFile(markerPath, "utf8")) as { id?: string };
  } catch {
    return null;
  }
}

async function atomicWrite(filePath: string, content: string, mode: number): Promise<void> {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode });
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function publicSummary(
  app: DockerComposeAppSummaryRecord,
  containers: DockerContainerSummary[] | null,
  appsRoot: string
): DockerComposeAppSummary {
  const projectContainers = containers?.filter((container) => container.composeProject === app.projectKey) ?? null;
  const runningCount = projectContainers?.filter((container) => container.state === "running").length ?? null;
  return {
    id: app.id,
    name: app.name,
    projectKey: app.projectKey,
    managedPath: managedAppPath(appsRoot, app.projectKey),
    services: app.services,
    warnings: app.warnings,
    risk: app.risk,
    revision: app.revision,
    deployedRevision: app.deployedRevision,
    needsDeploy: app.deployedRevision !== app.revision,
    containerCount: projectContainers?.length ?? null,
    runningCount,
    status: projectStatus(projectContainers, app.deployedRevision !== null),
    createdAt: app.createdAt,
    updatedAt: app.updatedAt
  };
}

function publicDetail(
  app: DockerComposeAppRecord,
  containers: DockerContainerSummary[] | null,
  appsRoot: string
): DockerComposeAppDetail {
  return {
    ...publicSummary(app, containers, appsRoot),
    composeContent: app.composeContent,
    environment: app.environment.map((entry) => ({ key: entry.key, valueConfigured: true }))
  };
}

function projectStatus(
  containers: DockerContainerSummary[] | null,
  wasDeployed: boolean
): DockerComposeAppSummary["status"] {
  if (!containers?.length) return containers && wasDeployed ? "stopped" : "configured";
  const running = containers.filter((container) => container.state === "running").length;
  if (running === containers.length) return "running";
  return running > 0 ? "partial" : "stopped";
}

function composeActionArgs(proposal: DockerOperationProposal): string[] {
  const service = proposal.service ? [proposal.service] : [];
  switch (proposal.action) {
    case "compose_up": return ["up", "-d", ...service];
    case "compose_down": return ["down"];
    case "compose_pull": return ["pull", ...service];
    case "compose_restart": return ["restart", ...service];
    default: throw new DockerComposeValidationError("Unsupported Compose action");
  }
}

function composeCommandArgs(app: { projectKey: string }, action: string[]): string[] {
  return ["compose", "-p", app.projectKey, "--env-file", MANAGED_ENV_FILE, "-f", MANAGED_COMPOSE_FILE, ...action];
}

function composeNeedsRegistryAuth(proposal: DockerOperationProposal): boolean {
  return proposal.action === "compose_pull" || proposal.action === "compose_up";
}

function renderEnvironment(environment: DockerComposeAppEnvironmentRecord[]): string {
  return environment
    .map((entry) => `${entry.key}=${JSON.stringify(entry.value.replace(/\$/gu, "$$$$"))}`)
    .join("\n") + (environment.length ? "\n" : "");
}

function composeProcessEnvironment(
  config: DockerConfig,
  environment: DockerComposeAppEnvironmentRecord[],
  dockerConfigDirectory: string | null = null
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(result)) {
    if (RESERVED_ENVIRONMENT_KEY_PATTERN.test(key)) delete result[key];
  }
  // App values come from the managed --env-file. Removing inherited values
  // preserves that precedence without letting App input control the CLI process.
  for (const entry of environment) delete result[entry.key];
  result.DOCKER_HOST = `unix://${config.socketPath}`;
  if (dockerConfigDirectory) result.DOCKER_CONFIG = dockerConfigDirectory;
  return result;
}

function collectServiceRisk(
  serviceName: string,
  service: Record<string, unknown>,
  warnings: Set<string>
): void {
  if (
    service.privileged === true ||
    service.network_mode === "host" ||
    service.pid === "host" ||
    service.ipc === "host" ||
    nonEmptyArray(service.cap_add) ||
    nonEmptyArray(service.devices)
  ) warnings.add(`Service ${serviceName} requests elevated host access`);
}

function requireRequestObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DockerComposeValidationError("Request body must be an object");
  }
}

function managedAppPath(appsRoot: string, projectKey: string): string {
  const resolvedRoot = path.resolve(appsRoot);
  const candidate = path.resolve(resolvedRoot, projectKey);
  if (!isPathInside(resolvedRoot, candidate) || candidate === resolvedRoot) {
    throw new DockerComposeValidationError("Project key escapes the managed Apps root");
  }
  return candidate;
}

function requiredText(value: unknown, label: string, maxBytes: number, trim = true): string {
  if (typeof value !== "string") throw new DockerComposeValidationError(`${label} is required`);
  const candidate = trim ? value.trim() : value;
  if (!candidate) throw new DockerComposeValidationError(`${label} is required`);
  if (Buffer.byteLength(candidate) > maxBytes) throw new DockerComposeValidationError(`${label} is too large`);
  return candidate;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DockerComposeValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

async function createDockerConfig(registryCredentials: DockerRegistryCredentialRecord[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zos-docker-config-"));
  try {
    await chmod(directory, 0o700);
    await writeFile(
      path.join(directory, "config.json"),
      `${JSON.stringify({ auths: dockerConfigAuths(registryCredentials) })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function redactComposeSecrets(
  value: unknown,
  environment: DockerComposeAppEnvironmentRecord[],
  registryCredentials: DockerRegistryCredentialRecord[]
): string {
  return redactEnvironmentSecrets(redactDockerRegistrySecrets(value, registryCredentials, 16_000), environment);
}

function redactEnvironmentSecrets(value: unknown, environment: DockerComposeAppEnvironmentRecord[]): string {
  let message = value instanceof Error ? value.message : String(value);
  const secrets = new Set<string>();
  for (const entry of environment) {
    if (entry.value.length === 0) continue;
    for (const secret of [
      entry.value,
      JSON.stringify(entry.value),
      JSON.stringify(entry.value.replace(/\$/gu, "$$$$"))
    ]) secrets.add(secret);
  }
  for (const secret of Array.from(secrets).sort((left, right) => right.length - left.length)) {
    message = message.split(secret).join(secret.startsWith('"') ? JSON.stringify("[redacted]") : "[redacted]");
  }
  return message.slice(0, 16_000);
}

function composeCliUnavailable(error: unknown, message: string): boolean {
  const code = error instanceof Error && "code" in error ? error.code : null;
  return code === "ENOENT" || code === "EACCES" ||
    /ENOENT|not found|spawn|not a docker command|unknown command[^\n]*compose|compose[^\n]*plugin[^\n]*unavailable/iu.test(message);
}

function materializationError(error: unknown): DockerComposeMaterializationError {
  return error instanceof DockerComposeMaterializationError
    ? error
    : new DockerComposeMaterializationError(error instanceof Error ? error.message : String(error));
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
  options: { maxOutputBytes?: number; stdoutOnlyOnSuccess?: boolean } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, env, stdio: ["ignore", "pipe", "pipe"] });
    const maxOutputBytes = options.maxOutputBytes ?? 16_000;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      callback();
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = truncateOutput(stdout + chunk.toString("utf8"), maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = truncateOutput(stderr + chunk.toString("utf8"), maxOutputBytes);
    });
    child.on("error", (error) => {
      if (settled && forceKillTimer) clearTimeout(forceKillTimer);
      settle(() => reject(timedOut ? new Error(`docker compose timed out after ${timeoutMs}ms`) : error));
    });
    child.on("close", (exitCode) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (settled) return;
      if (timedOut) {
        settle(() => reject(new Error(`docker compose timed out after ${timeoutMs}ms`)));
        return;
      }
      const output = options.stdoutOnlyOnSuccess ? stdout : `${stdout}${stderr}`;
      if (exitCode === 0) {
        settle(() => resolve(output));
      } else {
        settle(() => reject(new Error(`${stderr}${stdout}`.trim() || `docker compose exited with ${exitCode ?? "signal"}`)));
      }
    });
  });
}

function truncateOutput(output: string, maxOutputBytes: number): string {
  return output.length > maxOutputBytes ? output.slice(output.length - maxOutputBytes) : output;
}
