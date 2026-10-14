#!/usr/bin/env node

import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { XMLValidator } from "fast-xml-parser";

const BUILTIN_MAPPINGS = [
  ["/var/lib/sigmaos/vmstore", "/zos/vm"],
  ["/var/lib/sigmaos", "/zos/state"]
];

export function parseLibvirtPathMappings(contents) {
  const bySource = new Map(BUILTIN_MAPPINGS);
  for (const line of contents.split(/\r?\n/u)) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== 2) throw new Error(`invalid migration mapping: ${line}`);
    const [source, target] = fields;
    if (!path.posix.isAbsolute(source) || !path.posix.isAbsolute(target) || source === "/" || target === "/") {
      throw new Error(`invalid absolute path mapping: ${source} -> ${target}`);
    }
    const normalizedSource = path.posix.normalize(source).replace(/\/+$/u, "");
    const normalizedTarget = path.posix.normalize(target).replace(/\/+$/u, "");
    const existing = bySource.get(normalizedSource);
    if (existing && existing !== normalizedTarget) {
      throw new Error(`conflicting migration mapping for ${normalizedSource}`);
    }
    bySource.set(normalizedSource, normalizedTarget);
  }
  return [...bySource].sort(([left], [right]) => right.length - left.length);
}

export function migrateLibvirtXml(contents, mappingContents) {
  assertValidXml(contents, "source");
  const mappings = parseLibvirtPathMappings(mappingContents);
  let replacements = 0;

  const remapValue = (value) => {
    const leading = value.match(/^\s*/u)?.[0] ?? "";
    const trailing = value.match(/\s*$/u)?.[0] ?? "";
    const candidate = value.slice(leading.length, value.length - trailing.length);
    for (const [source, target] of mappings) {
      if (candidate === source) {
        replacements += 1;
        return `${leading}${target}${trailing}`;
      }
      if (candidate.startsWith(`${source}/`)) {
        replacements += 1;
        return `${leading}${target}${candidate.slice(source.length)}${trailing}`;
      }
    }
    return value;
  };

  const migratedAttributes = contents.replace(
    /(\s[\w:.-]+\s*=\s*)(["'])([^"']*)\2/gu,
    (match, prefix, quote, value) => `${prefix}${quote}${remapValue(value)}${quote}`
  );
  const migrated = migratedAttributes.replace(
    />([^<]+)</gu,
    (match, value) => `>${remapValue(value)}<`
  );
  assertValidXml(migrated, "migrated");
  return { contents: migrated, replacements };
}

function assertValidXml(contents, label) {
  const result = XMLValidator.validate(contents);
  if (result !== true) {
    const detail = typeof result === "object" && result.err?.msg ? `: ${result.err.msg}` : "";
    throw new Error(`${label} libvirt XML is invalid${detail}`);
  }
}

async function main() {
  const [sourcePath, mappingsPath, targetPath] = process.argv.slice(2);
  if (!sourcePath || !mappingsPath || !targetPath) {
    throw new Error("usage: zos-migrate-libvirt.mjs <domain-xml> <path-mappings> <output>");
  }
  const [sourceStat, mappingsStat] = await Promise.all([lstat(sourcePath), lstat(mappingsPath)]);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("domain XML must be a regular file");
  if (!mappingsStat.isFile() || mappingsStat.isSymbolicLink()) throw new Error("path mappings must be a regular file");
  const [contents, mappings] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(mappingsPath, "utf8")
  ]);
  const migrated = migrateLibvirtXml(contents, mappings);
  await writeFile(targetPath, migrated.contents, { mode: 0o600 });
  process.stdout.write(`${migrated.replacements}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
