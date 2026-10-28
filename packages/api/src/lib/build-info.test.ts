import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBuildInfo, parseBuildInfo } from "./build-info.js";

// Package tests also run on installed appliances; never read their live metadata.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === "/usr/lib/cyberos/build-info.json") {
        return Promise.reject(new Error("Host metadata is outside the test fixture"));
      }
      return fs.readFile(...args);
    }
  };
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-api-build-info-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("build information loading", () => {
  it("loads a validated generated metadata file", async () => {
    const infoPath = path.join(tempDir, "metadata/build-info.json");
    await mkdir(path.dirname(infoPath), { recursive: true });
    await writeFile(
      infoPath,
      JSON.stringify({
        version: "0.2.0",
        commitSha: "abcdef0123456789",
        commitShortSha: "abcdef012345",
        tag: "v0.2.0",
        branch: "main",
        builtAt: "2026-09-14T00:00:00.000Z",
        source: "release",
        dirty: false,
        reproducible: false
      })
    );

    await expect(loadBuildInfo({ configuredPath: infoPath, cwd: tempDir })).resolves.toMatchObject({
      version: "0.2.0",
      commitShortSha: "abcdef012345",
      source: "release",
      dirty: false,
      reproducible: false
    });
  });

  it("falls back to the package version when metadata is missing or malformed", async () => {
    await writeFile(path.join(tempDir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    await writeFile(path.join(tempDir, "build-info.json"), "{not-json");

    await expect(loadBuildInfo({ configuredPath: "", cwd: tempDir })).resolves.toEqual({
      version: "0.2.0",
      commitSha: null,
      commitShortSha: null,
      tag: null,
      branch: null,
      builtAt: null,
      source: "unknown",
      dirty: null,
      reproducible: false
    });
  });

  it("rejects metadata with unexpected public field types", () => {
    expect(parseBuildInfo({ version: "0.2.0", source: "secret", dirty: "false" })).toBeNull();
  });

  it("rejects removed Nix build metadata", () => {
    expect(parseBuildInfo({
      version: "2.0.0",
      commitSha: "abcdef0123456789",
      commitShortSha: "abcdef012345",
      tag: null,
      branch: "main",
      builtAt: "2026-10-28T00:00:00.000Z",
      source: "nix",
      dirty: false,
      reproducible: true
    })).toBeNull();
  });

  it("rejects an invalid build timestamp before it reaches the web formatter", () => {
    expect(parseBuildInfo({
      version: "0.2.0",
      commitSha: "abcdef0123456789",
      commitShortSha: "abcdef012345",
      tag: "v0.2.0",
      branch: "main",
      builtAt: "not-a-date",
      source: "release",
      dirty: false,
      reproducible: false
    })).toBeNull();
  });
});
