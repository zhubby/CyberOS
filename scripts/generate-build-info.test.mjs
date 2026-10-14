import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectBuildInfo, writeBuildInfo } from "./generate-build-info.mjs";

let repoRoot;

beforeEach(async () => {
  repoRoot = await mkdtemp(path.join(os.tmpdir(), "zos-build-info-"));
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ version: "0.2.0" }));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe("build metadata generation", () => {
  it("prefers explicit release metadata and normalizes its values", async () => {
    const info = await collectBuildInfo({
      repoRoot,
      env: {
        ZOS_BUILD_COMMIT_SHA: "ABCDEF0123456789",
        ZOS_BUILD_TAG: "v0.2.0",
        ZOS_BUILD_BRANCH: "main",
        ZOS_BUILD_TIME: "2026-09-14T08:00:00+08:00",
        ZOS_BUILD_SOURCE: "release",
        ZOS_BUILD_DIRTY: "false"
      },
      runGit: async () => {
        throw new Error("Git should not be required for explicit metadata");
      }
    });

    expect(info).toEqual({
      version: "0.2.0",
      commitSha: "abcdef0123456789",
      commitShortSha: "abcdef012345",
      tag: "v0.2.0",
      branch: "main",
      builtAt: "2026-09-14T00:00:00.000Z",
      source: "release",
      dirty: false
    });
  });

  it("uses Git checkout data for local builds", async () => {
    const gitValues = new Map([
      ["rev-parse HEAD", "0123456789abcdef\n"],
      ["describe --tags --exact-match HEAD", "v0.2.0\n"],
      ["branch --show-current", "feature/version\n"],
      ["status --porcelain=v1 --untracked-files=normal", " M apps/api/src/index.ts\n"]
    ]);
    const info = await collectBuildInfo({
      repoRoot,
      env: {},
      now: new Date("2026-09-14T02:03:04.000Z"),
      runGit: async (args) => gitValues.get(args.join(" ")) ?? ""
    });

    expect(info).toMatchObject({
      commitSha: "0123456789abcdef",
      tag: "v0.2.0",
      branch: "feature/version",
      source: "local",
      dirty: true
    });
    expect(info.builtAt).toBe("2026-09-14T02:03:04.000Z");
  });

  it("degrades to unknown when Git metadata is unavailable", async () => {
    const info = await collectBuildInfo({
      repoRoot,
      env: { SOURCE_DATE_EPOCH: "1789344000" },
      runGit: async () => {
        throw new Error("git unavailable");
      }
    });

    expect(info).toMatchObject({
      version: "0.2.0",
      commitSha: null,
      commitShortSha: null,
      tag: null,
      branch: null,
      source: "unknown",
      dirty: null
    });
    expect(info.builtAt).toBe("2026-09-14T00:00:00.000Z");
  });

  it("writes only the public build fields to the generated JSON file", async () => {
    const outputPath = await writeBuildInfo(repoRoot, {
      version: "0.2.0",
      commitSha: null,
      commitShortSha: null,
      tag: null,
      branch: null,
      builtAt: null,
      source: "unknown",
      dirty: null
    });
    const value = JSON.parse(await readFile(outputPath, "utf8"));

    expect(Object.keys(value).sort()).toEqual(
      ["branch", "builtAt", "commitSha", "commitShortSha", "dirty", "source", "tag", "version"].sort()
    );
  });
});
