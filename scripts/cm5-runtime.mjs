#!/usr/bin/env node
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RUNTIME_ROOT = "/usr/lib/cyberos";
const DEPLOY_ROOT = "/cyberos/dev-deploy";
const UNIT_PATTERN = /^cyberos-[a-z0-9@_.-]+\.(service|timer|target)$/u;
const SCHEDULED_JOB_PATTERN = /^cyberos-(health|maintenance|backup-daily|backup-weekly)\.service$/u;

// These paths mirror packaging/debian/install. Never accept a caller-provided
// destination or unit outside this list, even when the manifest is malformed.
export const COMPONENTS = Object.freeze({
  web: { path: "apps/web/dist", kind: "static", units: [] },
  docs: { path: "docs/dist", kind: "static", units: [] },
  api: { path: "apps/api/dist", kind: "node", units: ["cyberos-api.service"] },
  worker: { path: "apps/worker/dist", kind: "node", units: ["cyberos-worker@*.service"] },
  ops: { path: "apps/ops/dist", kind: "node", units: ["cyberos-health.service", "cyberos-maintenance.service"] },
  backup: { path: "apps/backup/dist", kind: "node", units: ["cyberos-backup-daily.service", "cyberos-backup-weekly.service"] },
  "media-streamer": { path: "apps/media-streamer/dist", kind: "node", units: ["cyberos-media-streamer.service"] },
  "mcp-cli": { path: "apps/mcp-cli/dist", kind: "node", units: [] },
  ...Object.fromEntries([
    "indexer", "monitor", "alerter", "photos", "downloader", "hostd",
    "host-accessd", "terminald", "bluetoothd", "vod-player", "tv-gamepad"
  ].map((name) => [name, { path: `bin/cyberos-${name}`, kind: "rust", units: [`cyberos-${name}.service`] }]))
});

async function defaultRun(command, args) {
  return execFileAsync(command, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
}

async function output(run, command, args) {
  const result = await run(command, args);
  return (typeof result === "string" ? result : result?.stdout ?? "").trim();
}

async function ensureHost(run) {
  if (await output(run, "uname", ["-s"]) !== "Linux" || !["aarch64", "arm64"].includes(await output(run, "uname", ["-m"]))) {
    throw new Error("CM5 runtime deployment requires Linux arm64");
  }
}

function validateId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/u.test(id)) throw new Error("Invalid deployment id");
}

function validateComponents(components) {
  if (!Array.isArray(components) || !components.length) throw new Error("No deployment components");
  const seen = new Set();
  return components.map((component) => {
    const expected = COMPONENTS[component?.name];
    if (!expected || seen.has(component.name) || component.path !== expected.path || component.kind !== expected.kind ||
      JSON.stringify(component.units) !== JSON.stringify(expected.units)) {
      throw new Error(`Invalid component path, kind, or units: ${component?.name}`);
    }
    seen.add(component.name);
    return { name: component.name, ...expected };
  });
}

async function exists(filePath) {
  try { await lstat(filePath); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function realDirectory(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected real directory without symlinks: ${directory}`);
}

async function safeAncestors(root, relative) {
  await realDirectory(root);
  let cursor = root;
  for (const part of relative.split("/").slice(0, -1)) {
    cursor = path.join(cursor, part);
    if (await exists(cursor)) await realDirectory(cursor);
    else await mkdir(cursor, { mode: 0o755 });
  }
}

async function inspectTree(filePath, hash = createHash("sha256"), relative = ".") {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Symlink in deployment component: ${filePath}`);
  hash.update(`${relative}\0${stat.mode & 0o777}\0${stat.isFile() ? stat.size : 0}\0`);
  if (stat.isDirectory()) {
    hash.update("directory\0");
    for (const name of (await readdir(filePath)).sort()) await inspectTree(path.join(filePath, name), hash, `${relative}/${name}`);
  } else if (stat.isFile()) {
    hash.update("file\0");
    const handle = await open(filePath, "r");
    try {
      const buffer = new Uint8Array(1024 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally { await handle.close(); }
  } else throw new Error(`Unsupported component file: ${filePath}`);
  return hash;
}

async function treeHash(filePath) {
  return (await inspectTree(filePath)).digest("hex");
}

async function normalizePayload(filePath, executable = false) {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Symlink in deployment component: ${filePath}`);
  if (stat.isDirectory()) {
    await chmod(filePath, 0o755);
    for (const name of await readdir(filePath)) await normalizePayload(path.join(filePath, name));
  } else if (stat.isFile()) await chmod(filePath, executable ? 0o755 : 0o644);
  else throw new Error(`Unsupported component file: ${filePath}`);
}

async function validatePayload(payloadRoot, component) {
  await safeAncestors(payloadRoot, component.path);
  const source = path.join(payloadRoot, component.path);
  // Mac's developer umask must not make root-installed assets unreadable to
  // the cyberos service user. Only new payload is normalized; backups retain
  // the original runtime modes for an exact rollback.
  await normalizePayload(source, component.kind === "rust");
  const stat = await lstat(source);
  if (component.kind === "rust") {
    if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) throw new Error(`Expected executable Rust payload: ${component.name}`);
    const handle = await open(source, "r");
    try {
      const header = Buffer.alloc(20);
      const { bytesRead } = await handle.read(header);
      if (bytesRead !== 20 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 183) {
        throw new Error(`Rust payload must be an arm64 Linux ELF binary: ${component.name}`);
      }
    } finally { await handle.close(); }
  } else {
    await realDirectory(source);
    const entry = component.kind === "static" ? "index.html" : "index.js";
    const entryStat = await lstat(path.join(source, entry));
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error(`Missing component entry: ${component.name}/${entry}`);
  }
  return treeHash(source);
}

async function saveReceipt(recordRoot, receipt) {
  const temporary = path.join(recordRoot, "receipt.json.tmp");
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path.join(recordRoot, "receipt.json"));
}

async function activeUnits(run) {
  const listing = await output(run, "systemctl", ["list-units", "--state=active", "--plain", "--no-legend", "cyberos-*"]);
  return [...new Set(listing.split("\n").map((line) => line.trim().split(/\s+/u)[0]).filter((unit) => UNIT_PATTERN.test(unit)))];
}

async function isActive(run, unit) {
  return await output(run, "systemctl", ["show", "--property=ActiveState", "--value", unit]) === "active";
}

function selectedUnits(components, before) {
  const units = components.flatMap((component) => component.units).flatMap((unit) => unit === "cyberos-worker@*.service"
    ? before.filter((active) => /^cyberos-worker@[^/]+\.service$/u.test(active)) : [unit]);
  for (const name of components.map((component) => component.name)) {
    if (name === "ops") units.push("cyberos-health.timer", "cyberos-maintenance.timer");
    if (name === "backup") units.push("cyberos-backup-daily.timer", "cyberos-backup-weekly.timer");
  }
  return [...new Set(units)].filter((unit) => before.includes(unit));
}

function rejectActiveJobs(components, before) {
  const names = new Set(components.map((component) => component.name));
  const activeJob = before.find((unit) => (names.has("ops") && /^cyberos-(health|maintenance)\.service$/u.test(unit)) ||
    (names.has("backup") && /^cyberos-backup-(daily|weekly)\.service$/u.test(unit)));
  if (activeJob) throw new Error(`Wait for active oneshot job before deploying: ${activeJob}`);
}

async function restoreActive(run, before) {
  const restored = [];
  const errors = [];
  // A job that happened to finish during deployment must not be run twice.
  // These jobs never depend on the API and selected active jobs are refused.
  const ordered = before.filter((unit) => !SCHEDULED_JOB_PATTERN.test(unit)).sort((a, b) => (a === "cyberos-api.service" ? -1 : b === "cyberos-api.service" ? 1 :
    a.endsWith(".target") - b.endsWith(".target")));
  for (const unit of ordered) {
    try {
      if (!await isActive(run, unit)) {
        await run("systemctl", ["start", unit]);
        restored.push(unit);
      }
    } catch (error) { errors.push(new Error(`Service failed to start: ${unit}: ${error.message}`, { cause: error })); }
  }
  if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  return restored;
}

// Replacing the inode avoids ETXTBSY for running ELF binaries. Copy to the
// destination filesystem first; restore the previous name if a rename fails.
async function replaceComponent(source, destination) {
  const suffix = `.cm5-${randomUUID()}`;
  const temporary = `${destination}${suffix}.new`;
  const previous = `${destination}${suffix}.old`;
  let moved = false;
  try {
    await cp(source, temporary, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    if (await exists(destination)) {
      await rename(destination, previous);
      moved = true;
    }
    try { await rename(temporary, destination); } catch (error) {
      if (moved) await rename(previous, destination);
      throw error;
    }
    if (moved) await rm(previous, { recursive: true });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function restoreFiles(recordRoot, runtimeRoot, components) {
  const errors = [];
  for (const component of [...components].reverse()) {
    try {
      const destination = path.join(runtimeRoot, component.path);
      if (component.existed) {
        const backup = path.join(recordRoot, "backup", component.path);
        if (await treeHash(backup) !== component.previousSha256) throw new Error(`Component backup checksum mismatch: ${component.name}`);
        await replaceComponent(backup, destination);
      } else await rm(destination, { recursive: true, force: true });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
}

async function diagnostics(run, recordRoot, units) {
  try {
    const args = [...new Set(["cyberos-api.service", ...units])].flatMap((unit) => ["-u", unit]);
    const journal = await output(run, "journalctl", [...args, "-n", "100", "--no-pager"]);
    await writeFile(path.join(recordRoot, "journal.txt"), journal, { mode: 0o600 });
  } catch { /* Preserve the original deployment error if diagnostics fail. */ }
}

async function verifyRuntime(run, components, units, attempts = 30) {
  const urls = ["/health", "/api/system/storage", "/api/system/health"];
  if (components.some((component) => component.name === "web")) urls.push("/");
  if (components.some((component) => component.name === "docs")) urls.push("/docs/");
  for (const url of urls) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await run("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", "--output", "/dev/null", `http://127.0.0.1:3010${url}`]);
        lastError = undefined;
        break;
      } catch (error) { lastError = error; }
      if (attempt < attempts - 1) await run("sleep", ["1"]);
    }
    if (lastError) throw new Error(`Runtime health check failed: ${url}`, { cause: lastError });
  }
  const services = [...new Set(units)].filter((unit) => unit.endsWith(".service"));
  const status = new Map();
  for (const unit of services) {
    if (!await isActive(run, unit)) throw new Error(`Affected service is inactive: ${unit}`);
    status.set(unit, await output(run, "systemctl", ["show", "--property=MainPID", "--property=NRestarts", unit]));
  }
  if (services.length) await run("sleep", ["3"]);
  for (const unit of services) {
    if (!await isActive(run, unit) || status.get(unit) !== await output(run, "systemctl", ["show", "--property=MainPID", "--property=NRestarts", unit])) {
      throw new Error(`Affected service did not remain stable: ${unit}`);
    }
  }
  return urls;
}

async function verifyBaseline(runtimeRoot, baselineCommit) {
  await realDirectory(runtimeRoot);
  const installed = JSON.parse(await readFile(path.join(runtimeRoot, "build-info.json"), "utf8"));
  if (typeof baselineCommit !== "string" || !/^[0-9a-f]{40}$/u.test(baselineCommit) || installed.commitSha !== baselineCommit) {
    throw new Error("Installed build baseline does not match deployment manifest");
  }
}

export async function applyDeployment({ stage, runtimeRoot = RUNTIME_ROOT, deployRoot = DEPLOY_ROOT, run = defaultRun }) {
  await ensureHost(run);
  await realDirectory(stage);
  const manifest = JSON.parse(await readFile(path.join(stage, "manifest.json"), "utf8"));
  validateId(manifest.id);
  const components = validateComponents(manifest.components);
  await verifyBaseline(runtimeRoot, manifest.baselineCommit);
  if (components.some((component) => component.kind !== "static")) {
    const installedLockHash = createHash("sha256").update(await readFile(path.join(runtimeRoot, "package-lock.json"))).digest("hex");
    if (manifest.packageLockSha256 !== installedLockHash) throw new Error("Installed dependency lock does not match; deploy a Debian package instead");
  }
  const records = [];
  for (const component of components) {
    const sha256 = await validatePayload(path.join(stage, "payload"), component);
    await safeAncestors(runtimeRoot, component.path);
    const destination = path.join(runtimeRoot, component.path);
    const existed = await exists(destination);
    records.push({ ...component, existed, sha256, previousSha256: existed ? await treeHash(destination) : null });
  }
  const before = await activeUnits(run);
  rejectActiveJobs(components, before);
  const stops = selectedUnits(components, before);
  await mkdir(deployRoot, { recursive: true, mode: 0o700 });
  await realDirectory(deployRoot);
  const recordRoot = path.join(deployRoot, manifest.id);
  await mkdir(recordRoot, { mode: 0o700 });
  const receipt = { id: manifest.id, status: "prepared", createdAt: new Date().toISOString(), baselineCommit: manifest.baselineCommit,
    build: manifest.build, components: records, activeUnits: before };
  for (const component of records.filter((entry) => entry.existed)) {
    const backup = path.join(recordRoot, "backup", component.path);
    await mkdir(path.dirname(backup), { recursive: true });
    await cp(path.join(runtimeRoot, component.path), backup, { recursive: true, preserveTimestamps: true });
  }
  await saveReceipt(recordRoot, receipt);
  try {
    receipt.status = "applying";
    await saveReceipt(recordRoot, receipt);
    if (stops.length) await run("systemctl", ["stop", ...stops]);
    for (const component of records) {
      const destination = path.join(runtimeRoot, component.path);
      await replaceComponent(path.join(stage, "payload", component.path), destination);
      if (await treeHash(destination) !== component.sha256) throw new Error(`Installed component checksum mismatch: ${component.name}`);
    }
    const restored = stops.length ? await restoreActive(run, before) : [];
    receipt.checks = await verifyRuntime(run, components, [...stops, ...restored]);
    await diagnostics(run, recordRoot, [...stops, ...restored]);
    receipt.status = "applied";
    receipt.completedAt = new Date().toISOString();
    await saveReceipt(recordRoot, receipt);
    return { recordRoot, receipt };
  } catch (error) {
    await diagnostics(run, recordRoot, before);
    receipt.error = error.message;
    try {
      receipt.status = "rollback-started";
      receipt.rollbackActiveUnits = before;
      await saveReceipt(recordRoot, receipt);
      const errors = [];
      try {
        const active = await activeUnits(run);
        const stopAgain = selectedUnits(components, active);
        if (stopAgain.length) await run("systemctl", ["stop", ...stopAgain]);
      } catch (stopError) { errors.push(stopError); }
      try {
        await restoreFiles(recordRoot, runtimeRoot, records);
        receipt.filesRestored = true;
      } catch (restoreError) { errors.push(restoreError); }
      try {
        const restored = stops.length ? await restoreActive(run, before) : [];
        await verifyRuntime(run, components, [...stops, ...restored], 5);
      } catch (restoreError) { errors.push(restoreError); }
      if (errors.length) throw new AggregateError(errors, errors.map((entry) => entry.message).join("; "));
      receipt.status = "rolled-back";
    } catch (rollbackError) {
      receipt.status = "rollback-failed";
      receipt.rollbackError = rollbackError.message;
      await saveReceipt(recordRoot, receipt);
      throw new AggregateError([error, rollbackError], `${error.message}; rollback requires intervention: ${recordRoot}: ${rollbackError.message}`);
    }
    await saveReceipt(recordRoot, receipt);
    throw error;
  }
}

export async function rollbackDeployment({ id, runtimeRoot = RUNTIME_ROOT, deployRoot = DEPLOY_ROOT, run = defaultRun }) {
  await ensureHost(run);
  validateId(id);
  const recordRoot = path.join(deployRoot, id);
  await realDirectory(recordRoot);
  const receipt = JSON.parse(await readFile(path.join(recordRoot, "receipt.json"), "utf8"));
  const recovering = ["prepared", "applying", "rollback-started", "rollback-failed"].includes(receipt.status);
  if (receipt.id !== id || (!recovering && receipt.status !== "applied")) throw new Error("Deployment is not available for rollback");
  const components = validateComponents(receipt.components);
  await verifyBaseline(runtimeRoot, receipt.baselineCommit);
  for (const component of receipt.components) {
    await safeAncestors(runtimeRoot, component.path);
    const destination = path.join(runtimeRoot, component.path);
    const currentHash = await exists(destination) ? await treeHash(destination) : null;
    if (currentHash !== component.sha256 && !(recovering && (currentHash === null || currentHash === component.previousSha256))) {
      throw new Error(`Component changed after deployment; refusing old rollback: ${component.name}`);
    }
    if (component.existed && await treeHash(path.join(recordRoot, "backup", component.path)) !== component.previousSha256) throw new Error(`Component backup checksum mismatch: ${component.name}`);
  }
  const current = await activeUnits(run);
  const recoveryUnits = ["rollback-started", "rollback-failed"].includes(receipt.status) ? receipt.rollbackActiveUnits : receipt.activeUnits;
  const previous = recovering && Array.isArray(recoveryUnits) ? recoveryUnits.filter((unit) => UNIT_PATTERN.test(unit)) : [];
  const before = [...new Set([...previous, ...current])];
  rejectActiveJobs(components, before);
  const stops = selectedUnits(components, before);
  receipt.status = "rollback-started";
  receipt.rollbackActiveUnits = before;
  await saveReceipt(recordRoot, receipt);
  let failure;
  try {
    if (stops.length) await run("systemctl", ["stop", ...stops]);
    await restoreFiles(recordRoot, runtimeRoot, receipt.components);
    receipt.filesRestored = true;
    const restored = stops.length ? await restoreActive(run, before) : [];
    await verifyRuntime(run, components, [...stops, ...restored]);
    receipt.status = "rolled-back";
    receipt.rolledBackAt = new Date().toISOString();
  } catch (error) { failure = error; }
  // Always attempt every unit restore, even if replacing a file or starting
  // another unit failed; do not mask the original error in a finally block.
  if (stops.length) {
    try { await restoreActive(run, before); } catch (error) {
      failure = failure ? new AggregateError([failure, error], `${failure.message}; ${error.message}`) : error;
    }
  }
  if (failure) {
    receipt.status = "rollback-failed";
    receipt.rollbackError = failure.message;
    await diagnostics(run, recordRoot, before);
  }
  await saveReceipt(recordRoot, receipt);
  if (failure) throw failure;
  return { recordRoot, receipt };
}

async function main() {
  if (process.getuid?.() !== 0) throw new Error("CM5 runtime apply/rollback requires a maintenance login with root privileges");
  const [action, argument, ...extra] = process.argv.slice(2);
  if (!argument || extra.length || !["apply", "rollback"].includes(action)) throw new Error("Usage: cm5-runtime.mjs apply STAGE | rollback ID (run under flock /run/lock/cyberos-deploy.lock)");
  const result = action === "apply" ? await applyDeployment({ stage: argument }) : await rollbackDeployment({ id: argument });
  console.log(JSON.stringify({ id: result.receipt.id, status: result.receipt.status, recordRoot: result.recordRoot }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
