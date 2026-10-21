import { parseBluetoothStatus } from "@zos/shared";
import type { BluetoothStatus } from "../api.js";

export function parseSystemBluetoothStatus(value: string): BluetoothStatus | null {
  try {
    return parseBluetoothStatus(JSON.parse(value)) as BluetoothStatus | null;
  } catch {
    return null;
  }
}
