import { useEffect, useState } from "react";
import type { BluetoothStatus } from "../api.js";
import { parseSystemBluetoothStatus } from "./system-bluetooth.js";

export function useSystemBluetoothStatus(onStatus: (status: BluetoothStatus) => void): boolean {
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/system/bluetooth/events");
    source.onopen = () => setReconnecting(false);
    source.onerror = () => setReconnecting(true);
    source.addEventListener("system.bluetooth.status", (event) => {
      const status = parseSystemBluetoothStatus((event as MessageEvent<string>).data);
      if (status) {
        setReconnecting(false);
        onStatus(status);
      }
    });
    return () => source.close();
  }, [onStatus]);
  return reconnecting;
}
