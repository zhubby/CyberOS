#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [sourceRoot, targetRoot, renamedSource = "", renamedTarget = ""] = process.argv.slice(2);

if (!path.isAbsolute(sourceRoot ?? "") || !path.isAbsolute(targetRoot ?? "")) {
  throw new Error("source and target roots must be absolute");
}
if ((renamedSource === "") !== (renamedTarget === "")) {
  throw new Error("renamed source and target must be provided together");
}
for (const value of [renamedSource, renamedTarget]) {
  if (value !== "" && (path.isAbsolute(value) || value !== path.basename(value))) {
    throw new Error("renamed database paths must be top-level file names");
  }
}

let sourceRootStat;
try {
  sourceRootStat = fs.lstatSync(sourceRoot, { bigint: true });
} catch (error) {
  if (error?.code === "ENOENT") {
    process.stdout.write("0\n");
    process.exit(0);
  }
  throw error;
}
if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink()) {
  throw new Error("source root must be a real directory");
}

let growth = 0n;
const sourceDevice = sourceRootStat.dev;

function targetSize(relativePath, sourceStat) {
  const mapped = relativePath === renamedSource ? renamedTarget : relativePath;
  const targetPath = path.join(targetRoot, mapped);
  let targetStat;
  try {
    targetStat = fs.lstatSync(targetPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0n;
    throw error;
  }
  if (sourceStat.isFile() !== targetStat.isFile()) return 0n;
  return targetStat.isFile() ? targetStat.size : 0n;
}

function walk(relativeDirectory) {
  const directoryPath = path.join(sourceRoot, relativeDirectory);
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const sourcePath = path.join(sourceRoot, relativePath);
    const sourceStat = fs.lstatSync(sourcePath, { bigint: true });
    if (sourceStat.dev !== sourceDevice) continue;
    if (sourceStat.isDirectory()) {
      walk(relativePath);
    } else if (sourceStat.isFile()) {
      const existingSize = targetSize(relativePath, sourceStat);
      if (sourceStat.size > existingSize) growth += sourceStat.size - existingSize;
    }
  }
}

walk("");
process.stdout.write(`${growth}\n`);
