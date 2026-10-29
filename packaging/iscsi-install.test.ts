import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("iSCSI dependency installation", () => {
  it.each(["install", "upgrade"])("guards targetctl before dependencies configure during %s", async (action) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-iscsi-install-"));
    roots.push(root);
    const runtime = path.join(root, "run/systemd/system");
    const bin = path.join(root, "bin");
    await mkdir(runtime, { recursive: true });
    await mkdir(bin);
    const guard = path.join(runtime, "rtslib-fb-targetctl.service.d/cyberos-install.conf");
    const calls = path.join(root, "systemctl-calls");
    const systemctl = path.join(bin, "systemctl");
    await writeFile(systemctl, `#!/bin/sh\nset -eu\n[ -f '${guard}' ]\nprintf '%s\\n' "$*" >> '${calls}'\n`);
    await chmod(systemctl, 0o755);
    const preinst = await readFile(new URL("debian/preinst", import.meta.url), "utf8").catch(() => "");
    const script = path.join(root, "preinst");
    await writeFile(script, preinst.replaceAll("/run/systemd/system", runtime));
    execFileSync("sh", [script, action], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(await readFile(guard, "utf8")).toBe("[Unit]\nConditionPathIsDirectory=/sys/kernel/config/target\n");
    expect(await readFile(calls, "utf8")).toBe("daemon-reload\n");
  });

  it("keeps native targetctl restoration conditional on available LIO", async () => {
    const dropin = await readFile(new URL("systemd/rtslib-fb-targetctl.service.d/cyberos.conf", import.meta.url), "utf8");
    expect(dropin).toContain("ConditionPathIsDirectory=/sys/kernel/config/target");
    expect(dropin).not.toMatch(/^(?:Wants|Requires)=/m);
    const install = await readFile(new URL("debian/install", import.meta.url), "utf8");
    expect(install).toContain("packaging/systemd/rtslib-fb-targetctl.service.d/cyberos.conf lib/systemd/system/rtslib-fb-targetctl.service.d/");
  });

  it("removes only its temporary guard after configuration or aborted installation", async () => {
    for (const name of ["postinst", "postrm"]) {
      const script = await readFile(new URL(`debian/${name}`, import.meta.url), "utf8");
      expect(script).toContain("rm -f /run/systemd/system/rtslib-fb-targetctl.service.d/cyberos-install.conf");
      expect(script).not.toContain("rm -rf /run/systemd/system/rtslib-fb-targetctl.service.d");
    }
  });

  it.each(["no", "yes"])("loads LIO and clears only skipped restoration failures (condition %s)", async (restoreCondition) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-iscsi-activation-"));
    roots.push(root);
    const deploy = await readFile(new URL("scripts/cyberos-deploy", import.meta.url), "utf8");
    const start = deploy.indexOf("activate_runtime() {");
    const end = deploy.indexOf("\nverify_runtime() {", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const script = path.join(root, "activate");
    await writeFile(script, `set -eu
STATEFUL_RUNTIME_UNITS=''
RUNTIME_SERVICES=''
TIMERS=''
modules_loaded=0
stale_failed=1
systemctl() {
  case "$*" in
    'restart cyberos-iscsi-prepare.service') modules_loaded=1 ;;
    'show --property=ConditionResult --value rtslib-fb-targetctl.service') printf '%s\\n' '${restoreCondition}' ;;
    'reset-failed rtslib-fb-targetctl.service') stale_failed=0 ;;
    'start cyberos-hostd.service')
      [ "$modules_loaded" -eq 1 ] || { echo 'LIO was not loaded after installation' >&2; return 1; }
      if [ '${restoreCondition}' = no ]; then
        [ "$stale_failed" -eq 0 ] || { echo 'Skipped restoration left a stale failure' >&2; return 1; }
      else
        [ "$stale_failed" -eq 1 ] || { echo 'A real restoration failure was hidden' >&2; return 1; }
      fi ;;
  esac
}
log() { :; }
stop_unit() { :; }
start_service_stably() { systemctl start "$1"; }
wait_for_url() { :; }
restore_unit_state() { :; }
apply_tv_runtime_settings() { :; }
${deploy.slice(start, end)}
activate_runtime "$1"
`);
    const result = spawnSync("sh", [script, root], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("repairs only recognized interrupted releases and rejects incomplete verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-deploy-preflight-"));
    roots.push(root);
    const buildPath = path.join(root, "build-info.json");
    await writeFile(buildPath, JSON.stringify({ version: "2.0.8", source: "release", commitSha: "a".repeat(40) }));
    const workflow = await readFile(new URL("../.github/workflows/deploy-cm5.yml", import.meta.url), "utf8");
    const start = workflow.indexOf('case "$package_status" in');
    const end = workflow.indexOf('[ -x /usr/local/sbin/cyberos-deploy ]', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const script = path.join(root, "preflight");
    await writeFile(script, `set -eu
package_status=$1
verify_only=$2
package_version=$3
target_version=$4
target_commit=$5
sudo() { printf '%s' "\${TEST_DATABASE_CHECK:-ok}"; }
${workflow.slice(start, end).replace(/^ {10}/gm, "").replaceAll("/usr/lib/cyberos/build-info.json", buildPath)}`);
    const run = (status: string, verify = "false", version = "2.0.8", integrity = "ok", target = "2.0.9", commit = "b".repeat(40)) => spawnSync("sh", [script, status, verify, version, target, commit], { encoding: "utf8", env: { ...process.env, TEST_DATABASE_CHECK: integrity } });
    const installed = run("install ok installed", "true");
    expect(installed.status, installed.stderr).toBe(0);
    for (const status of ["install ok unpacked", "install ok half-configured"]) {
      expect(run(status).status).toBe(0);
      expect(run(status, "true").status).not.toBe(0);
      expect(run(status, "false", "2.0.7").status).not.toBe(0);
      expect(run(status, "false", "2.0.8", "corrupt").status).not.toBe(0);
      expect(run(status, "false", "2.0.8", "ok", "2.0.7").status).not.toBe(0);
      expect(run(status, "false", "2.0.8", "ok", "2.0.8").status).not.toBe(0);
      expect(run(status, "false", "2.0.8", "ok", "2.0.8", "a".repeat(40)).status).toBe(0);
    }
    expect(run("deinstall ok config-files").status).not.toBe(0);
    expect(run("install reinstreq half-installed").status).not.toBe(0);
  });
});
