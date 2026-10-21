import type { DockerContainer, DockerImageSummary, DockerSummary } from "../api.js";

type DockerNetwork = DockerSummary["networks"][number];
type DockerVolume = DockerSummary["volumes"][number];

export type DockerImageUsage = "in-use" | "unused" | "unknown";

const naturalCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true
});

export function sortDockerContainers(containers: DockerContainer[]): DockerContainer[] {
  return stableNaturalSort(containers, (container) => container.name, (container) => container.id);
}

export function sortDockerImages(images: DockerImageSummary[]): DockerImageSummary[] {
  return stableNaturalSort(images, (image) => image.tags[0] ?? image.shortId, (image) => image.id);
}

export function sortDockerNetworks(networks: DockerNetwork[]): DockerNetwork[] {
  return stableNaturalSort(networks, (network) => network.name, (network) => network.id);
}

export function sortDockerVolumes(volumes: DockerVolume[]): DockerVolume[] {
  return stableNaturalSort(volumes, (volume) => volume.name, (volume) => volume.name);
}

export function dockerImageUsage(image: DockerImageSummary): DockerImageUsage {
  if (image.containerCount === null) return "unknown";
  return image.containerCount > 0 ? "in-use" : "unused";
}

function stableNaturalSort<T>(
  values: T[],
  primary: (value: T) => string,
  identity: (value: T) => string
): T[] {
  return values
    .map((value, index) => ({ value, index }))
    .sort((left, right) =>
      naturalCollator.compare(primary(left.value), primary(right.value)) ||
      naturalCollator.compare(identity(left.value), identity(right.value)) ||
      left.index - right.index
    )
    .map(({ value }) => value);
}
