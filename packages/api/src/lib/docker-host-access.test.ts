import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureNasRoots, openCyberOsDb, upsertRootReadiness, type CyberOsDatabase } from "@cyberos/db";
import type { DockerEngineRuntime } from "./docker-client.js";
import {
  DOCKER_HOST_ACCESS_POLICY_VERSION,
  DockerHostAccessPolicy,
  DockerHostAccessValidationError,
  reconcileRunningDockerHostAccess
} from "./docker-host-access.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-host-access-policy-"));
  const nasPath = path.join(tempDir, "nas");
  await mkdir(nasPath);
  await mkdir(path.join(nasPath, ".cyberos-host-access-capacity"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
  ensureNasRoots(db, [{ id: "primary", name: "Primary", path: nasPath }]);
  upsertRootReadiness(db, {
    rootId: "primary",
    status: "ready",
    reason: null,
    source: "/dev/sda1",
    uuid: "volume-uuid",
    fstype: "ext4"
  });
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("DockerHostAccessPolicy", () => {
  it("returns a fixed vendor-neutral catalog and keeps unverified proxies unavailable", () => {
    const catalog = new DockerHostAccessPolicy(db, {
      platform: "linux",
      runtimeRoot: path.join(tempDir, "runtime"),
      daemonAvailable: true
    }).catalog();

    expect(catalog.policyVersion).toMatch(/^2026-/u);
    expect(catalog.capabilities.map((capability) => capability.id)).toEqual([
      "host_os_identity",
      "host_processes",
      "host_sys",
      "nas_capacity",
      "account_map",
      "docker_metadata",
      "systemd_status"
    ]);
    expect(catalog.capabilities.find((capability) => capability.id === "docker_metadata")?.availability)
      .toEqual({ status: "unavailable", reasonCodes: ["docker_proxy_unverified"] });
    expect(catalog.nasRoots).toMatchObject([{ rootId: "primary", availability: { status: "available" } }]);
  });

  it("resolves only fixed host sources and produces a digest-bound deterministic fingerprint", () => {
    const policy = availablePolicy();
    const input = {
      grants: [
        { capability: "nas_capacity", rootId: "primary" },
        { capability: "host_os_identity" },
        { capability: "account_map" },
        { capability: "docker_metadata" }
      ],
      scopeId: "monitoring",
      revision: "revision-1",
      imageDigest: "sha256:image-1",
      service: "collector"
    };
    const first = policy.resolve(input);
    const second = policy.resolve(input);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(policy.resolve({ ...input, imageDigest: "sha256:image-2" }).fingerprint).not.toBe(first.fingerprint);
    expect(first.mounts.map((mount) => mount.source)).toEqual(expect.arrayContaining([
      "/etc/os-release",
      "/etc/localtime",
      "/etc/machine-id",
      "/etc/passwd",
      "/etc/group"
    ]));
    expect(first.mounts.some((mount) => mount.source.endsWith("/nas/.cyberos-host-access-capacity"))).toBe(true);
    expect(first.environment).toEqual({ DOCKER_HOST: "unix:///run/cyberos-host-access/docker.sock" });
    expect(first.capDrop).toEqual(["ALL"]);
    expect(first.securityOpt).toEqual(["no-new-privileges:true"]);
    expect(first.coverage.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ coverage: "docker_containers", state: "configured" }),
      expect.objectContaining({ coverage: "journald", state: "unsupported" }),
      expect.objectContaining({ coverage: "smart_nvme", state: "unsupported" })
    ]));
  });

  it("rejects target traversal, unavailable roots, managed mount collisions, and elevated Compose fields", () => {
    const policy = availablePolicy();
    expect(() => policy.resolve({
      grants: [{ capability: "host_processes", target: "/host/../proc" }],
      scopeId: "scope",
      revision: "revision",
      imageDigest: "sha256:image"
    })).toThrow(DockerHostAccessValidationError);
    expect(() => policy.resolve({
      grants: [{ capability: "nas_capacity", rootId: "missing" }],
      scopeId: "scope",
      revision: "revision",
      imageDigest: "sha256:image"
    })).toThrow(DockerHostAccessValidationError);
    expect(() => policy.resolve({
      grants: [{ capability: "host_processes" }],
      scopeId: "scope",
      revision: "revision",
      imageDigest: "sha256:image",
      existingMountTargets: ["/host"]
    })).toThrow(DockerHostAccessValidationError);
    expect(() => policy.resolve({
      grants: [{ capability: "host_sys" }],
      scopeId: "scope",
      revision: "revision",
      imageDigest: "sha256:image",
      service: "collector",
      serviceDefinition: { privileged: true, cap_add: ["SYS_ADMIN"] }
    })).toThrow(DockerHostAccessValidationError);
    expect(() => policy.resolve({
      grants: [
        { capability: "host_processes", target: "/host" },
        { capability: "host_sys", target: "/host/sys" }
      ],
      scopeId: "scope",
      revision: "revision",
      imageDigest: "sha256:image"
    })).toThrow(DockerHostAccessValidationError);
    expect(() => policy.resolve({
      grants: [{ capability: "host_sys" }],
      scopeId: "scope",
      revision: "revision",
      imageDigest: "sha256:image",
      service: "collector",
      serviceDefinition: { uts: "host" }
    })).toThrow(DockerHostAccessValidationError);
  });

  it("marks namespace-sensitive capabilities degraded or unavailable", () => {
    const rootless = new DockerHostAccessPolicy(db, { platform: "linux", rootless: true }).catalog();
    expect(rootless.capabilities.find((capability) => capability.id === "host_processes")?.availability)
      .toEqual({ status: "unavailable", reasonCodes: ["rootless_docker"] });
    const userns = new DockerHostAccessPolicy(db, { platform: "linux", userNamespace: true }).catalog();
    expect(userns.capabilities.find((capability) => capability.id === "host_sys")?.availability)
      .toEqual({ status: "degraded", reasonCodes: ["user_namespace_enabled"] });
    const detected = new DockerHostAccessPolicy(db, { platform: "linux" });
    detected.setRuntimeCompatibility({ rootless: true });
    expect(detected.catalog().capabilities.find((capability) => capability.id === "host_sys")?.availability)
      .toEqual({ status: "unavailable", reasonCodes: ["rootless_docker"] });
  });

  it("reconciles proxy sockets only from managed running-container labels", async () => {
    const summary = {
      id: "container-1",
      shortId: "container-1",
      name: "collector-1",
      image: "collector:latest",
      state: "running",
      status: "Up",
      ports: [],
      composeProject: "monitoring",
      composeService: "collector",
      cpuPercent: null,
      memoryUsageBytes: null,
      memoryLimitBytes: null,
      memoryPercent: null,
      createdAt: null
    } as const;
    const engine = {
      listContainers: async () => [summary, { ...summary, id: "container-2", name: "forged" }],
      getContainerDetails: async (id: string) => ({
        ...(id === "container-1" ? summary : { ...summary, id, name: "forged" }),
        command: null,
        entrypoint: [],
        environment: [],
        mounts: [],
        networks: [],
        restartPolicy: null,
        hostname: null,
        workingDir: null,
        labels: id === "container-1" ? {
          "io.cyberos.managed": "true",
          "io.cyberos.host-access.policy": DOCKER_HOST_ACCESS_POLICY_VERSION,
          "io.cyberos.host-access.fingerprint": "fingerprint",
          "io.cyberos.host-access.grants": "host_processes,docker_metadata"
        } : {
          "io.cyberos.managed": "true",
          "io.cyberos.host-access.grants": "docker_metadata"
        }
      })
    } as unknown as DockerEngineRuntime;
    const calls: unknown[] = [];

    const result = await reconcileRunningDockerHostAccess(engine, {
      reconcile: async (input) => { calls.push(input); }
    });

    expect(result).toEqual({ reconciled: 1, failures: [] });
    expect(calls).toEqual([{
      scopeId: "monitoring",
      service: "collector",
      capabilities: ["docker_metadata"]
    }]);
  });
});

function availablePolicy(): DockerHostAccessPolicy {
  return new DockerHostAccessPolicy(db, {
    platform: "linux",
    runtimeRoot: path.join(tempDir, "runtime"),
    daemonAvailable: true,
    dockerProxyCompatible: true,
    systemdProxyCompatible: true
  });
}
