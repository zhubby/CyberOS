import type {
  BluetoothAdapterInput,
  BluetoothDeviceInput,
  BluetoothOperationResult,
  BluetoothPairingChallengeInput,
  BluetoothStatus,
  HostdRequest
} from "@cyberos/shared";
import { HostdClient, HostdRequestError } from "./hostd-client.js";

const HOSTD_TIMEOUT_MS = 35_000;

export interface BluetoothManagerRuntime {
  getStatus(): Promise<BluetoothStatus>;
  setAdapterPower(input: BluetoothAdapterInput & { powered: boolean }): Promise<BluetoothOperationResult>;
  setDefaultAdapter(input: BluetoothAdapterInput): Promise<BluetoothOperationResult>;
  startScan(input: BluetoothAdapterInput): Promise<BluetoothOperationResult>;
  stopScan(input: BluetoothAdapterInput): Promise<BluetoothOperationResult>;
  pair(input: BluetoothDeviceInput): Promise<BluetoothOperationResult>;
  cancelPairing(input: BluetoothDeviceInput): Promise<BluetoothOperationResult>;
  answerChallenge(input: BluetoothPairingChallengeInput & { accept: boolean }): Promise<BluetoothOperationResult>;
  trust(input: BluetoothDeviceInput & { trusted: boolean }): Promise<BluetoothOperationResult>;
  connect(input: BluetoothDeviceInput): Promise<BluetoothOperationResult>;
  disconnect(input: BluetoothDeviceInput): Promise<BluetoothOperationResult>;
  unpair(input: BluetoothDeviceInput): Promise<BluetoothOperationResult>;
}

export class BluetoothManagerRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "BluetoothManagerRequestError";
  }
}

export class HostdBluetoothManagerClient implements BluetoothManagerRuntime {
  private readonly client: HostdClient;

  constructor(socketPath: string) {
    this.client = new HostdClient(socketPath);
  }

  getStatus(): Promise<BluetoothStatus> {
    return this.request({ action: "status" });
  }

  setAdapterPower(input: BluetoothAdapterInput & { powered: boolean }) {
    const adapterId = validateAdapterId(input?.adapterId);
    if (typeof input?.powered !== "boolean") {
      throw new BluetoothManagerRequestError("Bluetooth adapter power state must be a boolean", 400);
    }
    return this.mutate({ action: "adapter_power", adapterId, powered: input.powered });
  }

  setDefaultAdapter(input: BluetoothAdapterInput) {
    return this.mutate({ action: "set_default_adapter", adapterId: validateAdapterId(input?.adapterId) });
  }

  startScan(input: BluetoothAdapterInput) {
    return this.mutate({ action: "scan_start", adapterId: validateAdapterId(input?.adapterId) });
  }

  stopScan(input: BluetoothAdapterInput) {
    return this.mutate({ action: "scan_stop", adapterId: validateAdapterId(input?.adapterId) });
  }

  pair(input: BluetoothDeviceInput) {
    return this.mutateDevice("pair", input);
  }

  cancelPairing(input: BluetoothDeviceInput) {
    return this.mutateDevice("cancel_pairing", input);
  }

  answerChallenge(input: BluetoothPairingChallengeInput & { accept: boolean }) {
    const challengeId = validateChallengeId(input?.challengeId);
    if (typeof input?.accept !== "boolean") {
      throw new BluetoothManagerRequestError("Bluetooth pairing response must be a boolean", 400);
    }
    if (input.pin !== undefined && (typeof input.pin !== "string" || input.pin.length > 16)) {
      throw new BluetoothManagerRequestError("Invalid Bluetooth pairing PIN", 400);
    }
    return this.mutate({
      action: "confirm_pin",
      adapterId: validateAdapterId(input?.adapterId),
      address: validateAddress(input?.address),
      challengeId,
      accept: input.accept,
      pin: input.pin ?? null
    });
  }

  trust(input: BluetoothDeviceInput & { trusted: boolean }) {
    if (typeof input?.trusted !== "boolean") {
      throw new BluetoothManagerRequestError("Bluetooth trust state must be a boolean", 400);
    }
    return this.mutate({
      action: "trust",
      adapterId: validateAdapterId(input?.adapterId),
      address: validateAddress(input?.address),
      trusted: input.trusted
    });
  }

  connect(input: BluetoothDeviceInput) {
    return this.mutateDevice("connect", input);
  }

  disconnect(input: BluetoothDeviceInput) {
    return this.mutateDevice("disconnect", input);
  }

  unpair(input: BluetoothDeviceInput) {
    return this.mutateDevice("unpair", input);
  }

  private mutateDevice(action: "pair" | "cancel_pairing" | "connect" | "disconnect" | "unpair", input: BluetoothDeviceInput) {
    return this.mutate({ action, adapterId: validateAdapterId(input?.adapterId), address: validateAddress(input?.address) });
  }

  private async mutate(payload: HostdRequest<"bluetooth.manager">): Promise<BluetoothOperationResult> {
    const status = await this.request(payload);
    return { status, message: null };
  }

  private async request<Request extends HostdRequest<"bluetooth.manager">>(payload: Request): Promise<BluetoothStatus> {
    try {
      return await this.client.request("bluetooth.manager", payload, HOSTD_TIMEOUT_MS) as unknown as BluetoothStatus;
    } catch (error) {
      if (error instanceof HostdRequestError) {
        throw new BluetoothManagerRequestError(safeBluetoothMessage(error), error.statusCode);
      }
      throw new BluetoothManagerRequestError("BlueZ host integration is unavailable", 503);
    }
  }
}

export function unavailableBluetoothStatus(message = "BlueZ and the host integration service are unavailable"): BluetoothStatus {
  return {
    collectedAt: new Date().toISOString(),
    backend: "unknown",
    available: false,
    adapters: [],
    devices: [],
    scan: { active: false, adapterId: null, startedAt: null, endsAt: null },
    challenge: null,
    error: message
  };
}

function validateAdapterId(value: unknown): string {
  if (typeof value !== "string" || !/^adapter-[a-zA-Z0-9_.:-]{1,64}$/u.test(value)) {
    throw new BluetoothManagerRequestError("Invalid Bluetooth adapter id", 400);
  }
  return value;
}

function validateAddress(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(value)) {
    throw new BluetoothManagerRequestError("Invalid Bluetooth device address", 400);
  }
  return value.toUpperCase();
}

function validateChallengeId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{16,64}$/iu.test(value)) {
    throw new BluetoothManagerRequestError("Invalid Bluetooth pairing challenge", 400);
  }
  return value;
}

function safeBluetoothMessage(error: HostdRequestError): string {
  if (error.statusCode === 404) return "The Bluetooth adapter or device was not found";
  if (error.statusCode === 409) return "The Bluetooth operation conflicts with the current device state";
  if (error.statusCode === 503) return "BlueZ and the host integration service are unavailable";
  return error.message;
}
