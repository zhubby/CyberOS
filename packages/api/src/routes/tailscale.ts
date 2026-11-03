import type { FastifyInstance, FastifyReply } from "fastify";
import {
  unavailableTailscaleStatus, type HostdRequest, type TailscaleActionInput,
  type TailscaleLoginInput, type TailscaleServiceInput, type TailscaleSettingsInput
} from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { HostdRequestError } from "../lib/hostd-client.js";
import { HostdTailscaleManager, type TailscaleManagerRuntime } from "../lib/tailscale-manager.js";

const PREFIX = "/api/system/tailscale";
const MUTATION = { bodyLimit: 16 * 1024 };
const ACTIONS = ["connect", "disconnect", "logout", "start", "restart"];

export function registerTailscaleRoutes(server: FastifyInstance, { config, system }: Pick<ApiRouteContext, "config" | "system">): void {
  const runtime = system?.tailscaleManager ?? new HostdTailscaleManager(config.hostd.socketPath);
  const read = () => runtime.request({ action: "status" }).catch(() => unavailableTailscaleStatus("Tailscale manager is unavailable"));
  server.get(PREFIX, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { tailscale: await read() };
  });
  server.get(`${PREFIX}/events`, async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    let closed = false;
    let sampling = false;
    let signature = "";
    reply.raw.on("close", () => { closed = true; });
    const sample = async () => {
      if (closed || sampling) return;
      sampling = true;
      try {
        const tailscale = await read();
        const next = JSON.stringify({ ...tailscale, collectedAt: "" });
        if (!closed && next !== signature) {
          signature = next;
          reply.raw.write(`event: system.tailscale.status\ndata: ${JSON.stringify(tailscale)}\n\n`);
        }
      } finally { sampling = false; }
    };
    reply.raw.write("retry: 2000\n\n");
    await sample();
    if (closed) return;
    const timer = setInterval(() => void sample(), 2000);
    const heartbeat = setInterval(() => { if (!closed) reply.raw.write(": heartbeat\n\n"); }, 15_000);
    reply.raw.on("close", () => { closed = true; clearInterval(timer); clearInterval(heartbeat); });
  });
  server.post(`${PREFIX}/login`, MUTATION, async (request, reply) => {
    const body = request.body;
    if (!input(body, ["controlUrl", "method", "authKey", "expectedRevision", "confirmed"]) || !validControlUrl(body.controlUrl)
      || !["browser", "auth_key"].includes(String(body.method))
      || !(body.authKey === null || (typeof body.authKey === "string" && body.authKey.length > 0 && body.authKey.length <= 4096))
      || (body.method === "browser" && body.authKey !== null) || (body.method === "auth_key" && body.authKey === null)) return invalid(reply);
    return send(reply, runtime, { action: "login", input: body as unknown as TailscaleLoginInput }, 202);
  });
  server.put(`${PREFIX}/service`, MUTATION, async (request, reply) => {
    const body = request.body;
    if (!input(body, ["autoStart", "expectedRevision", "confirmed"]) || typeof body.autoStart !== "boolean") return invalid(reply);
    return send(reply, runtime, { action: "service", input: body as unknown as TailscaleServiceInput });
  });
  server.post(`${PREFIX}/actions`, MUTATION, async (request, reply) => {
    const body = request.body;
    if (!input(body, ["action", "expectedRevision", "confirmed"]) || !ACTIONS.includes(String(body.action))) return invalid(reply);
    return send(reply, runtime, { action: "action", input: body as unknown as TailscaleActionInput });
  });
  server.put(`${PREFIX}/settings`, MUTATION, async (request, reply) => {
    const body = request.body;
    if (!input(body, ["settings", "expectedRevision", "confirmed"]) || !validSettings(body.settings)) return invalid(reply);
    return send(reply, runtime, { action: "settings", input: body as unknown as TailscaleSettingsInput }, 202);
  });
  for (const action of ["confirm", "rollback"] as const) {
    server.post<{ Params: { id: string } }>(`${PREFIX}/apply/:id/${action}`, MUTATION, async (request, reply) => {
      if (!/^[a-f0-9-]{36}$/iu.test(request.params.id)) return invalid(reply);
      return send(reply, runtime, { action, id: request.params.id });
    });
  }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function input(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
    && value.confirmed === true && typeof value.expectedRevision === "string" && /^[a-f0-9]{64}$/u.test(value.expectedRevision);
}
function validControlUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 1024) return false;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}
function validSettings(value: unknown): boolean {
  if (!record(value) || !Object.keys(value).length) return false;
  return Object.entries(value).every(([key, item]) => {
    if (["acceptDns", "acceptRoutes", "exitNodeAllowLanAccess", "advertiseExitNode"].includes(key)) return typeof item === "boolean";
    if (key === "hostname") return typeof item === "string" && item.length <= 63;
    if (key === "exitNodeId") return typeof item === "string" && item.length <= 256;
    if (key === "advertisedRoutes") return Array.isArray(item) && item.length <= 128 && item.every((r: unknown) => typeof r === "string" && r.length <= 64);
    return false;
  });
}
function invalid(reply: FastifyReply) { return reply.status(400).send({ error: "Invalid or unconfirmed Tailscale request" }); }
async function send(reply: FastifyReply, runtime: TailscaleManagerRuntime, request: HostdRequest<"tailscale.manager">, status = 200) {
  reply.header("cache-control", "no-store");
  try { return reply.status(status).send({ tailscale: await runtime.request(request) }); }
  catch (error) {
    const code = error instanceof HostdRequestError ? error.statusCode : 503;
    const messages: Record<number, string> = {
      400: "Tailscale rejected the configuration or authentication; check the supplied values",
      403: "Tailscale operation is not permitted", 404: "Tailscale transaction was not found",
      409: "Tailscale configuration changed or needs confirmation; refresh and review the current state",
      501: "Update the Tailscale system package to manage this configuration",
      502: "Tailscale operation failed; refresh to check configuration recovery",
      504: "Tailscale operation timed out; refresh to check the actual state"
    };
    return reply.status(code).send({ error: messages[code] ?? "Tailscale manager is unavailable" });
  }
}
