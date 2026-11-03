import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadCyberOsRuntime, unavailableTailscaleStatus } from "@cyberos/shared";
import { registerTailscaleRoutes } from "./tailscale.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberos-tailscale-api-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const socket = path.join(root, "hostd.sock");
  const calls: Array<Record<string, unknown>> = [];
  const hostd = net.createServer((connection) => {
    let data = "";
    connection.on("data", (part) => { data += part.toString(); });
    connection.on("end", () => {
      const request = JSON.parse(data) as { id: string; payload: Record<string, unknown> };
      calls.push(request.payload);
      connection.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: unavailableTailscaleStatus(null) })}\n`);
    });
  });
  await new Promise<void>((resolve) => hostd.listen(socket, resolve));
  cleanups.push(() => new Promise<void>((resolve) => hostd.close(() => resolve())));
  const server = Fastify(); cleanups.push(() => server.close());
  const config = loadCyberOsRuntime({ CYBEROS_ROOT: root }, root);
  registerTailscaleRoutes(server, { config: { ...config, hostd: { socketPath: socket } } });
  return { server, calls };
}

describe("Tailscale routes and real hostd transport", () => {
  it("returns a typed status and prevents caching authentication URLs", async () => {
    const { server, calls } = await fixture();
    const result = await server.inject({ method: "GET", url: "/api/system/tailscale" });
    expect(result.statusCode).toBe(200);
    expect(result.json().tailscale.backendState).toBe("Unavailable");
    expect(result.headers["cache-control"]).toContain("no-store");
    expect(calls).toEqual([{ action: "status" }]);
  });
  it("rejects arbitrary commands, missing confirmations and malformed settings before reaching hostd", async () => {
    const { server, calls } = await fixture();
    for (const [url, payload] of [
      ["actions", { action: "command", confirmed: true, expectedRevision: "a".repeat(64) }],
      ["actions", { action: "logout", confirmed: false, expectedRevision: "a".repeat(64) }],
      ["settings", { confirmed: true, expectedRevision: "a".repeat(64), settings: { RunSSH: true } }],
      ["login", { confirmed: true, expectedRevision: "a".repeat(64), method: "browser", controlUrl: "file:///etc/shadow", authKey: null }]
    ] as const) {
      const result = await server.inject({ method: url === "settings" ? "PUT" : "POST", url: `/api/system/tailscale/${url}`, payload });
      expect(result.statusCode).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it("passes scoped updates and login keys through the local transport without returning the submitted key", async () => {
    const { server, calls } = await fixture();
    const payload = { confirmed: true, expectedRevision: "a".repeat(64), method: "auth_key", controlUrl: "https://headscale.example.com", authKey: "secret-preauth-key" };
    const login = await server.inject({ method: "POST", url: "/api/system/tailscale/login", payload });
    expect(login.statusCode).toBe(202); expect(login.payload).not.toContain("secret-preauth-key");
    expect(calls[0]).toEqual({ action: "login", input: payload });
  });
});
