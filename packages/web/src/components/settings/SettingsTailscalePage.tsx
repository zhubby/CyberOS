import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Check, ExternalLink, LoaderCircle, Network, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { parseTailscaleStatus, type TailscaleAction, type TailscaleStatus } from "@cyberos/shared";
import {
  finishSystemTailscaleApply, getSystemTailscale, loginSystemTailscale, runSystemTailscaleAction,
  TailscaleApiError, updateSystemTailscaleService, updateSystemTailscaleSettings
} from "../../api.js";
import { createTailscaleDraft, receiveTailscaleStatus, tailscaleSettingsPatch, type TailscaleDraft } from "../../lib/tailscale-settings.js";
import { formatBytes } from "../../i18n/format.js";
import { Switch } from "../common/Switch.js";
import { CustomSelect } from "../common/CustomSelect.js";
import { ModalPortal } from "../common/ModalPortal.js";
import { PanelContentSkeleton } from "../workspace/ManagementSkeleton.js";
import { useModalDialog } from "../workspace/useModalDialog.js";

interface Confirmation {
  action: "disconnect" | "logout" | "restart" | "apply";
  run: () => Promise<TailscaleStatus>;
}

const ERROR_CODES = ["400", "403", "404", "409", "501", "502", "504", "unavailable"] as const;
type ErrorCode = typeof ERROR_CODES[number];
const STATE_LABELS = {
  Running: "settings.tailscale.states.Running", Stopped: "settings.tailscale.states.Stopped", NeedsLogin: "settings.tailscale.states.NeedsLogin",
  NeedsMachineAuth: "settings.tailscale.states.NeedsMachineAuth", Starting: "settings.tailscale.states.Starting", NoState: "settings.tailscale.states.NoState", Unavailable: "settings.tailscale.states.Unavailable"
} as const;
const SERVICE_LABELS = {
  active: "settings.tailscale.serviceStates.active", inactive: "settings.tailscale.serviceStates.inactive", failed: "settings.tailscale.serviceStates.failed",
  activating: "settings.tailscale.serviceStates.activating", deactivating: "settings.tailscale.serviceStates.deactivating", unknown: "settings.tailscale.serviceStates.unknown"
} as const;

export function SettingsTailscalePage({ onNotifySuccess }: { onNotifySuccess: (message: string) => void }) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<{ status: TailscaleStatus | null; draft: TailscaleDraft | null; receivedAt: number }>({ status: null, draft: null, receivedAt: Date.now() });
  const { status, draft } = view;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [search, setSearch] = useState("");
  const [controlUrl, setControlUrl] = useState("https://controlplane.tailscale.com");
  const [method, setMethod] = useState<"browser" | "auth_key">("browser");
  const [authKey, setAuthKey] = useState("");
  const [now, setNow] = useState(Date.now());
  const dialogId = useId();
  const closeConfirmation = () => { if (!busy) setConfirmation(null); };
  const dialogRef = useModalDialog(closeConfirmation, busy, confirmation !== null);
  const receive = useCallback((next: TailscaleStatus, reset = false) => {
    setView((current) => {
      if (current.status && Date.parse(next.collectedAt) < Date.parse(current.status.collectedAt)) return current;
      return { status: next, draft: reset ? createTailscaleDraft(next) : receiveTailscaleStatus(current.draft, next), receivedAt: Date.now() };
    });
  }, []);

  useEffect(() => {
    let active = true;
    let live = false;
    let initialized = false;
    const refresh = () => getSystemTailscale().then((next) => {
      if (active) {
        if (!initialized) { setControlUrl(next.controlUrl); initialized = true; }
        receive(next); setLoading(false);
      }
    }).catch(() => { if (active) { setError("unavailable"); setLoading(false); } });
    void refresh();
    const source = typeof EventSource !== "undefined" ? new EventSource("/api/system/tailscale/events") : null;
    if (source) {
      source.onopen = () => { live = true; if (active) setReconnecting(false); };
      source.onerror = () => { live = false; if (active) setReconnecting(true); };
      source.addEventListener("system.tailscale.status", (event) => {
        try {
          const next = parseTailscaleStatus(JSON.parse((event as MessageEvent<string>).data));
          if (active && next) { receive(next); setLoading(false); }
        } catch { /* A malformed event cannot update the trusted state. */ }
      });
    }
    const timer = setInterval(() => { if (!live) void refresh(); }, 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; source?.close(); clearInterval(timer); clearInterval(clock); };
  }, [receive]);

  async function perform(work: () => Promise<TailscaleStatus>, reset = false): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      receive(await work(), reset);
      return true;
    } catch (next) {
      const code = next instanceof TailscaleApiError ? String(next.status) : "unavailable";
      setError(ERROR_CODES.find((item) => item === code) ?? "unavailable");
      return false;
    } finally { setBusy(false); }
  }

  function edit(patch: Partial<TailscaleDraft>) {
    setView((current) => current.draft ? { ...current, draft: { ...current.draft, ...patch } } : current);
  }
  function action(value: TailscaleAction) {
    if (!status) return;
    const run = () => runSystemTailscaleAction({ action: value, expectedRevision: status.revision, confirmed: true });
    if (value === "disconnect" || value === "logout" || value === "restart") setConfirmation({ action: value, run });
    else void perform(run);
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const input = { settings: tailscaleSettingsPatch(draft), expectedRevision: draft.revision, confirmed: true };
    setConfirmation({ action: "apply", run: () => updateSystemTailscaleSettings(input) });
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    if (!status) return;
    const input = { controlUrl: controlUrl.trim(), method, authKey: method === "auth_key" ? authKey.trim() : null, expectedRevision: status.revision, confirmed: true };
    setAuthKey("");
    await perform(() => loginSystemTailscale(input));
  }

  const message = error ? t(`settings.tailscale.errors.${error}`, { defaultValue: t("settings.tailscale.errors.unavailable") }) : null;
  if (loading) return <div className="settings-content-body"><PanelContentSkeleton /></div>;
  if (!status || !draft) return <div className="settings-content-body"><p className="settings-inline-error" role="alert">{message}</p><button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(getSystemTailscale)}>{t("settings.tailscale.refresh")}</button></div>;

  const pending = status.transaction?.state === "pending" ? status.transaction : null;
  const seconds = pending ? Math.max(0, Math.ceil((Date.parse(pending.deadlineAt) - Date.parse(status.collectedAt) - (now - view.receivedAt)) / 1000)) : 0;
  const locked = busy || pending !== null;
  const dirty = Object.keys(tailscaleSettingsPatch(draft)).length > 0;
  const conflict = dirty && draft.revision !== status.revision;
  const signedIn = status.account !== null || ["Running", "Stopped"].includes(status.backendState);
  const peers = status.peers.filter((peer) => `${peer.hostname} ${peer.dnsName} ${peer.os} ${peer.ips.join(" ")}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const exits = status.peers.filter((peer) => peer.exitNodeOption && (peer.online || peer.id === draft.exitNodeId));
  const exitOptions = [{ value: "", label: t("settings.tailscale.noExit") }, ...exits.map((peer) => ({ value: peer.id, label: `${peer.hostname || peer.dnsName} · ${peer.ips[0] ?? ""}`, disabled: !peer.online }))];
  if (draft.exitNodeId && !exitOptions.some((option) => option.value === draft.exitNodeId)) exitOptions.push({ value: draft.exitNodeId, label: draft.exitNodeId, disabled: true });
  const date = (value: string | null) => value && !value.startsWith("0001-") ? new Date(value).toLocaleString(i18n.language) : t("settings.tailscale.unknown");
  const yn = (value: boolean) => t(`settings.tailscale.${value ? "enabled" : "disabled"}`);
  const locale = i18n.language === "zh-CN" ? "zh-CN" : "en";

  return <div className="settings-content-body tailscale-settings" aria-busy={busy || undefined}>
    {message ? <p className="settings-inline-error" role="alert">{message}</p> : null}
    {reconnecting ? <p className="settings-field-help" role="status">{t("settings.tailscale.reconnecting")}</p> : null}
    {pending ? <section className="settings-section-card tailscale-transaction" role="status">
      <h3>{t("settings.tailscale.pending")}</h3>
      <p>{t("settings.tailscale.countdown", { seconds })}</p>
      <div className="settings-card-actions">
        <button type="button" className="primary-button" disabled={busy || seconds <= 0} onClick={() => void perform(() => finishSystemTailscaleApply(pending.id, "confirm"), true).then((ok) => { if (ok) onNotifySuccess(t("settings.tailscale.kept")); })}>{t("settings.tailscale.keep")}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(() => finishSystemTailscaleApply(pending.id, "rollback"), true)}>{t("settings.tailscale.rollback")}</button>
      </div>
    </section> : null}
    {status.transaction?.state === "rolled_back" || status.transaction?.state === "conflict" ? <p className="settings-inline-alert" role="status">{t(`settings.tailscale.transaction.${status.transaction.state}`)}</p> : null}
    <div className="settings-page-grid">
      <section className="settings-section-card">
        <header><div><h3>{t("settings.tailscale.connection")}</h3><p>{STATE_LABELS[status.backendState as keyof typeof STATE_LABELS] ? t(STATE_LABELS[status.backendState as keyof typeof STATE_LABELS]) : status.backendState}</p></div><Network size={18} aria-hidden="true" /></header>
        {!status.available ? <p className="settings-inline-alert" role="status">{t(["unknown", "unavailable"].includes(status.service.state) ? "settings.tailscale.errors.unavailable" : status.service.installed ? "settings.tailscale.serviceStopped" : "settings.tailscale.notInstalled")}</p> : null}
        {status.error && status.available ? <p className="settings-inline-alert" role="status">{t("settings.tailscale.errors.recovery")}</p> : null}
        <dl className="tailscale-facts"><Fact label={t("settings.tailscale.version")}>{status.version}</Fact><Fact label={t("settings.tailscale.service")}>{t(SERVICE_LABELS[status.service.state as keyof typeof SERVICE_LABELS] ?? SERVICE_LABELS.unknown)}</Fact></dl>
        <div className="tailscale-switches">
          <Switch label={t("settings.tailscale.autoStart")} checked={status.service.autoStart} disabled={locked || !status.service.installed} onCheckedChange={(autoStart) => void perform(() => updateSystemTailscaleService({ autoStart, expectedRevision: status.revision, confirmed: true }))} />
          <Switch label={t("settings.tailscale.connected")} checked={status.backendState === "Running"} disabled={locked || !status.available || !signedIn} onCheckedChange={(value) => action(value ? "connect" : "disconnect")} />
        </div>
        <div className="settings-card-actions">
          {!status.service.active ? <button type="button" className="secondary-button" disabled={locked || !status.service.installed} onClick={() => action("start")}>{t("settings.tailscale.actions.start")}</button> : <button type="button" className="secondary-button" disabled={locked} onClick={() => action("restart")}>{t("settings.tailscale.actions.restart")}</button>}
          {signedIn ? <button type="button" className="danger-button" disabled={locked || !status.available} onClick={() => action("logout")}>{t("settings.tailscale.actions.logout")}</button> : null}
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(getSystemTailscale)}><RefreshCw size={14} aria-hidden="true" />{t("settings.tailscale.refresh")}</button>
        </div>
        {!signedIn && status.available ? <form className="tailscale-login" onSubmit={(event) => void login(event)}>
          <fieldset className="settings-field-grid settings-field-grid-single" disabled={locked}>
            <label><span>{t("settings.tailscale.controlUrl")}</span><input type="url" required value={controlUrl} maxLength={1024} autoComplete="off" spellCheck={false} onChange={(event) => setControlUrl(event.target.value)} /></label>
            <label><span>{t("settings.tailscale.loginMethod")}</span><CustomSelect value={method} onChange={(value) => { setMethod(value); setAuthKey(""); }} ariaLabel={t("settings.tailscale.loginMethod")} options={[{ value: "browser", label: t("settings.tailscale.browserLogin") }, { value: "auth_key", label: "Auth key" }]} /></label>
            {method === "auth_key" ? <label><span>Auth key</span><input type="password" value={authKey} required maxLength={4096} autoComplete="new-password" spellCheck={false} onChange={(event) => setAuthKey(event.target.value)} /><small>{t("settings.tailscale.keyHelp")}</small></label> : null}
          </fieldset>
          <div className="settings-card-actions"><button type="submit" className="primary-button" disabled={locked || (method === "auth_key" && !authKey.trim())}>{t("settings.tailscale.login")}</button></div>
          <p className="settings-field-help">{t("settings.tailscale.headscaleHelp")}</p>
        </form> : null}
        {status.loginUrl ? <p className="tailscale-auth-link"><a href={status.loginUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} aria-hidden="true" />{t("settings.tailscale.authorize")}</a><span>{t("settings.tailscale.authWaiting")}</span></p> : null}
      </section>

      <section className="settings-section-card">
        <header><h3>{t("settings.tailscale.localInfo")}</h3></header>
        <dl className="tailscale-facts">
          <Fact label={t("settings.tailscale.device")}>{status.hostname}</Fact><Fact label={t("settings.tailscale.account")}>{status.account}</Fact><Fact label="Tailnet">{status.tailnet}</Fact>
          <Fact label={t("settings.tailscale.controlUrl")}>{status.controlUrl}</Fact><Fact label="IPv4 / IPv6">{status.ips.join("\n")}</Fact>
          <Fact label="MagicDNS">{status.dnsName}</Fact><Fact label={t("settings.tailscale.keyExpiry")}>{date(status.keyExpiry)}</Fact>
        </dl>
        {status.health.length ? <ul className="tailscale-health" aria-label={t("settings.tailscale.health")}>{status.health.map((health, index) => <li key={index}><AlertTriangle size={14} aria-hidden="true" />{health}</li>)}</ul> : <p className="settings-field-help">{t(status.available ? "settings.tailscale.noHealth" : "settings.tailscale.unknown")}</p>}
      </section>

      <section className="settings-section-card">
        <header><div><h3>{t("settings.tailscale.nodes")}</h3><p>{t("settings.tailscale.nodeCount", { count: status.peers.length })}</p></div><button type="button" className="secondary-button" aria-label={t("settings.tailscale.refresh")} disabled={busy} onClick={() => void perform(getSystemTailscale)}><RefreshCw size={14} aria-hidden="true" /></button></header>
        <label><span>{t("settings.tailscale.search")}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <ul className="tailscale-peers">
          {peers.map((peer) => <li key={peer.id}>
            <div className="tailscale-peer-heading"><strong>{peer.hostname || peer.dnsName || peer.id}</strong><span className={peer.online ? "is-online" : ""}>{t(`settings.tailscale.${peer.online ? "online" : "offline"}`)}</span></div>
            <p>{peer.os || t("settings.tailscale.unknown")}{peer.exitNodeOption ? ` · ${t("settings.tailscale.exitEligible")}` : ""}</p>
            <code>{peer.ips.join(" · ")}</code>
            <p>{peer.directAddress ? `${t("settings.tailscale.direct")} · ${peer.directAddress}` : peer.active && peer.relay ? `${t("settings.tailscale.relay")} · ${peer.relay}` : t("settings.tailscale.noTraffic")}</p>
            <p>{t("settings.tailscale.traffic", { rx: formatBytes(peer.rxBytes, locale), tx: formatBytes(peer.txBytes, locale) })}</p>
          </li>)}
        </ul>
        {!peers.length ? <p className="settings-field-help">{t("settings.tailscale.noNodes")}</p> : null}
        {status.peersTruncated ? <p className="settings-field-help">{t("settings.tailscale.truncated")}</p> : null}
      </section>
      <form className="tailscale-config" onSubmit={save}>
        <section className="settings-section-card">
          <header><h3>{t("settings.tailscale.network")}</h3></header>
          <fieldset className="settings-field-grid settings-field-grid-single" disabled={locked || !status.available}>
            <label><span>{t("settings.tailscale.hostname")}</span><input maxLength={63} value={draft.hostname} pattern="[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?" placeholder={status.hostname} spellCheck={false} onChange={(event) => edit({ hostname: event.target.value })} /></label>
            <Switch label={t("settings.tailscale.acceptDns")} checked={draft.acceptDns} onCheckedChange={(acceptDns) => edit({ acceptDns })} />
            <Switch label={t("settings.tailscale.acceptRoutes")} checked={draft.acceptRoutes} onCheckedChange={(acceptRoutes) => edit({ acceptRoutes })} />
            <label><span>{t("settings.tailscale.exitNode")}</span><CustomSelect value={draft.exitNodeId} disabled={locked || !status.available || draft.advertiseExitNode} options={exitOptions} onChange={(exitNodeId) => edit({ exitNodeId, ...(exitNodeId ? { advertiseExitNode: false } : {}) })} ariaLabel={t("settings.tailscale.exitNode")} /></label>
            <Switch label={t("settings.tailscale.allowLan")} disabled={!draft.exitNodeId} checked={draft.exitNodeAllowLanAccess} onCheckedChange={(exitNodeAllowLanAccess) => edit({ exitNodeAllowLanAccess })} />
          </fieldset>
        </section>
        <section className="settings-section-card">
          <header><h3>{t("settings.tailscale.gateway")}</h3></header>
          <fieldset className="settings-field-grid settings-field-grid-single" disabled={locked || !status.available}>
            <label><span>{t("settings.tailscale.subnets")}</span><textarea rows={4} value={draft.routesText} onChange={(event) => edit({ routesText: event.target.value })} spellCheck={false} placeholder={"192.168.20.0/24\nfd00::/64"} /><small>{t("settings.tailscale.subnetHelp")}</small></label>
            <Switch label={t("settings.tailscale.advertiseExit")} disabled={!!draft.exitNodeId} checked={draft.advertiseExitNode} onCheckedChange={(advertiseExitNode) => edit({ advertiseExitNode, ...(advertiseExitNode ? { exitNodeId: "" } : {}) })} />
          </fieldset>
          <dl className="tailscale-facts"><Fact label={t("settings.tailscale.forwardingV4")}>{yn(status.ipv4Forwarding)}</Fact><Fact label={t("settings.tailscale.forwardingV6")}>{yn(status.ipv6Forwarding)}</Fact><Fact label={t("settings.tailscale.published")}>{status.settings.advertisedRoutes.join("\n")}</Fact><Fact label={t("settings.tailscale.advertiseExit")}>{yn(status.settings.advertiseExitNode)}</Fact></dl>
          <p className="settings-field-help">{t("settings.tailscale.approvalHelp")}</p>
          {status.primaryRoutes.length ? <p className="settings-field-help">{t("settings.tailscale.primaryRoutes", { routes: status.primaryRoutes.join(", ") })}</p> : null}
          <p className="settings-field-help">{t("settings.tailscale.forwardingHelp")}</p>
        </section>
        <section className="settings-section-card">
          {conflict ? <p className="settings-inline-error" role="alert">{t("settings.tailscale.draftConflict")}</p> : <p className="settings-field-help">{t("settings.tailscale.applyHelp")}</p>}
          <div className="settings-card-actions">
            <button type="submit" className="primary-button" disabled={locked || !dirty || conflict || !status.available}><Check size={14} aria-hidden="true" />{t("common.actions.saveChanges")}</button>
            <button type="button" className="secondary-button" disabled={busy || (!dirty && !conflict)} onClick={() => setView((current) => ({ ...current, draft: createTailscaleDraft(status) }))}>{t("settings.tailscale.discard")}</button>
          </div>
        </section>
      </form>
    </div>
    {confirmation ? <ModalPortal className="management-modal-backdrop" role="presentation" onMouseDown={closeConfirmation}>
      <section ref={dialogRef} className="settings-section-card tailscale-confirm" role="alertdialog" aria-modal="true" aria-labelledby={dialogId} aria-describedby={`${dialogId}-description`} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header><h3 id={dialogId}>{t(`settings.tailscale.confirm.${confirmation.action}.title`)}</h3><button type="button" disabled={busy} onClick={closeConfirmation} aria-label={t("common.actions.close")}><X size={16} aria-hidden="true" /></button></header>
        <p id={`${dialogId}-description`}>{t(`settings.tailscale.confirm.${confirmation.action}.description`)}</p>
        {message ? <p className="settings-inline-error" role="alert">{message}</p> : null}
        <div className="settings-card-actions"><button type="button" className="secondary-button" disabled={busy} onClick={closeConfirmation}>{t("common.actions.cancel")}</button><button type="button" className="primary-button" disabled={busy || pending !== null} onClick={() => void perform(confirmation.run, confirmation.action === "apply").then((ok) => { if (ok) setConfirmation(null); })}>{busy ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : null}{t("settings.tailscale.confirmAction")}</button></div>
      </section>
    </ModalPortal> : null}
  </div>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children || "—"}</dd></div>;
}
