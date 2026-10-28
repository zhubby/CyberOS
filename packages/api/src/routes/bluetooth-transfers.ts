import { constants as fsConstants } from "node:fs";
import { access, link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createBluetoothSendTransfers,
  completeBluetoothReceiveFinalization,
  defaultBluetoothSettings,
  failBluetoothReceiveFinalization,
  getBluetoothSettings,
  getBluetoothTransfer,
  getBluetoothTransferServiceHealth,
  listBluetoothTransfers,
  listBluetoothReceiveFinalizations,
  noteBluetoothReceiveFinalizationError,
  reserveBluetoothReceiveFinalization,
  requestBluetoothTransferCancellation,
  saveBluetoothSettings
} from "@cyberos/db";
import {
  type BluetoothAudioDevice,
  type BluetoothInboxStatus,
  type BluetoothSettingsRecord,
  type BluetoothStatus
} from "@cyberos/shared";
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
const FINALIZATION_INTERVAL_MS = 1_000;
const TRANSFER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type SettingsPatch = Partial<Omit<BluetoothSettingsRecord, "updatedAt">>;

export function registerBluetoothTransferRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const bluetooth = context.system?.bluetoothManager ?? new HostdBluetoothManagerClient(context.config.hostd.socketPath);
  let closed = false;
  let finalization = Promise.resolve();
  let finalizationTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleFinalization = () => {
    finalization = finalizeBluetoothReceives(context)
      .catch((error: unknown) => {
        server.log.warn({ error }, "Bluetooth receive finalization failed");
      })
      .finally(() => {
        if (closed) return;
        finalizationTimer = setTimeout(scheduleFinalization, FINALIZATION_INTERVAL_MS);
        finalizationTimer.unref();
      });
  };
  scheduleFinalization();
  server.addHook("onClose", async () => {
    closed = true;
    if (finalizationTimer) clearTimeout(finalizationTimer);
    await finalization;
  });

  server.get("/api/system/bluetooth/settings", async (_request, reply) => {
    try {
      const status = await bluetooth.getStatus().catch(() => unavailableBluetoothStatus());
      const audioDevices = bluetoothAudioDevices(status);
      const settings = getBluetoothSettings(context.db) ?? defaultBluetoothSettings();
      reply.send({
        settings,
        audioDevices,
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
      const scope = await resolveStoragePoolScope(
        context.config.paths.dataRoot,
        context.system,
        request.body?.storagePoolId
      );
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

export async function finalizeBluetoothReceives(
  context: ApiRouteContext,
  incomingPath?: string
): Promise<void> {
  const transfers = listBluetoothReceiveFinalizations(context.db);
  if (transfers.length === 0) return;
  incomingPath ??= path.join(path.dirname(context.config.paths.databasePath), "bluetooth", "incoming");
  await mkdir(incomingPath, { recursive: true });
  const inboxes = new Map<string, Promise<{
    scope: Awaited<ReturnType<typeof resolveStoragePoolScope>>;
    inbox: Awaited<ReturnType<typeof resolveScopedExistingPath>>;
  }>>();
  for (const transfer of transfers) {
    if (!TRANSFER_ID_PATTERN.test(transfer.id)) {
      failBluetoothReceiveFinalization(context.db, transfer.id, "Bluetooth receive transfer id is invalid");
      continue;
    }
    const source = path.join(incomingPath, `${transfer.id}.part`);
    const displayName = path.posix.basename(transfer.displayName);
    if (!displayName || displayName === "." || displayName === ".." || displayName !== transfer.displayName) {
      failBluetoothReceiveFinalization(context.db, transfer.id, "Bluetooth receive file name is invalid");
      continue;
    }
    let published = false;
    try {
      const inboxPath = path.posix.dirname(transfer.relativePath);
      const inboxKey = JSON.stringify([transfer.storagePoolId, inboxPath]);
      let inboxPromise = inboxes.get(inboxKey);
      if (!inboxPromise) {
        inboxPromise = resolveBluetoothFinalizationInbox(context, {
          storagePoolId: transfer.storagePoolId,
          path: inboxPath
        });
        inboxes.set(inboxKey, inboxPromise);
      }
      const { scope, inbox } = await inboxPromise;
      const inboxMetadata = await stat(inbox.realPath);
      if (!inboxMetadata.isDirectory()) {
        noteBluetoothReceiveFinalizationError(context.db, transfer.id, "Bluetooth inbox is not a directory");
        continue;
      }
      let finalizationRelativePath = transfer.finalizationRelativePath;
      for (let collision = 0; collision < 1_000; collision += 1) {
        const previousRelativePath = finalizationRelativePath;
        if (!finalizationRelativePath) {
          finalizationRelativePath = await nextBluetoothReceivePath(
            inbox.realPath,
            inbox.relativePath,
            displayName,
            transfer.createdAt,
            collision
          );
          if (!reserveBluetoothReceiveFinalization(context.db, {
            id: transfer.id,
            previousRelativePath,
            relativePath: finalizationRelativePath
          })) {
            finalizationRelativePath = null;
            continue;
          }
        }
        const destinationName = validateBluetoothReceivePath(inbox.relativePath, finalizationRelativePath);
        const destinationPath = path.join(inbox.realPath, destinationName);
        const temporaryPath = path.join(inbox.realPath, `.cyberos-bluetooth-${transfer.id}.part`);
        const result = await publishReceivedFile(source, temporaryPath, destinationPath);
        if (result === "collision") {
          const replacement = await nextBluetoothReceivePath(
            inbox.realPath,
            inbox.relativePath,
            displayName,
            transfer.createdAt,
            collision + 1
          );
          if (!reserveBluetoothReceiveFinalization(context.db, {
            id: transfer.id,
            previousRelativePath: finalizationRelativePath,
            relativePath: replacement
          })) {
            break;
          }
          finalizationRelativePath = replacement;
          continue;
        }
        published = true;
        const completed = completeBluetoothReceiveFinalization(context.db, {
          id: transfer.id,
          storagePoolId: scope.pool.id,
          relativePath: finalizationRelativePath,
          displayName: destinationName
        });
        if (!completed) break;
        await unlink(source).catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        break;
      }
    } catch (error) {
      if (published || error instanceof StorageScopeError || isRetryableFinalizationError(error)) {
        noteBluetoothReceiveFinalizationError(
          context.db,
          transfer.id,
          error instanceof Error ? error.message : "Bluetooth inbox is temporarily unavailable"
        );
        continue;
      }
      failBluetoothReceiveFinalization(
        context.db,
        transfer.id,
        error instanceof Error ? error.message : "Bluetooth receive finalization failed"
      );
    }
  }
}

async function resolveBluetoothFinalizationInbox(
  context: ApiRouteContext,
  selection: { storagePoolId: string; path: string }
) {
  const scope = await resolveStoragePoolScope(
    context.config.paths.dataRoot,
    context.system,
    selection.storagePoolId
  );
  return {
    scope,
    inbox: await resolveScopedExistingPath(scope, selection.path)
  };
}

async function nextBluetoothReceivePath(
  directory: string,
  relativeDirectory: string,
  requestedName: string,
  createdAt: string,
  startAttempt: number
): Promise<string> {
  const parsed = path.parse(requestedName);
  const timestamp = createdAt.replace(/[^0-9A-Za-z-]/gu, "-");
  for (let attempt = startAttempt; attempt < 1_000; attempt += 1) {
    const name = attempt === 0
      ? requestedName
      : `${parsed.name}-${timestamp}${attempt === 1 ? "" : `-${attempt}`}${parsed.ext}`;
    try {
      await lstat(path.join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return path.posix.join(relativeDirectory, name);
      }
      throw error;
    }
  }
  throw new Error("Could not allocate a unique Bluetooth inbox name");
}

function validateBluetoothReceivePath(relativeDirectory: string, relativePath: string): string {
  const name = path.posix.basename(relativePath);
  if (!name || name === "." || name === ".." || path.posix.join(relativeDirectory, name) !== relativePath) {
    throw new Error("Bluetooth receive finalization path is invalid");
  }
  return name;
}

async function publishReceivedFile(
  source: string,
  temporaryPath: string,
  destinationPath: string
): Promise<"published" | "collision"> {
  if (await pathsShareInode(temporaryPath, destinationPath)) return "published";
  try {
    await lstat(destinationPath);
    return "collision";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await unlink(temporaryPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  try {
    const sourceHandle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const sourceMetadata = await sourceHandle.stat();
      if (!sourceMetadata.isFile()) throw new Error("Bluetooth receive staging file is invalid");
      const temporaryHandle = await open(
        temporaryPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600
      );
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, offset);
          if (bytesRead === 0) break;
          let written = 0;
          while (written < bytesRead) {
            const result = await temporaryHandle.write(
              buffer,
              written,
              bytesRead - written,
              offset + written
            );
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close().catch(() => undefined);
      }
    } finally {
      await sourceHandle.close().catch(() => undefined);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  try {
    await link(temporaryPath, destinationPath);
    return "published";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (await pathsShareInode(temporaryPath, destinationPath)) return "published";
      await unlink(temporaryPath).catch(() => undefined);
      return "collision";
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function pathsShareInode(left: string, right: string): Promise<boolean> {
  try {
    const [leftMetadata, rightMetadata] = await Promise.all([lstat(left), lstat(right)]);
    return leftMetadata.isFile()
      && rightMetadata.isFile()
      && leftMetadata.dev === rightMetadata.dev
      && leftMetadata.ino === rightMetadata.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRetryableFinalizationError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && (
    code.startsWith("SQLITE_")
    || ["EACCES", "EBUSY", "EDQUOT", "EIO", "EMFILE", "ENFILE", "ENODEV", "ENOMEM", "ENOSPC", "EROFS", "ESTALE"].includes(code)
  );
}

async function getBluetoothInboxStatus(
  settings: BluetoothSettingsRecord,
  context: ApiRouteContext
): Promise<BluetoothInboxStatus> {
  if (!settings.receiveEnabled) return { status: "disabled", reason: null };
  if (!settings.inboxStoragePoolId || !settings.inboxPath) {
    return { status: "unconfigured", reason: null };
  }
  try {
    const scope = await resolveStoragePoolScope(
      context.config.paths.dataRoot,
      context.system,
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
  const candidates = status.devices
    .filter((device) => device.paired && (device.type === "headset" || device.type === "speaker"));
  return candidates
    .filter((device) => {
      const sameAddress = candidates.filter((candidate) => candidate.address.toUpperCase() === device.address.toUpperCase());
      if (sameAddress.length === 1) return true;
      return device.connected && sameAddress.filter((candidate) => candidate.connected).length === 1;
    })
    .map((device) => ({
      id: bluetoothAudioDeviceId(device.adapterId, device.address),
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
    "inboxStoragePoolId", "inboxPath"
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new BluetoothTransferRequestError("Bluetooth settings contain unknown fields", 400);
  }
  for (const key of ["defaultAdapterId", "defaultAudioDeviceId", "inboxStoragePoolId", "inboxPath"] as const) {
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
  if (candidate.receiveEnabled || body.inboxPath !== undefined || body.inboxStoragePoolId !== undefined) {
    if (!candidate.inboxStoragePoolId || !candidate.inboxPath) {
      throw new BluetoothTransferRequestError("A mounted Bluetooth inbox directory is required", 400);
    }
    const scope = await resolveStoragePoolScope(
      context.config.paths.dataRoot,
      context.system,
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
    candidate.inboxStoragePoolId = scope.pool.id;
    candidate.inboxPath = directory.relativePath;
  }
  return {
    ...("defaultAdapterId" in body ? { defaultAdapterId: candidate.defaultAdapterId } : {}),
    ...("defaultAudioDeviceId" in body ? { defaultAudioDeviceId: candidate.defaultAudioDeviceId } : {}),
    ...("receiveEnabled" in body ? { receiveEnabled: candidate.receiveEnabled === true } : {}),
    ...(body.inboxStoragePoolId !== undefined || body.inboxPath !== undefined ? {
      inboxStoragePoolId: candidate.inboxStoragePoolId,
      inboxPath: candidate.inboxPath
    } : {})
  };
}

function bluetoothAudioDeviceId(adapterId: string, address: string): string {
  return `bluetooth:${adapterId}/${address}`;
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
