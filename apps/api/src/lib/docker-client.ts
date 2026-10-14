import http from "node:http";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { URLSearchParams } from "node:url";
import type {
  DockerContainerDetails,
  DockerContainerState,
  DockerContainerSummary,
  DockerImageRemoveResult,
  DockerImageSummary,
  DockerNetworkDetails,
  DockerNetworkSummary,
  DockerResourceCapabilities,
  DockerVolumeDetails,
  DockerVolumeSummary
} from "@zos/shared";

export interface DockerEngineInfo {
  version: string | null;
  apiVersion: string | null;
  negotiatedApiVersion: string | null;
  operatingSystem: string | null;
  architecture: string | null;
  dockerRootDir: string | null;
  resourceCapabilities?: DockerResourceCapabilities;
}

export interface DockerEngineCounts {
  images: number;
  imageDetails?: DockerImageSummary[];
  networks: number;
  volumes: number;
  networkDetails?: DockerNetworkSummary[];
  volumeDetails?: DockerVolumeSummary[];
}

export interface DockerContainerStats {
  cpuPercent: number | null;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
}

export interface DockerExecStream {
  socket: net.Socket;
}

export type DockerPortProtocol = "tcp" | "udp" | "sctp";

export type DockerContainerMount =
  | {
      type: "bind";
      source: string;
      target: string;
      readOnly: boolean;
    }
  | {
      type: "volume";
      source: string;
      target: string;
      readOnly: boolean;
      noCopy: boolean;
    }
  | {
      type: "tmpfs";
      target: string;
      readOnly: boolean;
      sizeBytes?: number;
      mode?: number;
    };

export interface DockerContainerPort {
  containerPort: number;
  protocol: DockerPortProtocol;
  hostIp?: string;
  hostPort?: number;
}

export interface DockerCreateContainerInput {
  name: string;
  image: string;
  platform?: string;
  hostname?: string;
  user?: string;
  workingDir?: string;
  entrypoint?: string[];
  command?: string[];
  environment?: Record<string, string>;
  labels?: Record<string, string>;
  tty?: boolean;
  openStdin?: boolean;
  init?: boolean;
  stopSignal?: string;
  stopTimeout?: number;
  nanoCpus?: number;
  cpuShares?: number;
  cpusetCpus?: string;
  memory?: number;
  memoryReservation?: number;
  memorySwap?: number;
  pidsLimit?: number;
  shmSize?: number;
  readOnlyRootfs?: boolean;
  privileged?: boolean;
  mounts?: DockerContainerMount[];
  networkMode?: string;
  networkName?: string;
  networkAliases?: string[];
  ipv4Address?: string;
  ipv6Address?: string;
  macAddress?: string;
  ports?: DockerContainerPort[];
  publishAllPorts?: boolean;
  dns?: string[];
  dnsSearch?: string[];
  extraHosts?: string[];
  restartPolicy?: "no" | "always" | "unless-stopped" | "on-failure";
  restartMaximumRetryCount?: number;
  autoRemove?: boolean;
}

export interface DockerCreateContainerResult {
  id: string;
  warnings: string[];
}

export interface DockerPullImageInput {
  image: string;
  registryAuth?: string;
}

export interface DockerCreateVolumeInput {
  name: string;
  labels?: Record<string, string>;
}

export interface DockerCreateVolumeResult {
  name: string;
  labels: Record<string, string>;
}

export interface DockerNetworkIpamConfig {
  subnet?: string;
  ipRange?: string;
  gateway?: string;
  auxiliaryAddresses?: Record<string, string>;
}

export interface DockerCreateNetworkInput {
  name: string;
  driver: "bridge" | "macvlan" | "ipvlan";
  options?: Record<string, string>;
  internal?: boolean;
  enableIPv4?: boolean;
  enableIPv6?: boolean;
  ipam?: {
    driver: "default";
    configs: DockerNetworkIpamConfig[];
  };
  labels?: Record<string, string>;
}

export interface DockerCreateNetworkResult {
  id: string;
  warning: string | null;
}

export interface DockerEngineRuntime {
  getInfo(): Promise<DockerEngineInfo>;
  getCounts(): Promise<DockerEngineCounts>;
  listContainers(): Promise<DockerContainerSummary[]>;
  listImages(): Promise<DockerImageSummary[]>;
  imageExists(image: string): Promise<boolean>;
  pullImage(input: DockerPullImageInput): Promise<void>;
  removeImage(image: string): Promise<DockerImageRemoveResult>;
  createContainer(input: DockerCreateContainerInput): Promise<DockerCreateContainerResult>;
  createVolume(input: DockerCreateVolumeInput): Promise<DockerCreateVolumeResult>;
  createNetwork(input: DockerCreateNetworkInput): Promise<DockerCreateNetworkResult>;
  getImageArchitecture(imageId: string): Promise<string | null>;
  getContainerDetails?(containerId: string, baseSummary?: DockerContainerSummary): Promise<DockerContainerDetails>;
  getNetworkDetails(networkId: string): Promise<DockerNetworkDetails>;
  getVolumeDetails(volumeName: string): Promise<DockerVolumeDetails>;
  getContainerLogs(containerId: string, tail: number): Promise<string>;
  startContainer(containerId: string): Promise<void>;
  stopContainer(containerId: string): Promise<void>;
  restartContainer(containerId: string): Promise<void>;
  removeContainer(containerId: string): Promise<void>;
  createExec(containerId: string, shell: string): Promise<string>;
  startExec(execId: string): Promise<DockerExecStream>;
  resizeExec(execId: string, cols: number, rows: number): Promise<void>;
}

interface DockerSocketClientOptions {
  socketPath: string;
  timeoutMs: number;
}

type DockerVersionResponse = {
  Version?: string;
  ApiVersion?: string;
  MinAPIVersion?: string;
  Os?: string;
  Arch?: string;
};

type DockerInfoResponse = {
  ServerVersion?: string;
  OperatingSystem?: string;
  Architecture?: string;
  DockerRootDir?: string;
  MemoryLimit?: boolean;
  SwapLimit?: boolean;
  CpuCfsQuota?: boolean;
  CpuCfsPeriod?: boolean;
  CPUShares?: boolean;
  CPUSet?: boolean;
  PidsLimit?: boolean;
};

type DockerNetworkRow = {
  Id?: string;
  Name?: string;
  Driver?: string;
  Scope?: string;
  Containers?: Record<string, unknown> | null;
};

type DockerVolumeRow = {
  Name?: string;
  Driver?: string;
  Scope?: string;
  Mountpoint?: string;
};

type DockerNetworkInspect = {
  Id?: string;
  Name?: string;
  Created?: string;
  Driver?: string;
  Scope?: string;
  EnableIPv4?: boolean;
  EnableIPv6?: boolean;
  Internal?: boolean;
  Attachable?: boolean;
  Ingress?: boolean;
  IPAM?: {
    Driver?: string;
    Config?: Array<{
      Subnet?: string;
      IPRange?: string;
      Gateway?: string;
      AuxAddress?: Record<string, string> | null;
      AuxiliaryAddresses?: Record<string, string> | null;
    }> | null;
  };
  Options?: Record<string, string> | null;
  Labels?: Record<string, string> | null;
  Containers?: Record<string, {
    Name?: string;
    EndpointID?: string;
    MacAddress?: string;
    IPv4Address?: string;
    IPv6Address?: string;
  }> | null;
};

type DockerVolumeInspect = DockerVolumeRow & {
  CreatedAt?: string;
  Labels?: Record<string, string> | null;
  Options?: Record<string, string> | null;
  Status?: Record<string, string> | null;
  UsageData?: {
    Size?: number;
    RefCount?: number;
  } | null;
};

type DockerImageInspect = {
  Architecture?: string;
};

type DockerImageRow = {
  Id?: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created?: number;
  Size?: number;
  SharedSize?: number;
  Containers?: number;
};

type DockerContainerRow = {
  Id?: string;
  ImageID?: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: Array<{
    IP?: string;
    PrivatePort?: number;
    PublicPort?: number;
    Type?: string;
  }>;
  Labels?: Record<string, string>;
  Created?: number | string;
};

type DockerContainerInspect = {
  Id?: string;
  Name?: string;
  Image?: string;
  Created?: string;
  State?: {
    Status?: string;
    Running?: boolean;
    Paused?: boolean;
    Restarting?: boolean;
    Dead?: boolean;
  };
  Labels?: Record<string, string>;
  Config?: {
    Image?: string;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    Env?: string[] | null;
    Hostname?: string;
    WorkingDir?: string;
    Labels?: Record<string, string> | null;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string };
  };
  Mounts?: Array<{
    Source?: string;
    Destination?: string;
    Mode?: string;
    Type?: string;
  }>;
  NetworkSettings?: {
    Networks?: Record<string, unknown>;
  };
};

type DockerStatsResponse = {
  cpu_stats?: {
    cpu_usage?: {
      total_usage?: number;
    };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: {
      total_usage?: number;
    };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: {
      cache?: number;
    };
  };
};

type DockerContainerCreateResponse = {
  Id?: string;
  Warnings?: string[] | null;
};

type DockerVolumeCreateResponse = {
  Name?: string;
  Labels?: Record<string, string> | null;
};

type DockerNetworkCreateResponse = {
  Id?: string;
  Warning?: string;
};

const MAX_DOCKER_API_VERSION = "1.56";

export class DockerRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null
  ) {
    super(message);
    this.name = "DockerRequestError";
  }
}

export class DockerSocketClient implements DockerEngineRuntime {
  private versionResponse: Promise<DockerVersionResponse> | null = null;
  private negotiatedApiVersion: string | null | undefined;
  private readonly imageArchitectureCache = new Map<string, string | null>();

  constructor(private readonly options: DockerSocketClientOptions) {}

  async getInfo(): Promise<DockerEngineInfo> {
    const version = await this.getVersionResponse();
    const negotiatedApiVersion = await this.ensureApiVersion();
    const info = await this.requestJson<DockerInfoResponse>("GET", "/info");
    return {
      version: info.ServerVersion ?? version.Version ?? null,
      apiVersion: version.ApiVersion ?? null,
      negotiatedApiVersion,
      operatingSystem: info.OperatingSystem ?? null,
      architecture: info.Architecture ?? version.Arch ?? null,
      dockerRootDir: info.DockerRootDir ?? null,
      resourceCapabilities: {
        memoryLimit: capabilityFlag(info.MemoryLimit),
        swapLimit: capabilityFlag(info.SwapLimit),
        cpuQuota: info.CpuCfsQuota === false || info.CpuCfsPeriod === false
          ? false
          : info.CpuCfsQuota === true && info.CpuCfsPeriod === true ? true : null,
        cpuShares: capabilityFlag(info.CPUShares),
        cpuset: capabilityFlag(info.CPUSet),
        pidsLimit: capabilityFlag(info.PidsLimit)
      }
    };
  }

  async getCounts(): Promise<DockerEngineCounts> {
    const [images, networks, volumes] = await Promise.all([
      this.listImages(),
      this.requestJson<DockerNetworkRow[]>("GET", "/networks"),
      this.requestJson<{ Volumes?: DockerVolumeRow[] | null }>("GET", "/volumes")
    ]);
    const networkDetails = Array.isArray(networks) ? networks.map(mapNetwork).filter((network): network is DockerNetworkSummary => network !== null) : [];
    const volumeDetails = Array.isArray(volumes.Volumes) ? volumes.Volumes.map(mapVolume).filter((volume): volume is DockerVolumeSummary => volume !== null) : [];
    return {
      images: images.length,
      imageDetails: images,
      networks: Array.isArray(networks) ? networks.length : 0,
      volumes: Array.isArray(volumes.Volumes) ? volumes.Volumes.length : 0,
      networkDetails,
      volumeDetails
    };
  }

  async listContainers(): Promise<DockerContainerSummary[]> {
    const containers = await this.requestJson<DockerContainerRow[]>("GET", "/containers/json", {
      all: "1"
    });
    const summaries = containers.map(mapContainer);
    const stats = await Promise.all(
      summaries.map((container) =>
        container.state === "running"
          ? this.getStats(container.id).catch((): DockerContainerStats => emptyStats())
          : Promise.resolve(emptyStats())
      )
    );
    return summaries.map((container, index) => ({
      ...container,
      ...stats[index]
    }));
  }

  async listImages(): Promise<DockerImageSummary[]> {
    const images = await this.requestJson<DockerImageRow[]>("GET", "/images/json", { "shared-size": "true", containers: "true" });
    const summaries = images.map(mapImage).filter((image): image is DockerImageSummary => image !== null);
    return mapWithConcurrency(summaries, 4, async (image) => ({
      ...image,
      architecture: await this.getImageArchitecture(image.id)
    }));
  }

  async getImageArchitecture(imageId: string): Promise<string | null> {
    if (this.imageArchitectureCache.has(imageId)) {
      return this.imageArchitectureCache.get(imageId) ?? null;
    }
    try {
      const inspected = await this.requestJson<DockerImageInspect>(
        "GET",
        `/images/${encodeURIComponent(imageId)}/json`
      );
      const architecture = inspected.Architecture?.trim() || null;
      this.imageArchitectureCache.set(imageId, architecture);
      return architecture;
    } catch {
      return null;
    }
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.requestJson<unknown>("GET", `/images/${encodeURIComponent(image)}/json`);
      return true;
    } catch (error) {
      if (error instanceof DockerRequestError && error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async pullImage(input: DockerPullImageInput): Promise<void> {
    const reference = splitImageReference(input.image);
    await this.requestNdjson("POST", "/images/create", {
      fromImage: reference.fromImage,
      ...(reference.tag ? { tag: reference.tag } : {})
    }, input.registryAuth ? { "X-Registry-Auth": input.registryAuth } : {});
  }

  async removeImage(image: string): Promise<DockerImageRemoveResult> {
    const inspected = await this.requestJson<{ Id?: string }>("GET", `/images/${encodeURIComponent(image)}/json`);
    if (!inspected.Id) {
      throw new DockerRequestError("Docker returned invalid image metadata");
    }
    const containers = await this.requestJson<DockerContainerRow[]>("GET", "/containers/json", { all: "1" });
    if (containers.some((container) => container.ImageID === inspected.Id)) {
      throw new DockerRequestError("Docker image is referenced by a container", 409);
    }
    const response = await this.requestJson<Array<{ Deleted?: string; Untagged?: string }>>(
      "DELETE",
      `/images/${encodeURIComponent(image)}`,
      { force: "false", noprune: "true" }
    );
    return {
      reference: image,
      deleted: response.flatMap((item) => item.Deleted ? [item.Deleted] : []),
      untagged: response.flatMap((item) => item.Untagged ? [item.Untagged] : [])
    };
  }

  async createContainer(input: DockerCreateContainerInput): Promise<DockerCreateContainerResult> {
    const response = await this.requestJson<DockerContainerCreateResponse>(
      "POST",
      "/containers/create",
      {
        name: input.name,
        ...(input.platform ? { platform: input.platform } : {})
      },
      containerCreatePayload(input)
    );
    if (!response.Id) {
      throw new DockerRequestError("Docker did not return a container id");
    }
    return {
      id: response.Id,
      warnings: response.Warnings ?? []
    };
  }

  async createVolume(input: DockerCreateVolumeInput): Promise<DockerCreateVolumeResult> {
    const response = await this.requestJson<DockerVolumeCreateResponse>("POST", "/volumes/create", {}, {
      Name: input.name,
      Driver: "local",
      Labels: input.labels ?? {}
    });
    if (!response.Name) {
      throw new DockerRequestError("Docker did not return a volume name");
    }
    return {
      name: response.Name,
      labels: response.Labels ?? {}
    };
  }

  async createNetwork(input: DockerCreateNetworkInput): Promise<DockerCreateNetworkResult> {
    const response = await this.requestJson<DockerNetworkCreateResponse>("POST", "/networks/create", {}, {
      Name: input.name,
      Driver: input.driver,
      Options: input.options ?? {},
      Internal: input.internal ?? false,
      EnableIPv4: input.enableIPv4 ?? true,
      EnableIPv6: input.enableIPv6 ?? false,
      IPAM: {
        Driver: input.ipam?.driver ?? "default",
        Config: (input.ipam?.configs ?? []).map((config) => ({
          ...(config.subnet ? { Subnet: config.subnet } : {}),
          ...(config.ipRange ? { IPRange: config.ipRange } : {}),
          ...(config.gateway ? { Gateway: config.gateway } : {}),
          ...(config.auxiliaryAddresses ? { AuxAddress: config.auxiliaryAddresses } : {})
        }))
      },
      Labels: input.labels ?? {}
    });
    if (!response.Id) {
      throw new DockerRequestError("Docker did not return a network id");
    }
    return {
      id: response.Id,
      warning: response.Warning ?? null
    };
  }

  async getContainerLogs(containerId: string, tail: number): Promise<string> {
    const buffer = await this.requestBuffer("GET", `/containers/${encodeURIComponent(containerId)}/logs`, {
      stdout: "1",
      stderr: "1",
      timestamps: "1",
      tail: String(Math.max(1, Math.min(tail, 1000)))
    });
    return decodeDockerOutput(buffer);
  }

  async getContainerDetails(containerId: string, baseSummary?: DockerContainerSummary): Promise<DockerContainerDetails> {
    const inspected = await this.requestJson<DockerContainerInspect>(
      "GET",
      `/containers/${encodeURIComponent(containerId)}/json`
    );
    const summary = baseSummary ?? inspectSummary(inspected, containerId);
    return {
      ...summary,
      command: inspected.Config?.Cmd?.join(" ") ?? null,
      entrypoint: inspected.Config?.Entrypoint ?? [],
      environment: (inspected.Config?.Env ?? []).map((entry) => entry.split("=", 1)[0] ?? entry),
      mounts: (inspected.Mounts ?? []).map((mount) => ({
        source: mount.Source ?? "",
        destination: mount.Destination ?? "",
        mode: mount.Mode ?? "",
        type: mount.Type ?? ""
      })),
      networks: Object.keys(inspected.NetworkSettings?.Networks ?? {}),
      restartPolicy: inspected.HostConfig?.RestartPolicy?.Name || null,
      hostname: inspected.Config?.Hostname || null,
      workingDir: inspected.Config?.WorkingDir || null,
      labels: inspected.Config?.Labels ?? inspected.Labels ?? {}
    };
  }

  async getNetworkDetails(networkId: string): Promise<DockerNetworkDetails> {
    const inspected = await this.requestJson<DockerNetworkInspect>(
      "GET",
      `/networks/${encodeURIComponent(networkId)}`
    );
    return mapNetworkDetails(inspected, networkId);
  }

  async getVolumeDetails(volumeName: string): Promise<DockerVolumeDetails> {
    const inspected = await this.requestJson<DockerVolumeInspect>(
      "GET",
      `/volumes/${encodeURIComponent(volumeName)}`
    );
    return mapVolumeDetails(inspected, volumeName);
  }

  async startContainer(containerId: string): Promise<void> {
    await this.requestJson<unknown>("POST", `/containers/${encodeURIComponent(containerId)}/start`);
  }

  async stopContainer(containerId: string): Promise<void> {
    await this.requestJson<unknown>("POST", `/containers/${encodeURIComponent(containerId)}/stop`);
  }

  async restartContainer(containerId: string): Promise<void> {
    await this.requestJson<unknown>("POST", `/containers/${encodeURIComponent(containerId)}/restart`);
  }

  async removeContainer(containerId: string): Promise<void> {
    await this.requestJson<unknown>("DELETE", `/containers/${encodeURIComponent(containerId)}`, {
      force: "0"
    });
  }

  async createExec(containerId: string, shell: string): Promise<string> {
    const response = await this.requestJson<{ Id?: string }>(
      "POST",
      `/containers/${encodeURIComponent(containerId)}/exec`,
      {},
      {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: [shell],
        Env: ["TERM=xterm-256color"]
      }
    );
    if (!response.Id) {
      throw new DockerRequestError("Docker did not return an exec id");
    }
    return response.Id;
  }

  async startExec(execId: string): Promise<DockerExecStream> {
    const apiPath = await this.pathFor(`/exec/${encodeURIComponent(execId)}/start`);
    const body = JSON.stringify({ Detach: false, Tty: true });
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const raw = net.connect(this.options.socketPath);
      const timer = setTimeout(() => {
        raw.destroy(new DockerRequestError("Docker exec start timed out"));
      }, this.options.timeoutMs);
      let buffer = Buffer.alloc(0);

      const cleanup = () => {
        clearTimeout(timer);
        raw.off("data", onData);
        raw.off("error", onError);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }

        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const statusCode = Number(header.match(/^HTTP\/1\.[01]\s+(\d+)/u)?.[1] ?? 0);
        const rest = buffer.subarray(headerEnd + 4);
        cleanup();
        if (statusCode < 200 || statusCode >= 300) {
          raw.destroy();
          reject(new DockerRequestError(`Docker exec start failed with status ${statusCode}`, statusCode));
          return;
        }
        if (rest.length) {
          raw.unshift(rest);
        }
        resolve(raw);
      };

      raw.once("connect", () => {
        raw.write(
          [
            `POST ${apiPath} HTTP/1.1`,
            "Host: docker",
            "Connection: Upgrade",
            "Upgrade: tcp",
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(body)}`,
            "",
            body
          ].join("\r\n")
        );
      });
      raw.on("data", onData);
      raw.once("error", onError);
    });

    return { socket };
  }

  async resizeExec(execId: string, cols: number, rows: number): Promise<void> {
    await this.requestJson<unknown>("POST", `/exec/${encodeURIComponent(execId)}/resize`, {
      w: String(Math.max(20, Math.min(cols, 400))),
      h: String(Math.max(5, Math.min(rows, 120)))
    });
  }

  private async getStats(containerId: string): Promise<DockerContainerStats> {
    const stats = await this.requestJson<DockerStatsResponse>(
      "GET",
      `/containers/${encodeURIComponent(containerId)}/stats`,
      {
        stream: "false"
      }
    );
    return calculateStats(stats);
  }

  private async requestJson<T>(
    method: string,
    requestPath: string,
    query: Record<string, string> = {},
    body?: unknown,
    versioned = true,
    headers: Record<string, string> = {}
  ): Promise<T> {
    const buffer = await this.requestBuffer(method, requestPath, query, body, versioned, headers);
    if (!buffer.length) {
      return undefined as T;
    }
    return JSON.parse(buffer.toString("utf8")) as T;
  }

  private async requestBuffer(
    method: string,
    requestPath: string,
    query: Record<string, string> = {},
    body?: unknown,
    versioned = true,
    headers: Record<string, string> = {}
  ): Promise<Buffer> {
    const fullPath = `${versioned ? await this.pathFor(requestPath) : requestPath}${queryString(query)}`;
    const bodyBuffer = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");

    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          method,
          path: fullPath,
          timeout: this.options.timeoutMs,
          headers: bodyBuffer
            ? {
                ...headers,
                "Content-Type": "application/json",
                "Content-Length": String(bodyBuffer.length)
              }
            : headers
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const payload = Buffer.concat(chunks);
            const statusCode = response.statusCode ?? 500;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new DockerRequestError(errorMessage(payload, statusCode), statusCode));
              return;
            }
            resolve(payload);
          });
        }
      );

      request.on("timeout", () => {
        request.destroy(new DockerRequestError("Docker request timed out"));
      });
      request.on("error", reject);
      if (bodyBuffer) {
        request.write(bodyBuffer);
      }
      request.end();
    });
  }

  private async requestNdjson(
    method: string,
    requestPath: string,
    query: Record<string, string> = {},
    headers: Record<string, string> = {}
  ): Promise<void> {
    const fullPath = `${await this.pathFor(requestPath)}${queryString(query)}`;

    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          method,
          path: fullPath,
          timeout: this.options.timeoutMs,
          headers
        },
        (response) => {
          const statusCode = response.statusCode ?? 500;
          if (statusCode < 200 || statusCode >= 300) {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => reject(new DockerRequestError(errorMessage(Buffer.concat(chunks), statusCode), statusCode)));
            response.on("error", reject);
            return;
          }

          const decoder = new StringDecoder("utf8");
          let pending = "";
          let settled = false;
          const fail = (error: unknown) => {
            if (settled) {
              return;
            }
            settled = true;
            response.destroy();
            reject(error);
          };
          const parseLine = (line: string) => {
            if (!line.trim()) {
              return;
            }
            const progress = JSON.parse(line) as { error?: string; errorDetail?: { message?: string } };
            const message = progress.errorDetail?.message ?? progress.error;
            if (message) {
              throw new DockerRequestError(message);
            }
          };
          const consume = (text: string, complete: boolean) => {
            pending += text;
            const lines = pending.split(/\r?\n/u);
            pending = complete ? "" : (lines.pop() ?? "");
            for (const line of lines) {
              parseLine(line);
            }
            if (complete && pending.trim()) {
              parseLine(pending);
              pending = "";
            }
          };

          response.on("data", (chunk: Buffer) => {
            if (settled) {
              return;
            }
            try {
              consume(decoder.write(chunk), false);
            } catch (error) {
              fail(error);
            }
          });
          response.on("end", () => {
            if (settled) {
              return;
            }
            try {
              consume(decoder.end(), true);
              settled = true;
              resolve();
            } catch (error) {
              fail(error);
            }
          });
          response.on("error", fail);
        }
      );

      request.on("timeout", () => {
        request.destroy(new DockerRequestError("Docker request timed out"));
      });
      request.on("error", reject);
      request.end();
    });
  }

  private async pathFor(requestPath: string): Promise<string> {
    const version = await this.ensureApiVersion();
    return version ? `/v${version}${requestPath}` : requestPath;
  }

  private async ensureApiVersion(): Promise<string | null> {
    if (this.negotiatedApiVersion !== undefined) {
      return this.negotiatedApiVersion;
    }
    const version = await this.getVersionResponse();
    this.negotiatedApiVersion = negotiateApiVersion(version);
    return this.negotiatedApiVersion;
  }

  private getVersionResponse(): Promise<DockerVersionResponse> {
    this.versionResponse ??= this.requestJson<DockerVersionResponse>("GET", "/version", {}, undefined, false);
    return this.versionResponse;
  }
}

function containerCreatePayload(input: DockerCreateContainerInput): Record<string, unknown> {
  const ports = input.ports ?? [];
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const port of ports) {
    const key = `${port.containerPort}/${port.protocol}`;
    exposedPorts[key] = {};
    if (port.hostPort !== undefined) {
      (portBindings[key] ??= []).push({
        HostIp: port.hostIp ?? "",
        HostPort: String(port.hostPort)
      });
    }
  }

  const networkMode = input.networkName ?? input.networkMode;
  const endpointIpam = {
    ...(input.ipv4Address ? { IPv4Address: input.ipv4Address } : {}),
    ...(input.ipv6Address ? { IPv6Address: input.ipv6Address } : {})
  };
  const endpoint = {
    ...(input.networkAliases?.length ? { Aliases: input.networkAliases } : {}),
    ...(Object.keys(endpointIpam).length ? { IPAMConfig: endpointIpam } : {}),
    ...(input.macAddress ? { MacAddress: input.macAddress } : {})
  };

  return {
    Image: input.image,
    ...(input.hostname !== undefined ? { Hostname: input.hostname } : {}),
    ...(input.user !== undefined ? { User: input.user } : {}),
    ...(input.workingDir !== undefined ? { WorkingDir: input.workingDir } : {}),
    ...(input.entrypoint !== undefined ? { Entrypoint: input.entrypoint } : {}),
    ...(input.command !== undefined ? { Cmd: input.command } : {}),
    ...(input.environment !== undefined
      ? { Env: Object.entries(input.environment).map(([name, value]) => `${name}=${value}`) }
      : {}),
    ...(input.labels !== undefined ? { Labels: input.labels } : {}),
    ...(input.tty !== undefined ? { Tty: input.tty } : {}),
    ...(input.openStdin !== undefined ? { OpenStdin: input.openStdin } : {}),
    ...(input.stopSignal !== undefined ? { StopSignal: input.stopSignal } : {}),
    ...(input.stopTimeout !== undefined ? { StopTimeout: input.stopTimeout } : {}),
    ...(ports.length ? { ExposedPorts: exposedPorts } : {}),
    HostConfig: {
      ...(input.init !== undefined ? { Init: input.init } : {}),
      ...(input.nanoCpus !== undefined ? { NanoCpus: input.nanoCpus } : {}),
      ...(input.cpuShares !== undefined ? { CpuShares: input.cpuShares } : {}),
      ...(input.cpusetCpus !== undefined ? { CpusetCpus: input.cpusetCpus } : {}),
      ...(input.memory !== undefined ? { Memory: input.memory } : {}),
      ...(input.memoryReservation !== undefined ? { MemoryReservation: input.memoryReservation } : {}),
      ...(input.memorySwap !== undefined ? { MemorySwap: input.memorySwap } : {}),
      ...(input.pidsLimit !== undefined ? { PidsLimit: input.pidsLimit } : {}),
      ...(input.shmSize !== undefined ? { ShmSize: input.shmSize } : {}),
      ...(input.readOnlyRootfs !== undefined ? { ReadonlyRootfs: input.readOnlyRootfs } : {}),
      ...(input.privileged !== undefined ? { Privileged: input.privileged } : {}),
      ...(input.mounts !== undefined ? { Mounts: input.mounts.map(mapContainerMount) } : {}),
      ...(networkMode !== undefined ? { NetworkMode: networkMode } : {}),
      ...(Object.keys(portBindings).length ? { PortBindings: portBindings } : {}),
      ...(input.publishAllPorts !== undefined ? { PublishAllPorts: input.publishAllPorts } : {}),
      ...(input.dns !== undefined ? { Dns: input.dns } : {}),
      ...(input.dnsSearch !== undefined ? { DnsSearch: input.dnsSearch } : {}),
      ...(input.extraHosts !== undefined ? { ExtraHosts: input.extraHosts } : {}),
      ...(input.restartPolicy !== undefined
        ? {
            RestartPolicy: {
              Name: input.restartPolicy,
              MaximumRetryCount: input.restartMaximumRetryCount ?? 0
            }
          }
        : {}),
      ...(input.autoRemove !== undefined ? { AutoRemove: input.autoRemove } : {})
    },
    ...(input.networkName
      ? {
          NetworkingConfig: {
            EndpointsConfig: {
              [input.networkName]: endpoint
            }
          }
        }
      : {})
  };
}

function mapContainerMount(mount: DockerContainerMount): Record<string, unknown> {
  if (mount.type === "bind") {
    return {
      Type: "bind",
      Source: mount.source,
      Target: mount.target,
      ReadOnly: mount.readOnly
    };
  }
  if (mount.type === "volume") {
    return {
      Type: "volume",
      Source: mount.source,
      Target: mount.target,
      ReadOnly: mount.readOnly,
      VolumeOptions: { NoCopy: mount.noCopy }
    };
  }
  return {
    Type: "tmpfs",
    Target: mount.target,
    ReadOnly: mount.readOnly,
    TmpfsOptions: {
      ...(mount.sizeBytes !== undefined ? { SizeBytes: mount.sizeBytes } : {}),
      ...(mount.mode !== undefined ? { Mode: mount.mode } : {})
    }
  };
}

function splitImageReference(image: string): { fromImage: string; tag?: string } {
  if (image.includes("@")) {
    return { fromImage: image };
  }
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon > lastSlash && lastColon < image.length - 1) {
    return {
      fromImage: image.slice(0, lastColon),
      tag: image.slice(lastColon + 1)
    };
  }
  return { fromImage: image };
}

function mapImage(row: DockerImageRow): DockerImageSummary | null {
  const id = row.Id?.trim();
  if (!id) {
    return null;
  }
  return {
    id,
    shortId: id.replace(/^sha256:/u, "").slice(0, 12),
    tags: imageReferences(row.RepoTags),
    digests: imageReferences(row.RepoDigests),
    createdAt: typeof row.Created === "number" && row.Created > 0
      ? new Date(row.Created * 1000).toISOString()
      : null,
    sizeBytes: nonNegativeNumber(row.Size),
    sharedSizeBytes: typeof row.SharedSize === "number" && Number.isFinite(row.SharedSize) && row.SharedSize >= 0
      ? row.SharedSize
      : null,
    architecture: null,
    containerCount: typeof row.Containers === "number" && row.Containers >= 0 ? row.Containers : null
  };
}

function capabilityFlag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function imageReferences(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.filter((value) => value && !value.includes("<none>"));
}

function nonNegativeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function negotiateApiVersion(version: DockerVersionResponse): string | null {
  const daemonVersion = version.ApiVersion?.trim();
  if (!daemonVersion) {
    const minimumVersion = version.MinAPIVersion?.trim();
    if (minimumVersion) {
      parseApiVersion(minimumVersion, "daemon minimum API version");
      throw new DockerRequestError(
        `Docker daemon requires API version ${minimumVersion}, but did not report a compatible API version`
      );
    }
    return null;
  }
  parseApiVersion(daemonVersion, "daemon API version");
  const negotiated = compareApiVersions(daemonVersion, MAX_DOCKER_API_VERSION) <= 0
    ? daemonVersion
    : MAX_DOCKER_API_VERSION;
  const minimumVersion = version.MinAPIVersion?.trim();
  if (minimumVersion) {
    parseApiVersion(minimumVersion, "daemon minimum API version");
    if (compareApiVersions(daemonVersion, minimumVersion) < 0) {
      throw new DockerRequestError(
        `Docker daemon reported API version ${daemonVersion}, below its minimum ${minimumVersion}`
      );
    }
    if (compareApiVersions(negotiated, minimumVersion) < 0) {
      throw new DockerRequestError(
        `Docker daemon requires API version ${minimumVersion}, but ZOS supports up to ${MAX_DOCKER_API_VERSION}`
      );
    }
  }
  return negotiated;
}

function compareApiVersions(left: string, right: string): number {
  const [leftMajor, leftMinor] = parseApiVersion(left, "API version");
  const [rightMajor, rightMinor] = parseApiVersion(right, "API version");
  return leftMajor - rightMajor || leftMinor - rightMinor;
}

function parseApiVersion(version: string, label: string): [number, number] {
  const match = /^(\d+)\.(\d+)$/u.exec(version);
  if (!match) {
    throw new DockerRequestError(`Docker returned an invalid ${label}: ${version}`);
  }
  return [Number(match[1]), Number(match[2])];
}

function inspectSummary(inspected: DockerContainerInspect, containerId: string): DockerContainerSummary {
  const state = inspected.State?.Status;
  return {
    id: inspected.Id ?? containerId,
    shortId: (inspected.Id ?? containerId).slice(0, 12),
    name: (inspected.Name ?? containerId).replace(/^\//u, ""),
    image: inspected.Config?.Image ?? inspected.Image ?? "",
    state: normalizeState(state),
    status: state ?? "unknown",
    ports: [],
    composeProject: inspected.Labels?.["com.docker.compose.project"] ?? null,
    composeService: inspected.Labels?.["com.docker.compose.service"] ?? null,
    cpuPercent: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    memoryPercent: null,
    createdAt: dockerCreatedAt(inspected.Created)
  };
}

function mapContainer(row: DockerContainerRow): DockerContainerSummary {
  const id = row.Id ?? "";
  const labels = row.Labels ?? {};
  return {
    id,
    shortId: id.slice(0, 12),
    name: (row.Names?.[0] ?? id.slice(0, 12)).replace(/^\//u, ""),
    image: row.Image ?? "",
    imageId: row.ImageID?.trim() || null,
    state: normalizeState(row.State),
    status: row.Status ?? row.State ?? "unknown",
    ports: (row.Ports ?? []).map(formatPort).filter((port): port is string => port !== null),
    composeProject: labels["com.docker.compose.project"] ?? null,
    composeService: labels["com.docker.compose.service"] ?? null,
    cpuPercent: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    memoryPercent: null,
    createdAt: dockerCreatedAt(row.Created)
  };
}

function mapNetwork(row: DockerNetworkRow): DockerNetworkSummary | null {
  const id = row.Id?.trim();
  const name = row.Name?.trim();
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    driver: row.Driver?.trim() || "unknown",
    scope: row.Scope?.trim() || "local",
    containerCount: Object.keys(row.Containers ?? {}).length
  };
}

function mapVolume(row: DockerVolumeRow): DockerVolumeSummary | null {
  const name = row.Name?.trim();
  if (!name) {
    return null;
  }
  return {
    name,
    driver: row.Driver?.trim() || "unknown",
    scope: row.Scope?.trim() || "local",
    mountpoint: row.Mountpoint?.trim() || ""
  };
}

function mapNetworkDetails(inspected: DockerNetworkInspect, fallbackId: string): DockerNetworkDetails {
  const containers = Object.entries(inspected.Containers ?? {}).map(([id, container]) => ({
    id,
    name: container.Name?.trim() || id.slice(0, 12),
    endpointId: container.EndpointID?.trim() || null,
    macAddress: container.MacAddress?.trim() || null,
    ipv4Address: container.IPv4Address?.trim() || null,
    ipv6Address: container.IPv6Address?.trim() || null
  }));
  return {
    id: inspected.Id?.trim() || fallbackId,
    name: inspected.Name?.trim() || fallbackId,
    createdAt: dockerCreatedAt(inspected.Created),
    driver: inspected.Driver?.trim() || "unknown",
    scope: inspected.Scope?.trim() || "local",
    containerCount: containers.length,
    enableIPv4: nullableBoolean(inspected.EnableIPv4),
    enableIPv6: nullableBoolean(inspected.EnableIPv6),
    internal: nullableBoolean(inspected.Internal),
    attachable: nullableBoolean(inspected.Attachable),
    ingress: nullableBoolean(inspected.Ingress),
    ipam: {
      driver: inspected.IPAM?.Driver?.trim() || null,
      configs: (inspected.IPAM?.Config ?? []).map((config) => ({
        subnet: config.Subnet?.trim() || null,
        ipRange: config.IPRange?.trim() || null,
        gateway: config.Gateway?.trim() || null,
        auxiliaryAddresses: stringRecord(config.AuxAddress ?? config.AuxiliaryAddresses)
      }))
    },
    options: stringRecord(inspected.Options),
    labels: stringRecord(inspected.Labels),
    containers
  };
}

function mapVolumeDetails(inspected: DockerVolumeInspect, fallbackName: string): DockerVolumeDetails {
  return {
    name: inspected.Name?.trim() || fallbackName,
    createdAt: dockerCreatedAt(inspected.CreatedAt),
    driver: inspected.Driver?.trim() || "unknown",
    scope: inspected.Scope?.trim() || "local",
    mountpoint: inspected.Mountpoint?.trim() || "",
    labels: stringRecord(inspected.Labels),
    options: stringRecord(inspected.Options),
    status: stringRecord(inspected.Status),
    sizeBytes: nullableNonNegativeNumber(inspected.UsageData?.Size),
    referenceCount: nullableNonNegativeNumber(inspected.UsageData?.RefCount)
  };
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringRecord(value: Record<string, string> | null | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function mapWithConcurrency<T, Result>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<Result>
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()));
  return results;
}

function dockerCreatedAt(value: number | string | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
      return new Date(seconds * 1000).toISOString();
    }
  }
  return null;
}

function normalizeState(value: string | undefined): DockerContainerState {
  switch (value) {
    case "created":
    case "running":
    case "paused":
    case "restarting":
    case "removing":
    case "exited":
    case "dead":
      return value;
    default:
      return "unknown";
  }
}

function formatPort(port: NonNullable<DockerContainerRow["Ports"]>[number]): string | null {
  if (!port.PrivatePort || !port.Type) {
    return null;
  }
  if (port.PublicPort) {
    return `${port.IP ? `${port.IP}:` : ""}${port.PublicPort}->${port.PrivatePort}/${port.Type}`;
  }
  return `${port.PrivatePort}/${port.Type}`;
}

function calculateStats(stats: DockerStatsResponse): DockerContainerStats {
  const cpuTotal = stats.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const previousCpuTotal = stats.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const systemTotal = stats.cpu_stats?.system_cpu_usage ?? 0;
  const previousSystemTotal = stats.precpu_stats?.system_cpu_usage ?? 0;
  const cpuDelta = cpuTotal - previousCpuTotal;
  const systemDelta = systemTotal - previousSystemTotal;
  const onlineCpus = stats.cpu_stats?.online_cpus ?? 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : null;
  const rawMemoryUsage = stats.memory_stats?.usage ?? null;
  const cache = stats.memory_stats?.stats?.cache ?? 0;
  const memoryUsageBytes = rawMemoryUsage === null ? null : Math.max(rawMemoryUsage - cache, 0);
  const memoryLimitBytes = stats.memory_stats?.limit ?? null;
  const memoryPercent =
    memoryUsageBytes !== null && memoryLimitBytes !== null && memoryLimitBytes > 0
      ? (memoryUsageBytes / memoryLimitBytes) * 100
      : null;
  return {
    cpuPercent,
    memoryUsageBytes,
    memoryLimitBytes,
    memoryPercent
  };
}

function emptyStats(): DockerContainerStats {
  return {
    cpuPercent: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    memoryPercent: null
  };
}

function decodeDockerOutput(buffer: Buffer): string {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    if (!streamType || streamType > 3 || size < 0 || offset + 8 + size > buffer.length) {
      break;
    }
    frames.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return (frames.length ? Buffer.concat(frames) : buffer).toString("utf8");
}

function errorMessage(payload: Buffer, statusCode: number): string {
  if (!payload.length) {
    return `Docker request failed with status ${statusCode}`;
  }
  try {
    const parsed = JSON.parse(payload.toString("utf8")) as {
      message?: string;
      error?: string;
      errorDetail?: { message?: string };
    };
    return parsed.errorDetail?.message ?? parsed.message ?? parsed.error ?? `Docker request failed with status ${statusCode}`;
  } catch {
    const lines = payload.toString("utf8").split(/\r?\n/u).reverse();
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          message?: string;
          error?: string;
          errorDetail?: { message?: string };
        };
        const message = parsed.errorDetail?.message ?? parsed.message ?? parsed.error;
        if (message) {
          return message;
        }
      } catch {
        // Continue looking for a structured error in later NDJSON lines.
      }
    }
    return payload.toString("utf8").trim() || `Docker request failed with status ${statusCode}`;
  }
}

function queryString(query: Record<string, string>): string {
  const params = new URLSearchParams(query);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
