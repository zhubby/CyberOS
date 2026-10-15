#!/usr/bin/env node

import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parsePathMappings, remapPath } from "./zos-migrate-database.mjs";

export function migrateLegacyShareAclState(contents, mappingContents) {
  const grants = JSON.parse(contents);
  if (!Array.isArray(grants)) throw new Error("share ACL state must be an array");
  const mappings = parsePathMappings(mappingContents);
  let pathValues = 0;
  const migrated = grants.map((grant) => {
    validateGrant(grant);
    const migratedPath = remapPath(grant.path, mappings);
    if (migratedPath !== grant.path) pathValues += 1;
    return { ...grant, path: migratedPath };
  });
  return {
    grants: migrated,
    report: {
      grants: migrated.length,
      pathValues
    }
  };
}

function validateGrant(grant) {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)
      || typeof grant.path !== "string" || !path.posix.isAbsolute(grant.path)
      || typeof grant.principal !== "string" || !/^[a-z_][a-z0-9_-]*$/u.test(grant.principal)
      || !["read", "write", "traverse"].includes(grant.access)
      || !["tree", "parent"].includes(grant.scope)) {
    throw new Error("invalid share ACL grant");
  }
}

async function main() {
  const [statePath, mappingsPath, reportPath] = process.argv.slice(2);
  if (!statePath || !mappingsPath || !reportPath) {
    throw new Error("usage: zos-migrate-share-acl.mjs <state-json> <path-mappings> <report-json>");
  }
  const [stateStat, mappingsStat] = await Promise.all([lstat(statePath), lstat(mappingsPath)]);
  if (!stateStat.isFile() || stateStat.isSymbolicLink()) throw new Error("share ACL state must be a regular file");
  if (!mappingsStat.isFile() || mappingsStat.isSymbolicLink()) throw new Error("path mappings must be a regular file");
  const [contents, mappingContents] = await Promise.all([
    readFile(statePath, "utf8"),
    readFile(mappingsPath, "utf8")
  ]);
  const result = migrateLegacyShareAclState(contents, mappingContents);
  const temporary = `${statePath}.new.${process.pid}`;
  await writeFile(temporary, JSON.stringify(result.grants), { mode: 0o600 });
  await rename(temporary, statePath);
  await writeFile(reportPath, `${JSON.stringify(result.report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result.report)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
