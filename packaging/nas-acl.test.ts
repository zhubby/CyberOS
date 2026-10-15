import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("scripts/zos-nas-acl.sh", import.meta.url));
let directory: string | null = null;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

describe("NAS ACL migration", () => {
  it("previews without writing, then saves ACL before changing the mounted pool", async () => {
    const fixture = await setup();
    const preview = run(fixture, "--check");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("planned change: grant zos rwx");
    await expect(readFile(fixture.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const applied = run(fixture, "--apply");
    expect(applied.status, applied.stderr).toBe(0);
    const [backup] = await readdir(fixture.backups);
    expect(backup).toMatch(/^acl\./u);
    expect(await readFile(path.join(fixture.backups, backup!, "acl.dump"), "utf8")).toContain("# file:");
    expect(await readFile(fixture.log, "utf8")).toContain(`setfacl -m u:zos:rwx -- ${fixture.pool}`);
    expect(await readFile(fixture.log, "utf8")).toContain(`setfacl -m d:u:zos:rwx -- ${fixture.pool}`);
  });

  it("refuses an unmounted path before writing any ACL", async () => {
    const fixture = await setup();
    const result = run(fixture, "--apply", { ZOS_NAS_MOUNTED: "0" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pool is not mounted");
    await expect(readFile(fixture.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an ACL masked below the requested permissions", async () => {
    const fixture = await setup();
    const result = run(fixture, "--apply", { ZOS_ACL_MASKED: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("zos ACL is ineffective");
  });

  it("rejects a restrictive mask before broadening unrelated accounts", async () => {
    const fixture = await setup();
    const preview = run(fixture, "--check", { ZOS_EXISTING_MASK: "r-x" });
    expect(preview.status).not.toBe(0);
    expect(preview.stderr).toContain("existing access ACL mask needs separate review");
    const result = run(fixture, "--apply", { ZOS_EXISTING_MASK: "r-x" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("existing access ACL mask needs separate review");
    await expect(readFile(fixture.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a sufficient existing mask unchanged", async () => {
    const fixture = await setup();
    const result = run(fixture, "--apply", { ZOS_EXISTING_MASK: "rwx" });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(fixture.log, "utf8")).toContain(`setfacl -n -m u:zos:rwx -- ${fixture.pool}`);
  });

  it("accepts masked group execute rights on a regular file", async () => {
    const fixture = await setup();
    const regularFile = path.join(fixture.pool, "document.txt");
    await writeFile(regularFile, "content");
    const environment = { ZOS_REGULAR_FILE: regularFile };

    const preview = run(fixture, "--check", environment);
    expect(preview.status, preview.stderr).toBe(0);

    const result = run(fixture, "--apply", environment);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(fixture.log, "utf8")).toContain(`setfacl -n -m u:zos:rw- -- ${regularFile}`);
  });

  it("keeps zos-owned private partial files private", async () => {
    const fixture = await setup();
    const partial = path.join(fixture.pool, ".download.part");
    await writeFile(partial, "partial");
    const result = run(fixture, "--apply", { ZOS_OWNER_FILE: partial });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(fixture.log, "utf8")).not.toContain(`-- ${partial}`);
  });

  it("rejects an ACL backup directory outside the configured ZOS root", async () => {
    const fixture = await setup();
    const result = run(fixture, "--apply", {
      ZOS_ACL_BACKUP_DIR: path.join(os.tmpdir(), "outside-zos-root")
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ZOS_ACL_BACKUP_DIR must be under");
  });
});

async function setup() {
  directory = await mkdtemp(path.join(os.tmpdir(), "zos-nas-acl-"));
  const bin = path.join(directory, "bin");
  const root = path.join(directory, "nas");
  const pool = path.join(root, "pool1");
  await mkdir(bin);
  await mkdir(pool, { recursive: true });
  const shim = `#!/bin/sh
case "$(basename "$0")" in
  id) if [ "$1" = -u ] && [ "$#" -eq 1 ]; then printf '0\\n'; else printf '111\\n'; fi ;;
  realpath) for arg do :; done; printf '%s\\n' "$arg" ;;
  findmnt)
    if [ "$ZOS_NAS_MOUNTED" = 0 ]; then exit 0; fi
    case " $* " in *' OPTIONS '*) printf 'rw,relatime\\n';; *) printf '%s\\n' "$ZOS_POOL";; esac ;;
  find)
    case " $* " in
      *' -printf '*) printf '.' ;;
      *' -print0 '*) printf '%s\\0' "$ZOS_POOL"; if [ -n "$ZOS_OWNER_FILE" ]; then printf '%s\\0' "$ZOS_OWNER_FILE"; fi; if [ -n "$ZOS_REGULAR_FILE" ]; then printf '%s\\0' "$ZOS_REGULAR_FILE"; fi ;;
      *' -exec '*) getfacl --absolute-names "$ZOS_POOL" ;;
    esac ;;
  getfacl)
    for arg do :; done
    if [ -n "$ZOS_OWNER_FILE" ] && [ "$arg" = "$ZOS_OWNER_FILE" ]; then
      printf '# file: %s\\nuser::rw-\\nuser:zos:rw-\\t#effective:---\\ngroup::---\\nmask::---\\nother::---\\n' "$arg"
      exit 0
    fi
    if [ -n "$ZOS_REGULAR_FILE" ] && [ "$arg" = "$ZOS_REGULAR_FILE" ]; then
      printf '# file: %s\\nuser::rw-\\nuser:sigmaos:rwx\\n' "$arg"
      if [ -f "$ZOS_ACL_LOG" ] && grep -Fq "setfacl -n -m u:zos:rw- -- $arg" "$ZOS_ACL_LOG"; then
        printf 'user:zos:rw-\\n'
      fi
      printf 'group::r-x\\nmask::rw-\\nother::---\\n'
      exit 0
    fi
    printf '# file: %s\\nuser::rwx\\n' "$ZOS_POOL"
    if [ -n "$ZOS_EXISTING_MASK" ]; then
      printf 'user:www-data:rwx\\ngroup::r-x\\nmask::%s\\ndefault:group::r-x\\ndefault:mask::%s\\n' "$ZOS_EXISTING_MASK" "$ZOS_EXISTING_MASK"
    fi
    if [ "$ZOS_ACL_MASKED" = 1 ]; then
      printf 'user:zos:rwx\\t#effective:r-x\\n'
    else
      printf 'user:zos:rwx\\n'
    fi ;;
  stat)
    for arg do :; done
    if [ -n "$ZOS_OWNER_FILE" ] && [ "$arg" = "$ZOS_OWNER_FILE" ]; then printf '111\\n'; else printf '999\\n'; fi ;;
  chmod) : ;;
  setfacl) printf 'setfacl %s\\n' "$*" >> "$ZOS_ACL_LOG" ;;
esac
`;
  for (const name of ["id", "realpath", "findmnt", "find", "getfacl", "stat", "chmod", "setfacl"]) {
    const target = path.join(bin, name);
    await writeFile(target, shim);
    await chmod(target, 0o755);
  }
  return {
    zosRoot: directory,
    bin,
    root,
    pool,
    log: path.join(directory, "calls.log"),
    backups: path.join(directory, "system-backups", "permissions")
  };
}

function run(fixture: Awaited<ReturnType<typeof setup>>, mode: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [script, mode, "--pool", fixture.pool, "--root", fixture.root], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      ZOS_ROOT: fixture.zosRoot,
      ZOS_NAS_MOUNTED: "1",
      ZOS_POOL: fixture.pool,
      ZOS_ACL_BACKUP_DIR: fixture.backups,
      ZOS_ACL_LOG: fixture.log,
      ...extraEnv
    }
  });
}
