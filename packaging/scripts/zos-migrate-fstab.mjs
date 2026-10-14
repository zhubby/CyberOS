#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function migrateFstab(source, mappings) {
  const normalized = mappings
    .map(({ source: from, target: to }) => ({ source: cleanPath(from), target: cleanPath(to) }))
    .sort((left, right) => right.source.length - left.source.length);
  return source.split(/(?<=\n)/u).map((line) => migrateLine(line, normalized)).join("");
}

function migrateLine(line, mappings) {
  if (/^\s*(?:#|$)/u.test(line)) return line;
  const match = /^(\s*)(\S+)(\s+)(\S+)([\s\S]*)$/u.exec(line);
  if (!match) return line;
  const [, prefix, device, separator, mountPoint, suffix] = match;
  const mapping = mappings.find(({ source }) => mountPoint === source || mountPoint.startsWith(`${source}/`));
  if (!mapping) return line;
  const migratedMountPoint = `${mapping.target}${mountPoint.slice(mapping.source.length)}`;
  return `${prefix}${device}${separator}${migratedMountPoint}${suffix}`;
}

function cleanPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/") {
    throw new Error(`invalid migration path: ${JSON.stringify(value)}`);
  }
  return value.replace(/\/+$/u, "");
}

async function main() {
  const [sourcePath, mappingsPath, targetPath] = process.argv.slice(2);
  if (!sourcePath || !mappingsPath || !targetPath) {
    throw new Error("usage: zos-migrate-fstab.mjs <fstab> <mapping-tsv> <output>");
  }
  const [source, mappingText] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(mappingsPath, "utf8")
  ]);
  const mappings = mappingText.split(/\r?\n/u).filter(Boolean).map((line) => {
    const [from, to, extra] = line.split("\t");
    if (!from || !to || extra !== undefined) throw new Error(`invalid migration mapping: ${line}`);
    return { source: from, target: to };
  });
  await writeFile(targetPath, migrateFstab(source, mappings), { encoding: "utf8", mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
