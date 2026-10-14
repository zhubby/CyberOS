#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";

const ZOS_ROOT = "/zos";
const RESERVED_LEGACY_PATHS = [
  "/srv/backup",
  "/srv/apps",
  "/srv/iso",
  "/var/lib/sigmaos/vmstore"
];

export function migrateLegacyConfig(source) {
  const parsed = parse(source);
  const config = { ...parsed };
  delete config.data_dir;
  config.root_dir = ZOS_ROOT;
  config.environment = "production";

  if (isRecord(config.admin) && config.admin.display_name === "SigmaOS Admin") {
    config.admin.display_name = "ZOS Admin";
  }

  const roots = Array.isArray(config.nas_roots) && config.nas_roots.length > 0
    ? config.nas_roots
    : [{ id: "primary", name: "Primary NAS", path: "/srv/nas", mount_policy: "required" }];
  const usedRootNames = new Set(["backup"]);
  const usedSourcePaths = new Set();
  const nasRootMappings = [];
  config.nas_roots = roots.map((value, index) => {
    if (!isRecord(value)) throw new Error(`invalid legacy NAS root at index ${index}`);
    const root = { ...value };
    const sourcePath = cleanLegacyPath(root.path, index);
    const overlappingPath = [...usedSourcePaths, ...RESERVED_LEGACY_PATHS]
      .find((existing) => pathsOverlap(existing, sourcePath));
    if (overlappingPath) {
      throw new Error(`overlapping legacy managed paths: ${sourcePath} and ${overlappingPath}`);
    }
    usedSourcePaths.add(sourcePath);
    const fallback = index === 0 ? "primary" : `root-${index + 1}`;
    const requested = safePathName(typeof root.id === "string" ? root.id : fallback) || fallback;
    let name = requested;
    let suffix = 2;
    while (usedRootNames.has(name)) {
      name = `${requested}-${suffix}`;
      suffix += 1;
    }
    usedRootNames.add(name);
    root.id = typeof root.id === "string" && root.id.trim() ? root.id : fallback;
    root.name = typeof root.name === "string" && root.name.trim() ? root.name : root.id;
    root.path = path.posix.join(ZOS_ROOT, "data", name);
    root.mount_policy ??= "required";
    nasRootMappings.push({ source: sourcePath, target: root.path });
    return root;
  });

  config.vm = {
    ...(isRecord(config.vm) ? config.vm : {}),
    storage_path: "/zos/vm",
    iso_roots: ["/zos/iso"]
  };
  config.hostd = {
    ...(isRecord(config.hostd) ? config.hostd : {}),
    socket_path: "/run/zos/hostd.sock"
  };
  config.terminal = {
    ...(isRecord(config.terminal) ? config.terminal : {}),
    user: "zos",
    termux_socket_path: "/run/zos/termux.sock"
  };
  config.vod_player = {
    ...(isRecord(config.vod_player) ? config.vod_player : {}),
    socket_path: "/run/zos/vod-player.sock",
    state_path: "/zos/state/vod-player/session.json",
    user: "zos"
  };

  const legacyBackup = isRecord(config.backup) ? config.backup : {};
  const requestedPasswordFile = typeof legacyBackup.password_file === "string"
    ? path.posix.basename(legacyBackup.password_file.trim())
    : "";
  const passwordFile = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(requestedPasswordFile)
    ? requestedPasswordFile
    : "restic-password";
  config.backup = {
    ...legacyBackup,
    repository_path: "/zos/data/backup/restic",
    password_file: path.posix.join("/zos/config", passwordFile),
    staging_path: "/zos/state/backup-staging"
  };

  const contents = `${stringify(config).trimEnd()}\n`;
  return {
    contents,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    nasRootMappings
  };
}

function cleanLegacyPath(value, index) {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || /\s/u.test(value)) {
    throw new Error(`invalid legacy NAS root path at index ${index}: ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value).replace(/\/+$/u, "") || "/";
  if (normalized === "/" || normalized === ZOS_ROOT || normalized.startsWith(`${ZOS_ROOT}/`)) {
    throw new Error(`unsafe legacy NAS root path at index ${index}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function safePathName(value) {
  const candidate = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return candidate === "." || candidate === ".." ? "" : candidate;
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function main() {
  const [sourcePath, targetPath, reportPath] = process.argv.slice(2);
  if (!sourcePath || !targetPath || !reportPath) {
    throw new Error("usage: zos-migrate-config.mjs <legacy-config> <new-config> <report-json>");
  }
  const source = await readFile(sourcePath, "utf8");
  const migrated = migrateLegacyConfig(source);
  await writeFile(targetPath, migrated.contents, { encoding: "utf8", mode: 0o600 });
  await writeFile(reportPath, `${JSON.stringify({
    sourceConfigSha256: migrated.sourceSha256,
    nasRootMappings: migrated.nasRootMappings
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
