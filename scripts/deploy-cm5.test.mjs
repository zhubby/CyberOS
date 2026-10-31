import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { assertCompatible, buildPlan, parseOptions, resolvePeerHost, shellQuote } from "./deploy-cm5.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("CM5 development deployment", () => {
  it("discovers the named Linux peer without persisting its address", () => {
    const status = { Peer: {
      first: { HostName: "other", DNSName: "other.example.ts.net.", OS: "linux", Online: true },
      cm5: { HostName: "Scorpius", DNSName: "scorpius.example.ts.net.", OS: "linux", Online: true, TailscaleIPs: ["100.64.1.2"] }
    } };
    expect(resolvePeerHost(status, { peer: "scorpius", user: "zhubby" })).toBe("zhubby@scorpius.example.ts.net");
    status.Peer.cm5.Online = false;
    expect(() => resolvePeerHost(status, { peer: "scorpius", user: "zhubby" })).toThrow(/offline/u);
    expect(() => resolvePeerHost(status, { peer: "missing", user: "zhubby" })).toThrow(/exactly one/u);
  });
  it("builds every component on the development Mac unless remote is explicitly selected", () => {
    expect(buildPlan(parseOptions(["--components", "web,api,photos"]))).toEqual({
      local: ["web", "api", "photos"], remote: []
    });
    expect(buildPlan(parseOptions(["--components", "photos", "--build", "local"]))).toEqual({ local: ["photos"], remote: [] });
    expect(buildPlan(parseOptions(["--components", "web,photos", "--build", "remote"]))).toEqual({ local: [], remote: ["web", "photos"] });
  });

  it("requires explicit components and rejects unknown options and shell-like hosts", () => {
    expect(() => parseOptions([])).toThrow(/components/u);
    expect(() => parseOptions(["--components", "unknown"])).toThrow(/component/u);
    expect(() => parseOptions(["--components", "web", "--skip-checks"])).toThrow(/Unknown/u);
    expect(() => parseOptions(["--components", "web", "--host", "-oProxyCommand=bad"])).toThrow(/host/u);
    expect(() => parseOptions(["--rollback", "../../state"])).toThrow(/deployment/u);
    expect(shellQuote("a'b $(touch x)")).toBe("'a'\\''b $(touch x)'");
  });

  it("expands runtime consumers once for shared source changes", () => {
    expect(parseOptions(["--components", "runtime,api"]).components).toEqual([
      "api", "worker", "ops", "backup", "media-streamer", "mcp-cli"
    ]);
  });

  it("prints a plan without contacting SSH or building", () => {
    const result = spawnSync(process.execPath, ["scripts/deploy-cm5.mjs", "--host", "test@cm5.invalid", "--components", "web,photos", "--dry-run"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("test@cm5.invalid");
    expect(result.stdout).toContain('"remote": []');
    expect(result.stdout).toContain('"photos"');
  });

  it("refuses backend swaps across schema or packaging changes, including new migrations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-dev-deploy-"));
    roots.push(root);
    await mkdir(path.join(root, "packages/db/src/migrations"), { recursive: true });
    await writeFile(path.join(root, "packages/db/src/schema.ts"), "baseline schema\n");
    await writeFile(path.join(root, "package-lock.json"), "{}\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { fastify: "5.0.0" } }));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    const baselineCommit = git("rev-parse", "HEAD");
    await expect(assertCompatible({ repoRoot: root, baselineCommit, components: ["api"] })).resolves.toBeUndefined();
    await writeFile(path.join(root, "packages/db/src/migrations/new.ts"), "new schema\n");
    await expect(assertCompatible({ repoRoot: root, baselineCommit, components: ["api"] })).rejects.toThrow(/package.*deploy|package.*workflow/u);
    await expect(assertCompatible({ repoRoot: root, baselineCommit, components: ["web"] })).resolves.toBeUndefined();
    await rm(path.join(root, "packages/db/src/migrations/new.ts"));
    await writeFile(path.join(root, "package-lock.json"), "{\"changed\":true}\n");
    await expect(assertCompatible({ repoRoot: root, baselineCommit, components: ["worker"] })).rejects.toThrow(/package.*deploy|package.*workflow/u);
    await writeFile(path.join(root, "package-lock.json"), "{}\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { fastify: "5.0.0" }, scripts: { "deploy:cm5": "node scripts/deploy-cm5.mjs" } }));
    await expect(assertCompatible({ repoRoot: root, baselineCommit, components: ["api"] })).resolves.toBeUndefined();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { fastify: "6.0.0" } }));
    await expect(assertCompatible({ repoRoot: root, baselineCommit, components: ["api"] })).rejects.toThrow(/package.*deploy|package.*workflow/u);
    expect(await readFile(path.join(root, "packages/db/src/schema.ts"), "utf8")).toBe("baseline schema\n");
  });
});
