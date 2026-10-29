#!/usr/bin/env node
import { createReadStream, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";

const [action, statePath, transactionPath] = process.argv.slice(2);
const cyberosRootValue = process.env.CYBEROS_ROOT ?? "/cyberos";
if (!path.isAbsolute(cyberosRootValue)) throw new Error("CYBEROS_ROOT must be absolute");
const cyberosRoot = path.resolve(cyberosRootValue);
if (cyberosRoot === path.parse(cyberosRoot).root) throw new Error("CYBEROS_ROOT must not be the filesystem root");
const systemBackupsRoot = path.join(cyberosRoot, "system-backups");
const backupRoot = path.resolve(process.env.CYBEROS_ACL_BACKUP_DIR ?? path.join(systemBackupsRoot, "permissions"));
if (backupRoot !== systemBackupsRoot && !backupRoot.startsWith(`${systemBackupsRoot}${path.sep}`)) {
  throw new Error(`CYBEROS_ACL_BACKUP_DIR must be under ${systemBackupsRoot}`);
}

function run(command, args, outputPath) {
  const output = outputPath ? openSync(outputPath, "a", 0o600) : "pipe";
  try {
    const result = spawnSync(command, args, {
      stdio: ["ignore", output, "pipe"],
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 600_000
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${command} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
    }
    return result.stdout ?? "";
  } finally {
    if (outputPath) closeSync(output);
  }
}

function key(grant) {
  return `${grant.path}\0${grant.principal}`;
}

function managedMetadataPath(value) {
  const segments = path.resolve(value).split(path.sep);
  return segments.includes(".cyberos");
}

function validate(grants) {
  if (!Array.isArray(grants)) throw new Error("Invalid ACL grant list");
  for (const grant of grants) {
    if (!grant || typeof grant.path !== "string" || !path.isAbsolute(grant.path)
      || !/^[a-z_][a-z0-9_-]*$/u.test(grant.principal)
      || !["read", "write", "traverse"].includes(grant.access)
      || !["tree", "parent"].includes(grant.scope)) {
      throw new Error("Invalid ACL grant");
    }
    if (managedMetadataPath(grant.path)) throw new Error("Managed storage metadata cannot be shared");
  }
}

function checkMounts(grants) {
  const mountpoints = run("findmnt", ["-rn", "-o", "TARGET"]).trim().split("\n");
  for (const grant of grants.filter((entry) => entry.scope === "tree")) {
    if (mountpoints.some((mountpoint) => mountpoint.startsWith(`${grant.path}/`))) {
      throw new Error(`Nested mount in shared path: ${grant.path}`);
    }
  }
}

function available(grant, desired) {
  if (!existsSync(grant.path)) {
    if (desired) throw new Error(`Shared path is missing: ${grant.path}`);
    process.stderr.write(`Previously shared path is missing; removing stale ACL state: ${grant.path}\n`);
    return false;
  }
  if (lstatSync(grant.path).isSymbolicLink()) throw new Error(`Shared path is a symlink: ${grant.path}`);
  return true;
}

function directories(target, callback) {
  run("find", ["-P", target, "-xdev", "-path", "*/.cyberos", "-prune", "-o",
    "-type", "d", "-exec", "setfacl", ...callback, "{}", "+"]);
}

function change(grant, remove = false) {
  const entry = `u:${grant.principal}`;
  const args = ["-n", remove ? "-x" : "-m", remove ? entry : `${entry}:${grant.access === "write" ? "rwX" : grant.access === "read" ? "rX" : "--x"}`];
  if (grant.scope === "tree") {
    run("find", ["-P", grant.path, "-xdev", "-path", "*/.cyberos", "-prune", "-o",
      "(", "-type", "d", "-o", "-type", "f", ")", "-exec", "setfacl", ...args, "--", "{}", "+"]);
    const defaultEntry = `d:${entry}`;
    const defaultMode = grant.access === "write" ? "rwx" : grant.access === "read" ? "r-x" : "--x";
    directories(grant.path, ["-n", remove ? "-x" : "-m", remove ? defaultEntry : `${defaultEntry}:${defaultMode}`, "--"]);
  } else {
    run("setfacl", [...args, "--", grant.path]);
  }
}

async function hasExistingEntry(snapshot, principal, managed) {
  const lines = createInterface({ input: createReadStream(snapshot), crlfDelay: Infinity });
  let currentPath = null;
  for await (const line of lines) {
    if (line.startsWith("# file: ")) currentPath = line.slice(8);
    if ((line.startsWith(`user:${principal}:`) || line.startsWith(`default:user:${principal}:`))
      && !managed.some((grant) => grant.principal === principal && currentPath
        && (grant.path === currentPath || (grant.scope === "tree" && currentPath.startsWith(`${grant.path}/`))))) {
      return true;
    }
  }
  return false;
}

async function maskUpdates(snapshot, previous, desired) {
  const lines = createInterface({ input: createReadStream(snapshot), crlfDelay: Infinity });
  let currentPath = null;
  let entries = [];
  const updates = [];
  const managed = new Set(["cyberos", ...previous.map((grant) => grant.principal), ...desired.map((grant) => grant.principal)]);
  const check = () => {
    if (!currentPath || managedMetadataPath(currentPath)) return;
    const metadata = lstatSync(currentPath);
    const isDirectory = metadata.isDirectory();
    const isExecutable = (metadata.mode & 0o111) !== 0;
    for (const prefix of ["", "default:"]) {
      if (prefix && !isDirectory) continue;
      const maskEntry = entries.find((entry) => entry.startsWith(`${prefix}mask::`));
      const groupEntry = entries.find((entry) => entry.startsWith(`${prefix}group::`));
      const mask = maskEntry?.slice(prefix.length + 6, prefix.length + 9)
        ?? groupEntry?.slice(prefix.length + 7, prefix.length + 10);
      if (!mask) continue;
      const requested = desired.filter((grant) => grant.path === currentPath && grant.scope === "parent"
        || grant.scope === "tree" && (grant.path === currentPath || currentPath.startsWith(`${grant.path}/`)));
      const required = requested.map((grant) => {
        if (grant.access === "traverse") return "x";
        if (grant.access === "write") return prefix || isDirectory || isExecutable ? "rwx" : "rw";
        return prefix || isDirectory || isExecutable ? "rx" : "r";
      });
      const missing = new Set(required.flatMap((permissions) => [...permissions])
        .filter((bit) => bit !== "-" && !mask.includes(bit)));
      if (!missing.size) continue;
      const unmanaged = entries.flatMap((entry) => {
        const match = entry.match(new RegExp(`^${prefix}(user|group):([^:]*):([rwx-]{3})(?:\\s|$)`, "u"));
        if (!match || match[1] === "user" && (!match[2] || managed.has(match[2]))) return [];
        return [match[3]];
      });
      if (unmanaged.some((permissions) => [...missing].some((bit) => permissions.includes(bit)))) {
        throw new Error(`Existing ACL mask needs separate review: ${currentPath}`);
      }
      updates.push({ path: currentPath, prefix,
        mask: [..."rwx"].map((bit) => mask.includes(bit) || missing.has(bit) ? bit : "-").join("") });
    }
  };
  for await (const line of lines) {
    if (line.startsWith("# file: ")) {
      check();
      currentPath = line.slice(8);
      entries = [];
    } else if (line) {
      entries.push(line);
    }
  }
  check();
  return updates;
}

async function prepare() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const desired = input.grants;
  validate(desired);
  const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : [];
  validate(previous);
  const existingPrevious = previous.filter((grant) => available(grant, false));
  for (const grant of desired) available(grant, true);
  const affectedByPath = new Map();
  for (const grant of [...existingPrevious, ...desired]) {
    if (!affectedByPath.has(grant.path) || grant.scope === "tree") affectedByPath.set(grant.path, grant);
  }
  const affected = [...affectedByPath.values()];
  checkMounts(affected);
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const transaction = mkdtempSync(path.join(backupRoot, "share-acl."));
  const snapshots = new Map();
  for (const [index, grant] of affected.entries()) {
    const snapshot = path.join(transaction, `acl-${index}.dump`);
    if (grant.scope === "tree") {
      run("find", ["-P", grant.path, "-xdev", "-path", "*/.cyberos", "-prune", "-o",
        "(", "-type", "d", "-o", "-type", "f", ")", "-exec", "getfacl", "--absolute-names", "--", "{}", "+"], snapshot);
    } else {
      run("getfacl", ["--absolute-names", "--", grant.path], snapshot);
    }
    snapshots.set(grant.path, snapshot);
  }
  writeFileSync(path.join(transaction, "previous.json"), JSON.stringify(previous), { mode: 0o600 });
  writeFileSync(path.join(transaction, "desired.json"), JSON.stringify(desired), { mode: 0o600 });
  const old = new Map(existingPrevious.map((grant) => [key(grant), grant]));
  const next = new Map(desired.map((grant) => [key(grant), grant]));
  try {
    const updates = [];
    for (const snapshot of snapshots.values()) updates.push(...await maskUpdates(snapshot, existingPrevious, desired));
    for (const grant of desired) {
      if (!old.has(key(grant))
        && await hasExistingEntry(snapshots.get(grant.path), grant.principal, existingPrevious)) {
        throw new Error(`ACL for ${grant.principal} already exists; refusing to replace administrator permissions`);
      }
    }
    const differs = (grant, counterpart) => !counterpart
      || counterpart.access !== grant.access || counterpart.scope !== grant.scope;
    const changed = previous.length !== desired.length
      || previous.some((grant) => differs(grant, next.get(key(grant))))
      || desired.some((grant) => differs(grant, old.get(key(grant))));
    for (const update of updates) {
      run("setfacl", ["-n", "-m", `${update.prefix}m::${update.mask}`, "--", update.path]);
    }
    if (changed) {
      for (const grant of [...existingPrevious].sort((a, b) => b.path.length - a.path.length)) change(grant, true);
    }
    for (const grant of [...desired].sort((a, b) => a.path.length - b.path.length)) change(grant);
  } catch (error) {
    for (const snapshot of [...snapshots.values()].reverse()) run("setfacl", [`--restore=${snapshot}`]);
    throw error;
  }
  process.stdout.write(`${transaction}\n`);
}

if (action === "prepare" && statePath && !transactionPath) {
  await prepare();
} else if ((action === "commit" || action === "rollback") && statePath && transactionPath
  && path.dirname(transactionPath) === backupRoot) {
  if (action === "rollback") {
    const snapshotFiles = readdirSync(transactionPath)
      .filter((file) => /^acl-\d+\.dump$/u.test(file))
      .sort((first, second) => Number(second.slice(4, -5)) - Number(first.slice(4, -5)));
    for (const file of snapshotFiles) run("setfacl", [`--restore=${path.join(transactionPath, file)}`]);
  } else {
    mkdirSync(path.dirname(statePath), { recursive: true });
    const staging = `${statePath}.new`;
    writeFileSync(staging, readFileSync(path.join(transactionPath, "desired.json")), { mode: 0o600 });
    renameSync(staging, statePath);
  }
} else {
  throw new Error("Invalid share ACL transaction");
}
