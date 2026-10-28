import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const outputDirectory = path.resolve("dist/pagefind");
const readinessTimeoutMs = parseReadinessTimeout(
  process.env.CYBEROS_PAGEFIND_READINESS_TIMEOUT_MS ?? "30000"
);
const readinessPollMs = 50;

class IndexNotReadyError extends Error {}

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

  // Astro's Pagefind integration can finish writing the entrypoint, metadata,
  // WASM, and chunks just after the build process exits on some filesystems.
  // Retry the complete snapshot so a partially written entry cannot point the
  // verifier at assets that have not been published yet.
  await waitForCompleteIndex();
  process.stdout.write("Pagefind search index validated.\n");
} catch (error) {
  process.stderr.write(
    `Pagefind search index validation failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}

async function validateCompleteIndex() {
  await requireNonemptyFile("pagefind.js");
  await requireNonemptyFile("pagefind-entry.json");
  const entry = JSON.parse(await readFile(path.join(outputDirectory, "pagefind-entry.json"), "utf8"));
  const languages = Object.values(entry.languages ?? {});
  if (!languages.some((language) => language.page_count > 0)) {
    throw new IndexNotReadyError("No pages were indexed");
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
  const details = await stat(path.join(outputDirectory, relativePath)).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!details?.isFile() || details.size === 0) {
    throw new IndexNotReadyError(`Missing or empty ${relativePath}`);
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
    throw new IndexNotReadyError(`No ${directory} chunks were generated`);
  }
  await Promise.all(names.map((name) => requireNonemptyFile(path.join(directory, name))));
}

async function waitForCompleteIndex() {
  const deadline = Date.now() + readinessTimeoutMs;
  let lastError = new IndexNotReadyError("Search index is not ready");

  while (true) {
    try {
      await validateCompleteIndex();
      return;
    } catch (error) {
      if (!isReadinessError(error)) throw error;
      lastError = error;
    }

    if (Date.now() >= deadline) throw lastError;
    await delay(readinessPollMs);
  }
}

function isReadinessError(error) {
  return error instanceof IndexNotReadyError || error instanceof SyntaxError || error?.code === "ENOENT";
}

function parseReadinessTimeout(value) {
  if (!/^\d+$/.test(value)) {
    throw new Error("CYBEROS_PAGEFIND_READINESS_TIMEOUT_MS must be an integer");
  }
  const timeout = Number(value);
  if (timeout < 100 || timeout > 60_000) {
    throw new Error("CYBEROS_PAGEFIND_READINESS_TIMEOUT_MS must be between 100 and 60000");
  }
  return timeout;
}
