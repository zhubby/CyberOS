import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve("packaging/scripts/cyberos-tv-mode");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("cyberos-tv-mode", () => {
  it("enables the kiosk and restores the previous desktop session", async () => {
    const fixture = await createFixture("ready");
    const enabled = run(fixture, "enable");

    expect(enabled.status).toBe(0);
    await expect(readFile(path.join(fixture.configDirectory, "enabled"), "utf8")).resolves.toBe("enabled\n");
    await expect(readFile(path.join(fixture.systemdDirectory, "lightdm.service.d", "50-cyberos-tv-mode.conf"), "utf8"))
      .resolves.toContain("ConditionPathExists=!");
    await expect(readFile(path.join(fixture.systemdDirectory, "cyberos-vod-player.service.d", "50-cyberos-tv-mode.conf"), "utf8"))
      .resolves.toContain("CYBEROS_VOD_PLAYER_VIDEO_OUTPUT=wayland");
    await expect(readFile(path.join(fixture.stateDirectory, "desktop-state"), "utf8"))
      .resolves.toContain("DM_ENABLED=enabled");

    const disabled = run(fixture, "disable");
    expect(disabled.status).toBe(0);
    const calls = await readFile(fixture.systemctlLog, "utf8");
    expect(calls).toContain("stop lightdm.service");
    expect(calls).toContain("start lightdm.service");
    expect(calls).toContain("enable cyberos-tv.target");
    expect(calls).toContain("disable cyberos-tv.target");
    await expect(readFile(path.join(fixture.stateDirectory, "desktop-state"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back the desktop and its own drop-ins when readiness fails", async () => {
    const fixture = await createFixture("degraded");
    const result = run(fixture, "enable");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("startup failed or did not become ready");
    const calls = await readFile(fixture.systemctlLog, "utf8");
    expect(calls).toContain("start lightdm.service");
    await expect(readFile(path.join(fixture.configDirectory, "enabled"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(fixture.systemdDirectory, "cyberos-vod-player.service.d", "50-cyberos-tv-mode.conf"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the desktop snapshot when rollback cannot restore the prior session", async () => {
    const fixture = await createFixture("degraded", { failStartDisplayManager: true });
    const result = run(fixture, "enable");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("keeping");
    await expect(readFile(path.join(fixture.stateDirectory, "desktop-state"), "utf8"))
      .resolves.toContain("DM_UNIT=lightdm.service");
  });

  it("refuses host mutation under declarative policy", async () => {
    const fixture = await createFixture("ready");
    const result = run(fixture, "enable", { CYBEROS_HOST_MUTATION_POLICY: "declarative" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("managed declaratively");
    await expect(readFile(fixture.systemctlLog, "utf8")).resolves.toBe("");
  });
});

interface Fixture {
  root: string;
  binDirectory: string;
  stateDirectory: string;
  configDirectory: string;
  systemdDirectory: string;
  systemctlLog: string;
}

async function createFixture(
  tvState: "ready" | "degraded",
  options: { failStartDisplayManager?: boolean } = {}
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-tv-mode-test-"));
  temporaryDirectories.push(root);
  const binDirectory = path.join(root, "bin");
  const stateDirectory = path.join(root, "state");
  const configDirectory = path.join(root, "config");
  const systemdDirectory = path.join(root, "systemd");
  const systemctlLog = path.join(root, "systemctl.log");
  await mkdir(binDirectory, { recursive: true });
  await writeFile(systemctlLog, "");
  await executable(path.join(binDirectory, "id"), "#!/bin/sh\nprintf '0\\n'\n");
  await executable(path.join(binDirectory, "install"), `#!/bin/sh
set -eu
directories=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) directories=1; shift ;;
    -o|-g|-m) shift 2 ;;
    *) break ;;
  esac
done
[ "$directories" = 1 ] || exit 2
mkdir -p "$@"
`);
  await executable(path.join(binDirectory, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> '${systemctlLog}'
case "$*" in
  'show display-manager.service --property=Id --value') printf 'lightdm.service\\n' ;;
  'is-enabled lightdm.service') printf 'enabled\\n' ;;
  'is-active --quiet lightdm.service'|'is-active --quiet cyberos-vod-player.service'|'is-active --quiet cyberos-api.service') exit 0 ;;
  'is-active cyberos-tv.target') printf 'active\\n' ;;
  'start lightdm.service') ${options.failStartDisplayManager ? "exit 1" : "exit 0"} ;;
esac
exit 0
`);
  await executable(path.join(binDirectory, "curl"), `#!/bin/sh
printf '%s\\n' '{"status":{"enabled":true,"state":"${tvState}","weston":{"state":"${tvState}"},"chromium":{"state":"${tvState}"},"vodPlayer":{"state":"${tvState}"},"cec":{"state":"degraded"}}}'
`);
  return { root, binDirectory, stateDirectory, configDirectory, systemdDirectory, systemctlLog };
}

async function executable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

function run(fixture: Fixture, command: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/sh", [scriptPath, command], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      PATH: `${fixture.binDirectory}:${process.env.PATH ?? ""}`,
      CYBEROS_TV_STATE_DIR: fixture.stateDirectory,
      CYBEROS_TV_CONFIG_DIR: fixture.configDirectory,
      CYBEROS_TV_SYSTEMD_DIR: fixture.systemdDirectory,
      CYBEROS_HOST_MUTATION_POLICY_FILE: path.join(fixture.root, "missing-policy"),
      CYBEROS_TV_WAIT_SECONDS: "0"
    }
  });
}
