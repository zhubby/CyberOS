import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createDockerComposeApp,
  ensureNasRoots,
  getDockerComposeApp,
  listDockerComposeApps,
  openZosDb,
  updateDockerComposeApp,
  upsertRootReadiness,
  type DockerRegistryCredentialRecord,
  type ZosDatabase
} from "@zos/db";
import type { DockerConfig, DockerContainerDetails } from "@zos/shared";
import { DockerComposeService } from "./docker-compose.js";
import type { DockerEngineRuntime } from "./docker-client.js";
import { DockerHostAccessPolicy } from "./docker-host-access.js";

let tempDir: string;
let appsRoot: string;
let nasRoot: string;
let dockerShim: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-docker-compose-"));
  appsRoot = path.join(tempDir, "apps");
  nasRoot = path.join(tempDir, "nas");
  dockerShim = path.join(tempDir, "docker");
  await mkdir(nasRoot, { recursive: true });
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "nas", name: "NAS", path: nasRoot }]);
  upsertRootReadiness(db, {
    rootId: "nas",
    status: "ready",
    reason: null,
    source: null,
    uuid: null,
    fstype: null
  });
  vi.stubEnv("ZOS_TEST_COMPOSE_OUTCOME", "success");
  await writeDockerShim();
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("DockerComposeService", () => {
  it("stores an App and materializes protected Compose and environment files", async () => {
    const service = composeService();
    await mkdir(appsRoot, { recursive: true });
    await chmod(appsRoot, 0o777);
    const app = await service.createApp({
      name: "Postgres",
      projectKey: "postgres",
      composeContent: "services:\n  db:\n    image: postgres:18\n",
      environment: [
        { key: "POSTGRES_PASSWORD", value: "postgres" },
        { key: "MULTILINE", value: "line 1\n\"quoted\"\\tail" },
        { key: "DOLLAR", value: "$TOKEN-${OTHER}" }
      ]
    });
    expect((await stat(appsRoot)).mode & 0o777).toBe(0o750);

    expect(app).toMatchObject({
      name: "Postgres",
      projectKey: "postgres",
      services: ["app"],
      environment: [
        { key: "DOLLAR", valueConfigured: true },
        { key: "MULTILINE", valueConfigured: true },
        { key: "POSTGRES_PASSWORD", valueConfigured: true }
      ],
      needsDeploy: true
    });
    expect(JSON.stringify(app)).not.toContain('"value":"postgres"');
    const appPath = path.join(appsRoot, "postgres");
    expect((await stat(appPath)).mode & 0o777).toBe(0o750);
    expect((await stat(path.join(appPath, "compose.yaml"))).mode & 0o777).toBe(0o640);
    expect((await stat(path.join(appPath, ".env"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(appPath, ".env"), "utf8")).toBe(
      'DOLLAR="$$TOKEN-$${OTHER}"\n' +
      `MULTILINE=${JSON.stringify("line 1\n\"quoted\"\\tail")}\nPOSTGRES_PASSWORD="postgres"\n`
    );
  });

  it("rejects unsupported local files, relative mounts, reserved variables, and unsafe App directories", async () => {
    const service = composeService();
    await expect(service.validateApp({
      projectKey: "bad",
      composeContent: "services:\n  app:\n    image: alpine\n    env_file: .env.local\n",
      environment: []
    })).rejects.toThrow(/unsupported local files/);
    await expect(service.validateApp({
      projectKey: "bad",
      composeContent: "services:\n  app:\n    image: alpine\n    volumes:\n      - ./data:/data\n",
      environment: []
    })).rejects.toThrow(/relative bind mount/);
    await expect(service.validateApp({
      projectKey: "bad",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: [{ key: "COMPOSE_FILE", value: "elsewhere.yaml" }]
    })).rejects.toThrow(/not allowed/);
    const aliases = Array.from({ length: 60 }, (_, index) => `  app${index}: *app`).join("\n");
    await expect(service.validateApp({
      projectKey: "alias-limit",
      composeContent: `x-app: &app { image: alpine }\nservices:\n${aliases}\n`,
      environment: []
    })).rejects.toThrow(/could not be parsed safely/);

    await mkdir(appsRoot, { recursive: true });
    await symlink(nasRoot, path.join(appsRoot, "unsafe"));
    await expect(service.createApp({
      name: "Unsafe",
      projectKey: "unsafe",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: []
    })).rejects.toThrow(/not a directory/);
    expect(listDockerComposeApps(db).some((app) => app.projectKey === "unsafe")).toBe(false);
  });

  it("classifies NAS bind mounts as high risk and rejects paths outside configured roots", async () => {
    const service = composeService();
    const dataPath = path.join(nasRoot, "postgres");
    await mkdir(dataPath);
    const validation = await service.validateApp({
      projectKey: "postgres",
      composeContent: `services:\n  app:\n    image: postgres:18\n    volumes:\n      - ${dataPath}:/var/lib/postgresql/data\n`,
      environment: []
    });
    expect(validation).toMatchObject({ risk: "high", warnings: [expect.stringContaining("NAS bind mount")] });

    vi.stubEnv("ZOS_TEST_COMPOSE_OUTCOME", "resolved-safe-bind");
    await expect(service.validateApp({
      projectKey: "interpolated-safe",
      composeContent: "services:\n  app:\n    image: alpine\n    volumes:\n      - ${HOST_PATH}/data:/data\n",
      environment: [{ key: "HOST_PATH", value: nasRoot }]
    })).resolves.toMatchObject({ risk: "high", warnings: [expect.stringContaining("NAS bind mount")] });
    vi.stubEnv("ZOS_TEST_COMPOSE_OUTCOME", "success");

    await expect(service.validateApp({
      projectKey: "outside",
      composeContent: "services:\n  app:\n    image: alpine\n    volumes:\n      - /etc:/host-etc\n",
      environment: []
    })).rejects.toThrow(/outside a ready NAS root/);

    const outsidePath = path.join(tempDir, "outside");
    await mkdir(outsidePath);
    await symlink(outsidePath, path.join(nasRoot, "escape"));
    await expect(service.validateApp({
      projectKey: "symlink-escape",
      composeContent: `services:\n  app:\n    image: alpine\n    volumes:\n      - ${path.join(nasRoot, "escape", "missing")}:/data\n`,
      environment: []
    })).rejects.toThrow(/outside a ready NAS root/);

    await expect(service.validateApp({
      projectKey: "driver-options",
      composeContent: "services:\n  app:\n    image: alpine\n    volumes:\n      - data:/data\nvolumes:\n  data:\n    driver_opts:\n      type: none\n      device: /etc\n      o: bind\n",
      environment: []
    })).rejects.toThrow(/unsupported driver options/);

    vi.stubEnv("ZOS_TEST_COMPOSE_OUTCOME", "resolved-escape");
    await expect(service.validateApp({
      projectKey: "interpolated-escape",
      composeContent: "services:\n  app:\n    image: alpine\n    volumes:\n      - ${HOST_PATH}:/data\n",
      environment: [{ key: "HOST_PATH", value: "/etc" }]
    })).rejects.toThrow(/outside a ready NAS root/);

    vi.stubEnv("ZOS_TEST_COMPOSE_OUTCOME", "resolved-elevated");
    await expect(service.validateApp({
      projectKey: "interpolated-risk",
      composeContent: "services:\n  app:\n    image: alpine\n    privileged: ${PRIVILEGED}\n",
      environment: [{ key: "PRIVILEGED", value: "true" }]
    })).resolves.toMatchObject({
      risk: "high",
      warnings: [expect.stringContaining("elevated host access")]
    });
  });

  it("pins approvals to an App revision and injects short-lived Registry credentials", async () => {
    const service = composeService();
    const created = await service.createApp({
      name: "Media",
      projectKey: "media",
      composeContent: "services:\n  app:\n    image: registry.example.com/media/app\n",
      environment: [{ key: "APP_TOKEN", value: "app-secret" }]
    });
    vi.stubEnv("DOCKER_CONTEXT", "unmanaged-context");
    vi.stubEnv("COMPOSE_FILE", "/tmp/unmanaged-compose.yaml");
    const result = await service.runProjectAction({
      action: "compose_up",
      targetType: "compose_project",
      composeProjectId: created.id,
      composeProjectName: created.name,
      composeRevision: created.revision,
      risk: "medium",
      summary: "Deploy Media"
    }, credentials());
    const output = JSON.parse(result.output.trim()) as {
      directory: string;
      args: string[];
      env: string;
      processEnv: string | null;
      dockerHost: string;
      dockerContext: string | null;
      composeFile: string | null;
    };
    expect(output.args).toEqual(expect.arrayContaining(["-p", "media", "--env-file", ".env", "-f", "compose.yaml", "up", "-d"]));
    expect(output.env).not.toContain("app-secret");
    expect(output.processEnv).toBeNull();
    expect(output.dockerHost).toBe(`unix://${dockerConfig().socketPath}`);
    expect(output.dockerContext).toBeNull();
    expect(output.composeFile).toBeNull();
    await expect(access(output.directory)).rejects.toThrow();
    expect(getDockerComposeApp(db, created.id)?.deployedRevision).toBe(created.revision);
    expect((await service.getProject(created.id, []))?.status).toBe("stopped");

    const updated = await service.updateApp(created.id, {
      name: created.name,
      composeContent: created.composeContent,
      environment: [{ key: "APP_TOKEN" }],
      expectedRevision: created.revision
    });
    await expect(service.runProjectAction({
      action: "compose_up",
      targetType: "compose_project",
      composeProjectId: created.id,
      composeRevision: created.revision,
      risk: "medium",
      summary: "Deploy stale Media"
    })).rejects.toThrow(/changed before the operation/);
    expect(updated?.needsDeploy).toBe(true);
  });

  it("materializes Host Access last and forces a full project recreation", async () => {
    vi.stubEnv("ZOS_TEST_COMPOSE_OUTCOME", "host-access");
    const policy = new DockerHostAccessPolicy(db, { platform: "linux" });
    vi.stubEnv("ZOS_TEST_HOST_ACCESS_LABELS", JSON.stringify(policy.resolveCompose({
      hostAccess: [{
        service: "collector",
        grants: [{ capability: "host_processes" }, { capability: "host_sys" }]
      }],
      services: ["collector"],
      projectKey: "collector",
      revision: "create"
    }).manifests[0]?.labels ?? {}));
    const service = new DockerComposeService(dockerConfig(), db, appsRoot, policy);
    const created = await service.createApp({
      name: "Collector",
      projectKey: "collector",
      composeContent: "services:\n  collector:\n    image: collector:latest\n",
      environment: [],
      hostAccess: [{
        service: "collector",
        grants: [{ capability: "host_processes" }, { capability: "host_sys" }]
      }]
    });

    expect(created).toMatchObject({
      risk: "high",
      hostAccessState: "pending_apply",
      hostAccess: [{ service: "collector" }]
    });
    const override = await readFile(path.join(appsRoot, "collector", "zos-host-access.override.yaml"), "utf8");
    expect(override).toContain("/proc");
    expect(override).toContain("/host/proc");
    expect(override).toContain("cap_drop");
    expect(override).toContain("no-new-privileges:true");

    const engine = {
      pullImage: vi.fn(async () => undefined),
      resolveImageId: vi.fn(async () => "sha256:collector")
    } as unknown as DockerEngineRuntime;
    const draft = await service.prepareHostAccessDraft(created.id, engine);
    const proposal = {
      action: "compose_up",
      targetType: "compose_project",
      composeProjectId: created.id,
      composeRevision: created.revision,
      hostAccess: draft.hostAccess,
      risk: "high",
      summary: "Deploy Collector"
    } as const;
    const result = await service.runProjectAction(proposal, [], engine, draft.draftId);
    const output = JSON.parse(result.output.trim()) as { args: string[] };
    expect(output.args).toEqual(expect.arrayContaining([
      "-f",
      "compose.yaml",
      "-f",
      "zos-host-access.override.yaml",
      "up",
      "-d",
      "--force-recreate"
    ]));
    const appliedOverride = parse(
      await readFile(path.join(appsRoot, "collector", "zos-host-access.override.yaml"), "utf8")
    ) as { services: { collector: { image: string; labels: Record<string, string> } } };
    expect(appliedOverride.services.collector.image).toBe("sha256:collector");
    expect(getDockerComposeApp(db, created.id)?.deployedHostAccess).toEqual([
      expect.objectContaining({ service: "collector" })
    ]);

    const runtimeContainer: DockerContainerDetails = {
      id: "container-1",
      shortId: "container-1",
      name: "collector-1",
      image: "collector:latest",
      imageId: "sha256:collector",
      state: "running",
      status: "running",
      ports: [],
      composeProject: "collector",
      composeService: "collector",
      cpuPercent: null,
      memoryUsageBytes: null,
      memoryLimitBytes: null,
      memoryPercent: null,
      createdAt: null,
      command: null,
      entrypoint: [],
      environment: [],
      mounts: [],
      networks: [],
      restartPolicy: null,
      hostname: null,
      workingDir: null,
      labels: appliedOverride.services.collector.labels
    };
    expect(await service.getApp(created.id, [runtimeContainer])).toMatchObject({ hostAccessState: "active" });

    const deployed = getDockerComposeApp(db, created.id)!;
    const updated = updateDockerComposeApp(db, created.id, deployed.revision, {
      name: deployed.name,
      composeContent: deployed.composeContent,
      environment: [],
      services: deployed.services,
      warnings: deployed.warnings,
      risk: deployed.risk,
      hostAccess: deployed.hostAccess
    });
    expect(await service.getApp(created.id, [runtimeContainer])).toMatchObject({ hostAccessState: "pending_apply" });
    const driftedContainer: DockerContainerDetails = {
      ...runtimeContainer,
      labels: {
        ...runtimeContainer.labels,
        "io.zos.host-access.fingerprint": "drifted"
      }
    };
    expect(await service.getApp(created.id, [driftedContainer])).toMatchObject({ hostAccessState: "needs_repair" });
    expect(updated?.revision).not.toBe(deployed.revision);
  });

  it("rejects conflicting raw Compose privileges for a granted service", async () => {
    const service = new DockerComposeService(
      dockerConfig(),
      db,
      appsRoot,
      new DockerHostAccessPolicy(db, { platform: "linux" })
    );
    await expect(service.validateApp({
      projectKey: "unsafe-access",
      composeContent: "services:\n  collector:\n    image: alpine\n    privileged: true\n",
      environment: [],
      hostAccess: [{ service: "collector", grants: [{ capability: "host_processes" }] }]
    })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "conflicting_compose_field", field: "privileged" })]
    });
  });

  it("classifies unavailable Host Access dependencies as service unavailable", async () => {
    const service = new DockerComposeService(
      dockerConfig(),
      db,
      appsRoot,
      new DockerHostAccessPolicy(db, { platform: "darwin" })
    );
    await expect(service.validateApp({
      projectKey: "unavailable-access",
      composeContent: "services:\n  collector:\n    image: alpine\n",
      environment: [],
      hostAccess: [{ service: "collector", grants: [{ capability: "host_processes" }] }]
    })).rejects.toMatchObject({ statusCode: 503 });
  });

  it("restores the database revision when publishing an update fails", async () => {
    const service = composeService();
    const created = await service.createApp({
      name: "Stable",
      projectKey: "stable",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: [{ key: "TOKEN", value: "secret" }]
    });
    await writeFile(path.join(appsRoot, "stable", ".zos-app.json"), '{"id":"other"}\n');

    await expect(service.updateApp(created.id, {
      name: "Changed",
      composeContent: "services:\n  app:\n    image: alpine:3\n",
      environment: [{ key: "TOKEN" }],
      expectedRevision: created.revision
    })).rejects.toThrow(/rollback failed/);
    expect(getDockerComposeApp(db, created.id)).toMatchObject({
      name: "Stable",
      revision: created.revision,
      composeContent: created.composeContent,
      environment: [{ key: "TOKEN", value: "secret" }]
    });
  });

  it("serializes concurrent updates and rejects the stale revision", async () => {
    const service = composeService();
    const created = await service.createApp({
      name: "Concurrent",
      projectKey: "concurrent",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: []
    });
    const results = await Promise.allSettled([
      service.updateApp(created.id, {
        name: "First",
        composeContent: created.composeContent,
        environment: [],
        expectedRevision: created.revision
      }),
      service.updateApp(created.id, {
        name: "Second",
        composeContent: created.composeContent,
        environment: [],
        expectedRevision: created.revision
      })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("continues startup reconciliation after one managed App directory is unsafe", async () => {
    const service = composeService();
    const unsafe = createDockerComposeApp(db, {
      name: "A unsafe",
      projectKey: "unsafe-reconcile",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: [],
      services: ["app"],
      warnings: [],
      risk: "medium"
    });
    const safe = createDockerComposeApp(db, {
      name: "B safe",
      projectKey: "safe-reconcile",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: [],
      services: ["app"],
      warnings: [],
      risk: "medium"
    });
    await mkdir(path.join(appsRoot, unsafe.projectKey), { recursive: true });

    await expect(service.reconcileAll()).rejects.toThrow(/Failed to reconcile 1 managed App/);
    await expect(access(path.join(appsRoot, safe.projectKey, "compose.yaml"))).resolves.toBeUndefined();
  });

  it("keeps the database record when a managed App directory cannot be safely deleted", async () => {
    const service = composeService();
    const created = await service.createApp({
      name: "Protected",
      projectKey: "protected",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: []
    });
    await writeFile(path.join(appsRoot, "protected", ".zos-app.json"), '{"id":"other"}\n');

    await expect(service.deleteApp(created.id, {
      expectedRevision: created.revision,
      confirmed: true
    })).rejects.toThrow(/ownership cannot be verified/);
    expect(getDockerComposeApp(db, created.id)?.revision).toBe(created.revision);
  });

  it("checks container occupancy inside the serialized Compose operation", async () => {
    const service = composeService();
    const created = await service.createApp({
      name: "Occupied",
      projectKey: "occupied",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: []
    });
    const isProjectInUse = vi.fn(async (projectKey: string) => projectKey === "occupied");

    await expect(service.deleteApp(created.id, {
      expectedRevision: created.revision,
      confirmed: true
    }, isProjectInUse)).resolves.toBe("in_use");
    expect(isProjectInUse).toHaveBeenCalledWith("occupied");
    expect(getDockerComposeApp(db, created.id)?.revision).toBe(created.revision);
    await expect(access(path.join(appsRoot, "occupied", "compose.yaml"))).resolves.toBeUndefined();
  });

  it("redacts short and overlapping environment secrets from Compose validation errors", async () => {
    const service = composeService();
    vi.stubEnv("ZOS_TEST_COMPOSE_OUTCOME", "validation-error");
    await expect(service.validateApp({
      projectKey: "redacted",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: [
        { key: "SHORT_TOKEN", value: "pass" },
        { key: "LONG_TOKEN", value: "password" },
        { key: "MULTILINE_TOKEN", value: "line 1\nsecret" }
      ]
    })).rejects.not.toThrow(/line 1|pass|word|secret/);
  });

  it("reports a missing Docker Compose plugin as unavailable", async () => {
    const service = composeService();
    vi.stubEnv("ZOS_TEST_COMPOSE_OUTCOME", "plugin-missing");
    await expect(service.validateApp({
      projectKey: "missing-plugin",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: []
    })).rejects.toMatchObject({ name: "DockerComposeUnavailableError" });
  });

  it("fails timed-out Compose commands and cleans temporary authentication", async () => {
    const config = dockerConfig();
    const service = new DockerComposeService(() => config, db, appsRoot);
    const created = await service.createApp({
      name: "Slow",
      projectKey: "slow",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: []
    });
    const capturedConfigDirectory = path.join(tempDir, "captured-config-directory");
    await writeFile(dockerShim, `#!/bin/sh
printf '%s' "$DOCKER_CONFIG" > '${capturedConfigDirectory}'
trap 'exit 0' TERM
while :; do sleep 1; done
`);
    await chmod(dockerShim, 0o755);
    config.operationTimeoutMs = 2_000;
    await expect(service.runProjectAction({
      action: "compose_pull",
      targetType: "compose_project",
      composeProjectId: created.id,
      composeRevision: created.revision,
      risk: "medium",
      summary: "Pull Slow"
    }, credentials())).rejects.toThrow(/timed out/);
    const directory = await readFile(capturedConfigDirectory, "utf8");
    await expect(access(directory)).rejects.toThrow();
  });
});

function composeService(operationTimeoutMs = 5_000) {
  return new DockerComposeService({ ...dockerConfig(), operationTimeoutMs }, db, appsRoot);
}

async function writeDockerShim() {
  await writeFile(dockerShim, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("config")) {
  if (process.env.ZOS_TEST_COMPOSE_OUTCOME === "validation-error") {
    process.stderr.write("invalid " + fs.readFileSync(path.join(process.cwd(), ".env"), "utf8"));
    process.exit(1);
  }
  if (process.env.ZOS_TEST_COMPOSE_OUTCOME === "plugin-missing") {
    process.stderr.write("docker: 'compose' is not a docker command.\\n");
    process.exit(1);
  }
  if (process.env.ZOS_TEST_COMPOSE_OUTCOME === "resolved-escape") {
    console.log(JSON.stringify({ services: { app: { volumes: [{ type: "bind", source: "/etc", target: "/data" }] } } }));
    process.exit(0);
  }
  if (process.env.ZOS_TEST_COMPOSE_OUTCOME === "resolved-elevated") {
    console.log(JSON.stringify({ services: { app: { image: "alpine", privileged: true } } }));
    process.exit(0);
  }
  if (process.env.ZOS_TEST_COMPOSE_OUTCOME === "resolved-safe-bind") {
    console.log(JSON.stringify({ services: { app: { image: "alpine", volumes: [{
      type: "bind",
      source: path.join(${JSON.stringify(nasRoot)}, "data"),
      target: "/data"
    }] } } }));
    process.exit(0);
  }
  if (process.env.ZOS_TEST_COMPOSE_OUTCOME === "host-access") {
    const final = args.filter((arg) => arg === "-f").length > 1;
    console.log(JSON.stringify({ services: { collector: {
      image: "collector:latest",
      ...(final ? {
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        labels: JSON.parse(process.env.ZOS_TEST_HOST_ACCESS_LABELS || "{}"),
        volumes: [
          { type: "bind", source: "/proc", target: "/host/proc", read_only: true },
          { type: "bind", source: "/sys", target: "/host/sys", read_only: true }
        ]
      } : {})
    } } }));
    process.exit(0);
  }
  console.log(JSON.stringify({ services: { app: { image: "alpine" } } }));
  process.exit(0);
}
const directory = process.env.DOCKER_CONFIG || "";
fs.writeFileSync(${JSON.stringify(path.join(tempDir, "captured-config-directory"))}, directory);
if (process.env.ZOS_TEST_COMPOSE_OUTCOME === "timeout") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  const env = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  console.log(JSON.stringify({
    directory,
    args,
    env,
    processEnv: process.env.APP_TOKEN || null,
    dockerHost: process.env.DOCKER_HOST,
    dockerContext: process.env.DOCKER_CONTEXT || null,
    composeFile: process.env.COMPOSE_FILE || null
  }));
}
`);
  await chmod(dockerShim, 0o755);
}

function credentials(): DockerRegistryCredentialRecord[] {
  return [{
    id: "registry-1",
    name: "Private",
    serverAddress: "registry.example.com",
    username: "builder",
    password: "registry-secret",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z"
  }];
}

function dockerConfig(): DockerConfig {
  return {
    enabled: true,
    socketPath: "/var/run/docker.sock",
    composeCommand: dockerShim,
    operationTimeoutMs: 5_000,
    consoleShells: ["/bin/sh", "/bin/bash"]
  };
}
