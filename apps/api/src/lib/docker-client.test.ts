import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerRequestError, DockerSocketClient } from "./docker-client.js";

let tempDir: string;
let socketPath: string;
let server: http.Server;
let daemonApiVersion: string;
let daemonMinimumApiVersion: string;
let pullResponse: "success" | "error";
let imageInUse: boolean;
let resourceInfo: Record<string, unknown>;
const receivedRequests: Array<{ method: string; url: string; body: unknown; registryAuth?: string }> = [];

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-docker-client-"));
  socketPath = path.join(tempDir, "docker.sock");
  daemonApiVersion = "1.55";
  daemonMinimumApiVersion = "1.24";
  pullResponse = "success";
  imageInUse = false;
  resourceInfo = { MemoryLimit: false, SwapLimit: false, CpuCfsQuota: true, CpuCfsPeriod: true, CPUShares: true, CPUSet: true, PidsLimit: true };
  receivedRequests.length = 0;
  server = http.createServer(async (request, response) => {
    const url = request.url ?? "";
    if (url === "/version") {
      sendJson(response, {
        Version: "27.1.0",
        ApiVersion: daemonApiVersion,
        MinAPIVersion: daemonMinimumApiVersion,
        Os: "linux",
        Arch: "amd64"
      });
      return;
    }
    const negotiatedApiVersion = Number(daemonApiVersion.split(".")[1]) > 56 ? "1.56" : daemonApiVersion;
    if (url === `/v${negotiatedApiVersion}/info`) {
      sendJson(response, {
        ServerVersion: "27.1.0",
        OperatingSystem: "Debian",
        Architecture: "x86_64",
        DockerRootDir: "/var/lib/docker",
        ...resourceInfo
      });
      return;
    }
    if (url === "/v1.55/images/library%2Falpine%3Alatest/json") {
      sendJson(response, { Id: "sha256:alpine" });
      return;
    }
    if (url === "/v1.55/images/library%2Fmissing%3Alatest/json") {
      sendJson(response, { message: "No such image" }, 404);
      return;
    }
    if (url === "/v1.55/images/library%2Fbroken%3Alatest/json") {
      sendJson(response, { message: "daemon unavailable" }, 503);
      return;
    }
    if (url.startsWith("/v1.55/images/create?")) {
      receivedRequests.push({
        method: request.method ?? "",
        url,
        body: null,
        ...(typeof request.headers["x-registry-auth"] === "string"
          ? { registryAuth: request.headers["x-registry-auth"] }
          : {})
      });
      response.setHeader("Content-Type", "application/json");
      if (pullResponse === "error") {
        response.write('{"status":"Pulling fs layer"}\n{"errorDetail":{"message":"registry denied"');
        response.end('},"error":"registry denied"}\n');
        return;
      }
      response.write('{"status":"Pulling fs layer"}\n{"status":"Download');
      response.end(' complete"}\n');
      return;
    }
    if (url.startsWith("/v1.55/containers/create?")) {
      const body = await readJson(request);
      receivedRequests.push({ method: request.method ?? "", url, body });
      sendJson(response, { Id: "container-created", Warnings: ["host setting adjusted"] }, 201);
      return;
    }
    if (url === "/v1.55/volumes/create") {
      const body = await readJson(request);
      receivedRequests.push({ method: request.method ?? "", url, body });
      if ((body as { Name?: string }).Name === "conflict") {
        sendJson(response, { message: "volume already exists" }, 409);
        return;
      }
      sendJson(response, { Name: "archive", Labels: { role: "backup" } }, 201);
      return;
    }
    if (url === "/v1.55/networks/create") {
      const body = await readJson(request);
      receivedRequests.push({ method: request.method ?? "", url, body });
      sendJson(response, { Id: "network-created", Warning: "IPv6 is experimental" }, 201);
      return;
    }
    if (url === "/v1.55/containers/json?all=1") {
      sendJson(response, [
        {
          Id: "abcdef1234567890",
          Names: ["/media"],
          Image: "jellyfin:latest",
          ImageID: imageInUse ? "sha256:1111111111112222" : "sha256:jellyfin",
          State: "running",
          Status: "Up 2 minutes",
          Created: 1,
          Ports: [{ PrivatePort: 8096, PublicPort: 8096, Type: "tcp" }],
          Labels: {
            "com.docker.compose.project": "media",
            "com.docker.compose.service": "jellyfin"
          }
        }
      ]);
      return;
    }
    if (url === "/v1.55/containers/abcdef1234567890/stats?stream=false") {
      sendJson(response, {
        cpu_stats: {
          cpu_usage: { total_usage: 300 },
          system_cpu_usage: 2000,
          online_cpus: 2
        },
        precpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 1000
        },
        memory_stats: {
          usage: 1024,
          limit: 4096,
          stats: { cache: 128 }
        }
      });
      return;
    }
    if (url === "/v1.55/containers/abcdef1234567890/json") {
      sendJson(response, {
        Id: "abcdef1234567890",
        Names: ["/media"],
        Image: "jellyfin:latest",
        State: "running",
        Status: "Up 2 minutes",
        Created: 1,
        Ports: [{ PrivatePort: 8096, PublicPort: 8096, Type: "tcp" }],
        Labels: { "com.docker.compose.project": "media" },
        Config: {
          Cmd: ["/init"],
          Entrypoint: ["/sbin/tini"],
          Env: ["TZ=UTC"],
          Hostname: "media",
          WorkingDir: "/config",
          Labels: { "app.role": "media" }
        },
        HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
        Mounts: [{ Source: "/zos/data/primary/media", Destination: "/media", Mode: "rw", Type: "bind" }],
        NetworkSettings: { Networks: { bridge: {} } }
      });
      return;
    }
    if (url === "/v1.55/images/json?shared-size=true&containers=true") {
      sendJson(response, [
        {
          Id: "sha256:1111111111112222",
          RepoTags: ["alpine:latest", "<none>:<none>"],
          RepoDigests: ["alpine@sha256:abc"],
          Created: 1_700_000_000,
          Size: 7_000_000,
          SharedSize: 1024,
          Containers: 2
        },
        { Id: "sha256:2222222222223333", RepoTags: null, RepoDigests: null, Containers: -1 }
      ]);
      return;
    }
    if (url === "/v1.55/images/sha256%3A1111111111112222/json") {
      sendJson(response, { Architecture: "amd64" });
      return;
    }
    if (url === "/v1.55/images/sha256%3A2222222222223333/json") {
      sendJson(response, { message: "inspect unavailable" }, 503);
      return;
    }
    if (url === "/v1.55/images/alpine%3Alatest/json") {
      sendJson(response, { Id: "sha256:1111111111112222" });
      return;
    }
    if (url === "/v1.55/images/alpine%3Alatest?force=false&noprune=true" && request.method === "DELETE") {
      receivedRequests.push({ method: request.method, url, body: null });
      sendJson(response, [{ Untagged: "alpine:latest" }, { Deleted: "sha256:1111111111112222" }]);
      return;
    }
    if (url === "/v1.55/networks") {
      sendJson(response, [{ Id: "network-1", Name: "bridge", Driver: "bridge", Scope: "local", Containers: { "container-1": {} } }]);
      return;
    }
    if (url === "/v1.55/networks/network-1") {
      sendJson(response, {
        Id: "network-1",
        Name: "bridge",
        Created: "2026-09-17T12:00:00.000Z",
        Driver: "bridge",
        Scope: "local",
        EnableIPv4: true,
        EnableIPv6: false,
        Internal: false,
        Attachable: true,
        Ingress: false,
        IPAM: { Driver: "default", Config: [{ Subnet: "172.18.0.0/16", IPRange: "172.18.1.0/24", Gateway: "172.18.0.1", AuxAddress: { router: "172.18.0.2" } }] },
        Options: { "com.docker.network.bridge.name": "br-test" },
        Labels: { environment: "test" },
        Containers: {
          "container-1": { Name: "media", EndpointID: "endpoint-1", MacAddress: "02:42:ac:12:00:02", IPv4Address: "172.18.0.2/16", IPv6Address: "" }
        }
      });
      return;
    }
    if (url === "/v1.55/networks/minimal") {
      sendJson(response, {});
      return;
    }
    if (url === "/v1.55/networks/missing") {
      sendJson(response, { message: "network not found" }, 404);
      return;
    }
    if (url === "/v1.55/volumes") {
      sendJson(response, { Volumes: [
        { Name: "volume-1", Driver: "local", Scope: "local", Mountpoint: "/var/lib/docker/volumes/volume-1/_data" },
        { Name: "volume-2" },
        { Name: "volume-3" }
      ] });
      return;
    }
    if (url === "/v1.55/volumes/volume-1") {
      sendJson(response, {
        Name: "volume-1",
        CreatedAt: "2026-09-16T11:00:00.000Z",
        Driver: "local",
        Scope: "local",
        Mountpoint: "/var/lib/docker/volumes/volume-1/_data",
        Labels: { role: "media" },
        Options: { type: "none" },
        Status: { availability: "active" },
        UsageData: { Size: 4096, RefCount: 2 }
      });
      return;
    }
    if (url === "/v1.55/volumes/minimal") {
      sendJson(response, {});
      return;
    }
    if (url === "/v1.55/volumes/missing") {
      sendJson(response, { message: "volume not found" }, 404);
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: `Unhandled ${url}` }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tempDir, { recursive: true, force: true });
});

describe("DockerSocketClient", () => {
  it("maps Docker Engine socket responses into runtime summaries", async () => {
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });

    await expect(client.getInfo()).resolves.toMatchObject({
      version: "27.1.0",
      apiVersion: "1.55",
      negotiatedApiVersion: "1.55",
      operatingSystem: "Debian",
      dockerRootDir: "/var/lib/docker",
      resourceCapabilities: { memoryLimit: false, swapLimit: false, cpuQuota: true, cpuShares: true, cpuset: true, pidsLimit: true }
    });
    await expect(client.getCounts()).resolves.toEqual({
      images: 2,
      imageDetails: [
        {
          id: "sha256:1111111111112222",
          shortId: "111111111111",
          tags: ["alpine:latest"],
          digests: ["alpine@sha256:abc"],
          createdAt: "2023-11-14T22:13:20.000Z",
          sizeBytes: 7_000_000,
          sharedSizeBytes: 1024,
          architecture: "amd64",
          containerCount: 2
        },
        {
          id: "sha256:2222222222223333",
          shortId: "222222222222",
          tags: [],
          digests: [],
          createdAt: null,
          sizeBytes: 0,
          sharedSizeBytes: null,
          architecture: null,
          containerCount: null
        }
      ],
      networks: 1,
      volumes: 3,
      networkDetails: [{ id: "network-1", name: "bridge", driver: "bridge", scope: "local", containerCount: 1 }],
      volumeDetails: [
        { name: "volume-1", driver: "local", scope: "local", mountpoint: "/var/lib/docker/volumes/volume-1/_data" },
        { name: "volume-2", driver: "unknown", scope: "local", mountpoint: "" },
        { name: "volume-3", driver: "unknown", scope: "local", mountpoint: "" }
      ]
    });
    await expect(client.listContainers()).resolves.toMatchObject([
      {
        id: "abcdef1234567890",
        shortId: "abcdef123456",
        name: "media",
        image: "jellyfin:latest",
        imageId: "sha256:jellyfin",
        state: "running",
        ports: ["8096->8096/tcp"],
        composeProject: "media",
        composeService: "jellyfin",
        cpuPercent: 40,
        memoryUsageBytes: 896,
        memoryLimitBytes: 4096,
        memoryPercent: 21.875
      }
    ]);
    await expect(client.getContainerDetails("abcdef1234567890")).resolves.toMatchObject({
      command: "/init",
      entrypoint: ["/sbin/tini"],
      environment: ["TZ"],
      mounts: [{ source: "/zos/data/primary/media", destination: "/media", mode: "rw", type: "bind" }],
      networks: ["bridge"],
      restartPolicy: "unless-stopped",
      hostname: "media",
      workingDir: "/config",
      labels: { "app.role": "media" }
    });
    await expect(client.getNetworkDetails("network-1")).resolves.toEqual({
      id: "network-1",
      name: "bridge",
      createdAt: "2026-09-17T12:00:00.000Z",
      driver: "bridge",
      scope: "local",
      containerCount: 1,
      enableIPv4: true,
      enableIPv6: false,
      internal: false,
      attachable: true,
      ingress: false,
      ipam: {
        driver: "default",
        configs: [{
          subnet: "172.18.0.0/16",
          ipRange: "172.18.1.0/24",
          gateway: "172.18.0.1",
          auxiliaryAddresses: { router: "172.18.0.2" }
        }]
      },
      options: { "com.docker.network.bridge.name": "br-test" },
      labels: { environment: "test" },
      containers: [{
        id: "container-1",
        name: "media",
        endpointId: "endpoint-1",
        macAddress: "02:42:ac:12:00:02",
        ipv4Address: "172.18.0.2/16",
        ipv6Address: null
      }]
    });
    await expect(client.getVolumeDetails("volume-1")).resolves.toEqual({
      name: "volume-1",
      createdAt: "2026-09-16T11:00:00.000Z",
      driver: "local",
      scope: "local",
      mountpoint: "/var/lib/docker/volumes/volume-1/_data",
      labels: { role: "media" },
      options: { type: "none" },
      status: { availability: "active" },
      sizeBytes: 4096,
      referenceCount: 2
    });
  });

  it("normalizes missing inspect fields and preserves not-found responses", async () => {
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });

    await expect(client.getNetworkDetails("minimal")).resolves.toMatchObject({
      id: "minimal",
      name: "minimal",
      createdAt: null,
      enableIPv4: null,
      ipam: { driver: null, configs: [] },
      options: {},
      labels: {},
      containers: []
    });
    await expect(client.getVolumeDetails("minimal")).resolves.toEqual({
      name: "minimal",
      createdAt: null,
      driver: "unknown",
      scope: "local",
      mountpoint: "",
      labels: {},
      options: {},
      status: {},
      sizeBytes: null,
      referenceCount: null
    });
    await expect(client.getNetworkDetails("missing")).rejects.toMatchObject({ statusCode: 404 });
    await expect(client.getVolumeDetails("missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("caps negotiated API versions and rejects daemons whose minimum is too new", async () => {
    daemonApiVersion = "1.60";
    daemonMinimumApiVersion = "1.40";
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });

    await expect(client.getInfo()).resolves.toMatchObject({
      apiVersion: "1.60",
      negotiatedApiVersion: "1.56"
    });

    daemonMinimumApiVersion = "1.57";
    const incompatibleClient = new DockerSocketClient({ socketPath, timeoutMs: 1000 });
    await expect(incompatibleClient.getInfo()).rejects.toThrow(
      "Docker daemon requires API version 1.57, but ZOS supports up to 1.56"
    );
  });

  it("treats missing and malformed capability flags as unknown", async () => {
    resourceInfo = { MemoryLimit: "true", SwapLimit: 1, CPUShares: null, CPUSet: [], CpuCfsQuota: true };
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });
    await expect(client.getInfo()).resolves.toMatchObject({
      resourceCapabilities: { memoryLimit: null, swapLimit: null, cpuQuota: null, cpuShares: null, cpuset: null, pidsLimit: null }
    });
    resourceInfo.CpuCfsPeriod = false;
    await expect(client.getInfo()).resolves.toMatchObject({ resourceCapabilities: { cpuQuota: false } });
    resourceInfo = { MemoryLimit: true, SwapLimit: true, CpuCfsQuota: false, CpuCfsPeriod: true, CPUShares: false, CPUSet: false, PidsLimit: false };
    await expect(client.getInfo()).resolves.toMatchObject({
      resourceCapabilities: { memoryLimit: true, swapLimit: true, cpuQuota: false, cpuShares: false, cpuset: false, pidsLimit: false }
    });
  });

  it("maps complete normalized container input to the Engine create payload", async () => {
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });

    await expect(client.createContainer({
      name: "media server",
      image: "registry.local:5000/media/server:2.1",
      platform: "linux/amd64",
      hostname: "media",
      user: "1000:1000",
      workingDir: "/app",
      entrypoint: ["/usr/bin/tini", "--"],
      command: ["server", "--foreground"],
      environment: { TZ: "UTC", TOKEN: "secret" },
      labels: { role: "media" },
      tty: true,
      openStdin: true,
      init: true,
      stopSignal: "SIGTERM",
      stopTimeout: 20,
      nanoCpus: 2_000_000_000,
      cpuShares: 512,
      cpusetCpus: "0-1",
      memory: 2_147_483_648,
      memoryReservation: 1_073_741_824,
      memorySwap: 3_221_225_472,
      pidsLimit: 256,
      shmSize: 67_108_864,
      readOnlyRootfs: true,
      privileged: false,
      mounts: [
        { type: "bind", source: "/zos/data/primary/media", target: "/media", readOnly: true },
        { type: "volume", source: "config", target: "/config", readOnly: false, noCopy: true },
        { type: "tmpfs", target: "/tmp", readOnly: false, sizeBytes: 16_777_216, mode: 0o1777 }
      ],
      networkMode: "bridge",
      networkName: "media-net",
      networkAliases: ["server"],
      ipv4Address: "172.20.0.10",
      ipv6Address: "fd00::10",
      macAddress: "02:42:ac:14:00:0a",
      ports: [
        { containerPort: 8096, protocol: "tcp", hostIp: "127.0.0.1", hostPort: 18096 },
        { containerPort: 1900, protocol: "udp" }
      ],
      publishAllPorts: false,
      dns: ["1.1.1.1"],
      dnsSearch: ["lan"],
      extraHosts: ["host.docker.internal:host-gateway"],
      restartPolicy: "on-failure",
      restartMaximumRetryCount: 5,
      autoRemove: false
    })).resolves.toEqual({ id: "container-created", warnings: ["host setting adjusted"] });

    expect(receivedRequests).toEqual([{
      method: "POST",
      url: "/v1.55/containers/create?name=media+server&platform=linux%2Famd64",
      body: {
        Image: "registry.local:5000/media/server:2.1",
        Hostname: "media",
        User: "1000:1000",
        WorkingDir: "/app",
        Entrypoint: ["/usr/bin/tini", "--"],
        Cmd: ["server", "--foreground"],
        Env: ["TZ=UTC", "TOKEN=secret"],
        Labels: { role: "media" },
        Tty: true,
        OpenStdin: true,
        StopSignal: "SIGTERM",
        StopTimeout: 20,
        ExposedPorts: { "8096/tcp": {}, "1900/udp": {} },
        HostConfig: {
          Init: true,
          NanoCpus: 2_000_000_000,
          CpuShares: 512,
          CpusetCpus: "0-1",
          Memory: 2_147_483_648,
          MemoryReservation: 1_073_741_824,
          MemorySwap: 3_221_225_472,
          PidsLimit: 256,
          ShmSize: 67_108_864,
          ReadonlyRootfs: true,
          Privileged: false,
          Mounts: [
            { Type: "bind", Source: "/zos/data/primary/media", Target: "/media", ReadOnly: true },
            { Type: "volume", Source: "config", Target: "/config", ReadOnly: false, VolumeOptions: { NoCopy: true } },
            { Type: "tmpfs", Target: "/tmp", ReadOnly: false, TmpfsOptions: { SizeBytes: 16_777_216, Mode: 0o1777 } }
          ],
          NetworkMode: "media-net",
          PortBindings: {
            "8096/tcp": [{ HostIp: "127.0.0.1", HostPort: "18096" }]
          },
          PublishAllPorts: false,
          Dns: ["1.1.1.1"],
          DnsSearch: ["lan"],
          ExtraHosts: ["host.docker.internal:host-gateway"],
          RestartPolicy: { Name: "on-failure", MaximumRetryCount: 5 },
          AutoRemove: false
        },
        NetworkingConfig: {
          EndpointsConfig: {
            "media-net": {
              Aliases: ["server"],
              IPAMConfig: { IPv4Address: "172.20.0.10", IPv6Address: "fd00::10" },
              MacAddress: "02:42:ac:14:00:0a"
            }
          }
        }
      }
    }]);
  });

  it("omits empty port bindings from minimal container payloads", async () => {
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });

    await client.createContainer({ name: "minimal", image: "alpine:latest", ports: [] });

    expect(receivedRequests[0]?.body).toEqual({ Image: "alpine:latest", HostConfig: {} });
    expect(receivedRequests[0]?.body).not.toHaveProperty("HostConfig.PortBindings");
  });

  it("checks image existence while preserving non-404 errors", async () => {
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });

    await expect(client.imageExists("library/alpine:latest")).resolves.toBe(true);
    await expect(client.imageExists("library/missing:latest")).resolves.toBe(false);
    await expect(client.imageExists("library/broken:latest")).rejects.toMatchObject({
      name: "DockerRequestError",
      statusCode: 503,
      message: "daemon unavailable"
    });
  });

  it("splits pull tags, sends registry authentication, and surfaces NDJSON errors", async () => {
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });

    await client.pullImage({ image: "registry.local:5000/media/server:2.1", registryAuth: "encoded-auth" });
    await client.pullImage({ image: "registry.local:5000/media/server@sha256:abcdef" });
    expect(receivedRequests).toEqual([
      {
        method: "POST",
        url: "/v1.55/images/create?fromImage=registry.local%3A5000%2Fmedia%2Fserver&tag=2.1",
        body: null,
        registryAuth: "encoded-auth"
      },
      {
        method: "POST",
        url: "/v1.55/images/create?fromImage=registry.local%3A5000%2Fmedia%2Fserver%40sha256%3Aabcdef",
        body: null
      }
    ]);

    pullResponse = "error";
    await expect(client.pullImage({ image: "library/private:latest" })).rejects.toThrow("registry denied");
  });

  it("removes images without force or parent pruning", async () => {
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });

    await expect(client.removeImage("alpine:latest")).resolves.toEqual({
      reference: "alpine:latest",
      deleted: ["sha256:1111111111112222"],
      untagged: ["alpine:latest"]
    });
    expect(receivedRequests).toEqual([{
      method: "DELETE",
      url: "/v1.55/images/alpine%3Alatest?force=false&noprune=true",
      body: null
    }]);
  });

  it("rejects referenced image tags before sending a deletion request", async () => {
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });
    imageInUse = true;
    await expect(client.removeImage("alpine:latest")).rejects.toMatchObject({ statusCode: 409 });
    expect(receivedRequests).toEqual([]);
    await expect(client.removeImage("library/missing:latest")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("creates local volumes and configured networks and preserves Engine errors", async () => {
    const client = new DockerSocketClient({ socketPath, timeoutMs: 1000 });

    await expect(client.createVolume({ name: "archive", labels: { role: "backup" } })).resolves.toEqual({
      name: "archive",
      labels: { role: "backup" }
    });
    await expect(client.createNetwork({
      name: "storage-net",
      driver: "macvlan",
      options: { parent: "eth0", macvlan_mode: "bridge" },
      internal: true,
      enableIPv4: true,
      enableIPv6: true,
      ipam: {
        driver: "default",
        configs: [{
          subnet: "192.168.20.0/24",
          ipRange: "192.168.20.128/25",
          gateway: "192.168.20.1",
          auxiliaryAddresses: { router: "192.168.20.2" }
        }]
      },
      labels: { zone: "storage" }
    })).resolves.toEqual({ id: "network-created", warning: "IPv6 is experimental" });

    expect(receivedRequests).toEqual([
      {
        method: "POST",
        url: "/v1.55/volumes/create",
        body: { Name: "archive", Driver: "local", Labels: { role: "backup" } }
      },
      {
        method: "POST",
        url: "/v1.55/networks/create",
        body: {
          Name: "storage-net",
          Driver: "macvlan",
          Options: { parent: "eth0", macvlan_mode: "bridge" },
          Internal: true,
          EnableIPv4: true,
          EnableIPv6: true,
          IPAM: {
            Driver: "default",
            Config: [{
              Subnet: "192.168.20.0/24",
              IPRange: "192.168.20.128/25",
              Gateway: "192.168.20.1",
            AuxAddress: { router: "192.168.20.2" }
            }]
          },
          Labels: { zone: "storage" }
        }
      }
    ]);

    await expect(client.createVolume({ name: "conflict" })).rejects.toEqual(
      expect.objectContaining<Partial<DockerRequestError>>({ statusCode: 409, message: "volume already exists" })
    );
  });
});

function sendJson(response: http.ServerResponse, body: unknown, statusCode = 200): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
