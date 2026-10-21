import { describe, expect, it } from "vitest";
import type { DockerContainer, DockerImageSummary, DockerSummary } from "../api.js";
import {
  dockerImageUsage,
  sortDockerContainers,
  sortDockerImages,
  sortDockerNetworks,
  sortDockerVolumes
} from "./docker-inventory.js";

function container(name: string, id = name): DockerContainer {
  return {
    id,
    shortId: id.slice(0, 12),
    name,
    image: "alpine:latest",
    state: "running",
    status: "Up",
    ports: [],
    composeProject: null,
    composeService: null,
    cpuPercent: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    memoryPercent: null,
    createdAt: null
  };
}

function image(name: string | null, id: string, containerCount: number | null = 0): DockerImageSummary {
  return {
    id,
    shortId: id.replace(/^sha256:/u, "").slice(0, 12),
    tags: name ? [name] : [],
    digests: [],
    createdAt: null,
    sizeBytes: 0,
    sharedSizeBytes: null,
    architecture: null,
    containerCount
  };
}

describe("Docker inventory sorting", () => {
  it("sorts all inventories A-Z with case-insensitive natural ordering without mutation", () => {
    const containers = [container("worker10"), container("Worker2"), container("api")];
    const images = [image("team/app10:latest", "sha256:3"), image("Team/app2:latest", "sha256:2"), image(null, "sha256:1")];
    const networks: DockerSummary["networks"] = [
      { id: "3", name: "net10", driver: "bridge", scope: "local", containerCount: 0 },
      { id: "2", name: "Net2", driver: "bridge", scope: "local", containerCount: 0 },
      { id: "1", name: "backend", driver: "bridge", scope: "local", containerCount: 0 }
    ];
    const volumes: DockerSummary["volumes"] = [
      { name: "volume10", driver: "local", scope: "local", mountpoint: "" },
      { name: "Volume2", driver: "local", scope: "local", mountpoint: "" },
      { name: "archive", driver: "local", scope: "local", mountpoint: "" }
    ];

    expect(sortDockerContainers(containers).map((entry) => entry.name)).toEqual(["api", "Worker2", "worker10"]);
    expect(sortDockerImages(images).map((entry) => entry.id)).toEqual(["sha256:1", "sha256:2", "sha256:3"]);
    expect(sortDockerNetworks(networks).map((entry) => entry.name)).toEqual(["backend", "Net2", "net10"]);
    expect(sortDockerVolumes(volumes).map((entry) => entry.name)).toEqual(["archive", "Volume2", "volume10"]);
    expect(containers.map((entry) => entry.name)).toEqual(["worker10", "Worker2", "api"]);
    expect(images.map((entry) => entry.id)).toEqual(["sha256:3", "sha256:2", "sha256:1"]);
  });

  it("uses immutable IDs and then original order as stable tie-breakers", () => {
    const entries = [container("API", "b"), container("api", "a"), container("api", "a")];
    expect(sortDockerContainers(entries)).toEqual([entries[1], entries[2], entries[0]]);
  });
});

describe("Docker image usage", () => {
  it("maps occupied, unused, and unknown images without exposing counts", () => {
    expect(dockerImageUsage(image("app:latest", "sha256:1", 2))).toBe("in-use");
    expect(dockerImageUsage(image("app:latest", "sha256:2", 0))).toBe("unused");
    expect(dockerImageUsage(image("app:latest", "sha256:3", null))).toBe("unknown");
  });
});
