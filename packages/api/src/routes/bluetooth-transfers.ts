import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createBluetoothSendTransfers,
  defaultBluetoothSettings,
  getBluetoothSettings,
  getBluetoothTransfer,
  getBluetoothTransferServiceHealth,
  listBluetoothTransfers,
  requestBluetoothTransferCancellation,
  saveBluetoothSettings
} from "@zos/db";
import type {
  BluetoothAudioDevice,
  BluetoothInboxStatus,
  BluetoothSettingsRecord,
  BluetoothStatus
} from "@zos/shared";
import type { ApiRouteContext } from "../context.js";
import {
  HostdBluetoothManagerClient,
  unavailableBluetoothStatus,
  type BluetoothManagerRuntime
} from "../lib/bluetooth-manager.js";
import {
  resolveScopedExistingPath,
  resolveStoragePoolScope,
  StorageScopeError
} from "../lib/storage-scope.js";

const MAX_TRANSFER_FILES = 100;
const MAX_TRANSFER_BODY_BYTES = 256 * 1024;
const EVENT_SAMPLE_MS = 500;
const EVENT_HEARTBEAT_MS = 15_000;

type SettingsPatch = Partial<Omit<BluetoothSettingsRecord, "updatedAt">>;

export function registerBluetoothTransferRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const bluetooth = context.system?.bluetoothManager ?? new HostdBluetoothManagerClient(context.config.hostd.socketPath);

  server.get("/api/system/bluetooth/settings", async (_request, reply) => {
    try {
      const status = await bluetooth.getStatus().catch(() => unavailableBluetoothStatus());
      const settings = getBluetoothSettings(context.db) ?? defaultBluetoothSettings();
      reply.send({
        settings,
        audioDevices: bluetoothAudioDevices(status),
        inboxStatus: await getBluetoothInboxStatus(settings, context)
      });
    } catch (error) {
      sendBluetoothTransferError(reply, error);
    }
  });

  server.patch<{ Body: SettingsPatch }>("/api/system/bluetooth/settings", async (request, reply) => {
    try {
      const patch = await validateSettingsPatch(request.body, context, bluetooth);
      const settings = saveBluetoothSettings(context.db, patch);
      reply.send({ settings, inboxStatus: await getBluetoothInboxStatus(settings, context) });
    } catch (error) {
      sendBluetoothTransferError(reply, error);
    }
  });

  server.get("/api/system/bluetooth/transfers", async () => ({
    transfers: listBluetoothTransfers(context.db),
    health: getBluetoothTransferServiceHealth(context.db)
  }));

  server.post<{
    Body: {
      adapterId?: string;
      address?: string;
      rootId?: string;
      storagePoolId?: string;
      paths?: string[];
    };
  }>("/api/system/bluetooth/transfers", { bodyLimit: MAX_TRANSFER_BODY_BYTES }, async (request, reply) => {
    try {
      const adapterId = validateAdapterId(request.body?.adapterId);
      const address = validateAddress(request.body?.address);
      const paths = validatePaths(request.body?.paths);
      const status = await bluetooth.getStatus();
      const device = status.devices.find((candidate) => candidate.adapterId === adapterId && candidate.address === address);
      if (!device?.paired) throw new BluetoothTransferRequestError("Bluetooth device must be paired before sending files", 409);
      const scope = await resolveStoragePoolScope(context.db, context.system, request.body?.rootId, request.body?.storagePoolId);
      const files = await Promise.all(paths.map(async (requestedPath) => {
        const safe = await resolveScopedExistingPath(scope, requestedPath);
        const metadata = await stat(safe.realPath);
        if (!metadata.isFile()) throw new BluetoothTransferRequestError("Bluetooth transfers only support files", 400);
        return {
          relativePath: safe.relativePath,
          displayName: safe.relativePath.split("/").at(-1) ?? safe.relativePath,
          totalBytes: metadata.size
        };
      }));
      const transfers = createBluetoothSendTransfers(context.db, {
        adapterId,
        deviceAddress: address,
        rootId: scope.root.id,
        storagePoolId: scope.pool.id,
        files
      });
      reply.status(201).send({ transfers });
    } catch (error) {
      sendBluetoothTransferError(reply, error);
    }
  });

  server.post<{ Params: { id: string } }>("/api/system/bluetooth/transfers/:id/cancel", async (request, reply) => {
    const transfer = getBluetoothTransfer(context.db, request.params.id);
    if (!transfer) {
      reply.status(404).send({ error: "Bluetooth transfer not found" });
      return;
    }
    const cancelled = requestBluetoothTransferCancellation(context.db, transfer.id);
    if (!cancelled) {
      reply.status(409).send({ error: `Bluetooth transfer cannot be cancelled while ${transfer.status}` });
      return;
    }
    reply.send({ transfer: cancelled });
  });

  server.get("/api/system/bluetooth/transfers/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    await streamBluetoothTransfers(request.raw, reply.raw, context);
  });
}

async function getBluetoothInboxStatus(
  settings: BluetoothSettingsRecord,
  context: ApiRouteContext
): Promise<BluetoothInboxStatus> {
  if (!settings.receiveEnabled) return { status: "disabled", reason: null };
  if (!settings.inboxRootId || !settings.inboxStoragePoolId || !settings.inboxPath) {
    return { status: "unconfigured", reason: null };
  }
  try {
    const scope = await resolveStoragePoolScope(
      context.db,
      context.system,
      settings.inboxRootId,
      settings.inboxStoragePoolId
    );
    if (scope.pool.availableBytes !== null && scope.pool.availableBytes <= 0) {
      return { status: "paused", reason: "insufficient_space" };
    }
    const directory = await resolveScopedExistingPath(scope, settings.inboxPath);
    const metadata = await stat(directory.realPath);
    if (!metadata.isDirectory()) return { status: "paused", reason: "invalid_directory" };
    try {
      await access(directory.realPath, fsConstants.W_OK | fsConstants.X_OK);
    } catch {
      return { status: "paused", reason: "not_writable" };
    }
    return { status: "ready", reason: null };
  } catch {
    return { status: "paused", reason: "storage_unavailable" };
  }
}

export function bluetoothAudioDevices(status: BluetoothStatus): BluetoothAudioDevice[] {
  return status.devices
    .filter((device) => device.paired && (device.type === "headset" || device.type === "speaker"))
    .map((device) => ({
      id: `bluetooth:${device.address}`,
      adapterId: device.adapterId,
      address: device.address,
      name: device.alias ?? device.name ?? device.address,
      connected: device.connected
    }));
}

async function validateSettingsPatch(
  body: SettingsPatch | undefined,
  context: ApiRouteContext,
  bluetooth: Pick<BluetoothManagerRuntime, "getStatus">
): Promise<SettingsPatch> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BluetoothTransferRequestError("Bluetooth settings are required", 400);
  }
  const allowed = new Set([
    "defaultAdapterId", "defaultAudioDeviceId", "receiveEnabled",
    "inboxRootId", "inboxStoragePoolId", "inboxPath"
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new BluetoothTransferRequestError("Bluetooth settings contain unknown fields", 400);
  }
  for (const key of ["defaultAdapterId", "defaultAudioDeviceId", "inboxRootId", "inboxStoragePoolId", "inboxPath"] as const) {
    if (key in body && body[key] !== null && typeof body[key] !== "string") {
      throw new BluetoothTransferRequestError(`Bluetooth setting ${key} must be a string or null`, 400);
    }
  }
  if ("receiveEnabled" in body && typeof body.receiveEnabled !== "boolean") {
    throw new BluetoothTransferRequestError("Bluetooth setting receiveEnabled must be a boolean", 400);
  }
  const current = getBluetoothSettings(context.db) ?? defaultBluetoothSettings();
  const candidate = { ...current, ...body };
  if (("defaultAdapterId" in body && candidate.defaultAdapterId !== null)
    || ("defaultAudioDeviceId" in body && candidate.defaultAudioDeviceId !== null)) {
    const status = await bluetooth.getStatus();
    if ("defaultAdapterId" in body && candidate.defaultAdapterId !== null
      && !status.adapters.some((adapter) => adapter.id === candidate.defaultAdapterId)) {
      throw new BluetoothTransferRequestError("Bluetooth default adapter was not found", 404);
    }
    const audioDevices = bluetoothAudioDevices(status);
    if ("defaultAudioDeviceId" in body && candidate.defaultAudioDeviceId !== null
      && !audioDevices.some((device) => device.id === candidate.defaultAudioDeviceId)) {
      throw new BluetoothTransferRequestError("Bluetooth audio device was not found", 404);
    }
  }
  if (candidate.receiveEnabled || body.inboxPath !== undefined || body.inboxRootId !== undefined || body.inboxStoragePoolId !== undefined) {
    if (!candidate.inboxRootId || !candidate.inboxStoragePoolId || !candidate.inboxPath) {
      throw new BluetoothTransferRequestError("A mounted Bluetooth inbox directory is required", 400);
    }
    const scope = await resolveStoragePoolScope(
      context.db,
      context.system,
      candidate.inboxRootId,
      candidate.inboxStoragePoolId
    );
    const directory = await resolveScopedExistingPath(scope, candidate.inboxPath);
    const metadata = await stat(directory.realPath);
    if (!metadata.isDirectory()) throw new BluetoothTransferRequestError("Bluetooth inbox must be a directory", 400);
    try {
      await access(directory.realPath, fsConstants.W_OK | fsConstants.X_OK);
    } catch {
      throw new BluetoothTransferRequestError("Bluetooth inbox is not writable", 403);
    }
    candidate.inboxRootId = scope.root.id;
    candidate.inboxStoragePoolId = scope.pool.id;
    candidate.inboxPath = directory.relativePath;
  }
  return {
    ...("defaultAdapterId" in body ? { defaultAdapterId: candidate.defaultAdapterId } : {}),
    ...("defaultAudioDeviceId" in body ? { defaultAudioDeviceId: candidate.defaultAudioDeviceId } : {}),
    ...("receiveEnabled" in body ? { receiveEnabled: candidate.receiveEnabled === true } : {}),
    ...(body.inboxRootId !== undefined || body.inboxStoragePoolId !== undefined || body.inboxPath !== undefined ? {
      inboxRootId: candidate.inboxRootId,
      inboxStoragePoolId: candidate.inboxStoragePoolId,
      inboxPath: candidate.inboxPath
    } : {})
  };
}

export async function streamBluetoothTransfers(
  request: { once(event: "close", listener: () => void): void },
  output: { write(chunk: string): unknown; end(): unknown },
  context: Pick<ApiRouteContext, "db">,
  timings: { sampleMs: number; heartbeatMs: number } = { sampleMs: EVENT_SAMPLE_MS, heartbeatMs: EVENT_HEARTBEAT_MS }
): Promise<void> {
  let closed = false;
  request.once("close", () => { closed = true; });
  let signature = "";
  let lastWrite = 0;
  while (!closed) {
    const payload = {
      transfers: listBluetoothTransfers(context.db),
      health: getBluetoothTransferServiceHealth(context.db)
    };
    const nextSignature = JSON.stringify(payload);
    const now = Date.now();
    if (nextSignature !== signature) {
      output.write("event: system.bluetooth.transfers\n");
      output.write(`data: ${nextSignature}\n\n`);
      signature = nextSignature;
      lastWrite = now;
    } else if (now - lastWrite >= timings.heartbeatMs) {
      output.write(": heartbeat\n\n");
      lastWrite = now;
    }
    await new Promise((resolve) => setTimeout(resolve, timings.sampleMs));
  }
  output.end();
}

function validateAdapterId(value: unknown): string {
  if (typeof value !== "string" || !/^adapter-[a-zA-Z0-9_.:-]{1,64}$/u.test(value)) {
    throw new BluetoothTransferRequestError("Invalid Bluetooth adapter id", 400);
  }
  return value;
}

function validateAddress(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(value)) {
    throw new BluetoothTransferRequestError("Invalid Bluetooth device address", 400);
  }
  return value.toUpperCase();
}

function validatePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRANSFER_FILES) {
    throw new BluetoothTransferRequestError(`Select between 1 and ${MAX_TRANSFER_FILES} files`, 400);
  }
  if (!value.every((path) => typeof path === "string" && path.length > 0 && path.length <= 4096)) {
    throw new BluetoothTransferRequestError("Invalid Bluetooth transfer path", 400);
  }
  return [...new Set(value)];
}

class BluetoothTransferRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "BluetoothTransferRequestError";
  }
}

function sendBluetoothTransferError(reply: FastifyReply, error: unknown): void {
  if (error instanceof BluetoothTransferRequestError || error instanceof StorageScopeError) {
    reply.status(error.statusCode).send({ error: error.message });
    return;
  }
  reply.status(503).send({ error: error instanceof Error ? error.message : "Bluetooth transfer service is unavailable" });
}
