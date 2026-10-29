import { Settings, Wifi, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NetworkSummary, WifiStatus } from "../../api.js";
import { systemWifiDeviceTone } from "../../lib/system-wifi.js";
import { useSystemWifiStatus } from "../../lib/use-system-wifi-status.js";

export function SystemWifiReadonly({
  wifi,
  onStatus,
  onOpenSettings
}: {
  wifi: NetworkSummary["wifi"];
  onStatus: (status: WifiStatus) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const reconnecting = useSystemWifiStatus(onStatus);
  const device = preferredWifiDevice(wifi.devices);
  const radioOff = wifi.radioEnabled === false;
  const radioUnknown = wifi.backend === "NetworkManager" && Boolean(device) && wifi.radioEnabled === null;
  const unavailable = wifi.backend !== "NetworkManager" || !device || radioUnknown;
  const tone = reconnecting
    ? "warning"
    : radioOff || unavailable
      ? "offline"
      : systemWifiDeviceTone(device.state);
  const state = reconnecting
    ? "reconnecting"
    : radioOff
      ? "off"
      : unavailable
        ? "unavailable"
        : device.state;
  const networkName = radioOff
    ? t("workspace.management.network.wifi.radioOffTitle")
    : radioUnknown
      ? t("workspace.management.network.wifi.radioUnknownTitle")
      : wifi.backend !== "NetworkManager"
        ? t("workspace.management.network.wifi.unavailableTitle")
        : !device
          ? t("workspace.management.network.wifi.noDevices")
          : device.ssid ?? device.activeConnectionName ?? t("workspace.management.network.wifi.notConnected");
  const signal = radioOff || unavailable ? null : device.signal;

  return (
    <section className="management-section system-wifi-readonly-card" data-state={tone}>
      <header className="system-wifi-readonly-header">
        <h3>{t("workspace.management.network.wifi.title")}</h3>
        <button type="button" onClick={onOpenSettings}>
          <Settings aria-hidden="true" size={14} />
          <span>{t("workspace.management.network.wifi.openSettings")}</span>
        </button>
      </header>
      <div className="system-wifi-readonly-body" role="status" aria-live="polite">
        <div className="system-wifi-readonly-identity">
          <div className="system-wifi-readonly-icon" data-state={tone}>
            {radioOff || unavailable ? <WifiOff aria-hidden="true" size={20} /> : <Wifi aria-hidden="true" size={20} />}
          </div>
          <div>
            <strong>{networkName}</strong>
            <span className="management-status-pill" data-state={tone}>
              {t(`workspace.management.network.wifi.states.${state}`)}
            </span>
          </div>
        </div>
        <div className="system-wifi-readonly-signal">
          <div>
            <span>{t("workspace.management.network.wifi.signal")}</span>
            <strong>{signal === null ? t("common.dash") : `${signal}%`}</strong>
          </div>
          <div
            className="system-wifi-readonly-signal-track"
            role="meter"
            aria-label={String(t("workspace.management.network.wifi.signal"))}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={signal ?? undefined}
            aria-valuetext={signal === null ? String(t("workspace.management.network.wifi.signalUnavailable")) : `${signal}%`}
          >
            <span style={{ width: `${signal ?? 0}%` }} />
          </div>
        </div>
      </div>
    </section>
  );
}

function preferredWifiDevice(devices: NetworkSummary["wifi"]["devices"]) {
  return devices.find((device) => device.state === "connected")
    ?? devices.find((device) => device.state === "hotspot")
    ?? devices.find((device) => device.state === "connecting")
    ?? devices[0]
    ?? null;
}
