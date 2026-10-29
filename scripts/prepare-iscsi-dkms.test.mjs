import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const temporary = [];
const execute = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-lio-source-"));
  temporary.push(root);
  const sourceDirectory = path.join(root, "cache");
  await mkdir(path.join(sourceDirectory, "drivers/target"), { recursive: true });
  const contents = { "drivers/target/Makefile": "obj-$(CONFIG_TARGET_CORE) += target_core_mod.o\n", COPYING: "GPL-2.0-only\n" };
  const files = [];
  for (const [name, value] of Object.entries(contents)) {
    await writeFile(path.join(sourceDirectory, name), value);
    files.push({ path: name, sha256: createHash("sha256").update(value).digest("hex") });
  }
  return { sourceDirectory, outputDirectory: path.join(root, "output"), manifest: { version: "6.18.34", repository: "gregkh/linux", commit: "1".repeat(40), files } };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("verified iSCSI kernel source assembly", () => {
  it("rejects a corrupt source before replacing an existing build tree", async () => {
    const options = await fixture();
    await mkdir(options.outputDirectory);
    await writeFile(path.join(options.outputDirectory, "existing"), "preserved");
    await writeFile(path.join(options.sourceDirectory, "COPYING"), "corrupted");
    const { prepareIscsiDkms } = await import("./prepare-iscsi-dkms.mjs");
    await expect(prepareIscsiDkms(options)).rejects.toThrow(/checksum/i);
    expect(await readFile(path.join(options.outputDirectory, "existing"), "utf8")).toBe("preserved");
  });

  it("assembles verified sources and restricts DKMS to kernels missing LIO", async () => {
    const options = await fixture();
    const { prepareIscsiDkms } = await import("./prepare-iscsi-dkms.mjs");
    await prepareIscsiDkms(options);
    expect(await readFile(path.join(options.outputDirectory, "COPYING"), "utf8")).toBe("GPL-2.0-only\n");
    const config = await readFile(path.join(options.outputDirectory, "dkms.conf"), "utf8");
    expect(config).toContain('AUTOINSTALL="yes"');
    for (const module of ["target_core_mod", "target_core_file", "iscsi_target_mod"]) expect(config).toContain(`="${module}"`);
    expect(await readFile(path.join(options.outputDirectory, "drivers/target/Makefile"), "utf8")).toContain("subdir-ccflags-y := -I$(abspath $(src)/../../include)");
    const probe = 'kernel_source_dir="$1"; kernelver="6.18.34+rpt-rpi-2712"; . "$1/dkms.conf"; printf "%s" "$BUILD_EXCLUSIVE_KERNEL"';
    await writeFile(path.join(options.outputDirectory, ".config"), "# CONFIG_TARGET_CORE is not set\n");
    const missing = await execute("bash", ["-c", probe, "source-probe", options.outputDirectory]);
    expect(new RegExp(missing.stdout).test("6.18.34+rpt-rpi-2712")).toBe(true);
    for (const state of ["y", "m"]) {
      await writeFile(path.join(options.outputDirectory, ".config"), `CONFIG_TARGET_CORE=${state}\n`);
      const native = await execute("bash", ["-c", probe, "source-probe", options.outputDirectory]);
      expect(new RegExp(native.stdout).test("6.18.34+rpt-rpi-2712")).toBe(false);
    }
  });

  it("refuses paths outside the pinned Linux source subset", async () => {
    const options = await fixture();
    options.manifest.files[0].path = "../outside";
    const { prepareIscsiDkms } = await import("./prepare-iscsi-dkms.mjs");
    await expect(prepareIscsiDkms(options)).rejects.toThrow(/source path/i);
  });
});
