import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("scripts/cyberos-nas-acl.sh", import.meta.url));
const hasLinuxAclTools =
  process.platform === "linux" &&
  spawnSync("getfacl", ["--version"]).status === 0 &&
  spawnSync("setfacl", ["--version"]).status === 0;
let directory: string | null = null;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

describe("storage pool ACL configuration", () => {
  it("previews without writing, then saves ACL before changing the mounted pool", async () => {
    const fixture = await setup();
    const preview = run(fixture, "--check");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("planned change: grant cyberos rwx");
    await expect(readFile(fixture.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const applied = run(fixture, "--apply");
    expect(applied.status, applied.stderr).toBe(0);
    const [backup] = await readdir(fixture.backups);
    expect(backup).toMatch(/^acl\./u);
    expect(await readFile(path.join(fixture.backups, backup!, "acl.dump"), "utf8")).toContain("# file:");
    expect(await readFile(fixture.log, "utf8")).toContain(`setfacl -m u:cyberos:rwx -- ${fixture.pool}`);
    expect(await readFile(fixture.log, "utf8")).toContain(`setfacl -m d:u:cyberos:rwx -- ${fixture.pool}`);
  });

  it("refuses an unmounted path before writing any ACL", async () => {
    const fixture = await setup();
    const result = run(fixture, "--apply", { CYBEROS_NAS_MOUNTED: "0" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pool is not mounted");
    await expect(readFile(fixture.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an ACL masked below the requested permissions", async () => {
    const fixture = await setup();
    const result = run(fixture, "--apply", { CYBEROS_ACL_MASKED: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cyberos ACL is ineffective");
  });

  it("widens restrictive directory masks without broadening unrelated accounts", async () => {
    const fixture = await setup();
    const preview = run(fixture, "--check", { CYBEROS_EXISTING_MASK: "r-x" });
    expect(preview.status, preview.stderr).toBe(0);
    await expect(readFile(fixture.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const result = run(fixture, "--apply", { CYBEROS_EXISTING_MASK: "r-x" });
    expect(result.status, result.stderr).toBe(0);
    const log = await readFile(fixture.log, "utf8");
    expect(log).toContain(
      `setfacl -n -m u:www-data:r-x,g::r-x,g:operators:r-x,u:cyberos:rwx,m::rwx -- ${fixture.pool}`
    );
    expect(log).toContain(
      `setfacl -n -m d:u:www-data:r-x,d:g::r-x,d:g:operators:r-x,d:u:cyberos:rwx,d:m::rwx -- ${fixture.pool}`
    );
  });

  it("keeps a sufficient existing mask unchanged", async () => {
    const fixture = await setup();
    const result = run(fixture, "--apply", { CYBEROS_EXISTING_MASK: "rwx" });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(fixture.log, "utf8")).toContain(`setfacl -n -m u:cyberos:rwx -- ${fixture.pool}`);
  });

  it("accepts masked group execute rights on a regular file", async () => {
    const fixture = await setup();
    const regularFile = path.join(fixture.pool, "document.txt");
    await writeFile(regularFile, "content");
    const environment = { CYBEROS_REGULAR_FILE: regularFile };

    const preview = run(fixture, "--check", environment);
    expect(preview.status, preview.stderr).toBe(0);

    const result = run(fixture, "--apply", environment);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(fixture.log, "utf8")).toContain(`setfacl -n -m u:cyberos:rw- -- ${regularFile}`);
  });

  it("widens a restrictive file mask while preserving every existing effective permission", async () => {
    const fixture = await setup();
    const restrictedFile = path.join(fixture.pool, ".env");
    await writeFile(restrictedFile, "SECRET=value\n");
    const environment = { CYBEROS_RESTRICTIVE_FILE: restrictedFile };

    const preview = run(fixture, "--check", environment);
    expect(preview.status, preview.stderr).toBe(0);
    await expect(readFile(fixture.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const result = run(fixture, "--apply", environment);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(fixture.log, "utf8")).toContain(
      `setfacl -n -m u:archive:r--,g::r--,u:cyberos:rw-,m::rw- -- ${restrictedFile}`
    );
  });

  it.runIf(hasLinuxAclTools)("preserves effective permissions with real Linux ACL tools", async () => {
    const fixture = await setup();
    const restrictedFile = path.join(fixture.pool, "linux-acl.txt");
    await writeFile(restrictedFile, "content");

    const seeded = spawnSync(
      "setfacl",
      ["-n", "-m", "u:42420:rwx,g::r-x,g:42421:rwx,m::r--", "--", restrictedFile],
      { encoding: "utf8" }
    );
    expect(seeded.status, seeded.stderr).toBe(0);
    const before = spawnSync("getfacl", ["-c", "-n", "-e", "--", restrictedFile], { encoding: "utf8" });
    expect(before.status, before.stderr).toBe(0);
    expect(before.stdout).toMatch(/^user:42420:rwx\s+#effective:r--$/mu);
    expect(before.stdout).toMatch(/^group::r-x\s+#effective:r--$/mu);
    expect(before.stdout).toMatch(/^group:42421:rwx\s+#effective:r--$/mu);

    const updated = spawnSync(
      "setfacl",
      ["-n", "-m", "u:42420:r--,g::r--,g:42421:r--,u:42422:rw-,m::rw-", "--", restrictedFile],
      { encoding: "utf8" }
    );
    expect(updated.status, updated.stderr).toBe(0);
    const after = spawnSync("getfacl", ["-c", "-n", "-e", "--", restrictedFile], { encoding: "utf8" });
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toMatch(/^user:42420:r--\s+#effective:r--$/mu);
    expect(after.stdout).toMatch(/^user:42422:rw-\s+#effective:rw-$/mu);
    expect(after.stdout).toMatch(/^group::r--\s+#effective:r--$/mu);
    expect(after.stdout).toMatch(/^group:42421:r--\s+#effective:r--$/mu);
    expect(after.stdout).toMatch(/^mask::rw-$/mu);
  });

  it("keeps cyberos-owned private partial files private", async () => {
    const fixture = await setup();
    const partial = path.join(fixture.pool, ".download.part");
    await writeFile(partial, "partial");
    const result = run(fixture, "--apply", { CYBEROS_OWNER_FILE: partial });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(fixture.log, "utf8")).not.toContain(`-- ${partial}`);
  });

  it("rejects an ACL backup directory outside the configured CyberOS root", async () => {
    const fixture = await setup();
    const result = run(fixture, "--apply", {
      CYBEROS_ACL_BACKUP_DIR: path.join(os.tmpdir(), "outside-cyberos-root")
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CYBEROS_ACL_BACKUP_DIR must be under");
  });
});

async function setup() {
  directory = await mkdtemp(path.join(os.tmpdir(), "cyberos-nas-acl-"));
  const bin = path.join(directory, "bin");
  const root = path.join(directory, "data");
  const pool = path.join(root, "pool1");
  await mkdir(bin);
  await mkdir(pool, { recursive: true });
  const shim = `#!/bin/sh
case "$(basename "$0")" in
  id) if [ "$1" = -u ] && [ "$#" -eq 1 ]; then printf '0\\n'; else printf '111\\n'; fi ;;
  realpath) for arg do :; done; printf '%s\\n' "$arg" ;;
  findmnt)
    if [ "$CYBEROS_NAS_MOUNTED" = 0 ]; then exit 0; fi
    case " $* " in *' OPTIONS '*) printf 'rw,relatime\\n';; *) printf '%s\\n' "$CYBEROS_POOL";; esac ;;
  find)
    case " $* " in
      *' -printf '*) printf '.' ;;
      *' -print0 '*) printf '%s\\0' "$CYBEROS_POOL"; if [ -n "$CYBEROS_OWNER_FILE" ]; then printf '%s\\0' "$CYBEROS_OWNER_FILE"; fi; if [ -n "$CYBEROS_REGULAR_FILE" ]; then printf '%s\\0' "$CYBEROS_REGULAR_FILE"; fi; if [ -n "$CYBEROS_RESTRICTIVE_FILE" ]; then printf '%s\\0' "$CYBEROS_RESTRICTIVE_FILE"; fi ;;
      *' -exec '*) getfacl --absolute-names "$CYBEROS_POOL" ;;
    esac ;;
  getfacl)
    for arg do :; done
    if [ -n "$CYBEROS_OWNER_FILE" ] && [ "$arg" = "$CYBEROS_OWNER_FILE" ]; then
      printf '# file: %s\\nuser::rw-\\nuser:cyberos:rw-\\t#effective:---\\ngroup::---\\nmask::---\\nother::---\\n' "$arg"
      exit 0
    fi
    if [ -n "$CYBEROS_REGULAR_FILE" ] && [ "$arg" = "$CYBEROS_REGULAR_FILE" ]; then
      printf '# file: %s\\nuser::rw-\\nuser:cyberos:rwx\\n' "$arg"
      if [ -f "$CYBEROS_ACL_LOG" ] && grep -Fq "setfacl -n -m u:cyberos:rw- -- $arg" "$CYBEROS_ACL_LOG"; then
        printf 'user:cyberos:rw-\\n'
      fi
      printf 'group::r-x\\nmask::rw-\\nother::---\\n'
      exit 0
    fi
    if [ -n "$CYBEROS_RESTRICTIVE_FILE" ] && [ "$arg" = "$CYBEROS_RESTRICTIVE_FILE" ]; then
      printf '# file: %s\\nuser::rw-\\n' "$arg"
      if [ -f "$CYBEROS_ACL_LOG" ] && grep -Fq "setfacl -n -m u:archive:r--,g::r--,u:cyberos:rw-,m::rw- -- $arg" "$CYBEROS_ACL_LOG"; then
        printf 'user:archive:r--\\nuser:cyberos:rw-\\ngroup::r--\\nmask::rw-\\nother::---\\n'
      else
        printf 'user:archive:rwx\\t#effective:r--\\ngroup::r-x\\t#effective:r--\\nmask::r--\\nother::---\\n'
      fi
      exit 0
    fi
    printf '# file: %s\\nuser::rwx\\n' "$CYBEROS_POOL"
    if [ -n "$CYBEROS_EXISTING_MASK" ]; then
      printf 'user:www-data:rwx\\ngroup::r-x\\ngroup:operators:rwx\\nmask::%s\\ndefault:user::rwx\\ndefault:user:www-data:rwx\\ndefault:group::r-x\\ndefault:group:operators:rwx\\ndefault:mask::%s\\ndefault:other::r-x\\n' "$CYBEROS_EXISTING_MASK" "$CYBEROS_EXISTING_MASK"
    fi
    if [ "$CYBEROS_ACL_MASKED" = 1 ]; then
      printf 'user:cyberos:rwx\\t#effective:r-x\\n'
    else
      printf 'user:cyberos:rwx\\n'
    fi ;;
  stat)
    for arg do :; done
    if [ -n "$CYBEROS_OWNER_FILE" ] && [ "$arg" = "$CYBEROS_OWNER_FILE" ]; then printf '111\\n'; else printf '999\\n'; fi ;;
  chmod) : ;;
  setfacl) printf 'setfacl %s\\n' "$*" >> "$CYBEROS_ACL_LOG" ;;
esac
`;
  for (const name of ["id", "realpath", "findmnt", "find", "getfacl", "stat", "chmod", "setfacl"]) {
    const target = path.join(bin, name);
    await writeFile(target, shim);
    await chmod(target, 0o755);
  }
  return {
    cyberosRoot: directory,
    bin,
    root,
    pool,
    log: path.join(directory, "calls.log"),
    backups: path.join(directory, "system-backups", "permissions")
  };
}

function run(fixture: Awaited<ReturnType<typeof setup>>, mode: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [script, mode, "--pool", fixture.pool], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      CYBEROS_ROOT: fixture.cyberosRoot,
      CYBEROS_NAS_MOUNTED: "1",
      CYBEROS_POOL: fixture.pool,
      CYBEROS_ACL_BACKUP_DIR: fixture.backups,
      CYBEROS_ACL_LOG: fixture.log,
      ...extraEnv
    }
  });
}
