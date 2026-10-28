import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("builds and validates the release manifest from explicit jq arguments", async () => {
    const workflow = await readFile(new URL("../.github/workflows/package-release.yml", import.meta.url), "utf8");

    for (const field of ["repository", "tag", "version", "commitSha", "architecture", "asset", "sha256"]) {
      expect(workflow).toContain(`${field}: $${field}`);
    }

    expect(workflow).toContain(".repository == $repository and");
    expect(workflow).toContain("release-manifest.json >/dev/null");
    expect(workflow).not.toContain("'{repository, tag, version, commitSha, architecture, asset, sha256}'");
    expect(workflow).not.toContain("relocate-mount");
    expect(workflow).not.toContain("migration-recovery");
  });
});
