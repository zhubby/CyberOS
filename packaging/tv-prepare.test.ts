import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve("packaging/scripts/cyberos-tv-prepare");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("cyberos-tv-prepare", () => {
  it("configures connected HDMI outputs and ignores DRM writeback connectors", async () => {
    const fixture = await createFixture();
    await addConnector(fixture, "card1-HDMI-A-1", "connected", "3840x2160\n1920x1080\n");
    await addConnector(fixture, "card1-Writeback-1", "connected", "4096x2160\n");

    const result = run(fixture, "start");

    expect(result.status).toBe(0);
    const config = await readFile(path.join(fixture.runtimeDirectory, "weston.ini"), "utf8");
    expect(config).toContain("name=HDMI-A-1");
    expect(config).toContain("scale=2");
    expect(config).not.toContain("Writeback");
  });

  it("forces and later releases the preferred HDMI connector when HPD is unavailable", async () => {
    const fixture = await createFixture();
    const statusPath = await addConnector(fixture, "card1-HDMI-A-1", "disconnected", "1024x768\n");

    const started = run(fixture, "start");

    expect(started.status).toBe(0);
    await expect(readFile(statusPath, "utf8")).resolves.toBe("on-digital\n");
    await expect(readFile(path.join(fixture.runtimeDirectory, "forced-connectors"), "utf8"))
      .resolves.toBe(`${statusPath}\n`);
    await expect(readFile(path.join(fixture.runtimeDirectory, "weston.ini"), "utf8"))
      .resolves.toContain("name=HDMI-A-1");

    const stopped = run(fixture, "stop");

    expect(stopped.status).toBe(0);
    await expect(readFile(statusPath, "utf8")).resolves.toBe("detect\n");
    await expect(readFile(path.join(fixture.runtimeDirectory, "forced-connectors"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can leave disconnected HDMI outputs untouched", async () => {
    const fixture = await createFixture();
    const statusPath = await addConnector(fixture, "card1-HDMI-A-1", "disconnected", "");

    const result = run(fixture, "start", { CYBEROS_TV_FORCE_HDMI: "never" });

    expect(result.status).toBe(0);
    await expect(readFile(statusPath, "utf8")).resolves.toBe("disconnected\n");
    const config = await readFile(path.join(fixture.runtimeDirectory, "weston.ini"), "utf8");
    expect(config).not.toContain("[output]");
  });

  it("rejects malformed HDMI connector overrides", async () => {
    const fixture = await createFixture();

    const result = run(fixture, "start", { CYBEROS_TV_HDMI_CONNECTOR: "HDMI-A-1/../../status" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must name an HDMI-A connector");
  });
});

interface Fixture {
  binDirectory: string;
  drmDirectory: string;
  runtimeDirectory: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-tv-prepare-test-"));
  temporaryDirectories.push(root);
  const binDirectory = path.join(root, "bin");
  const drmDirectory = path.join(root, "drm");
  const runtimeDirectory = path.join(root, "runtime");
  await mkdir(binDirectory, { recursive: true });
  await mkdir(drmDirectory, { recursive: true });
  await executable(path.join(binDirectory, "install"), `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) shift ;;
    -m|-o|-g) shift 2 ;;
    *) break ;;
  esac
done
mkdir -p "$@"
`);
  await executable(path.join(binDirectory, "chown"), "#!/bin/sh\nexit 0\n");
  return { binDirectory, drmDirectory, runtimeDirectory };
}

async function addConnector(
  fixture: Fixture,
  name: string,
  status: "connected" | "disconnected",
  modes: string
): Promise<string> {
  const directory = path.join(fixture.drmDirectory, name);
  await mkdir(directory, { recursive: true });
  const statusPath = path.join(directory, "status");
  await writeFile(statusPath, `${status}\n`);
  await writeFile(path.join(directory, "modes"), modes);
  return statusPath;
}

async function executable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

function run(fixture: Fixture, command: "start" | "stop", environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/sh", [scriptPath, command], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      PATH: `${fixture.binDirectory}:${process.env.PATH ?? ""}`,
      CYBEROS_TV_DRM_ROOT: fixture.drmDirectory,
      CYBEROS_TV_RUNTIME_DIR: fixture.runtimeDirectory
    }
  });
}
