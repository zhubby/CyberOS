import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bumpVersion,
  compareStableVersions,
  prepareRelease,
  readVersionState,
  versionStateErrors
} from "./versioning.mjs";

let fixtureRoot;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "zos-release-"));
  await writeFixture(fixtureRoot);
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("release versioning", () => {
  it("calculates stable SemVer increments", () => {
    expect(bumpVersion("0.1.9", "patch")).toBe("0.1.10");
    expect(bumpVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(bumpVersion("0.1.9", "major")).toBe("1.0.0");
    expect(() => bumpVersion("0.1", "patch")).toThrow(/stable SemVer/u);
    expect(() => bumpVersion("0.1.0", "prerelease")).toThrow(/Unsupported release increment/u);
  });

  it("orders stable versions for monotonic CI checks", () => {
    expect(compareStableVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareStableVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareStableVersions("0.1.9", "0.2.0")).toBe(-1);
  });

  it("updates manifests, dependencies, lock entries, and packaging versions", async () => {
    await prepareRelease(fixtureRoot, {
      increment: "minor",
      note: "Add release traceability.",
      now: new Date("2026-09-14T08:00:00.000Z")
    });

    const state = await readVersionState(fixtureRoot);
    expect(state.version).toBe("0.2.0");
    expect(versionStateErrors(state)).toEqual([]);
    expect(state.manifests[1].value.dependencies["@zos/shared"]).toBe("0.2.0");
    for (const { manifestPath, packageName } of PRODUCT_CARGO_PACKAGES) {
      expect(state.cargoManifests[manifestPath]).toContain('version = "0.2.0"');
      expect(state.cargoLock).toContain(`name = "${packageName}"\nversion = "0.2.0"`);
    }
    expect(state.debianChangelog).toContain("zos (0.2.0) unstable");
    expect(state.debianChangelog).toContain("* Add release traceability.");
  });

  it("ignores non-npm directories matched by a workspace glob", async () => {
    const state = await readVersionState(fixtureRoot);

    expect(state.manifests.map(({ relativePath }) => relativePath)).toEqual([
      "package.json",
      "apps/api/package.json",
      "packages/shared/package.json"
    ]);
  });

  it("does not write files during dry-run preparation", async () => {
    const before = await readFile(path.join(fixtureRoot, "package.json"), "utf8");
    const result = await prepareRelease(fixtureRoot, {
      increment: "patch",
      note: "Preview the release.",
      write: false
    });

    expect(result.nextVersion).toBe("0.1.1");
    expect(await readFile(path.join(fixtureRoot, "package.json"), "utf8")).toBe(before);
  });

  it("reports version drift before preparing a release", async () => {
    const apiPath = path.join(fixtureRoot, "apps/api/package.json");
    const apiManifest = JSON.parse(await readFile(apiPath, "utf8"));
    apiManifest.version = "0.0.9";
    await writeFile(apiPath, JSON.stringify(apiManifest));

    const state = await readVersionState(fixtureRoot);
    expect(versionStateErrors(state)).toContain("apps/api/package.json has version \"0.0.9\"; expected 0.1.0");
    await expect(prepareRelease(fixtureRoot, { increment: "patch", note: "Should fail." })).rejects.toThrow(
      /inconsistent/u
    );
  });

  it.each(PRODUCT_CARGO_PACKAGES)("reports $packageName Cargo version drift", async ({ manifestPath, packageName }) => {
    await writeFile(
      path.join(fixtureRoot, manifestPath),
      `[package]\nname = "${packageName}"\nversion = "0.0.9"\n`
    );

    const state = await readVersionState(fixtureRoot);
    expect(versionStateErrors(state)).toContain(
      `${manifestPath} has version "0.0.9"; expected 0.1.0`
    );
  });
});

const PRODUCT_CARGO_PACKAGES = [
  ["apps/downloader/Cargo.toml", "zos-downloader"],
  ["apps/hostd/Cargo.toml", "zos-hostd"],
  ["apps/indexer/Cargo.toml", "zos-indexer"],
  ["apps/monitor/Cargo.toml", "zos-monitor"],
  ["apps/photostaff/Cargo.toml", "zos-photostaff"],
  ["apps/termux/Cargo.toml", "zos-termux"],
  ["apps/vod-player/Cargo.toml", "zos-vod-player"]
].map(([manifestPath, packageName]) => ({ manifestPath, packageName }));

async function writeFixture(root) {
  await Promise.all([
    mkdir(path.join(root, "apps/api"), { recursive: true }),
    mkdir(path.join(root, "apps/downloader"), { recursive: true }),
    mkdir(path.join(root, "apps/hostd"), { recursive: true }),
    mkdir(path.join(root, "apps/indexer"), { recursive: true }),
    mkdir(path.join(root, "apps/monitor"), { recursive: true }),
    mkdir(path.join(root, "apps/photostaff"), { recursive: true }),
    mkdir(path.join(root, "apps/termux"), { recursive: true }),
    mkdir(path.join(root, "apps/vod-player"), { recursive: true }),
    mkdir(path.join(root, "packages/shared"), { recursive: true }),
    mkdir(path.join(root, "packaging/debian"), { recursive: true }),
    mkdir(path.join(root, "packaging/appliance"), { recursive: true })
  ]);

  const rootManifest = { name: "zos", version: "0.1.0", workspaces: ["apps/*", "packages/*"] };
  const apiManifest = {
    name: "@zos/api",
    version: "0.1.0",
    dependencies: { "@zos/shared": "0.1.0" }
  };
  const sharedManifest = { name: "@zos/shared", version: "0.1.0" };
  const lock = {
    name: "zos",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "zos", version: "0.1.0", workspaces: ["apps/*", "packages/*"] },
      "apps/api": {
        name: "@zos/api",
        version: "0.1.0",
        dependencies: { "@zos/shared": "0.1.0" }
      },
      "packages/shared": { name: "@zos/shared", version: "0.1.0" }
    }
  };

  await Promise.all([
    writeFile(path.join(root, "package.json"), JSON.stringify(rootManifest, null, 2)),
    writeFile(path.join(root, "apps/api/package.json"), JSON.stringify(apiManifest, null, 2)),
    writeFile(path.join(root, "packages/shared/package.json"), JSON.stringify(sharedManifest, null, 2)),
    writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock, null, 2)),
    ...PRODUCT_CARGO_PACKAGES.map(({ manifestPath, packageName }) =>
      writeFile(
        path.join(root, manifestPath),
        `[package]\nname = "${packageName}"\nversion = "0.1.0"\n`
      )
    ),
    writeFile(
      path.join(root, "Cargo.lock"),
      `version = 4\n\n[[package]]\nname = "dependency"\nversion = "1.2.3"\n\n${PRODUCT_CARGO_PACKAGES.map(({ packageName }) => `[[package]]\nname = "${packageName}"\nversion = "0.1.0"\n`).join("\n")}`
    ),
    writeFile(
      path.join(root, "packaging/debian/changelog"),
      "zos (0.1.0) unstable; urgency=medium\n\n  * Initial release.\n\n -- ZOS Maintainers <maintainers@zos.local>  Thu, 20 Aug 2026 10:20:00 +0000\n"
    ),
    writeFile(
      path.join(root, "packaging/appliance/manifest.toml"),
      'name = "zos-appliance"\nversion = "0.1.0"\n'
    )
  ]);
}
