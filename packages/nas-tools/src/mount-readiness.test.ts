import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkMountReadiness, type MountCommandRunner } from "./mount-readiness.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function makeRoot(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-mount-"));
  const root = path.join(tempDir, "nas");
  await mkdir(root);
  return root;
}

function runner(output: string): MountCommandRunner {
  return { run: async () => output };
}

describe("mount readiness", () => {
  it("accepts a required root covered by the expected mount", async () => {
    const root = await makeRoot();
    const result = await checkMountReadiness(
      { id: "nas", name: "NAS", path: root, mountPolicy: "required" },
      { commandRunner: runner(JSON.stringify({ filesystems: [{ source: "/dev/sda1", uuid: "abc", fstype: "ext4", target: root }] })) }
    );
    expect(result).toMatchObject({ status: "ready", source: "/dev/sda1", uuid: "abc", fstype: "ext4" });
  });

  it("rejects an existing directory that is only covered by the root filesystem", async () => {
    const root = await makeRoot();
    const result = await checkMountReadiness(
      { id: "nas", name: "NAS", path: root, mountPolicy: "required" },
      { commandRunner: runner(JSON.stringify({ filesystems: [{ source: "/dev/root", uuid: "root", fstype: "ext4", target: "/" }] })) }
    );
    expect(result).toMatchObject({ status: "not_ready", reason: "path is not covered by a dedicated mount" });
  });

  it("rejects a mount identity mismatch", async () => {
    const root = await makeRoot();
    const result = await checkMountReadiness(
      { id: "nas", name: "NAS", path: root, mountPolicy: "required", expectedUuid: "expected" },
      { commandRunner: runner(JSON.stringify({ filesystems: [{ source: "/dev/sda1", uuid: "actual", fstype: "ext4", target: root }] })) }
    );
    expect(result).toMatchObject({ status: "not_ready", reason: "mount identity mismatch" });
  });

  it("reports findmnt failures as unknown", async () => {
    const root = await makeRoot();
    const commandRunner: MountCommandRunner = { run: async () => { throw new Error("missing"); } };
    await expect(checkMountReadiness({ id: "nas", name: "NAS", path: root, mountPolicy: "required" }, { commandRunner }))
      .resolves.toMatchObject({ status: "unknown", reason: "findmnt unavailable" });
  });

  it("allows development optional roots without findmnt", async () => {
    const root = await makeRoot();
    await expect(checkMountReadiness({ id: "nas", name: "NAS", path: root, mountPolicy: "optional" }))
      .resolves.toMatchObject({ status: "ready" });
  });
});
