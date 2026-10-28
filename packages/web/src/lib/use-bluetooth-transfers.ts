import { useCallback, useEffect, useState } from "react";
import {
  getBluetoothTransfers,
  type BluetoothTransfer,
  type BluetoothTransferServiceHealth,
  type BluetoothTransfersResponse
} from "../api.js";

export function useBluetoothTransfers(enabled = true): BluetoothTransfersResponse & {
  loading: boolean;
  reconnecting: boolean;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<BluetoothTransfersResponse>({
    transfers: [],
    health: {
      status: "unavailable",
      heartbeatAt: null,
      error: null,
      activeTransfers: 0,
      queuedTransfers: 0
    }
  });
  const [loading, setLoading] = useState(enabled);
  const [reconnecting, setReconnecting] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getBluetoothTransfers();
    setState(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void refresh().catch(() => {
      if (active) setLoading(false);
    });
    const events = new EventSource("/api/system/bluetooth/transfers/events");
    events.addEventListener("system.bluetooth.transfers", (event) => {
      if (!active) return;
      const next = parseBluetoothTransfersEvent((event as MessageEvent<string>).data);
      if (next) {
        setState(next);
        setLoading(false);
        setReconnecting(false);
      } else {
        setReconnecting(true);
      }
    });
    events.onerror = () => {
      if (active) setReconnecting(true);
    };
    return () => {
      active = false;
      events.close();
    };
  }, [enabled, refresh]);

  return { ...state, loading, reconnecting, refresh };
}

export function parseBluetoothTransfersEvent(value: string): BluetoothTransfersResponse | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isExactRecord(parsed, ["transfers", "health"]) || !Array.isArray(parsed.transfers)) return null;
    if (!parsed.transfers.every(isBluetoothTransfer) || !isBluetoothTransferHealth(parsed.health)) return null;
    return {
      transfers: parsed.transfers,
      health: parsed.health
    };
  } catch {
    return null;
  }
}

function isBluetoothTransfer(value: unknown): value is BluetoothTransfer {
  if (!isExactRecord(value, [
    "id", "direction", "adapterId", "deviceAddress", "storagePoolId", "relativePath",
    "displayName", "status", "transferredBytes", "totalBytes", "error", "obexTransferPath",
    "controlRequested", "readAt", "createdAt", "updatedAt", "startedAt", "finishedAt", "lastProgressAt"
  ])) return false;
  return isNonEmptyString(value.id)
    && (value.direction === "send" || value.direction === "receive")
    && isNullableString(value.adapterId)
    && typeof value.deviceAddress === "string" && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(value.deviceAddress)
    && isNonEmptyString(value.storagePoolId)
    && typeof value.relativePath === "string"
    && isNonEmptyString(value.displayName)
    && ["queued", "running", "paused", "finalizing", "completed", "failed", "cancelled"].includes(String(value.status))
    && isNonNegativeInteger(value.transferredBytes)
    && (value.totalBytes === null || isNonNegativeInteger(value.totalBytes))
    && isNullableString(value.error)
    && isNullableString(value.obexTransferPath)
    && (value.controlRequested === null || value.controlRequested === "cancel")
    && isNullableString(value.readAt)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && isNullableString(value.startedAt)
    && isNullableString(value.finishedAt)
    && isNullableString(value.lastProgressAt);
}

function isBluetoothTransferHealth(value: unknown): value is BluetoothTransferServiceHealth {
  return isExactRecord(value, ["status", "heartbeatAt", "error", "activeTransfers", "queuedTransfers"])
    && ["ready", "stale", "unavailable"].includes(String(value.status))
    && isNullableString(value.heartbeatAt)
    && isNullableString(value.error)
    && isNonNegativeInteger(value.activeTransfers)
    && isNonNegativeInteger(value.queuedTransfers);
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
