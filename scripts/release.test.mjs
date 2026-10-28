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
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "cyberos-release-"));
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
    expect(state.manifests[1].value.dependencies["@cyberos/shared"]).toBe("0.2.0");
    expect(state.docsManifest.version).toBe("0.2.0");
    expect(state.docsLock.packages["../packages/shared"].version).toBe("0.2.0");
    for (const { manifestPath, packageName } of PRODUCT_CARGO_PACKAGES) {
      expect(state.cargoManifests[manifestPath]).toContain('version = "0.2.0"');
      expect(state.cargoLock).toContain(`name = "${packageName}"\nversion = "0.2.0"`);
    }
    expect(state.debianChangelog).toContain("cyberos (0.2.0) unstable");
    expect(state.debianChangelog).toContain("* Add release traceability.");
  });

  it("ignores non-npm directories matched by a workspace glob", async () => {
    const state = await readVersionState(fixtureRoot);

    expect(state.manifests.map(({ relativePath }) => relativePath)).toEqual([
      "package.json",
      "packages/api/package.json",
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
    const apiPath = path.join(fixtureRoot, "packages/api/package.json");
    const apiManifest = JSON.parse(await readFile(apiPath, "utf8"));
    apiManifest.version = "0.0.9";
    await writeFile(apiPath, JSON.stringify(apiManifest));

    const state = await readVersionState(fixtureRoot);
    expect(versionStateErrors(state)).toContain("packages/api/package.json has version \"0.0.9\"; expected 0.1.0");
    await expect(prepareRelease(fixtureRoot, { increment: "patch", note: "Should fail." })).rejects.toThrow(
      /inconsistent/u
    );
  });

  it("reports documentation version drift", async () => {
    const docsPath = path.join(fixtureRoot, "docs/package.json");
    const docsManifest = JSON.parse(await readFile(docsPath, "utf8"));
    docsManifest.version = "0.0.9";
    await writeFile(docsPath, JSON.stringify(docsManifest));

    const state = await readVersionState(fixtureRoot);
    expect(versionStateErrors(state)).toContain(
      'docs/package.json has version "0.0.9"; expected 0.1.0'
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
  ["crates/alerter/Cargo.toml", "cyberos-alerter"],
  ["crates/bluetoothd/Cargo.toml", "cyberos-bluetoothd"],
  ["crates/downloader/Cargo.toml", "cyberos-downloader"],
  ["crates/host-accessd/Cargo.toml", "cyberos-host-accessd"],
  ["crates/hostd/Cargo.toml", "cyberos-hostd"],
  ["crates/indexer/Cargo.toml", "cyberos-indexer"],
  ["crates/monitor/Cargo.toml", "cyberos-monitor"],
  ["crates/photos/Cargo.toml", "cyberos-photos"],
  ["crates/terminald/Cargo.toml", "cyberos-terminald"],
  ["crates/tv-gamepad/Cargo.toml", "cyberos-tv-gamepad"],
  ["crates/vod-player/Cargo.toml", "cyberos-vod-player"],
  ["crates/monitoring-contracts/Cargo.toml", "cyberos-monitoring-contracts"]
].map(([manifestPath, packageName]) => ({ manifestPath, packageName }));

async function writeFixture(root) {
  await Promise.all([
    mkdir(path.join(root, "packages/api"), { recursive: true }),
    mkdir(path.join(root, "crates/alerter"), { recursive: true }),
    mkdir(path.join(root, "crates/bluetoothd"), { recursive: true }),
    mkdir(path.join(root, "crates/downloader"), { recursive: true }),
    mkdir(path.join(root, "crates/host-accessd"), { recursive: true }),
    mkdir(path.join(root, "crates/hostd"), { recursive: true }),
    mkdir(path.join(root, "crates/indexer"), { recursive: true }),
    mkdir(path.join(root, "crates/monitor"), { recursive: true }),
    mkdir(path.join(root, "crates/photos"), { recursive: true }),
    mkdir(path.join(root, "crates/terminald"), { recursive: true }),
    mkdir(path.join(root, "crates/tv-gamepad"), { recursive: true }),
    mkdir(path.join(root, "crates/vod-player"), { recursive: true }),
    mkdir(path.join(root, "crates/monitoring-contracts"), { recursive: true }),
    mkdir(path.join(root, "packages/shared"), { recursive: true }),
    mkdir(path.join(root, "docs"), { recursive: true }),
    mkdir(path.join(root, "packaging/debian"), { recursive: true })
  ]);

  const rootManifest = { name: "cyberos", version: "0.1.0", workspaces: ["packages/*"] };
  const apiManifest = {
    name: "@cyberos/api",
    version: "0.1.0",
    dependencies: { "@cyberos/shared": "0.1.0" }
  };
  const sharedManifest = { name: "@cyberos/shared", version: "0.1.0" };
  const docsManifest = { name: "@cyberos/docs", version: "0.1.0", private: true };
  const docsLock = {
    name: "@cyberos/docs",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "@cyberos/docs", version: "0.1.0" },
      "../packages/shared": { name: "@cyberos/shared", version: "0.1.0" }
    }
  };
  const lock = {
    name: "cyberos",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "cyberos", version: "0.1.0", workspaces: ["packages/*"] },
      "packages/api": {
        name: "@cyberos/api",
        version: "0.1.0",
        dependencies: { "@cyberos/shared": "0.1.0" }
      },
      "packages/shared": { name: "@cyberos/shared", version: "0.1.0" }
    }
  };

  await Promise.all([
    writeFile(path.join(root, "package.json"), JSON.stringify(rootManifest, null, 2)),
    writeFile(path.join(root, "packages/api/package.json"), JSON.stringify(apiManifest, null, 2)),
    writeFile(path.join(root, "packages/shared/package.json"), JSON.stringify(sharedManifest, null, 2)),
    writeFile(path.join(root, "docs/package.json"), JSON.stringify(docsManifest, null, 2)),
    writeFile(path.join(root, "docs/package-lock.json"), JSON.stringify(docsLock, null, 2)),
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
      "cyberos (0.1.0) unstable; urgency=medium\n\n  * Initial release.\n\n -- CyberOS Maintainers <maintainers@cyberos.local>  Thu, 20 Aug 2026 10:20:00 +0000\n"
    )
  ]);
}
