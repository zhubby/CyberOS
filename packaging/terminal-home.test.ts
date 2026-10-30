import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("terminal home installation", () => {
  it.each(["install", "upgrade"])("accepts a fresh account or the current home during %s", async (action) => {
    const fixture = await installationFixture();
    for (const home of ["", "/home/cyberos"]) {
      const result = fixture.run("preinst", action, home);
      expect(result.status, result.stderr).toBe(0);
    }
  });

  it.each(["/cyberos/home/terminal", "/home/another-user"])("rejects %s before changing the host", async (home) => {
    const fixture = await installationFixture();
    for (const [script, action] of [["preinst", "install"], ["preinst", "upgrade"], ["postinst", "configure"]] as const) {
      const result = fixture.run(script, action, home);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("clean installation");
      expect(result.stderr).toContain("/home/cyberos");
      await expect(readFile(fixture.hostChanges, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

describe("terminal home upgrade backup", () => {
  it("restores terminal configuration and user files without archiving the tmux socket", async () => {
    const fixture = await backupFixture();
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(path.join(fixture.home, ".cyberos/tmux.sock"), resolve));
    try {
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("tmux.sock");
      const restore = path.join(fixture.root, "restore");
      await mkdir(restore);
      execFileSync("tar", ["-C", restore, "-xzf", path.join(fixture.backup, "terminal-home.tgz")]);
      expect(await readFile(path.join(restore, "cyberos/.bashrc"), "utf8")).toBe("export EDITOR=vi\n");
      expect(await readFile(path.join(restore, "cyberos/notes.txt"), "utf8")).toBe("keep this file\n");
      expect(await readFile(path.join(restore, "cyberos/.cyberos/settings"), "utf8")).toBe("keep settings\n");
      expect((await stat(path.join(restore, "cyberos"))).mode & 0o777).toBe(0o750);
      expect((await stat(path.join(restore, "cyberos/.cyberos/settings"))).mode & 0o777).toBe(0o600);
      await expect(readFile(path.join(restore, "cyberos/.cyberos/tmux.sock"))).rejects.toMatchObject({ code: "ENOENT" });
      const stateEntries = execFileSync("tar", ["-tzf", path.join(fixture.backup, "state.tgz")], { encoding: "utf8" });
      expect(stateEntries.split("\n")).toContain("state/database");
      expect(stateEntries.split("\n")).toContain("home/share/");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("stops before installing a package when the terminal home cannot be backed up", async () => {
    const fixture = await backupFixture();
    await rm(fixture.home, { recursive: true });
    const result = fixture.run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("installing package");
  });
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-home-"));
  roots.push(root);
  return root;
}

async function installationFixture() {
  const root = await temporaryRoot();
  const bin = path.join(root, "bin");
  const hostChanges = path.join(root, "host-changes");
  await mkdir(bin);
  await executable(path.join(bin, "getent"), `#!/bin/sh
if [ "$1 $2" = 'passwd cyberos' ]; then
  [ -n "$TEST_TERMINAL_HOME" ] || exit 2
  printf 'cyberos:x:999:999::%s:/bin/bash\n' "$TEST_TERMINAL_HOME"
  exit 0
fi
exit 2
`);
  for (const name of ["install", "addgroup", "adduser", "usermod", "systemctl", "rm", "chown", "ln"]) {
    await executable(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${hostChanges}'\nexit 97\n`);
  }
  for (const name of ["preinst", "postinst"]) {
    const script = await readFile(new URL(`debian/${name}`, import.meta.url), "utf8");
    await writeFile(path.join(root, name), script.replaceAll("/run/systemd/system", path.join(root, "systemd")));
  }
  return {
    hostChanges,
    run: (script: string, action: string, home: string) => spawnSync("sh", [path.join(root, script), action], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_TERMINAL_HOME: home }
    })
  };
}

async function backupFixture() {
  const root = await temporaryRoot();
  const cyberosRoot = path.join(root, "cyberos");
  const homeParent = path.join(root, "home");
  const home = path.join(homeParent, "cyberos");
  const backup = path.join(root, "backup");
  await Promise.all([
    mkdir(path.join(cyberosRoot, "state"), { recursive: true }),
    mkdir(path.join(cyberosRoot, "home/share"), { recursive: true }),
    mkdir(path.join(home, ".cyberos"), { recursive: true }),
    mkdir(backup)
  ]);
  await Promise.all([
    writeFile(path.join(cyberosRoot, "state/database"), "database fixture"),
    writeFile(path.join(home, ".bashrc"), "export EDITOR=vi\n"),
    writeFile(path.join(home, "notes.txt"), "keep this file\n"),
    writeFile(path.join(home, ".cyberos/settings"), "keep settings\n")
  ]);
  await chmod(home, 0o750);
  await chmod(path.join(home, ".cyberos/settings"), 0o600);
  const deploy = await readFile(new URL("scripts/cyberos-deploy", import.meta.url), "utf8");
  const start = deploy.indexOf('if [ "$create_upgrade_backup" -eq 1 ]; then', deploy.indexOf('log "stopping scheduled writers and services"'));
  const end = deploy.indexOf('log "installing $manifest_tag"', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const script = path.join(root, "backup.sh");
  await writeFile(script, `set -eu\ncreate_upgrade_backup=1\nbackup_path=$1\n${deploy.slice(start, end)
    .replaceAll("-C /cyberos", `-C '${cyberosRoot}'`)
    .replaceAll("-C /home", `-C '${homeParent}'`)}\nprintf 'installing package\\n'\n`);
  return {
    root, home, backup,
    run: () => spawnSync("sh", [script, backup], { encoding: "utf8" })
  };
}

async function executable(file: string, content: string) {
  await writeFile(file, content);
  await chmod(file, 0o755);
}
