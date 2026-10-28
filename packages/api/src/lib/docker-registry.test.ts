import { describe, expect, it } from "vitest";
import type { DockerRegistryCredentialRecord } from "@cyberos/db";
import {
  dockerConfigAuths,
  dockerRegistryAuthHeader,
  dockerRegistryForImage,
  findDockerRegistryCredential,
  normalizeDockerImageReference,
  normalizeDockerRegistryAddress,
  redactDockerRegistrySecrets,
  toPublicDockerRegistryCredential
} from "./docker-registry.js";

const records: DockerRegistryCredentialRecord[] = [
  registry("hub", "Docker Hub", "docker.io", "hub-user", "hub-token"),
  registry("private", "Private", "registry.example.com:5000", "builder", "private-token")
];
const privateRegistry = records[1]!;

describe("Docker registry credentials", () => {
  it("normalizes Docker Hub aliases and private registry hosts", () => {
    expect(normalizeDockerRegistryAddress("INDEX.DOCKER.IO")).toBe("docker.io");
    expect(normalizeDockerRegistryAddress("registry-1.docker.io")).toBe("docker.io");
    expect(normalizeDockerRegistryAddress("Registry.Example.com:5000")).toBe("registry.example.com:5000");
    expect(normalizeDockerRegistryAddress("Registry.Example.com:80")).toBe("registry.example.com:80");
    expect(normalizeDockerRegistryAddress("[2001:db8::1]:5000")).toBe("[2001:db8::1]:5000");
  });

  it("rejects registry URLs, paths, credentials, and malformed image references", () => {
    expect(() => normalizeDockerRegistryAddress("https://registry.example.com")).toThrow(/hostname or IP/);
    expect(() => normalizeDockerRegistryAddress("registry.example.com/team")).toThrow(/hostname or IP/);
    expect(() => normalizeDockerRegistryAddress("user@registry.example.com")).toThrow(/hostname or IP/);
    expect(() => normalizeDockerImageReference("https://registry.example.com/team/app")).toThrow(/invalid/);
    expect(() => normalizeDockerImageReference("team/app latest")).toThrow(/invalid/);
  });

  it("matches unqualified, tagged, digest, localhost, and private registry references", () => {
    expect(dockerRegistryForImage("alpine:latest")).toBe("docker.io");
    expect(dockerRegistryForImage(`library/alpine@sha256:${"a".repeat(64)}`)).toBe("docker.io");
    expect(dockerRegistryForImage("docker.io/library/alpine:latest")).toBe("docker.io");
    expect(dockerRegistryForImage("registry.example.com:5000/team/app:2")).toBe("registry.example.com:5000");
    expect(dockerRegistryForImage("localhost/team/app:latest")).toBe("localhost");
    expect(findDockerRegistryCredential(records, "alpine")?.id).toBe("hub");
    expect(findDockerRegistryCredential(records, "registry.example.com:5000/team/app")?.id).toBe("private");
    expect(findDockerRegistryCredential(records, "registry.other.example/team/app")).toBeNull();
  });

  it("encodes Engine and Compose authentication without exposing secrets publicly", () => {
    const authHeader = dockerRegistryAuthHeader(privateRegistry);
    const decoded = JSON.parse(Buffer.from(authHeader, "base64url").toString("utf8"));
    expect(decoded).toEqual({
      username: "builder",
      password: "private-token",
      serveraddress: "registry.example.com:5000"
    });
    const paddedRecord = registry("padded", "Padded", "registry.example.com", "u", "p");
    expect(dockerRegistryAuthHeader(paddedRecord)).toMatch(/==$/u);
    expect(dockerRegistryAuthHeader(paddedRecord).length % 4).toBe(0);
    expect(authHeader).not.toMatch(/[+/]/u);
    expect(dockerConfigAuths(records)).toEqual({
      "https://index.docker.io/v1/": { auth: Buffer.from("hub-user:hub-token").toString("base64") },
      "registry.example.com:5000": { auth: Buffer.from("builder:private-token").toString("base64") }
    });
    expect(toPublicDockerRegistryCredential(privateRegistry)).toEqual({
      id: "private",
      name: "Private",
      serverAddress: "registry.example.com:5000",
      username: "builder",
      credentialConfigured: true,
      updatedAt: "2026-09-16T00:00:00.000Z"
    });
    expect(JSON.stringify(toPublicDockerRegistryCredential(privateRegistry))).not.toContain("private-token");
  });

  it("redacts configured credentials and authorization headers from errors", () => {
    expect(redactDockerRegistrySecrets(
      "pull failed private-token X-Registry-Auth=abc Bearer secret",
      records
    )).toBe("pull failed [redacted] X-Registry-Auth=[redacted] Bearer [redacted]");
    const encoded = dockerRegistryAuthHeader(privateRegistry);
    const composeAuth = Buffer.from("builder:private-token").toString("base64");
    expect(redactDockerRegistrySecrets(`${encoded} ${composeAuth}`, records)).toBe("[redacted] [redacted]");
    const escaped = registry("escaped", "Escaped", "docker.io", "user", "secret\"\\token");
    expect(redactDockerRegistrySecrets(JSON.stringify({ password: escaped.password }), [escaped])).toBe('{"password":"[redacted]"}');
    const long = registry("long", "Long", "docker.io", "user", "s".repeat(1000));
    expect(redactDockerRegistrySecrets(`failed ${long.password}`, [long])).toBe("failed [redacted]");
  });
});

function registry(
  id: string,
  name: string,
  serverAddress: string,
  username: string,
  password: string
): DockerRegistryCredentialRecord {
  return {
    id,
    name,
    serverAddress,
    username,
    password,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z"
  };
}
