import { mkdtemp, rm } from "node:fs/promises";
import net, { type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerHostAccessControlClient, DockerHostAccessControlError } from "./docker-host-access-control.js";

let tempDir: string;
let server: Server | null;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-host-access-control-"));
  server = null;
});

afterEach(async () => {
  server?.close();
  server?.unref();
  await rm(tempDir, { recursive: true, force: true });
});

describe("DockerHostAccessControlClient", () => {
  it("sends a bounded canonical reconciliation request", async () => {
    const socketPath = path.join(tempDir, "control.sock");
    let request = "";
    server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        request += chunk.toString("utf8");
        if (request.endsWith("\n")) socket.end('{"ok":true,"status":200}\n');
      });
    });
    await listen(server, socketPath);

    await new DockerHostAccessControlClient(socketPath).reconcile({
      scopeId: "collector",
      service: "agent",
      capabilities: ["docker_metadata", "docker_metadata"]
    });

    expect(JSON.parse(request)).toEqual({
      version: 1,
      action: "reconcile",
      scopeId: "collector",
      service: "agent",
      capabilities: ["docker_metadata"]
    });
  });

  it("preserves daemon status codes and rejects invalid or oversized responses", async () => {
    const deniedPath = path.join(tempDir, "denied.sock");
    server = net.createServer((socket) => socket.end('{"ok":false,"status":503,"error":"docker_proxy_unverified"}\n'));
    await listen(server, deniedPath);
    await expect(new DockerHostAccessControlClient(deniedPath).reconcile({
      scopeId: "collector",
      capabilities: ["docker_metadata"]
    })).rejects.toMatchObject({ statusCode: 503, message: "docker_proxy_unverified" });
    closeServer(server);

    const invalidPath = path.join(tempDir, "invalid.sock");
    server = net.createServer((socket) => socket.end("not-json\n"));
    await listen(server, invalidPath);
    await expect(new DockerHostAccessControlClient(invalidPath).reconcile({
      scopeId: "collector",
      capabilities: []
    })).rejects.toBeInstanceOf(DockerHostAccessControlError);
    closeServer(server);

    const oversizedPath = path.join(tempDir, "oversized.sock");
    server = net.createServer((socket) => socket.end("x".repeat(65 * 1024)));
    await listen(server, oversizedPath);
    await expect(new DockerHostAccessControlClient(oversizedPath).reconcile({
      scopeId: "collector",
      capabilities: []
    })).rejects.toMatchObject({ statusCode: 502 });
  });

  it("returns 503 when the daemon is absent or does not respond", async () => {
    await expect(new DockerHostAccessControlClient(path.join(tempDir, "missing.sock"), 20).reconcile({
      scopeId: "collector",
      capabilities: []
    })).rejects.toMatchObject({ statusCode: 503 });

    const socketPath = path.join(tempDir, "timeout.sock");
    server = net.createServer(() => undefined);
    await listen(server, socketPath);
    await expect(new DockerHostAccessControlClient(socketPath, 20).reconcile({
      scopeId: "collector",
      capabilities: []
    })).rejects.toMatchObject({ statusCode: 503 });
  });
});

async function listen(target: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.once("error", reject);
    target.listen(socketPath, resolve);
  });
}

function closeServer(target: Server | null): void {
  if (!target) return;
  target.close();
  target.unref();
  server = null;
}
