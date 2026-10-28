import type { DockerImageSummary, DockerRegistryCredential } from "../api.js";
import { parseDockerImageReference } from "@cyberos/shared/docker-images";

export function isValidDockerImageReference(value: string): boolean {
  return parseDockerImageReference(value) !== null;
}

export function filterDockerImages(images: DockerImageSummary[], query: string): DockerImageSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return images;
  }
  return images.filter((image) =>
    [image.id, image.shortId, ...image.tags, ...image.digests]
      .some((value) => value.toLocaleLowerCase().includes(needle))
  );
}

export function dockerImageDisplayName(image: DockerImageSummary): string {
  return image.tags[0] ?? image.shortId;
}

export function dockerImageDeleteTargets(image: DockerImageSummary): string[] {
  return image.tags.length ? image.tags : [image.id];
}

export function dockerImageRemovalBlocked(image: DockerImageSummary): boolean {
  return image.containerCount === null || image.containerCount > 0;
}

export function dockerRegistryAddressForImage(reference: string): string {
  return parseDockerImageReference(reference)?.serverAddress ?? "docker.io";
}

export function matchingDockerRegistry(
  reference: string,
  registries: DockerRegistryCredential[]
): DockerRegistryCredential | null {
  const address = parseDockerImageReference(reference)?.serverAddress;
  return registries.find((registry) => registry.serverAddress === address) ?? null;
}
