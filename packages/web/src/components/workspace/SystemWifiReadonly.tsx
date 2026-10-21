import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, Settings, Signal, Wifi, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { scanSystemWifi, type NetworkSummary, type SystemWifiScanResult, type WifiStatus } from "../../api.js";
import { groupSystemWifiAccessPoints, systemWifiDeviceTone } from "../../lib/system-wifi.js";
import { useSystemWifiStatus } from "../../lib/use-system-wifi-status.js";

export function SystemWifiReadonly({
  wifi,
  canScan,
  onStatus,
  onOpenSettings,
  onNotifyError
}: {
  wifi: NetworkSummary["wifi"];
  canScan: boolean;
  onStatus: (status: WifiStatus) => void;
  onOpenSettings: () => void;
  onNotifyError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [selectedDeviceId, setSelectedDeviceId] = useState(wifi.devices[0]?.id ?? "");
  const [scan, setScan] = useState<SystemWifiScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const scannedOnEntry = useRef(false);
  const reconnecting = useSystemWifiStatus(onStatus);
  const device = wifi.devices.find((candidate) => candidate.id === selectedDeviceId) ?? wifi.devices[0] ?? null;
  const networks = useMemo(() => {
    if (wifi.radioEnabled !== true || !scan || scan.device !== device?.name) return [];
    return groupSystemWifiAccessPoints(scan.accessPoints);
  }, [device?.name, scan, wifi.radioEnabled]);

  useEffect(() => {
    if (!selectedDeviceId && wifi.devices[0]) setSelectedDeviceId(wifi.devices[0].id);
  }, [selectedDeviceId, wifi.devices]);

  useEffect(() => {
    if (scannedOnEntry.current || wifi.radioEnabled !== true || !canScan || !device) return;
    scannedOnEntry.current = true;
    void refreshScan();
  }, [canScan, device?.name, wifi.radioEnabled]);

  useEffect(() => {
    if (wifi.radioEnabled !== true) {
      scannedOnEntry.current = false;
      setScan(null);
    }
  }, [wifi.radioEnabled]);

  async function refreshScan() {
    if (!device || !canScan || wifi.radioEnabled !== true || scanning) return;
    setScanning(true);
    try {
      setScan(await scanSystemWifi({ device: device.name }));
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(t("workspace.management.network.wifi.errors.operation")));
    } finally {
      setScanning(false);
    }
  }

  const radioOff = wifi.radioEnabled === false;
  const radioUnknown = wifi.backend === "NetworkManager" && Boolean(device) && wifi.radioEnabled === null;
  const unavailable = wifi.backend !== "NetworkManager" || !device || radioUnknown;
  const disabled = radioOff || unavailable;
  return (
    <section className="management-section system-wifi-section" data-disabled={disabled || undefined}>
      <header className="management-section-header system-wifi-header">
        <div><h3>{t("workspace.management.network.wifi.title")}</h3><p>{t("workspace.management.network.wifi.readOnlyDescription")}</p></div>
        <div className="system-wifi-toolbar">
          {wifi.devices.length > 1 ? <select aria-label={String(t("workspace.management.network.wifi.device"))} value={device?.id ?? ""} onChange={(event) => setSelectedDeviceId(event.target.value)}>{wifi.devices.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select> : null}
          <button type="button" onClick={() => void refreshScan()} disabled={disabled || !canScan || !device || scanning}><RefreshCw className={scanning ? "is-spinning" : ""} size={14} /><span>{t("common.actions.refresh")}</span></button>
          <button type="button" onClick={onOpenSettings}><Settings size={14} /><span>{t("workspace.management.network.wifi.openSettings")}</span></button>
        </div>
      </header>

      {radioOff ? (
        <div className="system-wifi-unavailable">
          <WifiOff aria-hidden="true" size={18} />
          <div><strong>{t("workspace.management.network.wifi.radioOffTitle")}</strong><p>{t("workspace.management.network.wifi.radioOffDescription")}</p></div>
        </div>
      ) : radioUnknown ? (
        <div className="system-wifi-unavailable"><AlertTriangle size={18} /><div><strong>{t("workspace.management.network.wifi.radioUnknownTitle")}</strong><p>{t("workspace.management.network.wifi.radioUnknownDescription")}</p></div></div>
      ) : unavailable ? (
        <div className="system-wifi-unavailable"><AlertTriangle size={18} /><div><strong>{t("workspace.management.network.wifi.unavailableTitle")}</strong><p>{t("workspace.management.network.wifi.unavailableDescription", { backend: wifi.backend })}</p></div></div>
      ) : (
        <div className="system-wifi-content">
          <div className="system-wifi-device-summary">
            <div className="system-wifi-device-identity">
              <div className="system-wifi-device-icon" data-state={systemWifiDeviceTone(device.state)}><Wifi size={20} /></div>
              <div className="system-wifi-device-copy"><div className="system-wifi-device-heading"><strong>{device.ssid ?? device.name}</strong><span className="management-status-pill" data-state={systemWifiDeviceTone(device.state)}>{reconnecting ? t("workspace.management.network.wifi.states.reconnecting") : t(`workspace.management.network.wifi.states.${device.state}`)}</span></div><small>{device.driver ?? t("common.dash")} · {device.mac ?? t("common.dash")}</small></div>
            </div>
            <div className="system-wifi-device-details"><dl><div><dt>{t("workspace.management.network.wifi.signal")}</dt><dd>{device.signal === null ? t("common.dash") : `${device.signal}%`}</dd></div><div><dt>{t("workspace.management.network.wifi.channel")}</dt><dd>{device.channel ?? t("common.dash")}</dd></div><div><dt>{t("workspace.management.network.wifi.mode")}</dt><dd>{t(`workspace.management.network.wifi.modes.${device.mode}`)}</dd></div></dl></div>
          </div>
          <section className="system-wifi-list-panel system-wifi-readonly-list">
            <div className="system-wifi-subheader"><div><h4>{t("workspace.management.network.wifi.availableTitle")}</h4><p>{scan ? t("workspace.management.network.wifi.scanTime", { time: new Date(scan.scannedAt).toLocaleTimeString() }) : t("workspace.management.network.wifi.scanPrompt")}</p></div></div>
            {networks.length ? <div className="system-wifi-network-list">{networks.map((network) => <article key={network.id} className="system-wifi-network-row"><Signal size={16} /><div><strong>{network.ssid}</strong><small>{t(`workspace.management.network.wifi.security.${network.security}`)} · {network.strongest.band} GHz · {network.strongest.channel}</small></div><span>{network.strongest.signal}%</span></article>)}</div> : <p className="management-empty">{scanning ? t("workspace.management.network.wifi.scanning") : t("workspace.management.network.wifi.noScan")}</p>}
          </section>
        </div>
      )}
    </section>
  );
}
