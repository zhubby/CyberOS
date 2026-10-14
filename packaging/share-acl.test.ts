import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("scripts/zos-share-acl.mjs", import.meta.url));
let directory: string | null = null;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

describe("share ACL transaction", () => {
  it.skipIf(process.platform !== "linux")("changes only the shared tree and restores ACLs on rollback", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "zos-share-acl-real-"));
    const shared = path.join(directory, "shared");
    const privatePath = path.join(directory, "private");
    const state = path.join(directory, "state.json");
    const backup = path.join(directory, "system-backups", "permissions");
    await mkdir(path.join(shared, "nested"), { recursive: true });
    await mkdir(privatePath);
    const runReal = (action: string, grants?: unknown[], transaction?: string) => spawnSync(
      process.execPath,
      [script, action, state, ...(transaction ? [transaction] : [])],
      { input: grants ? JSON.stringify({ grants }) : undefined, encoding: "utf8",
        env: { ...process.env, ZOS_ROOT: directory!, ZOS_ACL_BACKUP_DIR: backup } }
    );
    const grant = { path: shared, principal: "nobody", access: "write", scope: "tree" };
    const initial = runReal("prepare", [grant]);
    expect(initial.status, initial.stderr).toBe(0);
    expect(runReal("commit", undefined, initial.stdout.trim()).status).toBe(0);
    expect(spawnSync("getfacl", ["-c", path.join(shared, "nested")], { encoding: "utf8" }).stdout)
      .toContain("user:nobody:rwx");
    expect(spawnSync("getfacl", ["-c", privatePath], { encoding: "utf8" }).stdout)
      .not.toContain("user:nobody:");

    const removal = runReal("prepare", []);
    expect(removal.status, removal.stderr).toBe(0);
    expect(runReal("rollback", undefined, removal.stdout.trim()).status).toBe(0);
    expect(spawnSync("getfacl", ["-c", shared], { encoding: "utf8" }).stdout)
      .toContain("user:nobody:rwx");
    const retry = runReal("prepare", []);
    expect(retry.status, retry.stderr).toBe(0);
    expect(runReal("commit", undefined, retry.stdout.trim()).status).toBe(0);
    expect(spawnSync("getfacl", ["-c", shared], { encoding: "utf8" }).stdout)
      .not.toContain("user:nobody:");
  });

  it.skipIf(process.platform !== "linux")("refuses to broaden another account through an ACL mask", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "zos-share-mask-"));
    const shared = path.join(directory, "shared");
    const state = path.join(directory, "state.json");
    await mkdir(shared);
    expect(spawnSync("setfacl", ["-m", "u:www-data:rwx,m::r-x", shared]).status).toBe(0);
    const result = spawnSync(process.execPath, [script, "prepare", state], {
      input: JSON.stringify({ grants: [{ path: shared, principal: "nobody", access: "write", scope: "tree" }] }),
      encoding: "utf8",
      env: { ...process.env, ZOS_ROOT: directory, ZOS_ACL_BACKUP_DIR: path.join(directory, "system-backups", "permissions") }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Existing ACL mask needs separate review");
    const acl = spawnSync("getfacl", ["-c", "-e", shared], { encoding: "utf8" }).stdout;
    expect(acl).toContain("user:www-data:rwx\t#effective:r-x");
    expect(acl).not.toContain("user:nobody:");
  });

  it.skipIf(process.platform !== "linux")("restores write access when a read-only shared file is chmod 0644", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "zos-share-upgrade-"));
    const shared = path.join(directory, "shared");
    const file = path.join(shared, "existing.txt");
    const state = path.join(directory, "state.json");
    const backup = path.join(directory, "system-backups", "permissions");
    await mkdir(shared);
    await writeFile(file, "existing\n");
    const runReal = (action: string, access: "read" | "write") => spawnSync(process.execPath,
      [script, action, state], {
        input: JSON.stringify({ grants: [{ path: shared, principal: "nobody", access, scope: "tree" }] }),
        encoding: "utf8", env: { ...process.env, ZOS_ROOT: directory!, ZOS_ACL_BACKUP_DIR: backup }
      });
    const first = runReal("prepare", "read");
    expect(first.status, first.stderr).toBe(0);
    expect(spawnSync(process.execPath, [script, "commit", state, first.stdout.trim()], {
      env: { ...process.env, ZOS_ROOT: directory, ZOS_ACL_BACKUP_DIR: backup }
    }).status).toBe(0);
    expect(spawnSync("setfacl", ["-n", "-m", "g::r--", file]).status).toBe(0);
    await chmod(file, 0o644);
    const before = spawnSync("getfacl", ["-c", "-e", file], { encoding: "utf8" }).stdout;
    expect(before).toContain("user:nobody:r--");
    expect(before).toContain("group::r--");
    const upgrade = runReal("prepare", "write");
    expect(upgrade.status, upgrade.stderr).toBe(0);
    const acl = spawnSync("getfacl", ["-c", "-e", file], { encoding: "utf8" }).stdout;
    expect(acl).toContain("user:nobody:rw-\t#effective:rw-");
    expect(acl).toContain("group::r--\t#effective:r--");
    expect(acl).toContain("mask::rw-");
    expect(acl).toContain("other::r--");
  });

  it.skipIf(process.platform !== "linux")("keeps masked execute rights masked on existing regular files", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "zos-share-file-mask-"));
    const shared = path.join(directory, "shared");
    const file = path.join(shared, "existing.txt");
    const state = path.join(directory, "state.json");
    await mkdir(shared);
    await writeFile(file, "existing\n");
    expect(spawnSync("setfacl", ["-m", "m::rwx,d:m::rwx", shared]).status).toBe(0);
    expect(spawnSync("setfacl", ["-m", "u:nobody:r-x,m::rw-", file]).status).toBe(0);
    const result = spawnSync(process.execPath, [script, "prepare", state], {
      input: JSON.stringify({ grants: [{ path: shared, principal: "www-data", access: "write", scope: "tree" }] }),
      encoding: "utf8",
      env: { ...process.env, ZOS_ROOT: directory, ZOS_ACL_BACKUP_DIR: path.join(directory, "system-backups", "permissions") }
    });
    expect(result.status, result.stderr).toBe(0);
    const acl = spawnSync("getfacl", ["-c", "-e", file], { encoding: "utf8" }).stdout;
    expect(acl).toContain("user:nobody:r-x\t#effective:r--");
    expect(acl).toContain("user:www-data:rwx\t#effective:rw-");
    expect(acl).toContain("mask::rw-");
  });

  it("commits scoped grants and rolls back a subsequent removal", async () => {
    const fixture = await setup();
    const grant = { path: fixture.shared, principal: "www-data", access: "read", scope: "tree" };
    const prepared = run(fixture, "prepare", JSON.stringify({ grants: [grant] }));
    expect(prepared.status).toBe(0);
    const transaction = prepared.stdout.trim();
    expect(run(fixture, "commit", undefined, transaction).status).toBe(0);
    await expect(readFile(fixture.state, "utf8")).resolves.toBe(JSON.stringify([grant]));

    const removed = run(fixture, "prepare", JSON.stringify({ grants: [] }));
    expect(removed.status).toBe(0);
    expect(run(fixture, "rollback", undefined, removed.stdout.trim()).status).toBe(0);
    await expect(readFile(fixture.state, "utf8")).resolves.toBe(JSON.stringify([grant]));
    const calls = await readFile(fixture.log, "utf8");
    expect(calls).toContain(`setfacl -R -P -n -m u:www-data:rX -- ${fixture.shared}`);
    expect(calls).toContain(`setfacl -R -P -n -x u:www-data -- ${fixture.shared}`);
    expect(calls).toContain("setfacl --restore=");
  });

  it("refuses to replace a pre-existing administrator ACL", async () => {
    const fixture = await setup();
    const prepared = run(fixture, "prepare", JSON.stringify({ grants: [
      { path: fixture.shared, principal: "www-data", access: "write", scope: "tree" }
    ] }), undefined, { ZOS_FAKE_EXISTING: "1" });
    expect(prepared.status).not.toBe(0);
    expect(prepared.stderr).toContain("refusing to replace administrator permissions");
  });

  it("rejects an ACL backup directory outside the configured ZOS root", async () => {
    const fixture = await setup();
    const result = run(fixture, "prepare", JSON.stringify({ grants: [] }), undefined, {
      ZOS_ACL_BACKUP_DIR: path.join(os.tmpdir(), "outside-zos-root")
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ZOS_ACL_BACKUP_DIR must be under");
  });

  it("removes stale state when a previously shared directory was deleted", async () => {
    const fixture = await setup();
    const missing = path.join(directory!, "removed");
    await writeFile(fixture.state, JSON.stringify([
      { path: missing, principal: "www-data", access: "read", scope: "tree" }
    ]));
    const prepared = run(fixture, "prepare", JSON.stringify({ grants: [] }));
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(prepared.stderr).toContain("Previously shared path is missing");
    expect(run(fixture, "commit", undefined, prepared.stdout.trim()).status).toBe(0);
    await expect(readFile(fixture.state, "utf8")).resolves.toBe("[]");
  });

  it("accepts an existing managed child when its parent becomes shared", async () => {
    const fixture = await setup();
    const child = path.join(fixture.shared, "child");
    await mkdir(child);
    await writeFile(fixture.state, JSON.stringify([
      { path: child, principal: "www-data", access: "read", scope: "tree" }
    ]));
    const prepared = run(fixture, "prepare", JSON.stringify({ grants: [
      { path: fixture.shared, principal: "www-data", access: "read", scope: "tree" }
    ] }), undefined, { ZOS_FAKE_MANAGED_CHILD: child });
    expect(prepared.status, prepared.stderr).toBe(0);
  });
});

async function setup() {
  directory = await mkdtemp(path.join(os.tmpdir(), "zos-share-acl-"));
  const bin = path.join(directory, "bin");
  const shared = path.join(directory, "shared");
  await mkdir(bin);
  await mkdir(shared);
  const shim = `#!/bin/sh
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$ZOS_ACL_LOG"
case "$(basename "$0")" in
  findmnt) printf '/\\n' ;;
  getfacl)
    for arg do :; done
    printf '# file: %s\\nuser::rwx\\n' "$arg"
    if [ "$ZOS_FAKE_EXISTING" = 1 ]; then printf 'user:www-data:rwx\\n'; fi
    if [ -n "$ZOS_FAKE_MANAGED_CHILD" ]; then
      printf '# file: %s\\nuser:www-data:r-x\\n' "$ZOS_FAKE_MANAGED_CHILD"
    fi ;;
esac
`;
  for (const command of ["findmnt", "getfacl", "setfacl", "find"]) {
    const target = path.join(bin, command);
    await writeFile(target, shim);
    await chmod(target, 0o755);
  }
  return {
    zosRoot: directory,
    bin,
    shared,
    state: path.join(directory, "state.json"),
    log: path.join(directory, "calls.log"),
    backups: path.join(directory, "system-backups", "permissions")
  };
}

function run(
  fixture: Awaited<ReturnType<typeof setup>>,
  action: string,
  input?: string,
  transaction?: string,
  extraEnv: NodeJS.ProcessEnv = {}
) {
  return spawnSync(process.execPath, [script, action, fixture.state, ...(transaction ? [transaction] : [])], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      ZOS_ROOT: fixture.zosRoot,
      ZOS_ACL_BACKUP_DIR: fixture.backups,
      ZOS_ACL_LOG: fixture.log,
      ...extraEnv
    }
  });
}
