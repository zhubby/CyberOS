import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";

const verifier = fileURLToPath(new URL("../scripts/verify-search-index.mjs", import.meta.url));

test("rejects missing Pagefind output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zos-search-missing-"));
  try {
    const result = await runVerifier(directory);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /validation failed/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects incomplete Pagefind output", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(path.join(fixture.output, "pagefind.zh-cn_fixture.pf_meta"), "metadata");
    await writeFile(path.join(fixture.output, "wasm.unknown.pagefind"), "wasm");
    const result = await runVerifier(fixture.directory);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /No index chunks/i);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("accepts a complete nonempty Pagefind index", async () => {
  const fixture = await createFixture();
  try {
    for (const [name, contents] of [
      ["pagefind.zh-cn_fixture.pf_meta", "metadata"],
      ["wasm.unknown.pagefind", "wasm"],
      ["index/zh-cn_fixture.pf_index", "index"],
      ["fragment/zh-cn_fixture.pf_fragment", "fragment"]
    ]) {
      await mkdir(path.dirname(path.join(fixture.output, name)), { recursive: true });
      await writeFile(path.join(fixture.output, name), contents);
    }
    const result = await runVerifier(fixture.directory);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /validated/i);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("waits for Pagefind entry output to finish writing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zos-search-delayed-"));
  const output = path.join(directory, "dist/pagefind");
  try {
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "pagefind.js"), "// browser bundle");

    const resultPromise = runVerifier(directory);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(
      path.join(output, "pagefind.zh-cn_fixture.pf_meta"),
      "metadata"
    );
    await writeFile(path.join(output, "wasm.unknown.pagefind"), "wasm");
    await mkdir(path.join(output, "index"), { recursive: true });
    await mkdir(path.join(output, "fragment"), { recursive: true });
    await writeFile(path.join(output, "index/zh-cn_fixture.pf_index"), "index");
    await writeFile(path.join(output, "fragment/zh-cn_fixture.pf_fragment"), "fragment");
    await writeFile(
      path.join(output, "pagefind-entry.json"),
      JSON.stringify({
        version: "1.5.0",
        languages: { "zh-cn": { hash: "zh-cn_fixture", wasm: null, page_count: 1 } }
      })
    );

    const result = await resultPromise;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /validated/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepare removes only the previous Pagefind output", async () => {
  const fixture = await createFixture();
  const page = path.join(fixture.directory, "dist/index.html");
  try {
    await writeFile(page, "<h1>Keep this page</h1>");
    const result = await runVerifier(fixture.directory, "--prepare");
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(() => stat(fixture.output), /ENOENT/);
    assert.equal((await stat(page)).isFile(), true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "zos-search-index-"));
  const output = path.join(directory, "dist/pagefind");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "pagefind.js"), "// browser bundle");
  await writeFile(
    path.join(output, "pagefind-entry.json"),
    JSON.stringify({
      version: "1.5.0",
      languages: { "zh-cn": { hash: "zh-cn_fixture", wasm: null, page_count: 1 } }
    })
  );
  return { directory, output };
}

function runVerifier(cwd, argument) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifier, ...(argument ? [argument] : [])], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
