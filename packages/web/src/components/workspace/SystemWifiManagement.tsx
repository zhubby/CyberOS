import {
  useEffect,
  useId,
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
  Settings,
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
  const [scan, setScan] = useState<SystemWifiScanResult | null>(null);
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
    return groupSystemWifiAccessPoints(scan.accessPoints);
  }, [scan, selectedDevice?.name, wifi.radioEnabled]);

  useEffect(() => {
    if (!selectedDevice && wifi.devices[0]) setSelectedDeviceId(wifi.devices[0].id);
  }, [selectedDevice, wifi.devices]);

  useEffect(() => {
    if (wifi.radioEnabled !== true) setScan(null);
  }, [wifi.radioEnabled]);

  useEffect(() => {
    if (canManageWifi) return;
    setConfirmation(null);
    setConnectDialog(null);
    setProfileDialog(null);
    setHotspotDialog(null);
  }, [canManageWifi]);

  async function refreshScan() {
    if (!selectedDevice || scanning || !canManageWifi || wifi.radioEnabled !== true) return;
    setScanning(true);
    setError(null);
    try {
      setScan(await scanSystemWifi({ device: selectedDevice.name }));
    } catch (nextError) {
      reportError(nextError);
    } finally {
      setScanning(false);
    }
  }

  async function runMutation(action: () => Promise<unknown>, successKey: string) {
    if (busy) return;
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
    setConfirmation(next);
  }

  function connectSaved(network: SystemWifiNetworkGroup) {
    if (!canManageWifi || !selectedDevice || !network.strongest.savedProfileId) return;
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
    if (!canManageWifi || network.security === "unsupported") return;
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
    if (!canManageWifi) return;
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
      run: () => runMutation(
        () => operations[action]({ device: selectedDevice.name, confirmed: true }),
        labels[action][2]
      )
    });
  }

  const unavailable = wifi.backend !== "NetworkManager" || !selectedDevice;
  const managementUnavailable = wifi.backend === "NetworkManager" && wifi.hostdReady && Boolean(selectedDevice) && !canManageWifi;
  const selectedDeviceCanHotspot = wifi.radioEnabled === true && canManageHotspot && selectedDevice?.capabilities.accessPoint === true;

  return (
    <>
      <section className="management-section system-wifi-section">
        <header className="management-section-header system-wifi-header">
          <div>
            <h3>{t("workspace.management.network.wifi.title")}</h3>
            <p>{t("workspace.management.network.wifi.description")}</p>
          </div>
          <div className="system-wifi-toolbar">
            {wifi.devices.length > 1 ? (
              <label>
                <span className="visually-hidden">{t("workspace.management.network.wifi.device")}</span>
                <select value={selectedDevice?.id ?? ""} onChange={(event) => setSelectedDeviceId(event.target.value)}>
                  {wifi.devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
                </select>
              </label>
            ) : null}
            <button
              type="button"
              className="management-icon-action"
              onClick={toggleRadio}
              disabled={unavailable || !wifi.hostdReady || !canManageWifi || busy}
              aria-pressed={wifi.radioEnabled === true}
              aria-label={wifi.radioEnabled ? t("workspace.management.network.wifi.disableRadio") : t("workspace.management.network.wifi.enableRadio")}
              title={wifi.radioEnabled ? t("workspace.management.network.wifi.disableRadio") : t("workspace.management.network.wifi.enableRadio")}
            >
              {wifi.radioEnabled ? <Wifi aria-hidden="true" size={15} /> : <WifiOff aria-hidden="true" size={15} />}
            </button>
            <button type="button" onClick={() => void refreshScan()} disabled={wifi.radioEnabled !== true || !canManageWifi || !selectedDevice || scanning || busy} aria-busy={scanning || undefined}>
              {scanning ? <LoaderCircle aria-hidden="true" size={14} /> : <RefreshCw aria-hidden="true" size={14} />}
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
                  {selectedDevice.activeConnectionId && selectedDevice.mode === "client" ? (
                    <button type="button" className="is-danger" onClick={requestDisconnect} disabled={!canManageWifi || busy}>
                      <WifiOff aria-hidden="true" size={14} />
                      <span>{t("workspace.management.network.wifi.disconnect")}</span>
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="system-wifi-grid">
                <section className="system-wifi-list-panel">
                  <div className="system-wifi-subheader">
                    <div>
                      <h4>{t("workspace.management.network.wifi.availableTitle")}</h4>
                      <p>{scan ? t("workspace.management.network.wifi.scanTime", { time: new Date(scan.scannedAt).toLocaleTimeString() }) : t("workspace.management.network.wifi.scanPrompt")}</p>
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
                            disabled={!canManageWifi || busy || network.security === "unsupported" || network.strongest.active}
                          >
                            {network.strongest.active ? <Check aria-hidden="true" size={14} /> : <KeyRound aria-hidden="true" size={14} />}
                            <span>{network.strongest.active ? t("workspace.management.network.wifi.current") : t("workspace.management.network.wifi.connect")}</span>
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="management-empty">{scanning ? t("workspace.management.network.wifi.scanning") : t("workspace.management.network.wifi.noScan")}</p>
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
                              <button type="button" className="management-icon-action" onClick={() => connectSaved(profileNetwork(profile))} disabled={!canManageWifi || busy} aria-label={t("workspace.management.network.wifi.connect")} title={t("workspace.management.network.wifi.connect")}>
                                <Wifi aria-hidden="true" size={14} />
                              </button>
                            ) : null}
                            <button type="button" className="management-icon-action" onClick={() => editProfile(profile)} disabled={!canManageWifi || !profile.managed || busy} aria-label={t("common.actions.edit")} title={profile.managed ? t("common.actions.edit") : t("workspace.management.network.wifi.externalReadOnly")}>
                              <Pencil aria-hidden="true" size={14} />
                            </button>
                            <button type="button" className="management-icon-action is-danger" onClick={() => forgetProfile(profile)} disabled={!canManageWifi || !profile.managed || busy} aria-label={t("workspace.management.network.wifi.forget")} title={profile.managed ? t("workspace.management.network.wifi.forget") : t("workspace.management.network.wifi.externalReadOnly")}>
                              <Trash2 aria-hidden="true" size={14} />
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : <p className="management-empty">{t("workspace.management.network.wifi.noProfiles")}</p>}
                </section>
              </div>

              {hotspot ? (
                <div className="system-wifi-hotspot-bar" data-active={hotspot.active || undefined}>
                  <Router aria-hidden="true" size={17} />
                  <div>
                    <strong>{hotspot.ssid}</strong>
                    <small>{hotspot.band === "auto" ? t("workspace.management.network.wifi.hotspot.autoBand") : `${hotspot.band} GHz`} · {hotspot.autostart ? t("workspace.management.network.wifi.hotspot.autostartOn") : t("workspace.management.network.wifi.hotspot.autostartOff")}</small>
                  </div>
                  <span className="management-status-pill" data-state={hotspot.active ? "ready" : "neutral"}>
                    {hotspot.active ? t("workspace.management.network.wifi.hotspot.running") : t("workspace.management.network.wifi.hotspot.stopped")}
                  </span>
                  <button type="button" onClick={() => hotspotAction(hotspot.active ? "stop" : "start")} disabled={!canManageHotspot || busy}>
                    {hotspot.active ? <WifiOff aria-hidden="true" size={14} /> : <Radio aria-hidden="true" size={14} />}
                    <span>{hotspot.active ? t("workspace.management.network.wifi.hotspot.stop") : t("workspace.management.network.wifi.hotspot.start")}</span>
                  </button>
                  <button type="button" className="management-icon-action" onClick={openHotspot} disabled={!canManageHotspot || busy} aria-label={t("common.actions.edit")} title={t("common.actions.edit")}>
                    <Settings aria-hidden="true" size={14} />
                  </button>
                  <button type="button" className="management-icon-action is-danger" onClick={() => hotspotAction("delete")} disabled={!canManageHotspot || busy} aria-label={t("common.actions.delete")} title={t("common.actions.delete")}>
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <p className="management-empty">{t("workspace.management.network.wifi.noDevices")}</p>
          )}
        </div>
      </section>

      {connectDialog && selectedDevice ? (
        <WifiFormDialog title={connectDialog.network.ssid} eyebrow={translate("workspace.management.network.wifi.connectEyebrow")} busy={busy} onClose={() => setConnectDialog(null)} onSubmit={submitConnect}>
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
        <WifiFormDialog title={profileDialog.profile.ssid} eyebrow={translate("workspace.management.network.wifi.profileEyebrow")} busy={busy} onClose={() => setProfileDialog(null)} onSubmit={submitProfile}>
          {profileDialog.confirmRestart ? (
            <RiskConfirmation title={translate("workspace.management.network.wifi.confirm.profileRestartTitle")} description={translate("workspace.management.network.wifi.confirm.profileRestartDescription")} />
          ) : (
            <>
              <label><span>{t("workspace.management.network.wifi.ssid")}</span><input autoFocus value={profileDialog.ssid} onChange={(event) => setProfileDialog({ ...profileDialog, ssid: event.target.value })} disabled={busy} /></label>
              <label><span>{t("workspace.management.network.wifi.securityLabel")}</span><select value={profileDialog.security} onChange={(event) => setProfileDialog({ ...profileDialog, security: event.target.value as ProfileDialogState["security"] })} disabled={busy}><option value="open">{t("workspace.management.network.wifi.security.open")}</option><option value="wpa2">{t("workspace.management.network.wifi.security.wpa2")}</option><option value="wpa3">{t("workspace.management.network.wifi.security.wpa3")}</option></select></label>
              {profileDialog.security !== "open" ? <label><span>{t("workspace.management.network.wifi.passwordOptional")}</span><input type="password" value={profileDialog.password} onChange={(event) => setProfileDialog({ ...profileDialog, password: event.target.value })} disabled={busy} autoComplete="new-password" placeholder={t("workspace.management.network.wifi.keepPassword")} /></label> : null}
              <Switch className="system-wifi-checkbox" checked={profileDialog.autoconnect} onCheckedChange={(autoconnect) => setProfileDialog({ ...profileDialog, autoconnect })} disabled={busy} label={t("workspace.management.network.wifi.autoconnectLabel")} />
            </>
          )}
          <DialogActions onCancel={() => profileDialog.confirmRestart ? setProfileDialog({ ...profileDialog, confirmRestart: false }) : setProfileDialog(null)} busy={busy} submitLabel={translate(profileDialog.confirmRestart ? "workspace.management.network.wifi.confirm.continue" : "common.actions.save")} submitDisabled={!validSystemWifiSsid(profileDialog.ssid) || Boolean(profileDialog.password && !validSystemWifiPassword(profileDialog.password))} danger={profileDialog.confirmRestart} />
        </WifiFormDialog>
      ) : null}

      {hotspotDialog && selectedDevice ? (
        <WifiFormDialog title={translate("workspace.management.network.wifi.hotspot.title")} eyebrow={translate("workspace.management.network.wifi.hotspot.eyebrow")} busy={busy} onClose={() => setHotspotDialog(null)} onSubmit={submitHotspot}>
          {hotspotDialog.confirmRestart ? (
            <RiskConfirmation title={translate("workspace.management.network.wifi.confirm.hotspotRestartTitle")} description={translate("workspace.management.network.wifi.confirm.hotspotRestartDescription")} />
          ) : (
            <HotspotFields state={hotspotDialog} device={selectedDevice} busy={busy} t={translate} onChange={setHotspotDialog} />
          )}
          <DialogActions onCancel={() => hotspotDialog.confirmRestart ? setHotspotDialog({ ...hotspotDialog, confirmRestart: false }) : setHotspotDialog(null)} busy={busy} submitLabel={translate(hotspotDialog.confirmRestart ? "workspace.management.network.wifi.confirm.continue" : "common.actions.save")} submitDisabled={!validSystemWifiSsid(hotspotDialog.ssid) || (!hotspotDialog.existing && !validSystemWifiPassword(hotspotDialog.password)) || Boolean(hotspotDialog.password && !validSystemWifiPassword(hotspotDialog.password))} danger={hotspotDialog.confirmRestart} />
        </WifiFormDialog>
      ) : null}

      {confirmation ? (
        <WifiConfirmationDialog
          confirmation={confirmation}
          busy={busy}
          onClose={() => setConfirmation(null)}
          t={translate}
        />
      ) : null}
    </>
  );
}

function WifiFormDialog({ title, eyebrow, busy, onClose, onSubmit, children }: { title: string; eyebrow: string; busy: boolean; onClose: () => void; onSubmit: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => focusDialog(dialogRef.current));
    return () => {
      window.cancelAnimationFrame(frame);
      const target = previousFocus.current;
      if (target?.isConnected) window.requestAnimationFrame(() => target.focus());
    };
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
      return;
    }
    trapDialogFocus(event, dialogRef.current);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <div className="management-modal-backdrop system-wifi-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="management-modal system-wifi-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeyDown}>
        <header><div><span className="eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2></div><button type="button" className="management-icon-action" onClick={onClose} disabled={busy} aria-label={t("common.actions.close")}><X aria-hidden="true" size={17} /></button></header>
        <form onSubmit={submit}>{children}</form>
      </section>
    </div>
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

function WifiConfirmationDialog({ confirmation, busy, onClose, t }: { confirmation: Confirmation; busy: boolean; onClose: () => void; t: Translate }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    closeButton.current?.focus();
    return () => {
      const target = previousFocus.current;
      if (target?.isConnected) window.requestAnimationFrame(() => target.focus());
    };
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
      return;
    }
    trapDialogFocus(event, dialogRef.current);
  }

  return (
    <div className="management-modal-backdrop system-wifi-modal-backdrop">
      <section ref={dialogRef} className="management-modal system-wifi-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeyDown}>
        <header><div><span className="eyebrow">{t("workspace.management.network.wifi.confirm.eyebrow")}</span><h2 id={titleId}>{confirmation.title}</h2></div><button ref={closeButton} type="button" className="management-icon-action" onClick={onClose} disabled={busy} aria-label={t("common.actions.close")}><X aria-hidden="true" size={17} /></button></header>
        <div className="system-wifi-confirm-body"><AlertTriangle aria-hidden="true" size={24} /><p>{confirmation.description}</p></div>
        <footer><button type="button" onClick={onClose} disabled={busy}>{t("common.actions.cancel")}</button><button type="button" className={confirmation.danger ? "is-danger" : "is-primary"} disabled={busy} aria-busy={busy || undefined} onClick={() => void confirmation.run().then(onClose).catch(() => undefined)}>{busy ? <LoaderCircle aria-hidden="true" size={14} /> : <Check aria-hidden="true" size={14} />}<span>{t("workspace.management.network.wifi.confirm.continue")}</span></button></footer>
      </section>
    </div>
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
  return (
    <>
      <label><span>{t("workspace.management.network.wifi.ssid")}</span><input autoFocus value={state.ssid} onChange={(event) => onChange({ ...state, ssid: event.target.value })} disabled={busy} /></label>
      <label><span>{state.existing ? t("workspace.management.network.wifi.passwordOptional") : t("workspace.management.network.wifi.password")}</span><input type="password" value={state.password} onChange={(event) => onChange({ ...state, password: event.target.value })} disabled={busy} autoComplete="new-password" placeholder={state.existing ? t("workspace.management.network.wifi.keepPassword") : undefined} /></label>
      <div className="system-wifi-form-grid">
        <label><span>{t("workspace.management.network.wifi.hotspot.band")}</span><select value={state.band} onChange={(event) => onChange({ ...state, band: event.target.value as HotspotDialogState["band"], channel: "" })} disabled={busy}><option value="auto">{t("workspace.management.network.wifi.hotspot.autoBand")}</option>{device.capabilities.bands.includes("2.4") ? <option value="2.4">2.4 GHz</option> : null}{device.capabilities.bands.includes("5") ? <option value="5">5 GHz</option> : null}</select></label>
        <label><span>{t("workspace.management.network.wifi.channel")}</span><select value={state.channel} onChange={(event) => onChange({ ...state, channel: event.target.value })} disabled={busy || state.band === "auto"}><option value="">{t("workspace.management.network.wifi.hotspot.autoChannel")}</option>{channels.map((channel) => <option key={channel} value={channel}>{channel}</option>)}</select></label>
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
