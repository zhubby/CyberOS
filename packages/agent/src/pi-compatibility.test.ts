import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { piAgentToolNames } from "./pi-agent.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const supportedPiVersion = "1.1.0";

describe("Pi compatibility contract", () => {
  it("keeps the package and lockfile exactly pinned to the documented version", async () => {
    const [manifestText, lockText, compatibility] = await Promise.all([
      readFile(path.join(repositoryRoot, "packages/agent/package.json"), "utf8"),
      readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
      readFile(path.join(repositoryRoot, "pi-compatibility.md"), "utf8")
    ]);
    const manifest = JSON.parse(manifestText) as { dependencies: Record<string, string> };
    const lock = JSON.parse(lockText) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };

    expect(manifest.dependencies["@earendil-works/pi-coding-agent"]).toBe(supportedPiVersion);
    expect(lock.packages["packages/agent"]?.dependencies?.["@earendil-works/pi-coding-agent"])
      .toBe(supportedPiVersion);
    expect(lock.packages["packages/agent/node_modules/@earendil-works/pi-coding-agent"]?.version)
      .toBe(supportedPiVersion);
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
