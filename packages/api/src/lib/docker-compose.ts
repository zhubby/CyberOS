import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createDockerComposeApp,
  createDockerComposeHostAccessDraft,
  deleteDockerComposeHostAccessDraft,
  deleteDockerComposeApp,
  DockerComposeAppConflictError,
  getDockerComposeApp,
  getDockerComposeHostAccessDraft,
  getDockerComposeAppSummary,
  getRootReadiness,
  listDockerComposeApps,
  listDockerComposeAppSummaries,
  listNasRoots,
  markDockerComposeAppDeployed,
  restoreDockerComposeApp,
  updateDockerComposeApp,
  type DockerComposeAppEnvironmentRecord,
  type DockerComposeHostAccessDraftRecord,
  type DockerComposeAppRecord,
  type DockerComposeAppSummaryRecord,
  type DockerRegistryCredentialRecord,
  type CyberOsDatabase
} from "@cyberos/db";
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
  DockerHostAccessValidationIssue,
  DockerOperationProposal
} from "@cyberos/shared";
import type { DockerEngineRuntime } from "./docker-client.js";
import { isPathInside } from "@cyberos/nas-tools";
import { parseDocument, stringify } from "yaml";
import {
  dockerConfigAuths,
  dockerRegistryAuthHeader,
  findDockerRegistryCredential,
  redactDockerRegistrySecrets
} from "./docker-registry.js";
import {
  DOCKER_HOST_ACCESS_LABEL_PREFIX,
  DOCKER_HOST_ACCESS_OVERRIDE_FILE,
  DockerHostAccessPolicy,
  DockerHostAccessValidationError,
  coverageReport,
  type DockerHostAccessControlRuntime,
  type DockerHostAccessManifest
} from "./docker-host-access.js";

export const DOCKER_APPS_ROOT = "/cyberos/apps";

const MANAGED_COMPOSE_FILE = "compose.yaml";
const MANAGED_ENV_FILE = ".env";
const MANAGED_MARKER_FILE = ".cyberos-app.json";
const PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_ENVIRONMENT_KEY_PATTERN = /^(?:COMPOSE_|DOCKER_)/u;
const MAX_NAME_LENGTH = 128;
const MAX_COMPOSE_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 256;

export class DockerComposeValidationError extends Error {
  constructor(
    message: string,
    readonly issues: DockerHostAccessValidationIssue[] = [],
    readonly statusCode: 400 | 503 = 400
  ) {
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

export class DockerComposeHostAccessDraftError extends Error {
  constructor(message: string, readonly statusCode: 409 | 503) {
    super(message);
    this.name = "DockerComposeHostAccessDraftError";
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
  prepareHostAccessDraft?(
    projectId: string,
    engine: DockerEngineRuntime,
    registryCredentials?: DockerRegistryCredentialRecord[]
  ): Promise<{
    draftId: string;
    draftRevision: string;
    hostAccess: NonNullable<DockerOperationProposal["hostAccess"]>;
  }>;
  runProjectAction(
    proposal: DockerOperationProposal,
    registryCredentials?: DockerRegistryCredentialRecord[],
    engine?: DockerEngineRuntime,
    hostAccessDraftId?: string | null
  ): Promise<{ output: string }>;
}

export class DockerComposeService implements DockerComposeRuntime {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly configSource: DockerConfig | (() => DockerConfig),
    private readonly db: CyberOsDatabase,
    private readonly appsRoot = DOCKER_APPS_ROOT,
    private readonly hostAccessPolicy = new DockerHostAccessPolicy(db),
    private readonly hostAccessControl?: DockerHostAccessControlRuntime
  ) {}

  async listProjects(containers: DockerContainerSummary[] | null): Promise<DockerComposeAppSummary[]> {
    return listDockerComposeAppSummaries(this.db).map((app) => (
      publicSummary(app, containers, this.appsRoot, this.hostAccessPolicy)
    ));
  }

  async getProject(
    projectId: string,
    containers: DockerContainerSummary[] | null = null
  ): Promise<DockerComposeAppSummary | null> {
    const app = getDockerComposeAppSummary(this.db, projectId);
    return app ? publicSummary(app, containers, this.appsRoot, this.hostAccessPolicy) : null;
  }

  async getApp(
    projectId: string,
    containers: DockerContainerSummary[] | null = null
  ): Promise<DockerComposeAppDetail | null> {
    const app = getDockerComposeApp(this.db, projectId);
    return app ? publicDetail(app, containers, this.appsRoot, this.hostAccessPolicy) : null;
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
        expectedRevision: current.revision,
        ...(input.hostAccess !== undefined ? { hostAccess: input.hostAccess } : {})
      }, current);
      return validateComposeDefinition(this.currentConfig(), this.db, {
        projectKey: current.projectKey,
        composeContent: normalized.composeContent,
        environment: normalized.resolvedEnvironment,
        hostAccess: normalized.hostAccess,
        revision: current.revision
      }, this.appsRoot, this.hostAccessPolicy);
    }
    const normalized = normalizeCreateInput({ ...input, name: "Validation" } as DockerComposeAppCreateInput);
    return validateComposeDefinition(this.currentConfig(), this.db, { ...normalized, revision: "validation" }, this.appsRoot, this.hostAccessPolicy);
  }

  async createApp(input: DockerComposeAppCreateInput): Promise<DockerComposeAppDetail> {
    return this.serialized(async () => {
      requireRequestObject(input);
      const normalized = normalizeCreateInput(input);
      const validation = await validateComposeDefinition(
        this.currentConfig(),
        this.db,
        { ...normalized, revision: "create" },
        this.appsRoot,
        this.hostAccessPolicy
      );
      const app = createDockerComposeApp(this.db, { ...normalized, ...validation });
      try {
        await materializeApp(app, this.appsRoot, this.hostAccessPolicy);
      } catch (error) {
        deleteDockerComposeApp(this.db, app.id, app.revision);
        await removeMaterializedApp(app, this.appsRoot).catch(() => undefined);
        throw materializationError(error);
      }
      return publicDetail(app, null, this.appsRoot, this.hostAccessPolicy);
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
        environment: normalized.resolvedEnvironment,
        hostAccess: normalized.hostAccess,
        revision: current.revision
      }, this.appsRoot, this.hostAccessPolicy);
      const updated = updateDockerComposeApp(this.db, projectId, input.expectedRevision, {
        name: normalized.name,
        composeContent: normalized.composeContent,
        environment: normalized.environment,
        ...validation
      });
      if (!updated) return null;
      try {
        await materializeApp(updated, this.appsRoot, this.hostAccessPolicy);
      } catch (error) {
        try {
          restoreDockerComposeApp(this.db, updated.revision, current);
          await materializeApp(current, this.appsRoot, this.hostAccessPolicy);
        } catch (rollbackError) {
          throw new DockerComposeMaterializationError(
            `${materializationError(error).message}; rollback failed: ${materializationError(rollbackError).message}`
          );
        }
        throw materializationError(error);
      }
      return publicDetail(updated, null, this.appsRoot, this.hostAccessPolicy);
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
          await materializeApp(app, this.appsRoot, this.hostAccessPolicy);
        } catch (rollbackError) {
          throw new DockerComposeMaterializationError(
            `Database deletion failed; runtime copy recovery failed: ${materializationError(rollbackError).message}`
          );
        }
        throw error;
      }
      if (result !== "deleted") {
        try {
          await materializeApp(app, this.appsRoot, this.hostAccessPolicy);
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
          await materializeApp(app, this.appsRoot, this.hostAccessPolicy);
          const manifests = this.hostAccessPolicy.resolveCompose({
            hostAccess: app.hostAccess,
            services: app.services,
            projectKey: app.projectKey,
            revision: app.revision
          }).manifests;
          await this.reconcileHostAccessControls(app, manifests);
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

  async prepareHostAccessDraft(
    projectId: string,
    engine: DockerEngineRuntime,
    registryCredentials: DockerRegistryCredentialRecord[] = []
  ): Promise<{
    draftId: string;
    draftRevision: string;
    hostAccess: NonNullable<DockerOperationProposal["hostAccess"]>;
  }> {
    return this.serialized(async () => {
      const app = getDockerComposeApp(this.db, projectId);
      if (!app) throw new DockerComposeValidationError("Compose App is no longer available");
      if (!engine.resolveImageId) {
        throw new DockerComposeHostAccessDraftError("Docker image identity resolution is unavailable", 503);
      }
      await materializeApp(app, this.appsRoot, this.hostAccessPolicy);
      const serviceImages = await resolveComposeServiceImages(this.currentConfig(), app, this.appsRoot);
      const imageDigests: Array<{ service: string; digest: string }> = [];
      for (const service of app.hostAccess.map((entry) => entry.service).sort()) {
        const image = serviceImages.get(service);
        if (!image) {
          throw new DockerComposeValidationError(`Host Access service ${service} has no resolved image`);
        }
        const credential = findDockerRegistryCredential(registryCredentials, image);
        await engine.pullImage({
          image,
          ...(credential ? { registryAuth: dockerRegistryAuthHeader(credential) } : {})
        });
        imageDigests.push({ service, digest: await engine.resolveImageId(image) });
      }
      const manifests = this.hostAccessPolicy.resolveCompose({
        hostAccess: app.hostAccess,
        services: app.services,
        projectKey: app.projectKey,
        revision: app.revision,
        imageDigests: Object.fromEntries(imageDigests.map((entry) => [entry.service, entry.digest]))
      }).manifests;
      const draft = createDockerComposeHostAccessDraft(this.db, {
        projectId: app.id,
        composeRevision: app.revision,
        policyVersion: this.hostAccessPolicy.catalog().policyVersion,
        imageDigests,
        fingerprints: manifests.map((manifest) => ({
          service: manifest.service!,
          fingerprint: manifest.fingerprint
        })),
        expiresAt: new Date(Date.now() + 15 * 60_000)
      });
      const catalog = new Map(this.hostAccessPolicy.catalog().capabilities.map((capability) => [capability.id, capability]));
      return {
        draftId: draft.id,
        draftRevision: draft.revision,
        hostAccess: {
          policyVersion: draft.policyVersion,
          added: grantDifference(app.hostAccess, app.deployedHostAccess).map((grant) => ({
            ...grant,
            risk: catalog.get(grant.capability)!.risk
          })),
          removed: grantDifference(app.deployedHostAccess, app.hostAccess).map((grant) => ({
            ...grant,
            risk: catalog.get(grant.capability)!.risk
          })),
          imageDigests
        }
      };
    });
  }

  async runProjectAction(
    proposal: DockerOperationProposal,
    registryCredentials: DockerRegistryCredentialRecord[] = [],
    engine?: DockerEngineRuntime,
    hostAccessDraftId?: string | null
  ): Promise<{ output: string }> {
    return this.serialized(async () => {
      if (!proposal.composeProjectId || !proposal.composeRevision) {
        throw new DockerComposeValidationError("Compose App operation is missing its revision");
      }
      const app = getDockerComposeApp(this.db, proposal.composeProjectId);
      if (!app) throw new DockerComposeValidationError("Compose App is no longer available");
      if (app.revision !== proposal.composeRevision) {
        throw new DockerComposeAppConflictError("Compose App changed before the operation was executed");
      }
      if (app.hostAccess.length && proposal.service && app.deployedRevision !== app.revision) {
        throw new DockerComposeValidationError("Host Access changes require applying the entire Compose project");
      }
      const hasHostAccessDraft = Boolean(proposal.hostAccess);
      const hostAccessDraft = hasHostAccessDraft && hostAccessDraftId
        ? getDockerComposeHostAccessDraft(this.db, hostAccessDraftId)
        : null;
      if (hasHostAccessDraft) {
        await this.validateHostAccessDraft(app, proposal, engine, hostAccessDraft);
      }
      await materializeApp(app, this.appsRoot, this.hostAccessPolicy, proposal.hostAccess?.imageDigests);
      const appDirectory = managedAppPath(this.appsRoot, app.projectKey);
      const dockerConfigDirectory = composeNeedsRegistryAuth(proposal)
        ? await createDockerConfig(registryCredentials)
        : null;
      try {
        const config = this.currentConfig();
        const output = await runCommand(
          config.composeCommand,
          composeCommandArgs(app, composeActionArgs(proposal, app.hostAccess.length > 0 || hasHostAccessDraft)),
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
        if (hostAccessDraft) deleteDockerComposeHostAccessDraft(this.db, hostAccessDraft.id);
      }
    });
  }

  private async validateHostAccessDraft(
    app: DockerComposeAppRecord,
    proposal: DockerOperationProposal,
    engine: DockerEngineRuntime | undefined,
    draft: DockerComposeHostAccessDraftRecord | null
  ): Promise<void> {
    if (!draft || !proposal.hostAccess || !engine?.resolveImageId) {
      throw new DockerComposeHostAccessDraftError("Compose Host Access draft is incomplete", 409);
    }
    if (
      draft.projectId !== app.id ||
      draft.composeRevision !== app.revision ||
      Date.parse(draft.expiresAt) <= Date.now()
    ) {
      throw new DockerComposeHostAccessDraftError("Compose Host Access draft expired or changed", 409);
    }
    const serviceImages = await resolveComposeServiceImages(this.currentConfig(), app, this.appsRoot);
    for (const expected of draft.imageDigests) {
      const image = serviceImages.get(expected.service);
      if (!image || await engine.resolveImageId(image) !== expected.digest) {
        throw new DockerComposeHostAccessDraftError("Compose image changed before the operation was executed", 409);
      }
    }
    let manifests: DockerHostAccessManifest[];
    try {
      manifests = this.hostAccessPolicy.resolveCompose({
        hostAccess: app.hostAccess,
        services: app.services,
        projectKey: app.projectKey,
        revision: app.revision,
        imageDigests: Object.fromEntries(draft.imageDigests.map((entry) => [entry.service, entry.digest]))
      }).manifests;
    } catch (error) {
      throw new DockerComposeHostAccessDraftError(hostAccessComposeError(error).message, 503);
    }
    const fingerprints = manifests.map((manifest) => ({ service: manifest.service!, fingerprint: manifest.fingerprint }));
    if (JSON.stringify(fingerprints) !== JSON.stringify(draft.fingerprints)) {
      throw new DockerComposeHostAccessDraftError("Compose Host Access resources changed before the operation was executed", 409);
    }
    await this.reconcileHostAccessControls(app, manifests);
  }

  private async reconcileHostAccessControls(
    app: DockerComposeAppRecord,
    manifests: DockerHostAccessManifest[]
  ): Promise<void> {
    for (const manifest of manifests) {
      const capabilities = manifest.grants
        .map((grant) => grant.capability)
        .filter((capability) => capability === "docker_metadata" || capability === "systemd_status");
      if (!capabilities.length) continue;
      if (!this.hostAccessControl) {
        throw new DockerComposeHostAccessDraftError("Docker Host Access proxy is unavailable", 503);
      }
      await this.hostAccessControl.reconcile({
        scopeId: app.projectKey,
        ...(manifest.service ? { service: manifest.service } : {}),
        capabilities
      });
    }
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
    environment: normalizeEnvironment(input.environment, true) as DockerComposeAppEnvironmentRecord[],
    hostAccess: input.hostAccess ?? []
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
    resolvedEnvironment,
    hostAccess: input.hostAccess ?? current.hostAccess
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
  db: CyberOsDatabase,
  input: {
    projectKey: string;
    composeContent: string;
    environment: DockerComposeAppEnvironmentRecord[];
    hostAccess: unknown;
    revision: string;
  },
  appsRoot: string,
  hostAccessPolicy: DockerHostAccessPolicy
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
    throw new DockerComposeValidationError("Compose include and top-level name are managed by CyberOS");
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
  const serviceNames = Object.keys(services);
  let rawHostAccess;
  try {
    rawHostAccess = hostAccessPolicy.resolveCompose({
      hostAccess: input.hostAccess,
      services: serviceNames,
      projectKey: input.projectKey,
      revision: input.revision,
      serviceDefinitions: serviceDefinitions(services),
      existingMountTargets: serviceMountTargets(services)
    });
  } catch (error) {
    throw hostAccessComposeError(error);
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "cyberos-compose-validate-"));
  try {
    await writeFile(path.join(tempDirectory, MANAGED_COMPOSE_FILE), input.composeContent, { mode: 0o600 });
    await writeFile(path.join(tempDirectory, MANAGED_ENV_FILE), renderEnvironment(input.environment), { mode: 0o600 });
    let output: string;
    try {
      output = await runCommand(
        config.composeCommand,
        composeCommandArgs({ projectKey: input.projectKey }, ["config", "--format", "json"], false),
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
    let resolvedHostAccess;
    try {
      resolvedHostAccess = hostAccessPolicy.resolveCompose({
        hostAccess: rawHostAccess.hostAccess,
        services: validatedServices,
        projectKey: input.projectKey,
        revision: input.revision,
        serviceDefinitions: serviceDefinitions(resolvedServices),
        existingMountTargets: serviceMountTargets(resolvedServices)
      });
    } catch (error) {
      throw hostAccessComposeError(error);
    }
    if (resolvedHostAccess.manifests.length) {
      await writeFile(
        path.join(tempDirectory, DOCKER_HOST_ACCESS_OVERRIDE_FILE),
        renderHostAccessOverride(resolvedHostAccess.manifests),
        { mode: 0o600 }
      );
      let finalOutput: string;
      try {
        finalOutput = await runCommand(
          config.composeCommand,
          composeCommandArgs({ projectKey: input.projectKey }, ["config", "--format", "json"], true),
          tempDirectory,
          config.operationTimeoutMs,
          composeProcessEnvironment(config, input.environment),
          { maxOutputBytes: MAX_COMPOSE_BYTES * 4, stdoutOnlyOnSuccess: true }
        );
      } catch (error) {
        throw new DockerComposeValidationError(
          redactEnvironmentSecrets(error, input.environment) || "Docker Compose Host Access validation failed"
        );
      }
      validateFinalHostAccessConfig(finalOutput, resolvedHostAccess.manifests);
    }
    const hostAccessRisk = resolvedHostAccess.manifests.some((manifest) => manifest.grants.some((grant) =>
      hostAccessPolicy.catalog().capabilities.find((capability) => capability.id === grant.capability)?.risk === "high"));
    return {
      services: Array.from(new Set(validatedServices)).sort(),
      warnings: Array.from(warnings),
      risk: warnings.size || hostAccessRisk ? "high" : "medium",
      hostAccess: resolvedHostAccess.hostAccess,
      hostAccessCoverage: resolvedHostAccess.coverage,
      issues: resolvedHostAccess.issues
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function validateServiceVolumes(
  db: CyberOsDatabase,
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
      throw new DockerComposeValidationError("Application data cannot be stored under /cyberos/apps");
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

async function resolveComposeServiceImages(
  config: DockerConfig,
  app: DockerComposeAppRecord,
  appsRoot: string
): Promise<Map<string, string>> {
  const output = await runCommand(
    config.composeCommand,
    composeCommandArgs(app, ["config", "--format", "json"], false),
    managedAppPath(appsRoot, app.projectKey),
    config.operationTimeoutMs,
    composeProcessEnvironment(config, app.environment),
    { maxOutputBytes: MAX_COMPOSE_BYTES * 4, stdoutOnlyOnSuccess: true }
  );
  let root: Record<string, unknown>;
  try {
    root = objectValue(JSON.parse(output) as unknown, "Resolved Compose document");
  } catch (error) {
    if (error instanceof DockerComposeValidationError) throw error;
    throw new DockerComposeValidationError("Docker Compose returned invalid image metadata");
  }
  const services = objectValue(root.services, "Resolved Compose services");
  return new Map(Object.entries(services).flatMap(([service, value]) => {
    const image = objectValue(value, `Resolved service ${service}`).image;
    return typeof image === "string" && image.trim() ? [[service, image]] : [];
  }));
}

function grantDifference(
  left: DockerComposeAppRecord["hostAccess"],
  right: DockerComposeAppRecord["hostAccess"]
): Array<Omit<NonNullable<DockerOperationProposal["hostAccess"]>["added"][number], "risk">> {
  const rightKeys = new Set(right.flatMap((entry) => entry.grants.map((grant) => grantKey(entry.service, grant))));
  return left.flatMap((entry) => entry.grants.flatMap((grant) => {
    if (rightKeys.has(grantKey(entry.service, grant))) return [];
    return [{
      service: entry.service,
      capability: grant.capability,
      ...(grant.capability === "nas_capacity" ? { rootId: grant.rootId } : {})
    }];
  })).sort((a, b) => `${a.service}:${a.capability}:${a.rootId ?? ""}`.localeCompare(`${b.service}:${b.capability}:${b.rootId ?? ""}`));
}

function grantKey(
  service: string,
  grant: DockerComposeAppRecord["hostAccess"][number]["grants"][number]
): string {
  return JSON.stringify([
    service,
    grant.capability,
    grant.capability === "nas_capacity" ? grant.rootId : null,
    grant.target ?? null
  ]);
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

async function materializeApp(
  app: DockerComposeAppRecord,
  appsRoot: string,
  hostAccessPolicy: DockerHostAccessPolicy,
  imageDigests: Array<{ service?: string; digest: string }> = []
): Promise<void> {
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
  let manifests: DockerHostAccessManifest[] = [];
  try {
    manifests = hostAccessPolicy.resolveCompose({
      hostAccess: app.hostAccess,
      services: app.services,
      projectKey: app.projectKey,
      revision: app.revision,
      imageDigests: Object.fromEntries(imageDigests.flatMap((entry) => entry.service ? [[entry.service, entry.digest]] : []))
    }).manifests;
  } catch (error) {
    throw new DockerComposeMaterializationError(hostAccessComposeError(error).message);
  }
  await atomicWrite(
    path.join(appDirectory, DOCKER_HOST_ACCESS_OVERRIDE_FILE),
    renderHostAccessOverride(manifests, imageDigests),
    0o640
  );
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
  appsRoot: string,
  hostAccessPolicy: DockerHostAccessPolicy
): DockerComposeAppSummary {
  const projectContainers = containers?.filter((container) => container.composeProject === app.projectKey) ?? null;
  const runningCount = projectContainers?.filter((container) => container.state === "running").length ?? null;
  const needsDeploy = app.deployedRevision !== app.revision;
  const hostAccessState = !app.hostAccess.length && !app.deployedHostAccess.length
    ? undefined
    : composeHostAccessState(app, projectContainers, hostAccessPolicy);
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
    needsDeploy,
    containerCount: projectContainers?.length ?? null,
    runningCount,
    status: projectStatus(projectContainers, app.deployedRevision !== null),
    ...(hostAccessState ? { hostAccessState } : {}),
    createdAt: app.createdAt,
    updatedAt: app.updatedAt
  };
}

function composeHostAccessState(
  app: DockerComposeAppSummaryRecord,
  projectContainers: DockerContainerSummary[] | null,
  policy: DockerHostAccessPolicy
): NonNullable<DockerComposeAppSummary["hostAccessState"]> {
  const needsDeploy = app.deployedRevision !== app.revision;
  if (!projectContainers) return needsDeploy ? "pending_apply" : "needs_repair";
  if (needsDeploy) {
    const deployedMatches = runtimeMatchesHostAccess(
      app,
      projectContainers,
      app.deployedHostAccess,
      app.deployedRevision,
      policy
    );
    return deployedMatches ? "pending_apply" : "needs_repair";
  }
  return runtimeMatchesHostAccess(app, projectContainers, app.hostAccess, app.revision, policy)
    ? "active"
    : "needs_repair";
}

function runtimeMatchesHostAccess(
  app: DockerComposeAppSummaryRecord,
  projectContainers: DockerContainerSummary[],
  hostAccess: DockerComposeAppSummaryRecord["hostAccess"],
  revision: string | null,
  policy: DockerHostAccessPolicy
): boolean {
  const runtimeContainers = projectContainers as Array<DockerContainerSummary & { labels?: Record<string, string> }>;
  const hasManagedLabels = (container: (typeof runtimeContainers)[number]) => (
    Object.keys(container.labels ?? {}).some((key) => key.startsWith(DOCKER_HOST_ACCESS_LABEL_PREFIX))
  );
  if (!hostAccess.length) return runtimeContainers.every((container) => !hasManagedLabels(container));
  if (!revision) return false;

  const imageDigests: Record<string, string> = {};
  for (const entry of hostAccess) {
    const containers = runtimeContainers.filter((container) => container.composeService === entry.service);
    const digests = new Set(containers.map((container) => container.imageId).filter((value): value is string => Boolean(value)));
    if (!containers.length || digests.size !== 1 || containers.some((container) => !container.labels)) return false;
    imageDigests[entry.service] = [...digests][0]!;
  }

  let manifests: DockerHostAccessManifest[];
  try {
    manifests = policy.resolveCompose({
      hostAccess,
      services: [...new Set([...app.services, ...hostAccess.map((entry) => entry.service)])],
      projectKey: app.projectKey,
      revision,
      imageDigests
    }).manifests;
  } catch {
    return false;
  }
  const expected = new Map(manifests.map((manifest) => [manifest.service!, manifest]));
  for (const [service, manifest] of expected) {
    if (!policy.runtimeDependenciesAvailable(manifest, app.projectKey)) return false;
    const containers = runtimeContainers.filter((container) => container.composeService === service);
    if (!containers.every((container) => Object.entries(manifest.labels).every(
      ([key, value]) => container.labels?.[key] === value
    ))) return false;
  }
  return runtimeContainers.every((container) => {
    if (!hasManagedLabels(container)) return true;
    const manifest = container.composeService ? expected.get(container.composeService) : undefined;
    if (!manifest) return false;
    return Object.entries(manifest.labels).every(
      ([key, value]) => container.labels?.[key] === value
    );
  });
}

function publicDetail(
  app: DockerComposeAppRecord,
  containers: DockerContainerSummary[] | null,
  appsRoot: string,
  hostAccessPolicy: DockerHostAccessPolicy
): DockerComposeAppDetail {
  const summary = publicSummary(app, containers, appsRoot, hostAccessPolicy);
  const grants = app.hostAccess.flatMap((entry) => entry.grants);
  return {
    ...summary,
    composeContent: app.composeContent,
    environment: app.environment.map((entry) => ({ key: entry.key, valueConfigured: true })),
    hostAccess: app.hostAccess,
    hostAccessCoverage: coverageReport(grants, hostAccessPolicy.catalog(), summary.hostAccessState === "active")
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

function composeActionArgs(proposal: DockerOperationProposal, hasHostAccess = false): string[] {
  const service = proposal.service ? [proposal.service] : [];
  switch (proposal.action) {
    case "compose_up": return ["up", "-d", ...(hasHostAccess ? ["--force-recreate"] : []), ...service];
    case "compose_down": return ["down"];
    case "compose_pull": return ["pull", ...service];
    case "compose_restart": return ["restart", ...service];
    default: throw new DockerComposeValidationError("Unsupported Compose action");
  }
}

function composeCommandArgs(app: { projectKey: string }, action: string[], includeHostAccess = true): string[] {
  return [
    "compose", "-p", app.projectKey, "--env-file", MANAGED_ENV_FILE,
    "-f", MANAGED_COMPOSE_FILE,
    ...(includeHostAccess ? ["-f", DOCKER_HOST_ACCESS_OVERRIDE_FILE] : []),
    ...action
  ];
}

function composeNeedsRegistryAuth(proposal: DockerOperationProposal): boolean {
  return proposal.action === "compose_pull" || proposal.action === "compose_up";
}

function serviceDefinitions(services: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(services).map(([name, value]) => [name, objectValue(value, `Service ${name}`)]));
}

function serviceMountTargets(services: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(services).map(([name, value]) => {
    const service = objectValue(value, `Service ${name}`);
    if (!Array.isArray(service.volumes)) return [name, []];
    return [name, service.volumes.flatMap((volume) => {
      if (typeof volume === "string") {
        const segments = volume.split(":");
        return segments.length >= 2 && segments[1]?.startsWith("/") ? [segments[1]] : [];
      }
      if (!volume || typeof volume !== "object" || Array.isArray(volume)) return [];
      const target = (volume as Record<string, unknown>).target;
      return typeof target === "string" && target.startsWith("/") ? [path.posix.normalize(target)] : [];
    })];
  }));
}

function renderHostAccessOverride(
  manifests: DockerHostAccessManifest[],
  imageDigests: Array<{ service?: string; digest: string }> = []
): string {
  const digests = new Map(imageDigests.flatMap((entry) => entry.service ? [[entry.service, entry.digest]] : []));
  const services = Object.fromEntries(manifests.map((manifest) => {
    const image = digests.get(manifest.service!);
    return [manifest.service!, {
      ...(image ? { image } : {}),
      volumes: manifest.mounts.map((mount) => ({
        type: "bind",
        source: mount.source,
        target: mount.target,
        read_only: true,
        bind: { create_host_path: false }
      })),
      environment: manifest.environment,
      cap_drop: manifest.capDrop,
      security_opt: manifest.securityOpt,
      labels: manifest.labels
    }];
  }));
  return stringify({ services }, { lineWidth: 0 });
}

function validateFinalHostAccessConfig(output: string, manifests: DockerHostAccessManifest[]): void {
  let root: Record<string, unknown>;
  try {
    root = objectValue(JSON.parse(output) as unknown, "Final Compose document");
  } catch (error) {
    if (error instanceof DockerComposeValidationError) throw error;
    throw new DockerComposeValidationError("Docker Compose returned an invalid final Host Access result");
  }
  const services = objectValue(root.services, "Final Compose services");
  for (const manifest of manifests) {
    const service = objectValue(services[manifest.service!], `Final service ${manifest.service}`);
    const capDrop = Array.isArray(service.cap_drop) ? service.cap_drop : [];
    const securityOpt = Array.isArray(service.security_opt) ? service.security_opt : [];
    if (!capDrop.includes("ALL") || !securityOpt.includes("no-new-privileges:true")) {
      throw new DockerComposeValidationError(`Final service ${manifest.service} does not preserve the Host Access security policy`);
    }
    const finalMounts = Array.isArray(service.volumes) ? service.volumes : [];
    if (manifest.mounts.some((mount) => !finalMounts.some((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const volume = candidate as Record<string, unknown>;
      return volume.type === "bind" &&
        volume.source === mount.source &&
        volume.target === mount.target &&
        volume.read_only === true;
    }))) {
      throw new DockerComposeValidationError(`Final service ${manifest.service} does not preserve managed Host Access mounts`);
    }
    const environment = objectValue(service.environment ?? {}, `Final service ${manifest.service} environment`);
    const labels = objectValue(service.labels ?? {}, `Final service ${manifest.service} labels`);
    if (
      Object.entries(manifest.environment).some(([key, value]) => environment[key] !== value) ||
      Object.entries(manifest.labels).some(([key, value]) => labels[key] !== value)
    ) {
      throw new DockerComposeValidationError(`Final service ${manifest.service} does not preserve managed Host Access metadata`);
    }
  }
}

function hostAccessComposeError(error: unknown): DockerComposeValidationError {
  if (error instanceof DockerHostAccessValidationError) {
    const unavailable = error.issues.some((issue) => (
      issue.code === "capability_unavailable" || issue.code === "root_unavailable"
    ));
    return new DockerComposeValidationError(error.message, error.issues, unavailable ? 503 : 400);
  }
  if (error instanceof DockerComposeValidationError) return error;
  return new DockerComposeValidationError("Docker Host Access configuration could not be resolved");
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberos-docker-config-"));
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
