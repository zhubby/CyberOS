import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const outputDirectory = path.resolve("dist/pagefind");
const readinessTimeoutMs = 5_000;
const readinessPollMs = 50;

try {
  const argument = process.argv[2];
  if (process.argv.length > 3 || (argument !== undefined && argument !== "--prepare")) {
    throw new Error("Usage: node scripts/verify-search-index.mjs [--prepare]");
  }

  await rejectSymlink(path.resolve("dist"));
  await rejectSymlink(outputDirectory);

  if (argument === "--prepare") {
    await rm(outputDirectory, { recursive: true, force: true });
    process.exit(0);
  }

  // Astro's Pagefind integration can finish its final writes just after the
  // build process exits on some filesystems. Wait only for the two entry files;
  // all referenced assets are still validated strictly below.
  await waitForNonemptyFile("pagefind.js");
  await waitForNonemptyFile("pagefind-entry.json");

  const entry = JSON.parse(await readFile(path.join(outputDirectory, "pagefind-entry.json"), "utf8"));
  const languages = Object.values(entry.languages ?? {});
  if (!languages.some((language) => language.page_count > 0)) {
    throw new Error("No pages were indexed");
  }

  for (const language of languages) {
    if (!/^[\w-]+$/.test(language.hash)) {
      throw new Error("Invalid language asset identifier");
    }
    if (language.wasm !== null && language.wasm !== undefined && !/^[\w-]+$/.test(language.wasm)) {
      throw new Error("Invalid WASM asset identifier");
    }
    await requireNonemptyFile(`pagefind.${language.hash}.pf_meta`);
    await requireNonemptyFile(`wasm.${language.wasm ?? "unknown"}.pagefind`);
  }

  await requireChunk("index", ".pf_index");
  await requireChunk("fragment", ".pf_fragment");
  process.stdout.write("Pagefind search index validated.\n");
} catch (error) {
  process.stderr.write(
    `Pagefind search index validation failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}

async function rejectSymlink(target) {
  const details = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (details?.isSymbolicLink()) {
    throw new Error(`Refusing symlink output: ${target}`);
  }
}

async function requireNonemptyFile(relativePath) {
  const details = await stat(path.join(outputDirectory, relativePath));
  if (!details.isFile() || details.size === 0) {
    throw new Error(`Missing or empty ${relativePath}`);
  }
}

async function waitForNonemptyFile(relativePath) {
  const deadline = Date.now() + readinessTimeoutMs;
  while (true) {
    try {
      const details = await stat(path.join(outputDirectory, relativePath));
      if (details.isFile() && details.size > 0) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (Date.now() >= deadline) {
      await requireNonemptyFile(relativePath);
      return;
    }
    await delay(readinessPollMs);
  }
}

async function requireChunk(directory, suffix) {
  const names = await readdir(path.join(outputDirectory, directory))
    .then((entries) => entries.filter((name) => name.endsWith(suffix)))
    .catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
  if (names.length === 0) {
    throw new Error(`No ${directory} chunks were generated`);
  }
  await Promise.all(names.map((name) => requireNonemptyFile(path.join(directory, name))));
}
