import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDeployment, rollbackDeployment } from "./cm5-runtime.mjs";

let fixture;
let runtimeRoot;
let deployRoot;
let stage;
const commit = "a".repeat(40);
const lock = "installed dependency lock\n";
const lockHash = createHash("sha256").update(lock).digest("hex");

beforeEach(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), "cyberos-cm5-runtime-"));
  runtimeRoot = path.join(fixture, "runtime");
  deployRoot = path.join(fixture, "deployments");
  stage = path.join(fixture, "stage");
  await mkdir(runtimeRoot);
  await mkdir(stage);
  await writeFile(path.join(runtimeRoot, "build-info.json"), JSON.stringify({ commitSha: commit }));
  await writeFile(path.join(runtimeRoot, "package-lock.json"), lock);
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function prepare(name = "web", overrides = {}) {
  const component = name === "api"
    ? { name, path: "apps/api/dist", kind: "node", units: ["cyberos-api.service"] }
    : { name, path: "apps/web/dist", kind: "static", units: [] };
  await mkdir(path.join(runtimeRoot, component.path), { recursive: true });
  await writeFile(path.join(runtimeRoot, component.path, "index.html"), "old component");
  await mkdir(path.join(stage, "payload", component.path), { recursive: true });
  await writeFile(path.join(stage, "payload", component.path, "index.html"), "new component");
  if (name === "api") {
    await writeFile(path.join(stage, "payload", component.path, "index.js"), "export {};\n");
  }
  const manifest = {
    id: "test-20261030",
    build: { version: "2.2.2", commitSha: "b".repeat(40), dirty: true },
    components: [component],
    baselineCommit: commit,
    packageLockSha256: lockHash,
    ...overrides
  };
  await writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

function host({ active = ["cyberos-api.service"], failHealth = false, failNewStart = false } = {}) {
  const units = new Set(active);
  const calls = [];
  let stopped = false;
  let startFailed = false;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "uname") return { stdout: args[0] === "-s" ? "Linux\n" : "aarch64\n" };
    if (command === "systemctl") {
      if (args[0] === "list-units") return { stdout: [...units].map((unit) => `${unit} loaded active running CyberOS`).join("\n") };
      if (args[0] === "show") {
        const unit = args.at(-1);
        if (args.includes("--property=ActiveState")) return { stdout: units.has(unit) ? "active\n" : "inactive\n" };
        return { stdout: "MainPID=42\nNRestarts=0\n" };
      }
      if (args[0] === "stop") {
        stopped = true;
        for (const unit of args.slice(1)) {
          units.delete(unit);
          if (unit === "cyberos-api.service") {
            for (const dependent of [...units]) {
              if (/cyberos-(worker@|downloader|bluetoothd|tv)/u.test(dependent)) units.delete(dependent);
            }
          }
        }
      }
      if (args[0] === "start") {
        if (failNewStart && stopped && !startFailed) {
          startFailed = true;
          throw new Error("new service failed to start");
        }
        for (const unit of args.slice(1)) units.add(unit);
      }
    }
    if (command === "curl" && failHealth) throw new Error("health unavailable");
    return { stdout: "" };
  };
  return { run, units, calls };
}

describe("CM5 component runtime deployment", () => {
  it("replaces only selected static assets, preserving official build metadata and recording a reversible backup", async () => {
    await prepare();
    const machine = host();
    const result = await applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run });
    expect(await readFile(path.join(runtimeRoot, "apps/web/dist/index.html"), "utf8")).toBe("new component");
    expect(JSON.parse(await readFile(path.join(runtimeRoot, "build-info.json"), "utf8"))).toEqual({ commitSha: commit });
    expect(JSON.parse(await readFile(path.join(result.recordRoot, "receipt.json"), "utf8")).status).toBe("applied");
    expect(machine.calls.some(([cmd, action]) => cmd === "systemctl" && action === "stop")).toBe(false);
    await rollbackDeployment({ id: "test-20261030", runtimeRoot, deployRoot, run: machine.run });
    expect(await readFile(path.join(runtimeRoot, "apps/web/dist/index.html"), "utf8")).toBe("old component");
  });

  it("restores every previously active API dependent including multiple workers and the TV target", async () => {
    await prepare("api");
    const active = ["cyberos-api.service", "cyberos-worker@1.service", "cyberos-worker@2.service", "cyberos-downloader.service", "cyberos-bluetoothd.service", "cyberos-tv.target", "cyberos-tv-chromium.service"];
    const machine = host({ active });
    await applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run });
    expect([...machine.units].sort()).toEqual(active.sort());
    expect(machine.calls.filter(([cmd, action]) => cmd === "systemctl" && action === "start")[0]).toEqual(["systemctl", "start", "cyberos-api.service"]);
  });

  it("rejects a mismatched installed baseline before touching runtime files", async () => {
    await prepare("web", { baselineCommit: "c".repeat(40) });
    const machine = host();
    await expect(applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run })).rejects.toThrow(/baseline/iu);
    expect(await readFile(path.join(runtimeRoot, "apps/web/dist/index.html"), "utf8")).toBe("old component");
  });

  it("rejects incompatible backend dependencies without stopping services", async () => {
    await prepare("api", { packageLockSha256: "0".repeat(64) });
    const machine = host();
    await expect(applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run })).rejects.toThrow(/dependenc|lock/iu);
    expect(machine.calls.some(([cmd, action]) => cmd === "systemctl" && action === "stop")).toBe(false);
  });

  it("restores files and all prior active units when the new service fails", async () => {
    await prepare("api");
    const active = ["cyberos-api.service", "cyberos-worker@2.service", "cyberos-downloader.service"];
    const machine = host({ active, failNewStart: true });
    await expect(applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run })).rejects.toThrow(/failed to start/u);
    expect(await readFile(path.join(runtimeRoot, "apps/api/dist/index.html"), "utf8")).toBe("old component");
    expect([...machine.units].sort()).toEqual(active.sort());
    expect(JSON.parse(await readFile(path.join(deployRoot, "test-20261030/receipt.json"), "utf8")).status).toBe("rolled-back");
  });

  it("rolls back static files when readiness checks fail", async () => {
    await prepare();
    const machine = host({ failHealth: true });
    await expect(applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run })).rejects.toThrow(/health/u);
    expect(await readFile(path.join(runtimeRoot, "apps/web/dist/index.html"), "utf8")).toBe("old component");
  });

  it("rejects staged symlinks and arbitrary component destinations", async () => {
    await prepare();
    await symlink(path.join(runtimeRoot, "package-lock.json"), path.join(stage, "payload/apps/web/dist/escape"));
    await expect(applyDeployment({ stage, runtimeRoot, deployRoot, run: host().run })).rejects.toThrow(/symlink/iu);
    await rm(path.join(stage, "payload/apps/web/dist/escape"));
    const manifest = JSON.parse(await readFile(path.join(stage, "manifest.json"), "utf8"));
    manifest.components[0].path = "../../state";
    await writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest));
    await expect(applyDeployment({ stage, runtimeRoot, deployRoot, run: host().run })).rejects.toThrow(/component|path/iu);
  });

  it("refuses an old manual rollback after a component has subsequently changed", async () => {
    await prepare();
    const machine = host();
    await applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run });
    await writeFile(path.join(runtimeRoot, "apps/web/dist/index.html"), "newer deployment");
    await expect(rollbackDeployment({ id: "test-20261030", runtimeRoot, deployRoot, run: machine.run })).rejects.toThrow(/changed|match|later/iu);
    expect(await readFile(path.join(runtimeRoot, "apps/web/dist/index.html"), "utf8")).toBe("newer deployment");
  });

  it("recovers an interrupted directory replacement from the durable receipt", async () => {
    await prepare();
    const machine = host();
    const result = await applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run });
    const receipt = result.receipt;
    receipt.status = "applying";
    await writeFile(path.join(result.recordRoot, "receipt.json"), JSON.stringify(receipt));
    // A process can exit after renaming the old directory aside and before
    // publishing the new directory. Recovery must not need the upload stage.
    await rm(path.join(runtimeRoot, "apps/web/dist"), { recursive: true });
    await rm(stage, { recursive: true });
    await rollbackDeployment({ id: receipt.id, runtimeRoot, deployRoot, run: machine.run });
    expect(await readFile(path.join(runtimeRoot, "apps/web/dist/index.html"), "utf8")).toBe("old component");
  });

  it("restores services stopped by an interrupted apply using the original activity snapshot", async () => {
    await prepare("api");
    const active = ["cyberos-api.service", "cyberos-worker@2.service", "cyberos-tv.target", "cyberos-tv-chromium.service"];
    const machine = host({ active });
    const result = await applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run });
    result.receipt.status = "applying";
    await writeFile(path.join(result.recordRoot, "receipt.json"), JSON.stringify(result.receipt));
    machine.units.clear();
    await rollbackDeployment({ id: result.receipt.id, runtimeRoot, deployRoot, run: machine.run });
    expect([...machine.units].sort()).toEqual(active.sort());
    expect(await readFile(path.join(runtimeRoot, "apps/api/dist/index.html"), "utf8")).toBe("old component");
  });

  it("records failed rollback checks after restoring files, without claiming the new deployment is still applied", async () => {
    await prepare();
    const machine = host();
    const result = await applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run });
    await expect(rollbackDeployment({ id: result.receipt.id, runtimeRoot, deployRoot, run: host({ failHealth: true }).run })).rejects.toThrow(/health/u);
    const receipt = JSON.parse(await readFile(path.join(result.recordRoot, "receipt.json"), "utf8"));
    expect(receipt.status).toBe("rollback-failed");
    expect(receipt.filesRestored).toBe(true);
    expect(await readFile(path.join(runtimeRoot, "apps/web/dist/index.html"), "utf8")).toBe("old component");
  });

  it("installs readable assets from a restrictive Mac umask and preserves original modes on rollback", async () => {
    await prepare();
    const installed = path.join(runtimeRoot, "apps/web/dist");
    const payload = path.join(stage, "payload/apps/web/dist");
    await chmod(installed, 0o750);
    await chmod(path.join(installed, "index.html"), 0o640);
    await chmod(payload, 0o700);
    await chmod(path.join(payload, "index.html"), 0o600);
    const machine = host();
    const result = await applyDeployment({ stage, runtimeRoot, deployRoot, run: machine.run });
    expect((await stat(installed)).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(installed, "index.html"))).mode & 0o777).toBe(0o644);
    await rollbackDeployment({ id: result.receipt.id, runtimeRoot, deployRoot, run: machine.run });
    expect((await stat(installed)).mode & 0o777).toBe(0o750);
    expect((await stat(path.join(installed, "index.html"))).mode & 0o777).toBe(0o640);
  });
});
