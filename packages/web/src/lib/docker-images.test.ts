import { describe, expect, it } from "vitest";
import type { DockerImageSummary, DockerRegistryCredential } from "../api.js";
import {
  dockerImageDeleteTargets,
  dockerImageDisplayName,
  dockerImageRemovalBlocked,
  dockerRegistryAddressForImage,
  filterDockerImages,
  isValidDockerImageReference,
  matchingDockerRegistry
} from "./docker-images.js";

const image: DockerImageSummary = {
  id: "sha256:abcdef",
  shortId: "abcdef",
  tags: ["registry.example.com/team/app:latest", "registry.example.com/team/app:stable"],
  digests: ["registry.example.com/team/app@sha256:1234"],
  createdAt: "2026-09-16T00:00:00.000Z",
  sizeBytes: 1024,
  sharedSizeBytes: 256,
  architecture: "amd64",
  containerCount: 0
};

const registry: DockerRegistryCredential = {
  id: "registry-1",
  name: "Private",
  serverAddress: "registry.example.com",
  username: "builder",
  credentialConfigured: true,
  updatedAt: "2026-09-16T00:00:00.000Z"
};

describe("Docker image UI helpers", () => {
  it("blocks image removal for occupied or unknown references", () => {
    expect(dockerImageRemovalBlocked(image)).toBe(false);
    expect(dockerImageRemovalBlocked({ ...image, containerCount: 1 })).toBe(true);
    expect(dockerImageRemovalBlocked({ ...image, containerCount: null })).toBe(true);
  });
  it("searches tags, digests, and ids case-insensitively", () => {
    expect(filterDockerImages([image], "STABLE")).toEqual([image]);
    expect(filterDockerImages([image], "sha256:1234")).toEqual([image]);
    expect(filterDockerImages([image], "missing")).toEqual([]);
  });

  it("uses a tag as the display name and falls back to the short id", () => {
    expect(dockerImageDisplayName(image)).toBe("registry.example.com/team/app:latest");
    expect(dockerImageDisplayName({ ...image, tags: [] })).toBe("abcdef");
  });

  it("requires a concrete tag for tagged images and the id for dangling images", () => {
    expect(dockerImageDeleteTargets(image)).toEqual(image.tags);
    expect(dockerImageDeleteTargets({ ...image, tags: [] })).toEqual([image.id]);
  });

  it("matches Docker Hub aliases and exact private registries", () => {
    expect(dockerRegistryAddressForImage("nginx:latest")).toBe("docker.io");
    expect(dockerRegistryAddressForImage(`library/nginx@sha256:${"a".repeat(64)}`)).toBe("docker.io");
    expect(dockerRegistryAddressForImage("index.docker.io/library/nginx")).toBe("docker.io");
    expect(dockerRegistryAddressForImage("registry.example.com:5000/team/app:tag")).toBe("registry.example.com:5000");
    expect(matchingDockerRegistry("registry.example.com/team/app:latest", [registry])).toEqual(registry);
    expect(matchingDockerRegistry("quay.io/team/app:latest", [registry])).toBeNull();
  });

  it("rejects empty, URL-like, and whitespace-containing references", () => {
    expect(isValidDockerImageReference("nginx:latest")).toBe(true);
    expect(isValidDockerImageReference(`registry.example.com/team/app@sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isValidDockerImageReference("")).toBe(false);
    expect(isValidDockerImageReference("https://registry.example.com/app")).toBe(false);
    expect(isValidDockerImageReference("team/my image")).toBe(false);
    expect(isValidDockerImageReference("team//image")).toBe(false);
    expect(isValidDockerImageReference("image@sha256:1234")).toBe(false);
    expect(matchingDockerRegistry("registry.example.com/team//app", [registry])).toBeNull();
  });
});
