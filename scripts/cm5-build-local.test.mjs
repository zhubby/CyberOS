import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLocalRust } from "./cm5-build-local.mjs";

let fixture;
let repoRoot;
let outputRoot;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberos-cm5-local-build-")));
  repoRoot = path.join(fixture, "source with spaces");
  outputRoot = path.join(fixture, "artifacts");
  await mkdir(path.join(repoRoot, "scripts"), { recursive: true });
  await writeFile(path.join(repoRoot, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.95.0"\n');
  await writeFile(path.join(repoRoot, "scripts/cm5-builder.Dockerfile"), "FROM rust:1.95.0-bookworm\n");
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

function elf() {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(183, 18);
  return bytes;
}

function docker({ endpoint = "unix:///Users/example/.orbstack/run/docker.sock", emit = true, failBuild = false, badArtifact = false } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "context" && args[1] === "show") return "orbstack\n";
    if (args[0] === "context" && args[1] === "inspect") return JSON.stringify(endpoint);
    if (args.includes("build") && failBuild) throw new Error("container build failed");
    if (args.includes("run") && emit) {
      for (const name of ["terminald", "photos"]) {
        await writeFile(path.join(outputRoot, `cyberos-${name}`), badArtifact ? Buffer.from("Mach-O executable") : elf());
        await chmod(path.join(outputRoot, `cyberos-${name}`), 0o755);
      }
    }
    return "";
  };
  return { calls, run };
}

describe("local Linux arm64 Rust builder", () => {
  it("builds in the selected local Docker context with read-only sources and isolated native caches", async () => {
    const machine = docker();
    const outputs = await buildLocalRust({ repoRoot, outputRoot, names: ["terminald", "photos"], run: machine.run });
    expect(outputs).toEqual({ terminald: path.join(outputRoot, "cyberos-terminald"), photos: path.join(outputRoot, "cyberos-photos") });
    expect((await stat(outputs.terminald)).mode & 0o777).toBe(0o755);
    const container = machine.calls.find((call) => call.includes("run"));
    expect(container.slice(0, 4)).toEqual(["docker", "--context", "orbstack", "run"]);
    expect(container).toContain("linux/arm64");
    expect(container).toContain(`type=bind,src=${repoRoot},dst=/source,readonly`);
    expect(container).toContain(`type=bind,src=${outputRoot},dst=/output`);
    expect(container.some((arg) => /^type=volume,src=cyberos-cm5-target-[a-f0-9]+,dst=\/target$/u.test(arg))).toBe(true);
    expect(container.some((arg) => /^type=volume,src=cyberos-cm5-cargo-[a-f0-9]+,dst=\/cargo$/u.test(arg))).toBe(true);
    expect(machine.calls.filter((call) => call.includes("build") || call.includes("run")).every((call) => call[1] === "--context" && call[2] === "orbstack")).toBe(true);
    expect(await readFile(path.join(repoRoot, "rust-toolchain.toml"), "utf8")).toContain('"1.95.0"');
  });

  it("refuses a remote Docker daemon before creating artifacts or building anything", async () => {
    const machine = docker({ endpoint: "ssh://build.example.org" });
    await expect(buildLocalRust({ repoRoot, outputRoot, names: ["terminald"], run: machine.run })).rejects.toThrow(/local|Unix/iu);
    expect(machine.calls.some((call) => call.includes("run") || call.includes("build"))).toBe(false);
    await expect(stat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported components and toolchain drift before invoking Docker", async () => {
    const machine = docker();
    await expect(buildLocalRust({ repoRoot, outputRoot, names: ["api"], run: machine.run })).rejects.toThrow(/Rust|component/u);
    await writeFile(path.join(repoRoot, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.96.0"\n');
    await expect(buildLocalRust({ repoRoot, outputRoot, names: ["terminald"], run: machine.run })).rejects.toThrow(/toolchain|1\.95/u);
    expect(machine.calls).toEqual([]);
  });

  it("does not reuse a stale artifact when a new container build fails", async () => {
    await mkdir(outputRoot);
    const stale = path.join(outputRoot, "cyberos-terminald");
    await writeFile(stale, elf());
    const machine = docker({ failBuild: true });
    await expect(buildLocalRust({ repoRoot, outputRoot, names: ["terminald"], run: machine.run })).rejects.toThrow(/build failed/u);
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing output or a Mac executable even when Docker reports success", async () => {
    await expect(buildLocalRust({ repoRoot, outputRoot, names: ["terminald"], run: docker({ emit: false }).run })).rejects.toThrow(/artifact|ENOENT/iu);
    await expect(buildLocalRust({ repoRoot, outputRoot, names: ["terminald"], run: docker({ badArtifact: true }).run })).rejects.toThrow(/ELF|arm64/u);
  });

  it("passes each selected crate and binary to Cargo when the container shell actually executes", async () => {
    const machine = docker();
    await buildLocalRust({ repoRoot, outputRoot, names: ["terminald", "photos"], run: machine.run });
    const container = machine.calls.find((call) => call.includes("run"));
    const bash = container.indexOf("bash");
    const fakeBin = path.join(fixture, "fake-bin");
    await mkdir(fakeBin);
    await writeFile(path.join(fakeBin, "rustc"), '#!/bin/sh\nprintf "rustc 1.95.0 (fixture)\\n"\n', { mode: 0o755 });
    await writeFile(path.join(fakeBin, "cargo"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CM5_TEST_ARGS"\nexit 17\n', { mode: 0o755 });
    const argsPath = path.join(fixture, "cargo-args.txt");
    const result = spawnSync("bash", container.slice(bash + 1), { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, CM5_TEST_ARGS: argsPath } });
    expect(result.status).toBe(17);
    expect((await readFile(argsPath, "utf8")).trim().split("\n")).toEqual([
      "build", "--locked", "--release", "--target", "aarch64-unknown-linux-gnu",
      "-p", "cyberos-terminald", "--bin", "cyberos-terminald", "-p", "cyberos-photos", "--bin", "cyberos-photos"
    ]);
  });
});
