import { describe, expect, it } from "vitest";
import type { DockerContainerSummary, DockerImageSummary } from "@cyberos/shared";
import { resolveDockerImageOccupancy } from "./docker-service.js";

const image: DockerImageSummary = {
  id: "sha256:abc", shortId: "abc", tags: ["app:latest"], digests: [],
  createdAt: null, sizeBytes: 1, sharedSizeBytes: null, architecture: "amd64", containerCount: null
};
const container: DockerContainerSummary = {
  id: "one", shortId: "one", name: "app", image: "app:old", imageId: "sha256:abc",
  state: "running", status: "Up", ports: [], composeProject: null, composeService: null,
  cpuPercent: null, memoryUsageBytes: null, memoryLimitBytes: null, memoryPercent: null, createdAt: null
};

describe("Docker summary image occupancy", () => {
  it("counts running and stopped containers by image ID rather than tag", () => {
    const result = resolveDockerImageOccupancy([image], [container, { ...container, id: "two", state: "exited", imageId: "abc" }]);
    expect(result[0]?.containerCount).toBe(2);
    expect(image.containerCount).toBeNull();
  });

  it("reports zero for an empty inventory or unrelated image IDs", () => {
    expect(resolveDockerImageOccupancy([image], [])[0]?.containerCount).toBe(0);
    expect(resolveDockerImageOccupancy([image], [{ ...container, imageId: "sha256:other" }])[0]?.containerCount).toBe(0);
  });

  it("preserves unknown counts when container identity metadata is incomplete", () => {
    const { imageId: _imageId, ...legacyContainer } = container;
    expect(resolveDockerImageOccupancy([image], [{ ...container, imageId: null }])[0]?.containerCount).toBeNull();
    expect(resolveDockerImageOccupancy([{ ...image, containerCount: 3 }], [legacyContainer])[0]?.containerCount).toBe(3);
  });
});
