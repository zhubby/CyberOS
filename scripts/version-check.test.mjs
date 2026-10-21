import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { requiresVersionBump } from "./versioning.mjs";

describe("version policy", () => {
  it("requires a release bump for runtime, configuration, and packaging changes", () => {
    expect(requiresVersionBump("packages/api/src/server.ts")).toBe(true);
    expect(requiresVersionBump("packages/web/src/App.tsx")).toBe(true);
    expect(requiresVersionBump("packaging/debian/install")).toBe(true);
    expect(requiresVersionBump("scripts/release.mjs")).toBe(true);
  });

  it("allows documentation, CI, todo, and test-only changes without a release", () => {
    expect(requiresVersionBump("README.md")).toBe(false);
    expect(requiresVersionBump("docs/runbook.md")).toBe(false);
    expect(requiresVersionBump(".github/workflows/package-release.yml")).toBe(false);
    expect(requiresVersionBump(".context/compound-engineering/todos/001-ready-p2-task.md")).toBe(false);
    expect(requiresVersionBump("packages/api/src/server.test.ts")).toBe(false);
    expect(requiresVersionBump("packages/web/src/App.spec.tsx")).toBe(false);
  });

  it("checks pull requests and direct branch pushes against a base revision", async () => {
    const workflow = await readFile(new URL("../.github/workflows/package-release.yml", import.meta.url), "utf8");

    expect(workflow).toContain("github.event.pull_request.base.sha");
    expect(workflow).toContain("github.ref_type == 'branch' && github.event.before");
  });
});
