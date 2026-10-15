import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("scripts/zos-migration-copy-growth.mjs", import.meta.url));
let directory;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("migration copy growth", () => {
  it("counts only positive file growth", async () => {
    const { source, target } = await setup();
    await writeFile(path.join(source, "growing"), "12345678");
    await writeFile(path.join(target, "growing"), "12");
    await writeFile(path.join(source, "smaller"), "1");
    await writeFile(path.join(target, "smaller"), "1234");
    await writeFile(path.join(source, "new"), "abc");

    expect(run(source, target)).toBe(9n);
  });

  it("maps the legacy database onto the existing ZOS database", async () => {
    const { source, target } = await setup();
    await writeFile(path.join(source, "sigmaos.sqlite"), "12345678");
    await writeFile(path.join(target, "zos.sqlite"), "12345");

    expect(run(source, target, "sigmaos.sqlite", "zos.sqlite")).toBe(3n);
    expect(run(source, target)).toBe(8n);
  });

  it("rejects rename mappings that can escape the target root", async () => {
    const { source, target } = await setup();
    expect(() => run(source, target, "../sigmaos.sqlite", "zos.sqlite")).toThrow(
      "renamed database paths must be top-level file names"
    );
  });
});

async function setup() {
  directory = await mkdtemp(path.join(os.tmpdir(), "zos-copy-growth-"));
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  await mkdir(source);
  await mkdir(target);
  return { source, target };
}

function run(source, target, renamedSource, renamedTarget) {
  const args = [script, source, target];
  if (renamedSource !== undefined && renamedTarget !== undefined) {
    args.push(renamedSource, renamedTarget);
  }
  return BigInt(execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
}
