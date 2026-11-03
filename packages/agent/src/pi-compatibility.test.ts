import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { piAgentToolNames } from "./pi-agent.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const supportedPiVersion = "1.4.0";

describe("Pi compatibility contract", () => {
  it("keeps the package and lockfile exactly pinned to the documented version", async () => {
    const [manifestText, apiManifestText, lockText, compatibility] = await Promise.all([
      readFile(path.join(repositoryRoot, "packages/agent/package.json"), "utf8"),
      readFile(path.join(repositoryRoot, "packages/api/package.json"), "utf8"),
      readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
      readFile(path.join(repositoryRoot, "pi-compatibility.md"), "utf8")
    ]);
    const manifest = JSON.parse(manifestText) as { dependencies: Record<string, string> };
    const apiManifest = JSON.parse(apiManifestText) as { dependencies: Record<string, string> };
    const lock = JSON.parse(lockText) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };

    expect(manifest.dependencies["@earendil-works/pi-coding-agent"]).toBe(supportedPiVersion);
    expect(manifest.dependencies["@earendil-works/pi-mcp"]).toBe(supportedPiVersion);
    expect(apiManifest.dependencies["@earendil-works/pi-mcp"]).toBe(supportedPiVersion);
    expect(lock.packages["packages/agent"]?.dependencies?.["@earendil-works/pi-coding-agent"])
      .toBe(supportedPiVersion);
    expect(lock.packages["packages/agent"]?.dependencies?.["@earendil-works/pi-mcp"])
      .toBe(supportedPiVersion);
    expect(lock.packages["packages/api"]?.dependencies?.["@earendil-works/pi-mcp"])
      .toBe(supportedPiVersion);
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (/(?:^|\/)node_modules\/@earendil-works\/pi-[^/]+$/u.test(location)) {
        expect(entry.version, location).toBe(supportedPiVersion);
      }
    }
    for (const [workspace, packageName] of [
      ["agent", "pi-coding-agent"], ["agent", "pi-mcp"], ["api", "pi-mcp"]
    ] as const) {
      const manifestPath = findPackageJSON(`@earendil-works/${packageName}`,
        pathToFileURL(path.join(repositoryRoot, "packages", workspace, "package.json")));
      if (!manifestPath) throw new Error(`Cannot locate ${packageName} manifest`);
      const installed = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name: string; version: string;
      };
      expect(installed.name).toBe(`@earendil-works/${packageName}`);
      expect(installed.version).toBe(supportedPiVersion);
      expect(lock.packages[path.relative(repositoryRoot, path.dirname(manifestPath))]?.version).toBe(supportedPiVersion);
    }
    expect(compatibility).toContain(`Supported Pi version | \`${supportedPiVersion}\` (exactly pinned)`);
  });

  it("exposes every AgentSession method used by the CyberOS host", () => {
    const requiredMethods = [
      "prompt",
      "steer",
      "followUp",
      "abort",
      "waitForIdle",
      "compact",
      "setModel",
      "setThinkingLevel",
      "getSessionStats",
      "subscribe",
      "bindExtensions",
      "dispose"
    ];

    for (const method of requiredMethods) {
      expect(AgentSession.prototype).toHaveProperty(method, expect.any(Function));
    }
  });

  it("never exposes Pi's local bash tool in a CyberOS tool allowlist", () => {
    for (const options of [{ mcpServerNames: [] }, { mcpServerNames: ["cyberos"] }]) {
      expect(piAgentToolNames(options)).not.toContain("bash");
    }
  });
});
