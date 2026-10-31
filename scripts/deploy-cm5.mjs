#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { fileURLToPath, URL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { collectBuildInfo } from "./generate-build-info.mjs";
import { COMPONENTS } from "./cm5-runtime.mjs";
import { buildLocalRust } from "./cm5-build-local.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeComponents = ["api", "worker", "ops", "backup", "media-streamer", "mcp-cli"];
const guardedPaths = [
  "package-lock.json", "packages/db/src/connection.ts", "packages/db/src/schema.ts",
  "packages/db/src/migrations", "packages/monitoring/contracts/migrations",
  "packaging/systemd", "packaging/helpers", "packaging/scripts", "packaging/debian"
];
const sshOptions = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function parseOptions(args) {
  const options = { components: [], build: "auto", dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (!["--host", "--peer", "--user", "--components", "--build", "--rollback"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--components") {
      options.components = [...new Set(value.split(",").flatMap((name) => {
        if (name === "all") return Object.keys(COMPONENTS);
        if (name === "runtime") return runtimeComponents;
        if (!Object.hasOwn(COMPONENTS, name)) throw new Error(`Unknown component: ${name}`);
        return [name];
      }))];
    } else options[arg.slice(2)] = value;
  }
  if (options.host && !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(options.host)) throw new Error("Invalid SSH host; use user@hostname or an SSH config alias");
  if (!["auto", "local", "remote"].includes(options.build)) throw new Error("--build must be auto, local, or remote");
  if (options.rollback && !/^dev-[a-zA-Z0-9-]+$/u.test(options.rollback)) throw new Error("Invalid deployment id");
  if (options.rollback && options.components.length) throw new Error("Choose --rollback or --components");
  if (!options.help && !options.rollback && !options.components.length) throw new Error("--components is required (web, api, runtime, photos, all, ...)");
  return options;
}

export function resolvePeerHost(status, { peer, user }) {
  const wanted = peer.toLowerCase().replace(/\.$/u, "");
  const peers = Object.values(status.Peer ?? {}).filter((node) =>
    node.OS === "linux" && [node.HostName, node.DNSName].some((name) => name?.toLowerCase().replace(/\.$/u, "") === wanted));
  if (peers.length !== 1) throw new Error(`Tailscale must have exactly one Linux peer named ${peer}; found ${peers.length}`);
  const node = peers[0];
  if (!node.Online) throw new Error(`Tailscale peer ${peer} is offline`);
  const address = node.DNSName?.replace(/\.$/u, "") || node.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/u.test(ip));
  if (!address) throw new Error(`Tailscale peer ${peer} has no usable address`);
  const host = `${user}@${address}`;
  parseOptions(["--host", host, "--components", "web"]);
  return host;
}

export function buildPlan(options) {
  const plan = { local: [], remote: [] };
  for (const name of options.components) {
    plan[options.build === "remote" ? "remote" : "local"].push(name);
  }
  return plan;
}

export async function assertCompatible({ repoRoot: root, baselineCommit, components }) {
  if (components.every((name) => COMPONENTS[name].kind === "static")) return;
  if (!/^[a-f0-9]{40,64}$/u.test(baselineCommit ?? "")) throw new Error("Installed commit is unknown; use the package deployment workflow first");
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let changes;
  try {
    git(["cat-file", "-e", `${baselineCommit}^{commit}`]);
    const paths = [...guardedPaths];
    if (components.some((name) => COMPONENTS[name].kind === "rust")) paths.push("Cargo.lock", "Cargo.toml", ":(glob)crates/*/Cargo.toml", "rust-toolchain.toml");
    changes = [git(["diff", "--name-only", baselineCommit, "--", ...paths]), git(["ls-files", "--others", "--exclude-standard", "--", ...paths])].filter(Boolean);
  } catch { throw new Error("Installed commit is unavailable locally; fetch it or use the package deployment workflow"); }
  if (changes.length) throw new Error(`Schema, dependency, or packaging changes require the package deployment workflow:\n${changes.join("\n")}`);
  const baselineFiles = git(["ls-tree", "-r", "--name-only", baselineCommit]).split("\n");
  const currentFiles = git(["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n");
  const manifests = [...new Set([...baselineFiles, ...currentFiles])].filter((file) => /^(package\.json|packages\/[^/]+\/package\.json)$/u.test(file));
  const dependencyState = (manifest) => Object.fromEntries(["name", "version", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "engines", "os", "cpu"].map((key) => [key, manifest[key]]));
  for (const file of manifests) {
    let baseline;
    let current;
    try {
      baseline = JSON.parse(git(["show", `${baselineCommit}:${file}`]));
      current = JSON.parse(await readFile(path.join(root, file), "utf8"));
    } catch { throw new Error(`Changed workspace manifest ${file}; use the package deployment workflow`); }
    if (!isDeepStrictEqual(dependencyState(baseline), dependencyState(current))) throw new Error(`Changed dependency manifest ${file}; use the package deployment workflow`);
  }
}

async function run(command, args, options = {}) {
  console.log(`+ ${command} ${args.map(shellQuote).join(" ")}`);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit", ...options });
    let output = "";
    if (options.capture) child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

async function ssh(host, command, capture = false) {
  return await run("ssh", [...sshOptions, host, command], { capture });
}

async function sync(host, local, remote) {
  await run("rsync", ["-az", "-e", `ssh ${sshOptions.join(" ")}`, local, `${host}:${remote}`]);
}

async function buildLocal(name) {
  const output = name === "docs" ? "docs/dist" : `packages/${name}/dist`;
  await rm(path.join(repoRoot, output), { recursive: true, force: true });
  await run("npm", name === "docs" ? ["run", "docs:build"] : ["run", "build", "-w", `@cyberos/${name}`]);
  return path.join(repoRoot, output);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run deploy:cm5 -- --components web,api,photos [--peer scorpius --user zhubby | --host user@cm5] [--build auto|local|remote] [--dry-run]\n       npm run deploy:cm5 -- --rollback dev-ID [--host user@cm5]\nComponents: " + [...Object.keys(COMPONENTS), "runtime", "all"].join(", "));
    return;
  }
  let config = {};
  try { config = JSON.parse(await readFile(path.join(repoRoot, ".cyberos/cm5.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let host = options.host ?? process.env.CYBEROS_CM5_HOST ?? config.host;
  if (!host) {
    const peer = options.peer ?? process.env.CYBEROS_CM5_PEER ?? config.peer ?? "scorpius";
    const user = options.user ?? process.env.CYBEROS_CM5_USER ?? config.user ?? os.userInfo().username;
    const status = JSON.parse(await run("tailscale", ["status", "--json"], { capture: true }));
    host = resolvePeerHost(status, { peer, user });
  }
  parseOptions(["--host", host, "--components", "web"]);
  const plan = buildPlan(options);
  if (options.dryRun) {
    console.log(JSON.stringify({ host, components: options.components, rollback: options.rollback, ...plan }, null, 2));
    return;
  }
  // This preflight checks administrator access without starting a service or modifying the installation.
  const probeCode = `const fs=require("node:fs"),os=require("node:os");const p="/usr/lib/cyberos/";console.log(JSON.stringify({home:os.homedir(),platform:process.platform,arch:process.arch,node:process.execPath,nodeVersion:process.versions.node,uid:process.getuid(),build:JSON.parse(fs.readFileSync(p+"build-info.json","utf8"))}));`;
  const probe = JSON.parse(await ssh(host, `set -eu; if [ "$(id -u)" -ne 0 ]; then sudo -n true; fi; node -e ${shellQuote(probeCode)}`, true));
  if (probe.platform !== "linux" || probe.arch !== "arm64") throw new Error("CM5 target must be Linux arm64");
  const [nodeMajor, nodeMinor] = probe.nodeVersion.split(".").map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) throw new Error("CM5 requires Node.js 22.12+");
  if (!/^\/[a-zA-Z0-9/_.-]+$/u.test(probe.home)) throw new Error("Remote home must be an absolute path without shell metacharacters");
  const id = `dev-${new Date().toISOString().replace(/[^0-9]/gu, "")}-${process.pid}`;
  const cache = path.posix.join(probe.home, ".cache/cyberos-dev-deploy");
  const remote = path.posix.join(cache, "runs", id);
  const local = path.join(repoRoot, ".cyberos/cm5-deploy", id);
  await mkdir(local, { recursive: true, mode: 0o700 });
  await ssh(host, `umask 077; mkdir -p ${shellQuote(remote)}`);
  await sync(host, path.join(repoRoot, "scripts/cm5-runtime.mjs"), `${remote}/cm5-runtime.mjs`);
  const invoke = (action, target) => ssh(host, `${probe.uid === 0 ? "" : "sudo -n "}flock -n /run/lock/cyberos-deploy.lock ${shellQuote(probe.node)} ${shellQuote(`${remote}/cm5-runtime.mjs`)} ${action} ${shellQuote(target)}`);
  if (options.rollback) {
    await invoke("rollback", options.rollback);
    await ssh(host, `rm -rf -- ${shellQuote(remote)}`);
    return;
  }
  await assertCompatible({ repoRoot, baselineCommit: probe.build.commitSha, components: options.components });
  const build = await collectBuildInfo({ repoRoot, env: { ...process.env, CYBEROS_BUILD_SOURCE: "local" } });
  const lock = await readFile(path.join(repoRoot, "package-lock.json"));
  const manifest = {
    id, baselineCommit: probe.build.commitSha, build,
    packageLockSha256: createHash("sha256").update(lock).digest("hex"),
    components: options.components.map((name) => ({ name, ...COMPONENTS[name] }))
  };
  // Build and stage all artifacts before any runtime files or services are touched.
  const nativeNames = plan.local.filter((name) => COMPONENTS[name].kind === "rust");
  const nativeArtifacts = nativeNames.length
    ? await buildLocalRust({ repoRoot, names: nativeNames, outputRoot: path.join(local, "native") }) : {};
  for (const name of plan.local) {
    const output = COMPONENTS[name].kind === "rust" ? nativeArtifacts[name] : await buildLocal(name);
    const destination = path.join(local, "payload", COMPONENTS[name].path);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(output, destination, { recursive: true });
  }
  await rm(path.join(local, "native"), { recursive: true, force: true });
  await writeFile(path.join(local, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await sync(host, `${local}/`, `${remote}/`);
  if (plan.remote.length) {
    const source = `${remote}/source`;
    await ssh(host, `mkdir -p ${shellQuote(source)}`);
    await run("rsync", ["-az", ...[".git", "node_modules", "target", ".cyberos", "dist", ".astro", "coverage", "test-results", "playwright-report", ".env", ".env.*", "*.log"].flatMap((exclude) => ["--exclude", exclude]), "-e", `ssh ${sshOptions.join(" ")}`, `${repoRoot}/`, `${host}:${source}/`]);
    const rust = plan.remote.filter((name) => COMPONENTS[name].kind === "rust");
    const portable = plan.remote.filter((name) => COMPONENTS[name].kind !== "rust");
    const commands = ["set -eu", `cd ${shellQuote(source)}`, `export PATH=${shellQuote(path.posix.dirname(probe.node))}:"$HOME/.cargo/bin:$PATH"`];
    if (portable.length) {
      if (portable.some((name) => name !== "docs")) commands.push("npm ci --no-audit --no-fund");
      if (portable.includes("docs")) commands.push("npm --prefix docs ci --no-audit --no-fund");
      for (const name of portable) commands.push(name === "docs" ? "npm run docs:build" : `npm run build -w ${shellQuote(`@cyberos/${name}`)}`);
    }
    if (rust.length) commands.push(`CARGO_TARGET_DIR=${shellQuote(`${cache}/target`)} cargo build --locked --release ${rust.flatMap((name) => ["-p", `cyberos-${name}`, "--bin", `cyberos-${name}`]).map(shellQuote).join(" ")}`);
    for (const name of plan.remote) {
      const destination = `${remote}/payload/${COMPONENTS[name].path}`;
      const output = COMPONENTS[name].kind === "rust" ? `${cache}/target/release/cyberos-${name}` : `${source}/${name === "docs" ? "docs" : `packages/${name}`}/dist`;
      commands.push(`mkdir -p ${shellQuote(path.posix.dirname(destination))}`, `cp -a ${shellQuote(output)} ${shellQuote(destination)}`);
    }
    await ssh(host, `flock -n ${shellQuote(`${cache}/build.lock`)} bash -lc ${shellQuote(commands.join("\n"))}`);
  }
  await invoke("apply", remote);
  await ssh(host, `rm -rf -- ${shellQuote(remote)}`);
  await rm(path.join(local, "payload"), { recursive: true, force: true });
  console.log(`CM5 test deployment: ${id}\nSource: ${build.commitSha} (dirty=${build.dirty})\nComponents: ${options.components.join(", ")}\nBackup/receipt: /cyberos/dev-deploy/${id}\nRollback: npm run deploy:cm5 -- --host ${host} --rollback ${id}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`deploy-cm5: ${error.message}`); process.exitCode = 1; });
}
