import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bluetooth, Check, FileUp, FolderOpen, Headphones, Inbox, Laptop, LoaderCircle,
  RefreshCw, Send, Shield, ShieldOff, Smartphone, Speaker, Unplug, Volume2, X
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  cancelBluetoothTransfer, connectBluetoothDevice, createBluetoothTransfers,
  disconnectBluetoothDevice, getBluetoothSettings, pairBluetoothDevice,
  respondBluetoothPairing, saveBluetoothSettings, setBluetoothAdapterPower,
  setBluetoothDeviceTrust, setDefaultBluetoothAdapter, startBluetoothScan,
  stopBluetoothScan, unpairBluetoothDevice, type BluetoothAudioDevice,
  type BluetoothInboxStatus, type BluetoothSettings, type BluetoothStatus, type BluetoothTransfer
} from "../../api.js";
import { formatBytes } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { useBluetoothTransfers } from "../../lib/use-bluetooth-transfers.js";
import { useSystemBluetoothStatus } from "../../lib/use-system-bluetooth-status.js";
import {
  StorageFilePickerDialog, type StorageFilePickerPool, type StorageFileSelection
} from "../workspace/StorageFilePickerDialog.js";

export function SettingsBluetoothPage({
  status, pools, locale, onStatus, onNotifySuccess, onNotifyError
}: {
  status: BluetoothStatus | null;
  pools: StorageFilePickerPool[];
  locale: SupportedLocale;
  onStatus: (status: BluetoothStatus) => void;
  onNotifySuccess: (message: string) => void;
  onNotifyError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [selectedAdapterId, setSelectedAdapterId] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [settings, setSettings] = useState<BluetoothSettings | null>(null);
  const [inboxStatus, setInboxStatus] = useState<BluetoothInboxStatus>({ status: "disabled", reason: null });
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [picker, setPicker] = useState<"inbox" | "files" | null>(null);
  const [sendTarget, setSendTarget] = useState<{ adapterId: string; address: string } | null>(null);
  const challengeRef = useRef<HTMLElement | null>(null);
  const reconnecting = useSystemBluetoothStatus(onStatus);
  const transfers = useBluetoothTransfers(true);
  const adapter = status?.adapters.find((candidate) => candidate.id === selectedAdapterId)
    ?? status?.adapters.find((candidate) => candidate.defaultAdapter)
    ?? status?.adapters[0]
    ?? null;
  const selectedAdapterScanning = Boolean(adapter && status?.scan.active && status.scan.adapterId === adapter.id);
  const anotherAdapterScanning = Boolean(adapter && status?.scan.active && status.scan.adapterId !== adapter.id);
  const displayOnlyChallenge = status?.challenge?.kind === "pin_display" || status?.challenge?.kind === "passkey_display";
  const devices = useMemo(() => status?.devices.filter((device) => device.adapterId === adapter?.id)
    .sort((left, right) => Number(right.connected) - Number(left.connected) || Number(right.paired) - Number(left.paired) || (right.rssi ?? -128) - (left.rssi ?? -128)) ?? [], [adapter?.id, status?.devices]);
  const audioDevices = useMemo<BluetoothAudioDevice[]>(() => {
    const candidates = status?.devices
      .filter((device) => device.paired && (device.type === "headset" || device.type === "speaker")) ?? [];
    return candidates
      .filter((device) => {
        const sameAddress = candidates.filter((candidate) => candidate.address.toUpperCase() === device.address.toUpperCase());
        if (sameAddress.length === 1) return true;
        return device.connected && sameAddress.filter((candidate) => candidate.connected).length === 1;
      })
      .map((device) => ({
        id: `bluetooth:${device.adapterId}/${device.address}`,
        adapterId: device.adapterId,
        address: device.address,
        name: device.alias ?? device.name ?? device.address,
        connected: device.connected
      }));
  }, [status?.devices]);

  useEffect(() => {
    if (!selectedAdapterId && adapter) setSelectedAdapterId(adapter.id);
  }, [adapter, selectedAdapterId]);

  useEffect(() => {
    let active = true;
    getBluetoothSettings()
      .then((result) => {
        if (!active) return;
        setSettings(result.settings);
        setInboxStatus(result.inboxStatus);
      })
      .catch((error) => {
        if (active) onNotifyError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setSettingsLoading(false);
      });
    return () => { active = false; };
  }, [onNotifyError]);

  useEffect(() => {
    setPin("");
    if (status?.challenge) challengeRef.current?.focus();
  }, [status?.challenge?.id]);

  async function runDevice(key: string, action: () => Promise<{ status: BluetoothStatus }>, notify = true) {
    if (busyKey) return;
    setBusyKey(key);
    try {
      const result = await action();
      onStatus(result.status);
      if (notify) onNotifySuccess(String(t("settings.bluetooth.operationSucceeded")));
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(t("settings.bluetooth.operationFailed")));
    } finally {
      setBusyKey(null);
    }
  }

  async function updateSettings(patch: Partial<Omit<BluetoothSettings, "updatedAt">>, key: string) {
    if (busyKey) return;
    setBusyKey(key);
    try {
      const next = await saveBluetoothSettings(patch);
      setSettings(next.settings);
      setInboxStatus(next.inboxStatus);
      onNotifySuccess(String(t("settings.bluetooth.settingsSaved")));
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(t("settings.bluetooth.operationFailed")));
    } finally {
      setBusyKey(null);
    }
  }

  async function chooseInbox(selection: StorageFileSelection) {
    setPicker(null);
    await updateSettings({
      receiveEnabled: false,
      inboxRootId: selection.rootId,
      inboxStoragePoolId: selection.storagePoolId,
      inboxPath: selection.path
    }, "inbox");
  }

  async function queueFiles(selections: StorageFileSelection[]) {
    setPicker(null);
    if (!sendTarget || selections.length === 0) return;
    const scope = selections[0]!;
    if (selections.some((selection) => selection.rootId !== scope.rootId || selection.storagePoolId !== scope.storagePoolId)) {
      onNotifyError(String(t("settings.bluetooth.transfers.singlePoolRequired")));
      return;
    }
    setBusyKey("send");
    try {
      await createBluetoothTransfers({
        adapterId: sendTarget.adapterId,
        address: sendTarget.address,
        rootId: scope.rootId,
        storagePoolId: scope.storagePoolId,
        paths: selections.map((selection) => selection.path)
      });
      await transfers.refresh();
      onNotifySuccess(String(t("settings.bluetooth.transfers.queued", { count: selections.length })));
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(t("settings.bluetooth.operationFailed")));
    } finally {
      setBusyKey(null);
      setSendTarget(null);
    }
  }

  async function cancelTransfer(transfer: BluetoothTransfer) {
    setBusyKey(`cancel-${transfer.id}`);
    try {
      await cancelBluetoothTransfer(transfer.id);
      await transfers.refresh();
    } catch (error) {
      onNotifyError(error instanceof Error ? error.message : String(t("settings.bluetooth.operationFailed")));
    } finally {
      setBusyKey(null);
    }
  }

  const unavailableReason = status?.error === "BlueZ and the host integration service are unavailable"
    ? String(t("settings.bluetooth.unavailable"))
    : status?.error
    ?? (!status?.available ? String(t("settings.bluetooth.noAdapters")) : null);
  const inboxConfigured = Boolean(settings?.inboxRootId && settings.inboxStoragePoolId && settings.inboxPath);
  const initialInboxPool = settings?.inboxStoragePoolId ?? pools[0]?.id ?? "";

  return (
    <div className="settings-content-body settings-device-page">
      {status?.challenge ? <section ref={challengeRef} className="settings-section-card bluetooth-challenge" role={displayOnlyChallenge ? "status" : "alertdialog"} aria-labelledby="bluetooth-challenge-title" aria-describedby="bluetooth-challenge-description" tabIndex={-1}><header><div><h3 id="bluetooth-challenge-title">{displayOnlyChallenge ? t("settings.bluetooth.displayChallengeTitle") : t("settings.bluetooth.challengeTitle")}</h3><p id="bluetooth-challenge-description">{t(`settings.bluetooth.challengeKinds.${status.challenge.kind}`)}</p></div></header>{status.challenge.pin !== null ? <strong className="bluetooth-passkey">{status.challenge.pin}</strong> : null}{status.challenge.passkey !== null ? <strong className="bluetooth-passkey">{String(status.challenge.passkey).padStart(6, "0")}</strong> : null}{status.challenge.kind === "passkey_display" && status.challenge.entered !== null ? <small>{t("settings.bluetooth.passkeyEntered", { entered: status.challenge.entered, total: 6 })}</small> : null}{status.challenge.kind === "pin" ? <label><span>{t("settings.bluetooth.pin")}</span><input value={pin} onChange={(event) => setPin(event.target.value)} inputMode="numeric" autoComplete="one-time-code" /></label> : null}{!displayOnlyChallenge ? <div className="settings-inline-actions"><button type="button" onClick={() => void runDevice("challenge-reject", () => respondBluetoothPairing({ adapterId: status.challenge!.adapterId, address: status.challenge!.deviceAddress, challengeId: status.challenge!.id, accept: false }))}>{t("common.actions.cancel")}</button><button type="button" className="primary-button" disabled={status.challenge.kind === "pin" && !pin.trim()} onClick={() => void runDevice("challenge-accept", () => respondBluetoothPairing({ adapterId: status.challenge!.adapterId, address: status.challenge!.deviceAddress, challengeId: status.challenge!.id, accept: true, ...(pin ? { pin } : {}) }))}>{t("settings.bluetooth.confirm")}</button></div> : null}</section> : null}

      <section className="settings-section-card bluetooth-settings-card">
        <header>
          <div><h3>{t("settings.bluetooth.adaptersTitle")}</h3><p>{reconnecting ? t("settings.bluetooth.reconnecting") : t("settings.bluetooth.adaptersDescription")}</p></div>
          {adapter ? <button type="button" className="settings-device-toggle" aria-pressed={adapter.powered} disabled={busyKey !== null} onClick={() => void runDevice("power", () => setBluetoothAdapterPower({ adapterId: adapter.id, powered: !adapter.powered }))}><Bluetooth aria-hidden="true" size={15} /><span>{adapter.powered ? t("settings.bluetooth.turnOff") : t("settings.bluetooth.turnOn")}</span></button> : null}
        </header>
        {unavailableReason ? <div className="settings-device-unavailable" role="status"><Bluetooth aria-hidden="true" size={20} /><p>{unavailableReason}</p></div> : null}
        {status?.adapters.length ? <div className="bluetooth-adapter-list">{status.adapters.map((candidate) => <button type="button" key={candidate.id} className={candidate.id === adapter?.id ? "is-active" : ""} onClick={() => {
          setSelectedAdapterId(candidate.id);
          if (!candidate.defaultAdapter) void runDevice("default", () => setDefaultBluetoothAdapter({ adapterId: candidate.id }));
        }}><Bluetooth aria-hidden="true" size={17} /><span><strong>{candidate.alias}</strong><small>{candidate.address}</small></span>{candidate.defaultAdapter ? <Check aria-label={String(t("settings.bluetooth.defaultAdapter"))} size={15} /> : null}</button>)}</div> : null}
      </section>

      {adapter ? <section className="settings-section-card bluetooth-devices-card">
        <header><div><h3>{t("settings.bluetooth.devicesTitle")}</h3><p>{t("settings.bluetooth.devicesDescription")}</p></div><button type="button" disabled={!adapter.powered || busyKey !== null || anotherAdapterScanning} onClick={() => void runDevice(selectedAdapterScanning ? "scan-stop" : "scan", () => selectedAdapterScanning ? stopBluetoothScan({ adapterId: adapter.id }) : startBluetoothScan({ adapterId: adapter.id }), false)}>{busyKey?.startsWith("scan") ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : selectedAdapterScanning ? <X aria-hidden="true" size={15} /> : <RefreshCw aria-hidden="true" size={15} />}<span>{selectedAdapterScanning ? t("settings.bluetooth.stopScan") : t("settings.bluetooth.scan")}</span></button></header>
        {anotherAdapterScanning ? <p className="settings-device-disabled">{t("settings.bluetooth.otherAdapterScanning", { adapter: status?.scan.adapterId ?? "" })}</p> : null}
        {!adapter.powered ? <p className="settings-device-disabled">{t("settings.bluetooth.adapterOffReason")}</p> : devices.length ? <div className="bluetooth-device-list">{devices.map((device) => <article key={`${device.adapterId}:${device.address}`} className="bluetooth-device-row">
          <div className="bluetooth-device-icon">{deviceIcon(device.type)}</div>
          <div className="bluetooth-device-copy"><strong>{device.alias ?? device.name ?? device.address}</strong><small>{device.address}{device.rssi === null ? "" : ` · ${device.rssi} dBm`}</small><div className="bluetooth-device-badges">{device.paired ? <span>{t("settings.bluetooth.paired")}</span> : null}{device.trusted ? <span>{t("settings.bluetooth.trusted")}</span> : null}{device.connected ? <span className="is-ready">{t("settings.bluetooth.connected")}</span> : null}</div></div>
          <div className="bluetooth-device-actions">{!device.paired ? <button type="button" disabled={busyKey !== null} onClick={() => void runDevice(device.address, () => pairBluetoothDevice({ adapterId: adapter.id, address: device.address }))}>{t("settings.bluetooth.pair")}</button> : <>
            <button type="button" className="management-icon-action" title={String(device.trusted ? t("settings.bluetooth.untrust") : t("settings.bluetooth.trust"))} aria-label={String(device.trusted ? t("settings.bluetooth.untrust") : t("settings.bluetooth.trust"))} disabled={busyKey !== null} onClick={() => void runDevice(`trust-${device.address}`, () => setBluetoothDeviceTrust({ adapterId: adapter.id, address: device.address, trusted: !device.trusted }))}>{device.trusted ? <ShieldOff size={15} /> : <Shield size={15} />}</button>
            <button type="button" disabled={busyKey !== null} onClick={() => void runDevice(`connect-${device.address}`, () => device.connected ? disconnectBluetoothDevice({ adapterId: adapter.id, address: device.address }) : connectBluetoothDevice({ adapterId: adapter.id, address: device.address }))}>{device.connected ? t("settings.bluetooth.disconnect") : t("settings.bluetooth.connect")}</button>
            <button type="button" className="management-icon-action" title={String(t("settings.bluetooth.transfers.sendFiles"))} aria-label={String(t("settings.bluetooth.transfers.sendFiles"))} disabled={busyKey !== null} onClick={() => { setSendTarget({ adapterId: adapter.id, address: device.address }); setPicker("files"); }}><Send size={15} /></button>
            <button type="button" className="management-icon-action is-danger" title={String(t("settings.bluetooth.forget"))} aria-label={String(t("settings.bluetooth.forget"))} disabled={busyKey !== null} onClick={() => void runDevice(`forget-${device.address}`, () => unpairBluetoothDevice({ adapterId: adapter.id, address: device.address }))}><Unplug size={15} /></button>
          </>}</div>
        </article>)}</div> : <p className="management-empty">{selectedAdapterScanning ? t("settings.bluetooth.scanning") : t("settings.bluetooth.noDevices")}</p>}
      </section> : null}

      <section className="settings-section-card bluetooth-output-card">
        <header><div><h3>{t("settings.bluetooth.audio.title")}</h3><p>{t("settings.bluetooth.audio.description")}</p></div><Volume2 aria-hidden="true" size={19} /></header>
        {settingsLoading ? <p className="management-empty">{t("common.states.loading")}</p> : <BluetoothAudioOutputField audioDevices={audioDevices} defaultAudioDeviceId={settings?.defaultAudioDeviceId ?? null} disabled={busyKey !== null} onChange={(defaultAudioDeviceId) => void updateSettings({ defaultAudioDeviceId }, "audio")} />}
      </section>

      <section className="settings-section-card bluetooth-inbox-card">
        <header><div><h3>{t("settings.bluetooth.inbox.title")}</h3><p>{t("settings.bluetooth.inbox.description")}</p></div><Inbox aria-hidden="true" size={19} /></header>
        <div className="bluetooth-inbox-controls"><button type="button" disabled={busyKey !== null || pools.length === 0} onClick={() => setPicker("inbox")}><FolderOpen aria-hidden="true" size={15} /><span>{inboxConfigured ? settings?.inboxPath : t("settings.bluetooth.inbox.choose")}</span></button><label className="bluetooth-switch-row"><input type="checkbox" checked={settings?.receiveEnabled ?? false} disabled={busyKey !== null || !inboxConfigured} onChange={(event) => void updateSettings({ receiveEnabled: event.target.checked }, "receive")} /><span><strong>{t("settings.bluetooth.inbox.receive")}</strong><small>{t("settings.bluetooth.inbox.trustedOnly")}</small></span></label></div>
        {!inboxConfigured ? <p className="settings-device-disabled">{t("settings.bluetooth.inbox.required")}</p> : null}
        {settings?.receiveEnabled && inboxStatus.status === "paused" && inboxStatus.reason ? <div className="settings-device-unavailable" role="status"><Inbox aria-hidden="true" size={18} /><p>{t(`settings.bluetooth.inbox.pauseReasons.${inboxStatus.reason}`)}</p></div> : null}
      </section>

      <section className="settings-section-card bluetooth-transfers-card">
        <header><div><h3>{t("settings.bluetooth.transfers.title")}</h3><p>{t("settings.bluetooth.transfers.description")}</p></div><button type="button" disabled={transfers.loading} onClick={() => void transfers.refresh()} title={String(t("common.actions.refresh"))} aria-label={String(t("common.actions.refresh"))}><RefreshCw aria-hidden="true" size={15} /></button></header>
        {transfers.health.status !== "ready" ? <div className="settings-device-unavailable"><FileUp aria-hidden="true" size={18} /><p>{transfers.health.error ?? t(`settings.bluetooth.transfers.health.${transfers.health.status}`)}</p></div> : null}
        {transfers.transfers.length === 0 ? <p className="management-empty">{transfers.loading ? t("common.states.loading") : t("settings.bluetooth.transfers.empty")}</p> : <div className="bluetooth-transfer-list">{transfers.transfers.map((transfer) => {
          const progress = transfer.totalBytes && transfer.totalBytes > 0 ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100)) : null;
          const cancellable = transfer.status === "queued" || transfer.status === "running" || transfer.status === "paused";
          return <article key={transfer.id} className="bluetooth-transfer-row" data-status={transfer.status}><span className="bluetooth-transfer-icon">{transfer.direction === "send" ? <Send size={16} /> : <Inbox size={16} />}</span><span className="bluetooth-transfer-copy"><strong>{transfer.displayName}</strong><small>{t(`settings.bluetooth.transfers.directions.${transfer.direction}`)} · {t(`settings.bluetooth.transfers.statuses.${transfer.status}`)} · {transfer.deviceAddress}</small>{progress !== null ? <span className="bluetooth-transfer-progress"><span style={{ width: `${progress}%` }} /></span> : null}<small>{formatBytes(transfer.transferredBytes, locale)}{transfer.totalBytes === null ? "" : ` / ${formatBytes(transfer.totalBytes, locale)}`}</small>{transfer.error ? <span className="bluetooth-transfer-error">{transfer.error}</span> : null}</span>{cancellable ? <button type="button" className="management-icon-action is-danger" disabled={busyKey !== null} onClick={() => void cancelTransfer(transfer)} title={String(t("common.actions.cancel"))} aria-label={String(t("common.actions.cancel"))}><X size={15} /></button> : null}</article>;
        })}</div>}
      </section>

      {picker === "inbox" ? <StorageFilePickerDialog pools={pools} initialPoolId={initialInboxPool} locale={locale} mode="directory" directoryPurpose="bluetoothInbox" {...(settings?.inboxPath ? { initialPath: settings.inboxPath } : {})} onCancel={() => setPicker(null)} onSelect={(selection) => void chooseInbox(selection)} /> : null}
      {picker === "files" ? <StorageFilePickerDialog pools={pools} initialPoolId={pools[0]?.id ?? ""} locale={locale} mode="files" onCancel={() => { setPicker(null); setSendTarget(null); }} onSelect={() => undefined} onSelectMany={(selections) => void queueFiles(selections)} /> : null}
    </div>
  );
}

export function BluetoothAudioOutputField({
  audioDevices, defaultAudioDeviceId, disabled, onChange
}: {
  audioDevices: BluetoothAudioDevice[];
  defaultAudioDeviceId: string | null;
  disabled: boolean;
  onChange: (deviceId: string | null) => void;
}) {
  const { t } = useTranslation();
  const configuredDeviceUnavailable = defaultAudioDeviceId !== null
    && !audioDevices.some((device) => device.id === defaultAudioDeviceId);
  return <label className="bluetooth-field-row"><span>{t("settings.bluetooth.audio.output")}</span><select value={defaultAudioDeviceId ?? ""} disabled={disabled} onChange={(event) => onChange(event.target.value || null)}><option value="">{t("settings.bluetooth.audio.systemDefault")}</option>{configuredDeviceUnavailable ? <option value={defaultAudioDeviceId ?? ""} disabled>{t("settings.bluetooth.audio.configuredUnavailable")}</option> : null}{audioDevices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.connected ? "" : ` (${t("settings.bluetooth.audio.disconnected")})`}</option>)}</select><small>{t("settings.bluetooth.audio.nextPlayback")}</small></label>;
}

function deviceIcon(type: BluetoothStatus["devices"][number]["type"]) {
  if (type === "phone") return <Smartphone aria-hidden="true" size={19} />;
  if (type === "computer") return <Laptop aria-hidden="true" size={19} />;
  if (type === "speaker") return <Speaker aria-hidden="true" size={19} />;
  if (type === "headset") return <Headphones aria-hidden="true" size={19} />;
  return <Bluetooth aria-hidden="true" size={19} />;
}
