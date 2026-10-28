import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from "react";
import { useTranslation } from "react-i18next";
import type { SystemEthernetConfig } from "@cyberos/shared";
import {
  AlertTriangle,
  Cable,
  Check,
  LoaderCircle,
  RotateCcw,
  Save,
  Settings2,
  X
} from "lucide-react";
import {
  applySystemEthernet,
  confirmSystemEthernet,
  rollbackSystemEthernet,
  saveSystemEthernet,
  type EthernetApplyTransaction,
  type EthernetStatus
} from "../../api.js";
import { formatLocaleNumber } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import {
  ethernetTransactionSeconds,
  hasSystemEthernetMetricConflict,
  parseSystemEthernetStatus,
  systemEthernetDeviceTone,
  validateSystemEthernetConfig
} from "../../lib/system-ethernet.js";

type EthernetDevice = EthernetStatus["devices"][number];
type Translate = (key: string, options?: Record<string, unknown>) => string;

interface Props {
  ethernet: EthernetStatus;
  canManageEthernet: boolean;
  locale: SupportedLocale;
  onStatus: (status: EthernetStatus) => void;
  onRefresh: () => Promise<void>;
  onNotifySuccess: (message: string) => void;
  onNotifyError: (message: string) => void;
}

interface EditorState {
  device: EthernetDevice;
  config: SystemEthernetConfig;
}

export function SystemEthernetManagement({
  ethernet,
  canManageEthernet,
  locale,
  onStatus,
  onRefresh,
  onNotifySuccess,
  onNotifyError
}: Props) {
  const { t } = useTranslation();
  const translate = t as Translate;
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<EthernetApplyTransaction | null>(ethernet.transaction);
  const [seconds, setSeconds] = useState(() => ethernetTransactionSeconds(ethernet.transaction?.deadlineAt ?? null));
  const pending = ethernet.devices.filter((device) => device.needsApply);

  useEffect(() => {
    if (ethernet.transaction) setTransaction(ethernet.transaction);
  }, [ethernet.transaction]);

  useEffect(() => {
    if (transaction?.status !== "awaiting_confirmation") {
      setSeconds(0);
      return;
    }
    const update = () => setSeconds(ethernetTransactionSeconds(transaction.deadlineAt));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [transaction]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/system/network/ethernet/events");
    source.onopen = () => setReconnecting(false);
    source.onerror = () => setReconnecting(true);
    source.addEventListener("system.ethernet.status", (event) => {
      const status = parseSystemEthernetStatus((event as MessageEvent<string>).data);
      if (status) {
        setReconnecting(false);
        if (status.transaction) setTransaction(status.transaction);
        onStatus(status);
      }
    });
    return () => source.close();
  }, [onStatus]);

  const metricConflict = useMemo(
    () => hasSystemEthernetMetricConflict(ethernet.devices.map((device) => device.desiredConfig)),
    [ethernet.devices]
  );

  function reportError(value: unknown) {
    const message = value instanceof Error ? value.message : translate("workspace.management.network.ethernet.errors.operation");
    setError(message);
    onNotifyError(message);
  }

  async function saveEditor() {
    if (!editor || busy || reconnecting || validateSystemEthernetConfig(editor.config).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const status = await saveSystemEthernet(editor.device.id, {
        config: editor.config,
        expectedRevision: editor.device.revision
      });
      onStatus(status);
      setEditor(null);
      onNotifySuccess(translate("workspace.management.network.ethernet.messages.saved"));
    } catch (nextError) {
      reportError(nextError);
    } finally {
      setBusy(false);
    }
  }

  async function beginApply() {
    if (busy || reconnecting || pending.length === 0 || metricConflict) return;
    setBusy(true);
    setError(null);
    try {
      const next = await applySystemEthernet(true);
      setTransaction(next);
      setConfirmApply(false);
      onNotifySuccess(translate("workspace.management.network.ethernet.messages.applying"));
    } catch (nextError) {
      reportError(nextError);
    } finally {
      setBusy(false);
    }
  }

  async function settle(action: "confirm" | "rollback") {
    if (!transaction || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = action === "confirm"
        ? await confirmSystemEthernet(transaction.id)
        : await rollbackSystemEthernet(transaction.id);
      setTransaction(next);
      await onRefresh();
      onNotifySuccess(translate(`workspace.management.network.ethernet.messages.${action === "confirm" ? "confirmed" : "rolledBack"}`));
    } catch (nextError) {
      reportError(nextError);
    } finally {
      setBusy(false);
    }
  }

  const applying = transaction?.status === "awaiting_confirmation";

  return (
    <>
      <section className="management-section system-ethernet-section">
        <header className="management-section-header system-ethernet-header">
          <div>
            <h3>{t("workspace.management.network.ethernet.title")}</h3>
            <p>{t("workspace.management.network.ethernet.description")}</p>
          </div>
          <div className="system-ethernet-actions">
            {reconnecting ? <span className="management-status-pill" data-state="warning">{t("workspace.management.network.ethernet.states.reconnecting")}</span> : null}
            {pending.length ? <span className="management-status-pill" data-state="warning">{t("workspace.management.network.ethernet.pendingCount", { count: pending.length })}</span> : null}
            <button type="button" className="is-primary" onClick={() => setConfirmApply(true)} disabled={!canManageEthernet || pending.length === 0 || metricConflict || busy || applying || reconnecting}>
              <Check aria-hidden="true" size={14} />
              <span>{t("workspace.management.network.ethernet.apply")}</span>
            </button>
          </div>
        </header>

        {error ? <p className="system-ethernet-error" role="alert">{error}</p> : null}
        {metricConflict ? <p className="system-ethernet-error" role="alert">{t("workspace.management.network.ethernet.errors.metricConflict")}</p> : null}
        {ethernet.warnings.length ? (
          <div className="system-ethernet-warnings" role="status">
            {ethernet.warnings.map((warning) => <p key={warning}><AlertTriangle aria-hidden="true" size={14} /><span>{formatEthernetWarning(warning, translate)}</span></p>)}
          </div>
        ) : null}
        {ethernet.backend !== "NetworkManager" || !ethernet.hostdReady ? (
          <div className="system-ethernet-unavailable">
            <AlertTriangle aria-hidden="true" size={18} />
            <div><strong>{t("workspace.management.network.ethernet.unavailableTitle")}</strong><p>{t("workspace.management.network.ethernet.unavailableDescription")}</p></div>
          </div>
        ) : ethernet.devices.length ? (
          <div className="system-ethernet-list">
            {ethernet.devices.map((device) => (
              <article key={device.id} className="system-ethernet-device" data-pending={device.needsApply || undefined}>
                <div className="system-ethernet-device-heading">
                  <div className="system-ethernet-device-icon" data-state={systemEthernetDeviceTone(device.state, reconnecting)}><Cable aria-hidden="true" size={19} /></div>
                  <div>
                    <div className="system-ethernet-device-title">
                      <strong>{device.name}</strong>
                      <span className="management-status-pill" data-state={systemEthernetDeviceTone(device.state, reconnecting)}>
                        {t(`workspace.management.network.ethernet.states.${reconnecting ? "reconnecting" : device.state}`)}
                      </span>
                      <span className="management-status-pill" data-state={device.managementState === "managed" ? "ready" : device.managementState === "external_unsupported" ? "offline" : "warning"}>
                        {t(`workspace.management.network.ethernet.management.${device.managementState}`)}
                      </span>
                    </div>
                    <small>{device.driver ?? t("common.dash")} · {device.permanentMac}</small>
                    {device.warnings.map((warning) => <p key={warning} className="system-ethernet-device-warning"><AlertTriangle aria-hidden="true" size={12} /><span>{formatEthernetWarning(warning, translate)}</span></p>)}
                  </div>
                </div>
                <dl className="system-ethernet-facts">
                  <div><dt>{t("workspace.management.network.ethernet.fields.addresses")}</dt><dd title={formatAddresses(device)}>{formatAddresses(device)}</dd></div>
                  <div><dt>{t("workspace.management.network.ethernet.fields.gateway")}</dt><dd>{device.ipv4Gateway ?? device.ipv6Gateway ?? t("common.dash")}</dd></div>
                  <div><dt>{t("workspace.management.network.ethernet.fields.speed")}</dt><dd>{device.speedMbps ? `${formatLocaleNumber(device.speedMbps, locale)} Mbps` : t("common.dash")}</dd></div>
                  <div><dt>{t("workspace.management.network.ethernet.fields.profile")}</dt><dd title={device.activeProfileName ?? undefined}>{device.activeProfileName ?? t("common.dash")}</dd></div>
                </dl>
                <div className="system-ethernet-device-actions">
                  {device.needsApply ? <span>{t("workspace.management.network.ethernet.needsApply")}</span> : null}
                  <button type="button" className="management-icon-action" onClick={() => openEditor(device, setEditor)} disabled={!device.desiredConfig || device.managementState === "external_unsupported" || busy || applying || reconnecting} aria-label={t("workspace.management.network.ethernet.edit", { name: device.name })} title={t("workspace.management.network.ethernet.edit", { name: device.name })}>
                    <Settings2 aria-hidden="true" size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : <p className="management-empty">{t("workspace.management.network.ethernet.noDevices")}</p>}
      </section>

      {editor ? (
        <EthernetEditor
          state={editor}
          busy={busy}
          unavailable={reconnecting}
          t={translate}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSave={() => void saveEditor()}
        />
      ) : null}
      {confirmApply ? (
        <ApplyConfirmation busy={busy} count={pending.length} t={translate} onCancel={() => setConfirmApply(false)} onConfirm={() => void beginApply()} />
      ) : null}
      {applying && transaction ? (
        <ApplyCountdown transaction={transaction} seconds={seconds} busy={busy} t={translate} onConfirm={() => void settle("confirm")} onRollback={() => void settle("rollback")} />
      ) : null}
    </>
  );
}

function openEditor(device: EthernetDevice, setEditor: (value: EditorState) => void) {
  if (!device.desiredConfig) return;
  setEditor({ device, config: structuredClone(device.desiredConfig) });
}

function formatAddresses(device: EthernetDevice): string {
  return device.addresses.map((address) => address.cidr ?? address.address).join(", ") || "-";
}

function formatEthernetWarning(warning: string, t: Translate): string {
  const key = {
    "No IPv4 default route is enabled": "noIpv4DefaultRoute",
    "No IPv6 default route is enabled": "noIpv6DefaultRoute",
    "Ethernet ports share a subnet but use asymmetric default-route settings": "asymmetricSubnetRoutes",
    "The active profile uses Ethernet features CyberOS cannot safely manage": "unsupportedProfile"
  }[warning];
  return key ? t(`workspace.management.network.ethernet.warnings.${key}`) : warning;
}

function EthernetEditor({ state, busy, unavailable, t, onChange, onClose, onSave }: {
  state: EditorState;
  busy: boolean;
  unavailable: boolean;
  t: Translate;
  onChange: (value: EditorState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement | null>(null);
  const errors = validateSystemEthernetConfig(state.config);
  useDialogFocus(dialog, busy ? undefined : onClose);

  function updateConfig(config: SystemEthernetConfig) {
    onChange({ ...state, config });
  }

  return (
    <div className="management-modal-backdrop system-ethernet-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialog} className="management-modal system-ethernet-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header>
          <div><span className="eyebrow">{t("workspace.management.network.ethernet.dialogEyebrow")}</span><h2 id={titleId}>{state.device.name}</h2><p>{state.device.permanentMac}</p></div>
          <button type="button" className="management-icon-action" onClick={onClose} disabled={busy} aria-label={t("common.actions.close")}><X aria-hidden="true" size={17} /></button>
        </header>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); onSave(); }}>
          <div className="system-ethernet-form">
            <label className="system-ethernet-toggle"><input type="checkbox" checked={state.config.enabled} onChange={(event) => updateConfig({ ...state.config, enabled: event.target.checked })} disabled={busy || unavailable} /><span>{t("workspace.management.network.ethernet.fields.enabled")}</span></label>
            <FamilyFields family="ipv4" config={state.config} busy={busy || unavailable} t={t} onChange={updateConfig} />
            <FamilyFields family="ipv6" config={state.config} busy={busy || unavailable} t={t} onChange={updateConfig} />
            {errors.length ? <p className="system-ethernet-form-error" role="alert">{t("workspace.management.network.ethernet.errors.invalid")}</p> : null}
          </div>
          <footer className="system-ethernet-dialog-actions"><button type="button" onClick={onClose} disabled={busy}>{t("common.actions.cancel")}</button><button type="submit" className="is-primary" disabled={busy || unavailable || errors.length > 0}>{busy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={14} /> : <Save aria-hidden="true" size={14} />}<span>{t("common.actions.save")}</span></button></footer>
        </form>
      </section>
    </div>
  );
}

function FamilyFields({ family, config, busy, t, onChange }: {
  family: "ipv4" | "ipv6";
  config: SystemEthernetConfig;
  busy: boolean;
  t: Translate;
  onChange: (value: SystemEthernetConfig) => void;
}) {
  const value = config[family];
  const automaticMode = family === "ipv4" ? "dhcp" : "automatic";
  const update = (next: typeof value) => onChange({ ...config, [family]: next });
  return (
    <fieldset className="system-ethernet-family" disabled={busy || !config.enabled}>
      <legend>{family.toUpperCase()}</legend>
      <div className="system-ethernet-form-grid">
        <label><span>{t("workspace.management.network.ethernet.fields.mode")}</span><select value={value.mode} onChange={(event) => update({ ...value, mode: event.target.value as typeof value.mode, address: null, prefixLength: null, gateway: null })}><option value="disabled">{t("workspace.management.network.ethernet.modes.disabled")}</option><option value={automaticMode}>{t(`workspace.management.network.ethernet.modes.${automaticMode}`)}</option><option value="static">{t("workspace.management.network.ethernet.modes.static")}</option></select></label>
        {value.mode === "static" ? <>
          <label><span>{t("workspace.management.network.ethernet.fields.address")}</span><input value={value.address ?? ""} onChange={(event) => update({ ...value, address: event.target.value || null })} /></label>
          <label><span>{t("workspace.management.network.ethernet.fields.prefix")}</span><input type="number" min="0" max={family === "ipv4" ? 32 : 128} value={value.prefixLength ?? ""} onChange={(event) => update({ ...value, prefixLength: event.target.value ? Number(event.target.value) : null })} /></label>
          <label><span>{t("workspace.management.network.ethernet.fields.gateway")}</span><input value={value.gateway ?? ""} onChange={(event) => update({ ...value, gateway: event.target.value || null })} /></label>
        </> : null}
        <label><span>{t("workspace.management.network.ethernet.fields.dnsMode")}</span><select value={value.dnsMode} onChange={(event) => update({ ...value, dnsMode: event.target.value as typeof value.dnsMode, dns: event.target.value === "automatic" ? [] : value.dns })}><option value="automatic">{t("workspace.management.network.ethernet.dns.automatic")}</option><option value="manual">{t("workspace.management.network.ethernet.dns.manual")}</option></select></label>
        {value.dnsMode === "manual" ? <label className="is-wide"><span>{t("workspace.management.network.ethernet.fields.dns")}</span><input value={value.dns.join(", ")} onChange={(event) => update({ ...value, dns: event.target.value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 3) })} /></label> : null}
        <label className="system-ethernet-toggle"><input type="checkbox" checked={value.useDefaultRoute} onChange={(event) => update({ ...value, useDefaultRoute: event.target.checked })} disabled={value.mode === "disabled"} /><span>{t("workspace.management.network.ethernet.fields.defaultRoute")}</span></label>
        <label><span>{t("workspace.management.network.ethernet.fields.metric")}</span><input type="number" min="1" max="65535" value={value.routeMetric} onChange={(event) => update({ ...value, routeMetric: Number(event.target.value) })} /></label>
      </div>
    </fieldset>
  );
}

function ApplyConfirmation({ busy, count, t, onCancel, onConfirm }: { busy: boolean; count: number; t: Translate; onCancel: () => void; onConfirm: () => void }) {
  const titleId = useId();
  const dialog = useRef<HTMLElement | null>(null);
  useDialogFocus(dialog, busy ? undefined : onCancel);
  return <div className="management-modal-backdrop system-ethernet-modal-backdrop"><section ref={dialog} className="management-modal system-ethernet-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header><div><span className="eyebrow">{t("workspace.management.network.ethernet.confirm.eyebrow")}</span><h2 id={titleId}>{t("workspace.management.network.ethernet.confirm.title")}</h2></div><button type="button" className="management-icon-action" onClick={onCancel} disabled={busy} aria-label={t("common.actions.close")}><X aria-hidden="true" size={17} /></button></header><div className="system-ethernet-confirm-body"><AlertTriangle aria-hidden="true" size={24} /><p>{t("workspace.management.network.ethernet.confirm.description", { count })}</p></div><footer><button type="button" onClick={onCancel} disabled={busy}>{t("common.actions.cancel")}</button><button type="button" className="is-danger" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={14} /> : <Check aria-hidden="true" size={14} />}<span>{t("workspace.management.network.ethernet.confirm.apply")}</span></button></footer></section></div>;
}

function ApplyCountdown({ transaction, seconds, busy, t, onConfirm, onRollback }: { transaction: EthernetApplyTransaction; seconds: number; busy: boolean; t: Translate; onConfirm: () => void; onRollback: () => void }) {
  const titleId = useId();
  const dialog = useRef<HTMLElement | null>(null);
  useDialogFocus(dialog);
  return <div className="management-modal-backdrop system-ethernet-modal-backdrop"><section ref={dialog} className="management-modal system-ethernet-countdown-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header><div><span className="eyebrow">{t("workspace.management.network.ethernet.transaction.eyebrow")}</span><h2 id={titleId}>{t("workspace.management.network.ethernet.transaction.title")}</h2></div><span className="system-ethernet-countdown" aria-live="polite">{seconds}s</span></header><div className="system-ethernet-confirm-body"><Cable aria-hidden="true" size={24} /><p>{t("workspace.management.network.ethernet.transaction.description", { count: transaction.deviceIds.length })}</p></div><footer><button type="button" className="is-danger" onClick={onRollback} disabled={busy}>{busy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={14} /> : <RotateCcw aria-hidden="true" size={14} />}<span>{t("workspace.management.network.ethernet.transaction.rollback")}</span></button><button type="button" className="is-primary" onClick={onConfirm} disabled={busy || seconds <= 0}>{busy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={14} /> : <Check aria-hidden="true" size={14} />}<span>{t("workspace.management.network.ethernet.transaction.keep")}</span></button></footer></section></div>;
}

function useDialogFocus(dialog: RefObject<HTMLElement | null>, onEscape?: () => void) {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => dialog.current?.focus());
    const element = dialog.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && escapeRef.current) {
        event.preventDefault();
        escapeRef.current();
      }
      if (event.key === "Tab" && element) trapFocus(event, element);
    };
    element?.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      element?.removeEventListener("keydown", handleKeyDown);
      if (previous?.isConnected) window.requestAnimationFrame(() => previous.focus());
    };
  }, [dialog]);
}

function trapFocus(event: KeyboardEvent | ReactKeyboardEvent, root: HTMLElement) {
  const controls = [...root.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")];
  if (!controls.length) return;
  const first = controls[0]!;
  const last = controls.at(-1)!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
