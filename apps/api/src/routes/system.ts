import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  SystemEthernetStatus,
  SystemEthernetUpdateInput,
  SystemPowerAction,
  SystemWifiConnectInput,
  SystemWifiHotspotActionInput,
  SystemWifiHotspotUpdateInput,
  SystemWifiProfileUpdateInput,
  SystemWifiRadioInput,
  SystemWifiStatus
} from "@sigmaos/shared";
import type { ApiRouteContext } from "../context.js";
import { unknownBuildInfo } from "../lib/build-info.js";
import {
  EthernetManagerRequestError,
  SystemEthernetManagerRuntime,
  type EthernetManagerRuntime
} from "../lib/ethernet-manager.js";
import {
  NetworkManagerRequestError,
  safeNetworkManagerMessage,
  SystemNetworkManagerRuntime,
  type NetworkManagerRuntime
} from "../lib/network-manager.js";
import {
  HostdSystemPowerRuntime,
  SystemPowerRequestError,
  isSystemPowerAction,
  safeSystemPowerMessage
} from "../lib/power-management.js";
import { collectSystemNetwork, collectSystemNetworkTraffic, collectSystemStorage } from "../lib/system-management.js";

const MAX_WIFI_BODY_BYTES = 64 * 1024;
const MAX_POWER_BODY_BYTES = 1024;
const WIFI_SAMPLE_MS = 1000;
const WIFI_HEARTBEAT_MS = 15_000;
const ETHERNET_SAMPLE_MS = 1000;
const ETHERNET_HEARTBEAT_MS = 15_000;

export function registerSystemRoutes(server: FastifyInstance, { buildInfo, config, system }: ApiRouteContext): void {
  const networkManager = system?.networkManager ?? new SystemNetworkManagerRuntime({
    ...(system?.commandRunner ? { commandRunner: system.commandRunner } : {}),
    hostdSocketPath: config.hostd.socketPath
  });
  const ethernetManager = system?.ethernetManager ?? new SystemEthernetManagerRuntime(config.hostd.socketPath);
  const systemDependencies = { ...system, networkManager, ethernetManager };
  const power = system?.power ?? new HostdSystemPowerRuntime(config.hostd.socketPath);

  server.get("/api/system/build-info", async () => ({
    build: buildInfo ?? unknownBuildInfo()
  }));

  server.get("/api/system/network", async () => ({
    network: await collectSystemNetwork(systemDependencies)
  }));

  server.get("/api/system/network/traffic", async () => ({
    traffic: await collectSystemNetworkTraffic(system)
  }));

  server.get("/api/system/network/ethernet", async (_request, reply) => {
    try {
      reply.send({ ethernet: await ethernetManager.getStatus() });
    } catch (error) {
      sendEthernetManagerError(reply, error);
    }
  });

  server.put<{ Params: { id: string }; Body: SystemEthernetUpdateInput }>(
    "/api/system/network/ethernet/:id",
    { bodyLimit: MAX_WIFI_BODY_BYTES },
    async (request, reply) => {
      try {
        reply.send({ ethernet: await ethernetManager.save(request.params.id, request.body) });
      } catch (error) {
        sendEthernetManagerError(reply, error);
      }
    }
  );

  server.post<{ Body: { confirmed?: boolean } }>(
    "/api/system/network/ethernet/apply",
    { bodyLimit: MAX_WIFI_BODY_BYTES },
    async (request, reply) => {
      try {
        reply.status(202).send({ transaction: await ethernetManager.apply(request.body?.confirmed === true) });
      } catch (error) {
        sendEthernetManagerError(reply, error);
      }
    }
  );

  server.post<{ Params: { transactionId: string } }>(
    "/api/system/network/ethernet/apply/:transactionId/confirm",
    async (request, reply) => {
      try {
        reply.send({ transaction: await ethernetManager.confirm(request.params.transactionId) });
      } catch (error) {
        sendEthernetManagerError(reply, error);
      }
    }
  );

  server.post<{ Params: { transactionId: string } }>(
    "/api/system/network/ethernet/apply/:transactionId/rollback",
    async (request, reply) => {
      try {
        reply.send({ transaction: await ethernetManager.rollback(request.params.transactionId) });
      } catch (error) {
        sendEthernetManagerError(reply, error);
      }
    }
  );

  server.get("/api/system/network/ethernet/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    await streamEthernetEvents(request.raw, reply.raw, ethernetManager);
  });

  server.get("/api/system/storage", async () => ({
    storage: await collectSystemStorage(system)
  }));

  server.post<{ Body: { action?: SystemPowerAction; confirmed?: boolean } }>(
    "/api/system/power",
    { bodyLimit: MAX_POWER_BODY_BYTES },
    async (request, reply) => {
      try {
        if (!isSystemPowerAction(request.body?.action)) {
          throw new SystemPowerRequestError("Power action must be reboot or shutdown", 400);
        }
        if (request.body.confirmed !== true) {
          throw new SystemPowerRequestError("Power action confirmation is required", 400);
        }
        reply.status(202).send({ result: await power.request(request.body.action) });
      } catch (error) {
        sendSystemPowerError(reply, error);
      }
    }
  );

  server.post<{ Body: { device?: string } }>(
    "/api/system/network/wifi/scan",
    { bodyLimit: MAX_WIFI_BODY_BYTES },
    async (request, reply) => {
      try {
        if (!request.body || typeof request.body.device !== "string") {
          throw new NetworkManagerRequestError("Wireless device is required", 400);
        }
        reply.send({ scan: await networkManager.scan({ device: request.body.device }) });
      } catch (error) {
        sendNetworkManagerError(reply, error);
      }
    }
  );

  server.post<{ Body: SystemWifiConnectInput }>(
    "/api/system/network/wifi/connect",
    { bodyLimit: MAX_WIFI_BODY_BYTES },
    async (request, reply) => {
      try {
        await requireManagementPathConfirmation(networkManager, request.body?.device, request.body?.confirmed);
        reply.send({ result: await networkManager.connect(request.body) });
      } catch (error) {
        sendNetworkManagerError(reply, error);
      }
    }
  );

  server.post<{ Body: { device: string; confirmed: boolean } }>(
    "/api/system/network/wifi/disconnect",
    { bodyLimit: MAX_WIFI_BODY_BYTES },
    async (request, reply) => {
      try {
        requireConfirmation(request.body?.confirmed);
        reply.send({ result: await networkManager.disconnect(request.body) });
      } catch (error) {
        sendNetworkManagerError(reply, error);
      }
    }
  );

  server.put<{ Body: SystemWifiRadioInput }>(
    "/api/system/network/wifi/radio",
    { bodyLimit: MAX_WIFI_BODY_BYTES },
    async (request, reply) => {
      try {
        if (request.body?.enabled === false) requireConfirmation(request.body.confirmed);
        reply.send({ result: await networkManager.setRadio(request.body) });
      } catch (error) {
        sendNetworkManagerError(reply, error);
      }
    }
  );

  server.patch<{ Params: { id: string }; Body: SystemWifiProfileUpdateInput }>(
    "/api/system/network/wifi/profiles/:id",
    { bodyLimit: MAX_WIFI_BODY_BYTES },
    async (request, reply) => {
      try {
        reply.send({ result: await networkManager.updateProfile(request.params.id, request.body) });
      } catch (error) {
        sendNetworkManagerError(reply, error);
      }
    }
  );

  server.delete<{ Params: { id: string }; Body: { confirmed?: boolean } }>(
    "/api/system/network/wifi/profiles/:id",
    { bodyLimit: MAX_WIFI_BODY_BYTES },
    async (request, reply) => {
      try {
        requireConfirmation(request.body?.confirmed);
        reply.send({ result: await networkManager.deleteProfile(request.params.id, true) });
      } catch (error) {
        sendNetworkManagerError(reply, error);
      }
    }
  );

  server.put<{ Body: SystemWifiHotspotUpdateInput }>(
    "/api/system/network/wifi/hotspot",
    { bodyLimit: MAX_WIFI_BODY_BYTES },
    async (request, reply) => {
      try {
        reply.send({ result: await networkManager.updateHotspot(request.body) });
      } catch (error) {
        sendNetworkManagerError(reply, error);
      }
    }
  );

  for (const [path, action] of [
    ["/api/system/network/wifi/hotspot/start", "startHotspot"],
    ["/api/system/network/wifi/hotspot/stop", "stopHotspot"]
  ] as const) {
    server.post<{ Body: SystemWifiHotspotActionInput }>(path, { bodyLimit: MAX_WIFI_BODY_BYTES }, async (request, reply) => {
      try {
        requireConfirmation(request.body?.confirmed);
        reply.send({ result: await networkManager[action](request.body) });
      } catch (error) {
        sendNetworkManagerError(reply, error);
      }
    });
  }

  server.delete<{ Body: SystemWifiHotspotActionInput }>(
    "/api/system/network/wifi/hotspot",
    { bodyLimit: MAX_WIFI_BODY_BYTES },
    async (request, reply) => {
      try {
        requireConfirmation(request.body?.confirmed);
        reply.send({ result: await networkManager.deleteHotspot(request.body) });
      } catch (error) {
        sendNetworkManagerError(reply, error);
      }
    }
  );

  server.get("/api/system/network/wifi/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    await streamWifiEvents(request.raw, reply.raw, networkManager);
  });
}

export async function streamEthernetEvents(
  closeSignal: WifiEventCloseSignal,
  output: WifiEventOutput,
  ethernetManager: Pick<EthernetManagerRuntime, "getStatus">,
  options: { sampleMs?: number; heartbeatMs?: number } = {}
): Promise<void> {
  const sampleMs = options.sampleMs ?? ETHERNET_SAMPLE_MS;
  const heartbeatMs = options.heartbeatMs ?? ETHERNET_HEARTBEAT_MS;
  let closed = false;
  let sampling = false;
  let lastSignature: string | null = null;
  let sampleTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  closeSignal.on("close", () => {
    closed = true;
    if (sampleTimer) clearInterval(sampleTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });
  output.write("retry: 2000\n\n");

  const sample = async () => {
    if (closed || sampling) return;
    sampling = true;
    try {
      const status = await ethernetManager.getStatus();
      const signature = ethernetStatusSignature(status);
      if (!closed && signature !== lastSignature) {
        lastSignature = signature;
        output.write("event: system.ethernet.status\n");
        output.write(`data: ${JSON.stringify(status)}\n\n`);
      }
    } catch {
      const status: SystemEthernetStatus = {
        collectedAt: new Date().toISOString(),
        backend: "unknown",
        hostdReady: false,
        devices: [],
        transaction: null,
        warnings: []
      };
      const signature = ethernetStatusSignature(status);
      if (!closed && signature !== lastSignature) {
        lastSignature = signature;
        output.write("event: system.ethernet.status\n");
        output.write(`data: ${JSON.stringify(status)}\n\n`);
      }
    } finally {
      sampling = false;
    }
  };

  await sample();
  if (closed) return;
  sampleTimer = setInterval(() => void sample(), sampleMs);
  heartbeatTimer = setInterval(() => {
    if (!closed) output.write(": heartbeat\n\n");
  }, heartbeatMs);
}

function ethernetStatusSignature(status: SystemEthernetStatus): string {
  return JSON.stringify({
    backend: status.backend,
    hostdReady: status.hostdReady,
    devices: status.devices,
    transaction: status.transaction,
    warnings: status.warnings
  });
}

interface WifiEventCloseSignal {
  on(event: "close", listener: () => void): unknown;
}

interface WifiEventOutput {
  write(chunk: string): unknown;
}

export async function streamWifiEvents(
  closeSignal: WifiEventCloseSignal,
  output: WifiEventOutput,
  networkManager: Pick<NetworkManagerRuntime, "getStatus">,
  options: { sampleMs?: number; heartbeatMs?: number } = {}
): Promise<void> {
  const sampleMs = options.sampleMs ?? WIFI_SAMPLE_MS;
  const heartbeatMs = options.heartbeatMs ?? WIFI_HEARTBEAT_MS;
  let closed = false;
  let sampling = false;
  let lastSignature: string | null = null;
  let sampleTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  closeSignal.on("close", () => {
    closed = true;
    if (sampleTimer) clearInterval(sampleTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });
  output.write("retry: 2000\n\n");

  const sample = async () => {
    if (closed || sampling) return;
    sampling = true;
    try {
      const status = await networkManager.getStatus();
      const signature = wifiStatusSignature(status);
      if (!closed && signature !== lastSignature) {
        lastSignature = signature;
        output.write("event: system.wifi.status\n");
        output.write(`data: ${JSON.stringify(status)}\n\n`);
      }
    } catch {
      const status: SystemWifiStatus = {
        collectedAt: new Date().toISOString(),
        backend: "unknown",
        radioEnabled: null,
        hostdReady: false,
        devices: [],
        hotspots: []
      };
      const signature = wifiStatusSignature(status);
      if (!closed && signature !== lastSignature) {
        lastSignature = signature;
        output.write("event: system.wifi.status\n");
        output.write(`data: ${JSON.stringify(status)}\n\n`);
      }
    } finally {
      sampling = false;
    }
  };

  await sample();
  if (closed) return;
  sampleTimer = setInterval(() => void sample(), sampleMs);
  heartbeatTimer = setInterval(() => {
    if (!closed) output.write(": heartbeat\n\n");
  }, heartbeatMs);
}

function wifiStatusSignature(status: SystemWifiStatus): string {
  return JSON.stringify({
    backend: status.backend,
    radioEnabled: status.radioEnabled,
    hostdReady: status.hostdReady,
    devices: status.devices,
    hotspots: status.hotspots
  });
}

async function requireManagementPathConfirmation(
  networkManager: Pick<NetworkManagerRuntime, "getStatus">,
  device: string | undefined,
  confirmed: boolean | undefined
): Promise<void> {
  if (!device) throw new NetworkManagerRequestError("Wireless device is required", 400);
  const status = await networkManager.getStatus();
  if (status.devices.some((candidate) => candidate.name === device && candidate.managementPath) && !confirmed) {
    throw new NetworkManagerRequestError("Confirmation is required because this interface carries the management path", 400);
  }
}

function requireConfirmation(confirmed: boolean | undefined): void {
  if (!confirmed) throw new NetworkManagerRequestError("Confirmation is required", 400);
}

function sendNetworkManagerError(reply: FastifyReply, error: unknown): void {
  reply.status(error instanceof NetworkManagerRequestError ? error.statusCode : 503).send({
    error: safeNetworkManagerMessage(error),
    ...(error instanceof NetworkManagerRequestError ? { rollback: error.rollback } : {})
  });
}

function sendEthernetManagerError(reply: FastifyReply, error: unknown): void {
  reply.status(error instanceof EthernetManagerRequestError ? error.statusCode : 503).send({
    error: safeNetworkManagerMessage(error),
    ...(error instanceof EthernetManagerRequestError ? { rollback: error.rollback } : {})
  });
}

function sendSystemPowerError(reply: FastifyReply, error: unknown): void {
  reply.status(error instanceof SystemPowerRequestError ? error.statusCode : 503).send({
    error: safeSystemPowerMessage(error)
  });
}
