import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(distro = 'ID=debian\nVERSION_CODENAME=trixie\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-tailscale-install-")); roots.push(root);
  const bin = path.join(root, "bin");
  for (const dir of [bin, "etc/apt/sources.list.d", "usr/share/keyrings"]) await mkdir(path.join(root, dir === bin ? "" : dir) || root, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(root, "etc/os-release"), distro);
  const commands: Record<string, string> = {
    id: "printf 0", dpkg: "printf arm64",
    curl: `while [ "$#" -gt 0 ]; do if [ "$1" = '-o' ]; then shift; printf test-signing-key > "$1"; exit 0; fi; shift; done; exit 1`,
    "apt-get": `printf '%s\\n' "$*" >> '${root}/apt-calls'; [ "\${FAIL_APT:-0}" = 0 ]`,
    "apt-cache": "exit 0"
  };
  for (const [name, body] of Object.entries(commands)) { const p = path.join(bin, name); await writeFile(p, `#!/bin/sh\n${body}\n`); await chmod(p, 0o755); }
  const source = await readFile(new URL("scripts/cyberos-configure-tailscale.sh", import.meta.url), "utf8");
  const script = path.join(root, "prepare.sh");
  await writeFile(script, source.replaceAll("/etc/", `${root}/etc/`).replaceAll("/usr/share/keyrings", `${root}/usr/share/keyrings`));
  return { root, script, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

describe("Tailscale installation repository", () => {
  it("prepares a signed stable repository and can run repeatedly without changing existing sources", async () => {
    const f = await fixture();
    const administrator = path.join(f.root, "etc/apt/sources.list.d/administrator.list"); await writeFile(administrator, "deb https://example.com/custom stable main\n");
    await run("sh", [f.script], { env: f.env });
    await run("sh", [f.script], { env: f.env });
    const repository = await readFile(path.join(f.root, "etc/apt/sources.list.d/cyberos-tailscale.list"), "utf8");
    expect(repository).toContain("signed-by="); expect(repository).toContain("https://pkgs.tailscale.com/stable/debian trixie main");
    expect(await readFile(administrator, "utf8")).toBe("deb https://example.com/custom stable main\n");
    expect(await readFile(path.join(f.root, "apt-calls"), "utf8")).toContain("update");
  });
  it("rejects unknown distributions before adding a repository", async () => {
    const f = await fixture('ID=unknown\nVERSION_CODENAME=unsupported\n');
    await expect(run("sh", [f.script], { env: f.env })).rejects.toThrow();
    await expect(readFile(path.join(f.root, "etc/apt/sources.list.d/cyberos-tailscale.list"))).rejects.toThrow();
  });
  it("reports repository failure before an installer can stop running services", async () => {
    const f = await fixture();
    await expect(run("sh", [f.script], { env: { ...f.env, FAIL_APT: "1" } })).rejects.toThrow();
    expect(await readFile(path.join(f.root, "apt-calls"), "utf8")).not.toContain("install");
  });
});
