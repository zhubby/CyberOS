import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

it("starts the production API bundle", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-api-bundle-"));
  const zosRoot = path.join(tempDir, "root");
  const nasRoot = path.join(zosRoot, "data", "test");
  const port = await reservePort();
  await mkdir(nasRoot, { recursive: true });
  await execFileAsync("npm", ["run", "build", "-w", "@zos/api"], { cwd: repoRoot });

  const child = spawn(process.execPath, [path.join(repoRoot, "packages/api/dist/index.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ZOS_CONFIG: path.join(tempDir, "missing.toml"),
      ZOS_ENVIRONMENT: "development",
      ZOS_ROOT: zosRoot,
      ZOS_NAS_ROOTS: `test:Test NAS:${nasRoot}`,
      ZOS_API_HOST: "127.0.0.1",
      ZOS_API_PORT: String(port),
      ZOS_WEB_DIST: path.join(tempDir, "missing-web"),
      ZOS_DOCS_DIST: path.join(tempDir, "missing-docs")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const response = await waitForHealth(port, () => exited);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: "zos-api" });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  } finally {
    if (!exited) {
      child.kill("SIGTERM");
      await exitPromise;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}, 20_000);

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve an API test port");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForHealth(port: number, hasExited: () => boolean): Promise<Response> {
  const url = `http://127.0.0.1:${port}/health`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (hasExited()) throw new Error("Production API bundle exited before becoming healthy");
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production API bundle did not become healthy at ${url}`);
}
