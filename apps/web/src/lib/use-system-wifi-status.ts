import { useEffect, useState } from "react";
import type { WifiStatus } from "../api.js";
import { parseSystemWifiStatus } from "./system-wifi.js";

export function useSystemWifiStatus(onStatus: (status: WifiStatus) => void): boolean {
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/system/network/wifi/events");
    source.onopen = () => setReconnecting(false);
    source.onerror = () => setReconnecting(true);
    source.addEventListener("system.wifi.status", (event) => {
      const status = parseSystemWifiStatus((event as MessageEvent<string>).data);
      if (status) {
        setReconnecting(false);
        onStatus(status);
      }
    });
    return () => source.close();
  }, [onStatus]);

  return reconnecting;
}
