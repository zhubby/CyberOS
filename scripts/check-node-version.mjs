import console from "node:console";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function assertMinimumNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19)) {
    throw new Error(`Node.js 22.19.0 or newer is required; found ${version}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    assertMinimumNodeVersion(process.argv[2] ?? process.versions.node);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
