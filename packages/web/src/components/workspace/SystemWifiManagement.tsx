import { ModalPortal } from "../common/ModalPortal.js";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import {
  AlertTriangle,
  Check,
  KeyRound,
  LoaderCircle,
  Pencil,
  Radio,
  RefreshCw,
  Router,
  Save,
  Shield,
  Signal,
  Trash2,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  connectSystemWifi,
  deleteSystemWifiHotspot,
  deleteSystemWifiProfile,
  disconnectSystemWifi,
  scanSystemWifi,
  setSystemWifiRadio,
  startSystemWifiHotspot,
  stopSystemWifiHotspot,
  updateSystemWifiHotspot,
  updateSystemWifiProfile,
  type NetworkSummary,
  type SystemWifiScanResult,
  type WifiStatus
} from "../../api.js";
import {
  groupSystemWifiAccessPoints,
  systemWifiChannels,
  systemWifiDeviceTone,
  validSystemWifiPassword,
  validSystemWifiSsid,
  type SystemWifiNetworkGroup
} from "../../lib/system-wifi.js";
import { useSystemWifiStatus } from "../../lib/use-system-wifi-status.js";
import { CustomSelect, type CustomSelectOption } from "../common/CustomSelect.js";
import { Switch } from "../common/Switch.js";

type WifiSummary = NetworkSummary["wifi"];
type WifiProfile = WifiSummary["profiles"][number];
type WifiHotspot = WifiSummary["hotspots"][number];
type Translate = (key: string, options?: Record<string, unknown>) => string;

interface SystemWifiManagementProps {
  wifi: WifiSummary;
  canManageWifi: boolean;
  canManageHotspot: boolean;
  onStatus: (status: WifiStatus) => void;
  onRefresh: () => Promise<void>;
  onNotifySuccess: (message: string) => void;
  onNotifyError: (message: string) => void;
}

interface Confirmation {
  title: string;
  description: string;
  danger: boolean;
  run: () => Promise<void>;
}

interface ConnectDialogState {
  network: SystemWifiNetworkGroup;
  password: string;
  autoconnect: boolean;
  confirmRisk: boolean;
}

interface ProfileDialogState {
  profile: WifiProfile;
  ssid: string;
  security: "open" | "wpa2" | "wpa3";
  password: string;
  autoconnect: boolean;
  confirmRestart: boolean;
}

interface HotspotDialogState {
  existing: WifiHotspot | null;
  ssid: string;
  password: string;
  band: "auto" | "2.4" | "5";
  channel: string;
  autostart: boolean;
  confirmRestart: boolean;
}

export function SystemWifiManagement({
  wifi,
  canManageWifi,
  canManageHotspot,
  onStatus,
  onRefresh,
  onNotifySuccess,
  onNotifyError
}: SystemWifiManagementProps) {
  const { t } = useTranslation();
  const translate = t as Translate;
  const [selectedDeviceId, setSelectedDeviceId] = useState(wifi.devices[0]?.id ?? "");
  const [networksDialogOpen, setNetworksDialogOpen] = useState(false);
  const [scan, setScan] = useState<SystemWifiScanResult | null>(null);
  const scanRequestId = useRef(0);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reconnecting = useSystemWifiStatus(onStatus);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [connectDialog, setConnectDialog] = useState<ConnectDialogState | null>(null);
  const [profileDialog, setProfileDialog] = useState<ProfileDialogState | null>(null);
  const [hotspotDialog, setHotspotDialog] = useState<HotspotDialogState | null>(null);

  const selectedDevice = wifi.devices.find((device) => device.id === selectedDeviceId) ?? wifi.devices[0] ?? null;
  const profiles = wifi.profiles.filter((profile) => !profile.device || profile.device === selectedDevice?.name);
  const hotspot = wifi.hotspots.find((candidate) => candidate.device === selectedDevice?.name) ?? null;
  const networks = useMemo(() => {
    if (wifi.radioEnabled !== true || !scan || scan.device !== selectedDevice?.name) return [];
    return groupSystemWifiAccessPoints(scan.accessPoints.map((accessPoint) => {
      const matches = profiles.filter((profile) => profile.ssid === accessPoint.ssid && profile.security === accessPoint.security);
      const savedProfile = matches.find((profile) => profile.id === selectedDevice.activeConnectionId)
        ?? matches.find((profile) => profile.id === accessPoint.savedProfileId)
        ?? matches[0];
      return {
        ...accessPoint,
        savedProfileId: savedProfile?.id ?? null,
        active: selectedDevice.mode === "client" && (savedProfile
          ? selectedDevice.activeConnectionId === savedProfile.id
          : selectedDevice.ssid === accessPoint.ssid && accessPoint.active)
      };
    }));
  }, [scan, selectedDevice, wifi.radioEnabled, wifi.profiles]);

  useEffect(() => {
    if (!selectedDevice && wifi.devices[0]) setSelectedDeviceId(wifi.devices[0].id);
  }, [selectedDevice, wifi.devices]);

  useEffect(() => {
    if (wifi.radioEnabled !== true) setScan(null);
  }, [wifi.radioEnabled]);

  useEffect(() => {
    if (canManageWifi) return;
    setNetworksDialogOpen(false);
    setConfirmation(null);
    setConnectDialog(null);
    setProfileDialog(null);
    setHotspotDialog(null);
  }, [canManageWifi]);

  useEffect(() => {
    if (!networksDialogOpen || !canManageWifi || !wifi.hostdReady || wifi.radioEnabled !== true) {
      setScanning(false);
      return;
    }
    void refreshScan();
    return () => { scanRequestId.current += 1; };
  }, [networksDialogOpen, selectedDevice?.name, canManageWifi, wifi.hostdReady, wifi.radioEnabled]);

  async function refreshScan() {
    if (!selectedDevice || !canManageWifi || !wifi.hostdReady || wifi.radioEnabled !== true) return;
    const requestId = ++scanRequestId.current;
    setScanning(true);
    setError(null);
    try {
      const result = await scanSystemWifi({ device: selectedDevice.name });
      if (requestId === scanRequestId.current) setScan(result);
    } catch (nextError) {
      if (requestId === scanRequestId.current) reportError(nextError);
    } finally {
      if (requestId === scanRequestId.current) setScanning(false);
    }
  }

  async function runMutation(action: () => Promise<unknown>, successKey: string) {
    if (busy) return;
    document.activeElement?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')?.focus();
    setBusy(true);
    setError(null);
    try {
      await action();
      await onRefresh();
      onNotifySuccess(translate(successKey));
    } catch (nextError) {
      reportError(nextError);
      throw nextError;
    } finally {
      setBusy(false);
    }
  }

  function reportError(value: unknown) {
    const message = value instanceof Error ? value.message : translate("workspace.management.network.wifi.errors.operation");
    setError(message);
    onNotifyError(message);
  }

  function requestConfirmation(next: Confirmation) {
    setError(null);
    setConfirmation(next);
  }

  function connectSaved(network: SystemWifiNetworkGroup) {
    if (!canManageWifi || wifi.radioEnabled !== true || busy || !selectedDevice || !network.strongest.savedProfileId) return;
    const execute = () => runMutation(
      () => connectSystemWifi({
        device: selectedDevice.name,
        profileId: network.strongest.savedProfileId!,
        ...(network.strongest.bssid ? { bssid: network.strongest.bssid } : {}),
        confirmed: selectedDevice.managementPath
      }),
      "workspace.management.network.wifi.messages.connected"
    );
    if (selectedDevice.managementPath) {
      requestConfirmation({
        title: translate("workspace.management.network.wifi.confirm.managementTitle"),
        description: translate("workspace.management.network.wifi.confirm.managementDescription"),
        danger: true,
        run: execute
      });
    } else {
      void execute().catch(() => undefined);
    }
  }

  function openConnect(network: SystemWifiNetworkGroup) {
    if (!canManageWifi || wifi.radioEnabled !== true || busy || network.security === "unsupported") return;
    setError(null);
    if (network.strongest.savedProfileId) {
      connectSaved(network);
      return;
    }
    setConnectDialog({ network, password: "", autoconnect: true, confirmRisk: false });
  }

  async function submitConnect() {
    if (!connectDialog || !selectedDevice) return;
    if (selectedDevice.managementPath && !connectDialog.confirmRisk) {
      setConnectDialog({ ...connectDialog, confirmRisk: true });
      return;
    }
    try {
      await runMutation(
        () => connectSystemWifi({
          device: selectedDevice.name,
          ssid: connectDialog.network.ssid,
          bssid: connectDialog.network.strongest.bssid,
          security: connectDialog.network.security === "unsupported" ? "open" : connectDialog.network.security,
          ...(connectDialog.network.security !== "open" ? { password: connectDialog.password } : {}),
          autoconnect: connectDialog.autoconnect,
          confirmed: connectDialog.confirmRisk
        }),
        "workspace.management.network.wifi.messages.connected"
      );
      setConnectDialog(null);
    } catch {
      // Keep the form open with the submitted values.
    }
  }

  function requestDisconnect() {
    if (!canManageWifi || !selectedDevice) return;
    requestConfirmation({
      title: translate("workspace.management.network.wifi.confirm.disconnectTitle"),
      description: selectedDevice.managementPath
        ? translate("workspace.management.network.wifi.confirm.managementDescription")
        : translate("workspace.management.network.wifi.confirm.disconnectDescription"),
      danger: true,
      run: () => runMutation(
        () => disconnectSystemWifi(selectedDevice.name, true),
        "workspace.management.network.wifi.messages.disconnected"
      )
    });
  }

  function toggleRadio() {
    if (!canManageWifi) return;
    const enabled = wifi.radioEnabled !== true;
    const execute = () => runMutation(
      () => setSystemWifiRadio({ enabled, confirmed: !enabled }),
      enabled
        ? "workspace.management.network.wifi.messages.radioEnabled"
        : "workspace.management.network.wifi.messages.radioDisabled"
    );
    if (!enabled) {
      requestConfirmation({
        title: translate("workspace.management.network.wifi.confirm.radioTitle"),
        description: translate("workspace.management.network.wifi.confirm.radioDescription"),
        danger: true,
        run: execute
      });
    } else {
      void execute().catch(() => undefined);
    }
  }

  function editProfile(profile: WifiProfile) {
    if (!canManageWifi || !profile.managed || profile.security === "unsupported") return;
    setError(null);
    setProfileDialog({
      profile,
      ssid: profile.ssid,
      security: profile.security,
      password: "",
      autoconnect: profile.autoconnect,
      confirmRestart: false
    });
  }

  async function submitProfile() {
    if (!profileDialog?.profile.revision) return;
    if (profileDialog.profile.active && !profileDialog.confirmRestart) {
      setProfileDialog({ ...profileDialog, confirmRestart: true });
      return;
    }
    try {
      await runMutation(
        () => updateSystemWifiProfile(profileDialog.profile.id, {
          ssid: profileDialog.ssid,
          security: profileDialog.security,
          ...(profileDialog.password ? { password: profileDialog.password } : {}),
          autoconnect: profileDialog.autoconnect,
          expectedRevision: profileDialog.profile.revision!,
          confirmed: profileDialog.confirmRestart
        }),
        "workspace.management.network.wifi.messages.profileSaved"
      );
      setProfileDialog(null);
    } catch {
      // Keep the form open after a failed update.
    }
  }

  function forgetProfile(profile: WifiProfile) {
    if (!canManageWifi || !profile.managed) return;
    requestConfirmation({
      title: translate("workspace.management.network.wifi.confirm.forgetTitle"),
      description: translate("workspace.management.network.wifi.confirm.forgetDescription", { ssid: profile.ssid }),
      danger: true,
      run: () => runMutation(
        () => deleteSystemWifiProfile(profile.id, true),
        "workspace.management.network.wifi.messages.profileForgotten"
      )
    });
  }

  function openHotspot() {
    if (!canManageHotspot || !selectedDevice) return;
    setError(null);
    setHotspotDialog({
      existing: hotspot,
      ssid: hotspot?.ssid ?? "CyberOS",
      password: "",
      band: hotspot?.band ?? "auto",
      channel: hotspot?.channel ? String(hotspot.channel) : "",
      autostart: hotspot?.autostart ?? false,
      confirmRestart: false
    });
  }

  async function submitHotspot() {
    if (!hotspotDialog || !selectedDevice) return;
    if (hotspotDialog.existing?.active && !hotspotDialog.confirmRestart) {
      setHotspotDialog({ ...hotspotDialog, confirmRestart: true });
      return;
    }
    try {
      await runMutation(
        () => updateSystemWifiHotspot({
          device: selectedDevice.name,
          ssid: hotspotDialog.ssid,
          ...(hotspotDialog.password ? { password: hotspotDialog.password } : {}),
          band: hotspotDialog.band,
          channel: hotspotDialog.channel ? Number(hotspotDialog.channel) : null,
          autostart: hotspotDialog.autostart,
          ...(hotspotDialog.existing ? { expectedRevision: hotspotDialog.existing.revision } : {}),
          confirmed: hotspotDialog.confirmRestart
        }),
        "workspace.management.network.wifi.messages.hotspotSaved"
      );
      setHotspotDialog(null);
    } catch {
      // Keep the form open after a failed update.
    }
  }

  function hotspotAction(action: "start" | "stop" | "delete") {
    if (!canManageHotspot || !selectedDevice) return;
    const labels = {
      start: ["workspace.management.network.wifi.confirm.hotspotStartTitle", "workspace.management.network.wifi.confirm.hotspotStartDescription", "workspace.management.network.wifi.messages.hotspotStarted"],
      stop: ["workspace.management.network.wifi.confirm.hotspotStopTitle", "workspace.management.network.wifi.confirm.hotspotStopDescription", "workspace.management.network.wifi.messages.hotspotStopped"],
      delete: ["workspace.management.network.wifi.confirm.hotspotDeleteTitle", "workspace.management.network.wifi.confirm.hotspotDeleteDescription", "workspace.management.network.wifi.messages.hotspotDeleted"]
    } as const;
    const operations = {
      start: startSystemWifiHotspot,
      stop: stopSystemWifiHotspot,
      delete: deleteSystemWifiHotspot
    } as const;
    requestConfirmation({
      title: translate(labels[action][0]),
      description: selectedDevice.managementPath
        ? `${translate(labels[action][1])} ${translate("workspace.management.network.wifi.confirm.managementDescription")}`
        : translate(labels[action][1]),
      danger: action !== "start",
      run: async () => {
        await runMutation(
          () => operations[action]({ device: selectedDevice.name, confirmed: true }),
          labels[action][2]
        );
        setHotspotDialog(null);
      }
    });
  }

  const unavailable = wifi.backend !== "NetworkManager" || !selectedDevice;
  const managementUnavailable = wifi.backend === "NetworkManager" && wifi.hostdReady && Boolean(selectedDevice) && !canManageWifi;
  const selectedDeviceCanHotspot = wifi.radioEnabled === true && canManageHotspot && selectedDevice?.capabilities.accessPoint === true;
  const networksObscured = Boolean(connectDialog || profileDialog || confirmation);

  return (
    <>
      <section className="management-section system-wifi-section">
        <header className="management-section-header system-wifi-header">
          <div>
            <h3>{t("workspace.management.network.wifi.title")}</h3>
            <p>{t("workspace.management.network.wifi.statusDescription")}</p>
          </div>
          <div className="system-wifi-toolbar">
            {wifi.devices.length > 1 ? (
              <label>
                <span className="visually-hidden">{t("workspace.management.network.wifi.device")}</span>
                <CustomSelect
                  value={selectedDevice?.id ?? ""}
                  ariaLabel={t("workspace.management.network.wifi.device")}
                  options={wifi.devices.map((device) => ({ value: device.id, label: device.name }))}
                  onChange={setSelectedDeviceId}
                />
              </label>
            ) : null}
            <button type="button" onClick={() => { setError(null); setNetworksDialogOpen(true); }} disabled={unavailable || !wifi.hostdReady || !canManageWifi || busy}>
              <RefreshCw aria-hidden="true" size={14} />
              <span>{t("workspace.management.network.wifi.scan")}</span>
            </button>
            <button type="button" onClick={openHotspot} disabled={!selectedDeviceCanHotspot || busy}>
              <Router aria-hidden="true" size={14} />
              <span>{t("workspace.management.network.wifi.hotspot.settings")}</span>
            </button>
          </div>
        </header>

        <div className="system-wifi-content">
          {error ? <p className="system-wifi-error" role="alert">{error}</p> : null}
          {managementUnavailable ? (
            <div className="system-wifi-unavailable" role="status">
              <AlertTriangle aria-hidden="true" size={18} />
              <div>
                <strong>{t("workspace.management.network.wifi.readOnlyTitle")}</strong>
                <p>{t("workspace.management.network.wifi.managementUnavailableDescription")}</p>
              </div>
            </div>
          ) : null}
          {wifi.backend !== "NetworkManager" ? (
            <div className="system-wifi-unavailable">
              <AlertTriangle aria-hidden="true" size={18} />
              <div>
                <strong>{t("workspace.management.network.wifi.unavailableTitle")}</strong>
                <p>{t("workspace.management.network.wifi.unavailableDescription", { backend: wifi.backend })}</p>
              </div>
            </div>
          ) : !wifi.hostdReady ? (
            <div className="system-wifi-unavailable">
              <AlertTriangle aria-hidden="true" size={18} />
              <div>
                <strong>{t("workspace.management.network.wifi.hostdUnavailableTitle")}</strong>
                <p>{t("workspace.management.network.wifi.hostdUnavailableDescription")}</p>
              </div>
            </div>
          ) : selectedDevice ? (
            <>
              <div className="system-wifi-device-summary">
                <div className="system-wifi-device-identity">
                  <div className="system-wifi-device-icon" data-state={systemWifiDeviceTone(selectedDevice.state)}>
                    {selectedDevice.mode === "hotspot" ? <Radio aria-hidden="true" size={20} /> : <Wifi aria-hidden="true" size={20} />}
                  </div>
                  <div className="system-wifi-device-copy">
                    <div className="system-wifi-device-heading">
                      <strong>{selectedDevice.ssid ?? selectedDevice.name}</strong>
                      <span className="management-status-pill" data-state={systemWifiDeviceTone(selectedDevice.state)}>
                        {reconnecting
                          ? t("workspace.management.network.wifi.states.reconnecting")
                          : t(`workspace.management.network.wifi.states.${selectedDevice.state}`)}
                      </span>
                    </div>
                    <small>
                      {selectedDevice.driver ?? t("common.dash")} · {selectedDevice.mac ?? t("common.dash")}
                      {selectedDevice.managementPath ? ` · ${t("workspace.management.network.wifi.managementPath")}` : ""}
                    </small>
                  </div>
                </div>
                <div className="system-wifi-device-details">
                  <dl>
                    <div><dt>{t("workspace.management.network.wifi.signal")}</dt><dd>{selectedDevice.signal === null ? t("common.dash") : `${selectedDevice.signal}%`}</dd></div>
                    <div><dt>{t("workspace.management.network.wifi.channel")}</dt><dd>{selectedDevice.channel ?? t("common.dash")}</dd></div>
                    <div><dt>{t("workspace.management.network.wifi.mode")}</dt><dd>{t(`workspace.management.network.wifi.modes.${selectedDevice.mode}`)}</dd></div>
                  </dl>
                </div>
              </div>

              {hotspot ? (
                <div className="system-wifi-hotspot-bar system-wifi-hotspot-summary" data-active={hotspot.active || undefined}>
                  <Router aria-hidden="true" size={17} />
                  <div>
                    <strong>{hotspot.ssid}</strong>
                    <small>{hotspot.band === "auto" ? t("workspace.management.network.wifi.hotspot.autoBand") : `${hotspot.band} GHz`} · {hotspot.autostart ? t("workspace.management.network.wifi.hotspot.autostartOn") : t("workspace.management.network.wifi.hotspot.autostartOff")}</small>
                  </div>
                  <span className="management-status-pill" data-state={hotspot.active ? "ready" : "neutral"}>
                    {hotspot.active ? t("workspace.management.network.wifi.hotspot.running") : t("workspace.management.network.wifi.hotspot.stopped")}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <p className="management-empty">{t("workspace.management.network.wifi.noDevices")}</p>
          )}
        </div>
      </section>

      {networksDialogOpen && selectedDevice ? (
        <WifiDialog
          title={translate("workspace.management.network.wifi.networksTitle")}
          eyebrow={translate("workspace.management.network.wifi.title")}
          className="system-wifi-networks-dialog"
          busy={busy}
          obscured={networksObscured}
          onClose={() => setNetworksDialogOpen(false)}
        >
          <div className="system-wifi-networks-body">
            {error ? <p className="system-wifi-error" role="alert">{error}</p> : null}
            <div className="system-wifi-network-controls system-wifi-toolbar">
              {wifi.devices.length > 1 ? (
                <label>
                  <span className="visually-hidden">{t("workspace.management.network.wifi.device")}</span>
                  <CustomSelect
                    value={selectedDevice.id}
                    ariaLabel={t("workspace.management.network.wifi.device")}
                    disabled={busy}
                    options={wifi.devices.map((device) => ({ value: device.id, label: device.name }))}
                    onChange={setSelectedDeviceId}
                  />
                </label>
              ) : <strong>{selectedDevice.name}</strong>}
              <button type="button" onClick={toggleRadio} disabled={!canManageWifi || busy} aria-pressed={wifi.radioEnabled === true}>
                {wifi.radioEnabled ? <Wifi aria-hidden="true" size={15} /> : <WifiOff aria-hidden="true" size={15} />}
                <span>{wifi.radioEnabled ? t("workspace.management.network.wifi.disableRadio") : t("workspace.management.network.wifi.enableRadio")}</span>
              </button>
              {selectedDevice.activeConnectionId && selectedDevice.mode === "client" ? (
                <button type="button" className="is-danger" onClick={requestDisconnect} disabled={!canManageWifi || busy}>
                  <WifiOff aria-hidden="true" size={14} />
                  <span>{t("workspace.management.network.wifi.disconnect")}</span>
                </button>
              ) : null}
              <button type="button" onClick={(event) => { event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus(); void refreshScan(); }} disabled={wifi.radioEnabled !== true || !wifi.hostdReady || !canManageWifi || scanning || busy} aria-busy={scanning || undefined}>
                {scanning ? <LoaderCircle aria-hidden="true" size={14} /> : <RefreshCw aria-hidden="true" size={14} />}
                <span>{t("workspace.management.network.wifi.scan")}</span>
              </button>
            </div>
              <div className="system-wifi-grid">
                <section className="system-wifi-list-panel">
                  <div className="system-wifi-subheader">
                    <div>
                      <h4>{t("workspace.management.network.wifi.availableTitle")}</h4>
                      <p role="status">{scanning ? t("workspace.management.network.wifi.scanning") : scan?.device === selectedDevice.name ? t("workspace.management.network.wifi.scanTime", { time: new Date(scan.scannedAt).toLocaleTimeString() }) : t("workspace.management.network.wifi.scanPrompt")}</p>
                    </div>
                  </div>
                  {networks.length ? (
                    <div className="system-wifi-network-list">
                      {networks.map((network) => (
                        <article key={network.id} className="system-wifi-network-row">
                          <Signal aria-hidden="true" size={16} />
                          <div>
                            <strong>{network.ssid}</strong>
                            <small>{t(`workspace.management.network.wifi.security.${network.security}`)} · {network.strongest.band} GHz · {network.strongest.channel}</small>
                          </div>
                          <span>{network.strongest.signal}%</span>
                          <button
                            type="button"
                            onClick={() => openConnect(network)}
                            disabled={wifi.radioEnabled !== true || !canManageWifi || busy || network.security === "unsupported" || network.strongest.active}
                            aria-label={t(network.strongest.active ? "workspace.management.network.wifi.currentNetwork" : "workspace.management.network.wifi.connectNetwork", { ssid: network.ssid })}
                          >
                            {network.strongest.active ? <Check aria-hidden="true" size={14} /> : <KeyRound aria-hidden="true" size={14} />}
                            <span>{network.strongest.active ? t("workspace.management.network.wifi.current") : t("workspace.management.network.wifi.connect")}</span>
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="management-empty">{wifi.radioEnabled !== true ? t(wifi.radioEnabled === false ? "workspace.management.network.wifi.radioOffTitle" : "workspace.management.network.wifi.radioUnknownTitle") : scanning ? t("workspace.management.network.wifi.scanning") : t("workspace.management.network.wifi.noScan")}</p>
                  )}
                </section>

                <section className="system-wifi-list-panel">
                  <div className="system-wifi-subheader">
                    <div>
                      <h4>{t("workspace.management.network.wifi.savedTitle")}</h4>
                      <p>{t("workspace.management.network.wifi.savedDescription")}</p>
                    </div>
                  </div>
                  {profiles.length ? (
                    <div className="system-wifi-profile-list">
                      {profiles.map((profile) => (
                        <article key={profile.id} className="system-wifi-profile-row">
                          <Shield aria-hidden="true" size={15} />
                          <div>
                            <strong>{profile.ssid}</strong>
                            <small>{profile.managed ? t("workspace.management.network.wifi.managed") : t("workspace.management.network.wifi.external")}</small>
                          </div>
                          <span className="management-status-pill" data-state={profile.active ? "ready" : "neutral"}>
                            {profile.active ? t("workspace.management.network.wifi.current") : profile.autoconnect ? t("workspace.management.network.wifi.autoconnect") : t("workspace.management.network.wifi.saved")}
                          </span>
                          <div className="system-wifi-row-actions">
                            {!profile.active ? (
                              <button type="button" className="management-icon-action" onClick={() => connectSaved(profileNetwork(profile))} disabled={wifi.radioEnabled !== true || !canManageWifi || busy} aria-label={t("workspace.management.network.wifi.connectNetwork", { ssid: profile.ssid })} title={t("workspace.management.network.wifi.connect")}>
                                <Wifi aria-hidden="true" size={14} />
                              </button>
                            ) : null}
                            <button type="button" className="management-icon-action" onClick={() => editProfile(profile)} disabled={!canManageWifi || !profile.managed || profile.security === "unsupported" || busy} aria-label={t("workspace.management.network.wifi.editNetwork", { ssid: profile.ssid })} title={profile.managed ? t("common.actions.edit") : t("workspace.management.network.wifi.externalReadOnly")}>
                              <Pencil aria-hidden="true" size={14} />
                            </button>
                            <button type="button" className="management-icon-action is-danger" onClick={() => forgetProfile(profile)} disabled={!canManageWifi || !profile.managed || busy} aria-label={t("workspace.management.network.wifi.forgetNetwork", { ssid: profile.ssid })} title={profile.managed ? t("workspace.management.network.wifi.forget") : t("workspace.management.network.wifi.externalReadOnly")}>
                              <Trash2 aria-hidden="true" size={14} />
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : <p className="management-empty">{t("workspace.management.network.wifi.noProfiles")}</p>}
                </section>
              </div>

          </div>
        </WifiDialog>
      ) : null}

      {connectDialog && selectedDevice ? (
        <WifiFormDialog title={connectDialog.network.ssid} eyebrow={translate("workspace.management.network.wifi.connectEyebrow")} busy={busy} error={error} onClose={() => setConnectDialog(null)} onSubmit={submitConnect}>
          {connectDialog.confirmRisk ? (
            <RiskConfirmation title={translate("workspace.management.network.wifi.confirm.managementTitle")} description={translate("workspace.management.network.wifi.confirm.managementDescription")} />
          ) : (
            <>
              <FormFact label={translate("workspace.management.network.wifi.securityLabel")} value={translate(`workspace.management.network.wifi.security.${connectDialog.network.security}`)} />
              {connectDialog.network.security !== "open" ? (
                <label><span>{t("workspace.management.network.wifi.password")}</span><input autoFocus type="password" value={connectDialog.password} onChange={(event) => setConnectDialog({ ...connectDialog, password: event.target.value })} disabled={busy} autoComplete="new-password" /></label>
              ) : null}
              <Switch className="system-wifi-checkbox" checked={connectDialog.autoconnect} onCheckedChange={(autoconnect) => setConnectDialog({ ...connectDialog, autoconnect })} disabled={busy} label={t("workspace.management.network.wifi.autoconnectLabel")} />
            </>
          )}
          <DialogActions onCancel={() => connectDialog.confirmRisk ? setConnectDialog({ ...connectDialog, confirmRisk: false }) : setConnectDialog(null)} busy={busy} submitLabel={translate(connectDialog.confirmRisk ? "workspace.management.network.wifi.confirm.continue" : "workspace.management.network.wifi.connect")} submitDisabled={connectDialog.network.security !== "open" && !validSystemWifiPassword(connectDialog.password)} danger={connectDialog.confirmRisk} />
        </WifiFormDialog>
      ) : null}

      {profileDialog ? (
        <WifiFormDialog title={profileDialog.profile.ssid} eyebrow={translate("workspace.management.network.wifi.profileEyebrow")} busy={busy} error={error} onClose={() => setProfileDialog(null)} onSubmit={submitProfile}>
          {profileDialog.confirmRestart ? (
            <RiskConfirmation title={translate("workspace.management.network.wifi.confirm.profileRestartTitle")} description={translate("workspace.management.network.wifi.confirm.profileRestartDescription")} />
          ) : (
            <>
              <label><span>{t("workspace.management.network.wifi.ssid")}</span><input autoFocus value={profileDialog.ssid} onChange={(event) => setProfileDialog({ ...profileDialog, ssid: event.target.value })} disabled={busy} /></label>
              <label>
                <span>{t("workspace.management.network.wifi.securityLabel")}</span>
                <CustomSelect<ProfileDialogState["security"]>
                  value={profileDialog.security}
                  ariaLabel={t("workspace.management.network.wifi.securityLabel")}
                  disabled={busy}
                  options={(["open", "wpa2", "wpa3"] as const).map((value) => ({
                    value, label: t(`workspace.management.network.wifi.security.${value}`)
                  }))}
                  onChange={(security) => setProfileDialog({ ...profileDialog, security })}
                />
              </label>
              {profileDialog.security !== "open" ? <label><span>{t("workspace.management.network.wifi.passwordOptional")}</span><input type="password" value={profileDialog.password} onChange={(event) => setProfileDialog({ ...profileDialog, password: event.target.value })} disabled={busy} autoComplete="new-password" placeholder={t("workspace.management.network.wifi.keepPassword")} /></label> : null}
              <Switch className="system-wifi-checkbox" checked={profileDialog.autoconnect} onCheckedChange={(autoconnect) => setProfileDialog({ ...profileDialog, autoconnect })} disabled={busy} label={t("workspace.management.network.wifi.autoconnectLabel")} />
            </>
          )}
          <DialogActions onCancel={() => profileDialog.confirmRestart ? setProfileDialog({ ...profileDialog, confirmRestart: false }) : setProfileDialog(null)} busy={busy} submitLabel={translate(profileDialog.confirmRestart ? "workspace.management.network.wifi.confirm.continue" : "common.actions.save")} submitDisabled={!validSystemWifiSsid(profileDialog.ssid) || Boolean(profileDialog.password && !validSystemWifiPassword(profileDialog.password))} danger={profileDialog.confirmRestart} />
        </WifiFormDialog>
      ) : null}

      {hotspotDialog && selectedDevice ? (
        <WifiFormDialog title={translate("workspace.management.network.wifi.hotspot.title")} eyebrow={translate("workspace.management.network.wifi.hotspot.eyebrow")} busy={busy} error={error} obscured={Boolean(confirmation)} onClose={() => setHotspotDialog(null)} onSubmit={submitHotspot}>
          {hotspotDialog.confirmRestart ? (
            <RiskConfirmation title={translate("workspace.management.network.wifi.confirm.hotspotRestartTitle")} description={translate("workspace.management.network.wifi.confirm.hotspotRestartDescription")} />
          ) : (
            <>
              <HotspotFields state={hotspotDialog} device={selectedDevice} busy={busy} t={translate} onChange={setHotspotDialog} />
              {hotspot ? (
                <div className="system-wifi-hotspot-actions system-wifi-toolbar">
                  <button type="button" onClick={() => hotspotAction(hotspot.active ? "stop" : "start")} disabled={!canManageHotspot || busy}>
                    {hotspot.active ? <WifiOff aria-hidden="true" size={14} /> : <Radio aria-hidden="true" size={14} />}
                    <span>{hotspot.active ? t("workspace.management.network.wifi.hotspot.stop") : t("workspace.management.network.wifi.hotspot.start")}</span>
                  </button>
                  <button type="button" className="is-danger" onClick={() => hotspotAction("delete")} disabled={!canManageHotspot || busy}>
                    <Trash2 aria-hidden="true" size={14} />
                    <span>{t("common.actions.delete")}</span>
                  </button>
                </div>
              ) : null}
            </>
          )}
          <DialogActions onCancel={() => hotspotDialog.confirmRestart ? setHotspotDialog({ ...hotspotDialog, confirmRestart: false }) : setHotspotDialog(null)} busy={busy} submitLabel={translate(hotspotDialog.confirmRestart ? "workspace.management.network.wifi.confirm.continue" : "common.actions.save")} submitDisabled={!validSystemWifiSsid(hotspotDialog.ssid) || (!hotspotDialog.existing && !validSystemWifiPassword(hotspotDialog.password)) || Boolean(hotspotDialog.password && !validSystemWifiPassword(hotspotDialog.password))} danger={hotspotDialog.confirmRestart} />
        </WifiFormDialog>
      ) : null}

      {confirmation ? (
        <WifiConfirmationDialog
          confirmation={confirmation}
          busy={busy}
          error={error}
          onClose={() => setConfirmation(null)}
          t={translate}
        />
      ) : null}
    </>
  );
}

interface WifiDialogProps {
  title: string;
  eyebrow: string;
  busy: boolean;
  error?: string | null;
  obscured?: boolean;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

function WifiFormDialog({ onSubmit, children, error, ...props }: WifiDialogProps & { onSubmit: () => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }
  return <WifiDialog {...props}><form onSubmit={submit}>{error ? <p className="system-wifi-error" role="alert">{error}</p> : null}{children}</form></WifiDialog>;
}

function WifiDialog({ title, eyebrow, busy, obscured = false, className, onClose, children }: WifiDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useLayoutEffect(() => {
    return () => {
      const target = previousFocus.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  useLayoutEffect(() => {
    if (obscured) return;
    focusDialog(dialogRef.current);
  }, [obscured]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (event.key === "Tab") event.stopPropagation();
    trapDialogFocus(event, dialogRef.current);
  }

  return (
    <ModalPortal className="management-modal-backdrop system-wifi-modal-backdrop" inert={obscured || undefined} aria-hidden={obscured || undefined} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className={["management-modal", "system-wifi-dialog", className].filter(Boolean).join(" ")} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeyDown}>
        <header><div><span className="eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2></div><button type="button" className="management-icon-action" onClick={onClose} disabled={busy} aria-label={t("common.actions.close")}><X aria-hidden="true" size={17} /></button></header>
        {children}
      </section>
    </ModalPortal>
  );
}

function DialogActions({ onCancel, busy, submitLabel, submitDisabled, danger }: { onCancel: () => void; busy: boolean; submitLabel: string; submitDisabled: boolean; danger: boolean }) {
  const { t } = useTranslation();
  return (
    <footer className="system-wifi-dialog-actions">
      <button type="button" onClick={onCancel} disabled={busy}>{t("common.actions.cancel")}</button>
      <button type="submit" className={danger ? "is-danger" : "is-primary"} disabled={busy || submitDisabled} aria-busy={busy || undefined}>{busy ? <LoaderCircle aria-hidden="true" size={14} /> : <Save aria-hidden="true" size={14} />}<span>{submitLabel}</span></button>
    </footer>
  );
}

function WifiConfirmationDialog({ confirmation, busy, error, onClose, t }: { confirmation: Confirmation; busy: boolean; error: string | null; onClose: () => void; t: Translate }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useLayoutEffect(() => {
    closeButton.current?.focus();
    return () => {
      const target = previousFocus.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (event.key === "Tab") event.stopPropagation();
    trapDialogFocus(event, dialogRef.current);
  }

  return (
    <ModalPortal className="management-modal-backdrop system-wifi-modal-backdrop">
      <section ref={dialogRef} className="management-modal system-wifi-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeyDown}>
        <header><div><span className="eyebrow">{t("workspace.management.network.wifi.confirm.eyebrow")}</span><h2 id={titleId}>{confirmation.title}</h2></div><button ref={closeButton} type="button" className="management-icon-action" onClick={onClose} disabled={busy} aria-label={t("common.actions.close")}><X aria-hidden="true" size={17} /></button></header>
        <div className="system-wifi-confirm-body"><AlertTriangle aria-hidden="true" size={24} /><div><p>{confirmation.description}</p>{error ? <p className="system-wifi-error" role="alert">{error}</p> : null}</div></div>
        <footer><button type="button" onClick={onClose} disabled={busy}>{t("common.actions.cancel")}</button><button type="button" className={confirmation.danger ? "is-danger" : "is-primary"} disabled={busy} aria-busy={busy || undefined} onClick={() => void confirmation.run().then(onClose).catch(() => undefined)}>{busy ? <LoaderCircle aria-hidden="true" size={14} /> : <Check aria-hidden="true" size={14} />}<span>{t("workspace.management.network.wifi.confirm.continue")}</span></button></footer>
      </section>
    </ModalPortal>
  );
}

function focusDialog(dialog: HTMLElement | null): void {
  if (!dialog || dialog.contains(document.activeElement)) return;
  const first = firstFocusable(dialog);
  if (first) first.focus();
  else dialog.focus();
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>, dialog: HTMLElement | null): void {
  if (event.key !== "Tab" || !dialog) return;
  const focusable = focusableElements(dialog);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function firstFocusable(dialog: HTMLElement): HTMLElement | null {
  return focusableElements(dialog)[0] ?? null;
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  )].filter((element) => element.getClientRects().length > 0);
}

function RiskConfirmation({ title, description }: { title: string; description: string }) {
  return <div className="system-wifi-risk"><AlertTriangle aria-hidden="true" size={24} /><div><h3>{title}</h3><p>{description}</p></div></div>;
}

function FormFact({ label, value }: { label: string; value: string }) {
  return <div className="system-wifi-form-fact"><span>{label}</span><strong>{value}</strong></div>;
}

function HotspotFields({ state, device, busy, t, onChange }: { state: HotspotDialogState; device: WifiSummary["devices"][number]; busy: boolean; t: Translate; onChange: (state: HotspotDialogState) => void }) {
  const channels = systemWifiChannels(device.capabilities.channels, state.band);
  const bandOptions: CustomSelectOption<HotspotDialogState["band"]>[] = [
    { value: "auto", label: t("workspace.management.network.wifi.hotspot.autoBand") }
  ];
  if (device.capabilities.bands.includes("2.4")) bandOptions.push({ value: "2.4", label: "2.4 GHz" });
  if (device.capabilities.bands.includes("5")) bandOptions.push({ value: "5", label: "5 GHz" });
  return (
    <>
      <label><span>{t("workspace.management.network.wifi.ssid")}</span><input autoFocus value={state.ssid} onChange={(event) => onChange({ ...state, ssid: event.target.value })} disabled={busy} /></label>
      <label><span>{state.existing ? t("workspace.management.network.wifi.passwordOptional") : t("workspace.management.network.wifi.password")}</span><input type="password" value={state.password} onChange={(event) => onChange({ ...state, password: event.target.value })} disabled={busy} autoComplete="new-password" placeholder={state.existing ? t("workspace.management.network.wifi.keepPassword") : undefined} /></label>
      <div className="system-wifi-form-grid">
        <label>
          <span>{t("workspace.management.network.wifi.hotspot.band")}</span>
          <CustomSelect
            value={state.band}
            ariaLabel={t("workspace.management.network.wifi.hotspot.band")}
            options={bandOptions}
            disabled={busy}
            onChange={(band) => onChange({ ...state, band, channel: "" })}
          />
        </label>
        <label>
          <span>{t("workspace.management.network.wifi.channel")}</span>
          <CustomSelect
            value={state.channel}
            ariaLabel={t("workspace.management.network.wifi.channel")}
            disabled={busy || state.band === "auto"}
            options={[
              { value: "", label: t("workspace.management.network.wifi.hotspot.autoChannel") },
              ...channels.map((channel) => ({ value: String(channel), label: String(channel) }))
            ]}
            onChange={(channel) => onChange({ ...state, channel })}
          />
        </label>
      </div>
      <Switch className="system-wifi-checkbox" checked={state.autostart} onCheckedChange={(autostart) => onChange({ ...state, autostart })} disabled={busy} label={t("workspace.management.network.wifi.hotspot.autostart")} />
    </>
  );
}

function profileNetwork(profile: WifiProfile): SystemWifiNetworkGroup {
  const accessPoint = {
    ssid: profile.ssid,
    bssid: "",
    signal: 0,
    frequencyMHz: 0,
    channel: 0,
    band: "2.4" as const,
    security: profile.security,
    active: profile.active,
    savedProfileId: profile.id
  };
  return { id: profile.id, ssid: profile.ssid, security: profile.security, strongest: accessPoint, accessPoints: [accessPoint] };
}
