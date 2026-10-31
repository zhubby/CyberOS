import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ShareProtocol } from "@cyberos/shared";
import { CircleAlert, Database, Folder, HardDrive, LoaderCircle, Network, Pencil, Plus, RefreshCw, Server, Share2, Trash2, X } from "lucide-react";
import { getShareSettings, getShareSummary, mutateProtocolShare, type ShareSettings, type ShareSummary, type StoragePool } from "../../api.js";
import { SHARE_PROTOCOLS, SHARE_SETTINGS_CHANGED_EVENT, createShareFormState, shareDirectoriesToInput, shareSettingsToForm, validateShareForm, type ShareDefinitionFormState, type ShareProtocolFormState } from "../../config/share-settings.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { formatDate, formatLocaleNumber } from "../../i18n/format.js";
import { CustomSelect } from "../common/CustomSelect.js";
import { ModalPortal } from "../common/ModalPortal.js";
import { Switch } from "../common/Switch.js";
import { ManagementDashboardControls, ManagementDashboardGrid, useManagementDashboard } from "./ManagementDashboard.js";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "./PanelHeader.js";
import { ShareProtocolFields } from "./ShareProtocolFields.js";

type StatusTone = "ready" | "warning" | "offline" | "neutral";
type Translate = (key: string, options?: Record<string, unknown>) => string;
const PROTOCOL_ICONS = { smb: Server, webdav: Network, ftp: HardDrive, nfs: Folder, dlna: Database };
type Editor = { kind: "edit"; protocol: ShareProtocol; originalId?: string; draft: ShareDefinitionFormState; snapshot: ShareSettings };
type Dialog = Editor | { kind: "delete"; share: ShareDefinitionFormState; snapshot: ShareSettings };

export function ShareManagementPanel({ storagePools, locale, onWorkQueuesChanged, onNotifyError, onNotifySuccess }: {
  storagePools: StoragePool[]; locale: SupportedLocale;
  onWorkQueuesChanged: () => void | Promise<void>;
  onNotifyError: (message: string | null) => void;
  onNotifySuccess: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const dashboard = useManagementDashboard("shares");
  const [settings, setSettings] = useState<ShareSettings | null>(null);
  const [summary, setSummary] = useState<ShareSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const form = useMemo(() => shareSettingsToForm(settings, storagePools), [settings, storagePools]);
  const writable = settings !== null && summary?.capabilities.canApplyConfiguration === true;
  const disabled = loading || busy || !writable;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [nextSettings, nextSummary] = await Promise.all([getShareSettings(), getShareSummary()]);
      setSettings(nextSettings);
      setSummary(nextSummary);
      setError(null);
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      onNotifyError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [onNotifyError]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const listener = () => { if (!busyRef.current) void refresh(); };
    window.addEventListener(SHARE_SETTINGS_CHANGED_EVENT, listener);
    return () => window.removeEventListener(SHARE_SETTINGS_CHANGED_EVENT, listener);
  }, [refresh]);

  function closeDialog() {
    if (busyRef.current) return;
    setDialog(null);
    setDialogError(null);
  }
  function openDialog(next: Dialog) {
    dialogTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialogError(null); setDialog(next);
  }
  function edit(protocol: ShareProtocol, share?: ShareDefinitionFormState) {
    if (!settings) return;
    const draft = share ? structuredClone(share) : createShareFormState(storagePools, form.shares);
    draft.protocol = protocol;
    if (!share) draft.protocols[protocol].enabled = true;
    openDialog({ kind: "edit", protocol, ...(share ? { originalId: share.id } : {}), draft, snapshot: settings });
  }
  function updateDraft(patch: Partial<ShareDefinitionFormState>) {
    setDialog((current) => current?.kind === "edit" ? { ...current, draft: { ...current.draft, ...patch } } : current);
    setDialogError(null);
  }
  function updateProtocol<P extends ShareProtocol>(protocol: P, patch: Partial<ShareProtocolFormState[P]>) {
    setDialog((current) => current?.kind === "edit" ? { ...current, draft: {
      ...current.draft, protocols: { ...current.draft.protocols, [protocol]: { ...current.draft.protocols[protocol], ...patch } }
    } } : current);
    setDialogError(null);
  }

  async function runMutation(action: () => Promise<ShareSettings>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setDialogError(null);
    try {
      const saved = await action();
      setSettings(saved);
      setError(null);
      onNotifySuccess(t("workspace.management.shares.saved"));
      // A successful configuration write is distinct from collecting live service health.
      setSummary(null);
      try {
        setSummary(await getShareSummary());
      } catch (nextError) {
        setError(errorMessage(nextError));
        onNotifyError(errorMessage(nextError));
      }
      void Promise.resolve().then(onWorkQueuesChanged).catch((nextError: unknown) => onNotifyError(errorMessage(nextError)));
      window.dispatchEvent(new Event(SHARE_SETTINGS_CHANGED_EVENT));
      setDialog(null);
    } catch (nextError) {
      const message = nextError instanceof Error && "statusCode" in nextError && nextError.statusCode === 409
        ? t("workspace.management.shares.conflict") : errorMessage(nextError);
      setDialogError(message);
      setError(message);
      onNotifyError(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function saveEditor(event: FormEvent) {
    event.preventDefault();
    if (dialog?.kind !== "edit") return;
    const current = shareSettingsToForm(dialog.snapshot, storagePools);
    const shares = dialog.originalId ? current.shares.map((share) => share.id === dialog.originalId ? dialog.draft : share) : [...current.shares, dialog.draft];
    const issue = validateShareForm({ ...current, shares }, storagePools)[0];
    if (issue) {
      setDialogError(t(`workspace.management.shares.validation.${issue.code}`, { share: issue.shareName ?? t("common.dash"), value: issue.value ?? t("common.dash") }));
      return;
    }
    const input = shareDirectoriesToInput({ ...current, shares: [dialog.draft] }).shares?.[0];
    if (!input) return;
    void runMutation(() => mutateProtocolShare({ protocol: dialog.protocol, method: dialog.originalId ? "PUT" : "POST",
      ...(dialog.originalId ? { id: dialog.originalId } : {}), expectedUpdatedAt: dialog.snapshot.updatedAt, share: input }));
  }

  return <section className="workspace-management workspace-share-management" aria-label={t("workspace.management.shares.title")}>
    <PanelHeader icon={<Share2 aria-hidden="true" size={20} />} title={t("workspace.management.shares.title")}
      subtitle={t("workspace.management.shares.description")} actions={<PanelHeaderActions label={t("workspace.management.actions.label")}>
        <ManagementDashboardControls dashboard={dashboard} disabled={loading || busy} />
        <PanelHeaderAction label={t("common.actions.refresh")} onClick={() => void refresh()} disabled={refreshing || busy} aria-busy={refreshing || undefined}>
          {refreshing ? <LoaderCircle className="is-spinning" size={17} /> : <RefreshCw size={17} />}
        </PanelHeaderAction>
      </PanelHeaderActions>} />
    <div className="management-body share-management-body">
      {error ? <p className="share-add-form-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{error}</p> : null}
      {!loading && !writable ? <p className="management-empty">{t("workspace.management.shares.configurationUnavailable")}</p> : null}
      <ManagementDashboardGrid dashboard={dashboard} loading={loading} items={[
        { id: "services", title: t("workspace.management.shares.servicesTitle"), content: <section className="management-section share-services-section">
          <header className="management-section-header"><div><h3>{t("workspace.management.shares.servicesTitle")}</h3><p>{shareStatusDetail(summary, loading, error, t)}</p></div>
            <span className="management-status-pill" data-state={shareStatusTone(summary, loading, error)}>{shareStatusLabel(summary, loading, error, t)}</span>
          </header>
          <dl className="management-fact-list share-overview-facts">
            <div><dt>{t("workspace.management.shares.metrics.shares")}</dt><dd>{formatLocaleNumber(settings?.shares.length ?? 0, locale)}</dd></div>
            <div><dt>{t("workspace.management.shares.metrics.protocols")}</dt><dd>{formatLocaleNumber(summary?.metrics.enabledProtocols ?? 0, locale)}</dd></div>
            <div><dt>{t("workspace.management.shares.facts.updated")}</dt><dd>{settings?.updatedAt && settings.updatedAt !== new Date(0).toISOString() ? formatDate(settings.updatedAt, locale) : t("workspace.management.shares.notSaved")}</dd></div>
          </dl>
          <div className="share-service-list">{SHARE_PROTOCOLS.map((protocol) => <div className="share-service-row" key={protocol}>
            {protocolIcon(protocol, 16)}<div><strong>{t(`workspace.management.shares.protocolLabels.${protocol}`)}</strong><span>{t("workspace.management.shares.enabledShares", { count: summary?.protocols[protocol].enabledShares ?? 0 })}</span></div>
            <span className="management-row-status" data-state={protocolSummaryTone(summary, protocol)}>{protocolSummaryLabel(summary, protocol, t)}</span>
          </div>)}</div>
          {summary?.issues.length ? <ul className="share-service-issues">{summary.issues.map((issue, index) => <li key={index}>{issue.source}: {issue.message}</li>)}</ul> : null}
        </section> },
        ...SHARE_PROTOCOLS.map((protocol) => ({ id: `protocol-${protocol}`, title: t(`workspace.management.shares.protocolLabels.${protocol}`),
          content: <ShareProtocolSection protocol={protocol} shares={form.shares.filter((share) => share.protocol === protocol)}
            summary={summary} disabled={disabled} createDisabled={!storagePools.length} t={t} onCreate={() => edit(protocol)} onEdit={(share) => edit(protocol, share)}
            onToggle={(share, enabled) => settings && void runMutation(() => mutateProtocolShare({ protocol, id: share.id, method: "PATCH", expectedUpdatedAt: settings.updatedAt, enabled }))}
            onDelete={(share) => settings && openDialog({ kind: "delete", share, snapshot: settings })} /> }))
      ]} />
    </div>
    {dialog ? <ShareDialog title={dialog.kind === "edit" ? `${t(`workspace.management.shares.protocolLabels.${dialog.protocol}`)} · ${t(dialog.originalId ? "common.actions.edit" : "workspace.management.shares.addShare")}` : t("workspace.management.shares.removeShare")} busy={busy} onClose={closeDialog} returnFocus={dialogTrigger.current} closeLabel={t("common.actions.close")}>
      <form className="share-add-form" onSubmit={dialog.kind === "edit" ? saveEditor : (event) => {
        event.preventDefault();
        if (dialog.kind === "delete") void runMutation(() => mutateProtocolShare({ protocol: dialog.share.protocol, id: dialog.share.id, method: "DELETE", expectedUpdatedAt: dialog.snapshot.updatedAt }));
      }}>
        <div className="share-add-form-body">
          {dialog.kind === "edit" ? <fieldset className="share-editor-fields" disabled={busy}>
            <div className="share-directory-fields">
              <label><span>{t("workspace.management.shares.fields.shareName")}</span><input autoFocus value={dialog.draft.name} onChange={(event) => updateDraft({ name: event.target.value })} /></label>
              <label><span>{t("workspace.management.shares.fields.shareId")}</span><input value={dialog.draft.id} disabled={Boolean(dialog.originalId)} onChange={(event) => updateDraft({ id: event.target.value })} /></label>
              <label><span>{t("workspace.management.shares.fields.root")}</span><CustomSelect value={dialog.draft.storagePoolId} options={storagePools.map((pool) => ({ value: pool.id, label: pool.name }))} onChange={(storagePoolId) => updateDraft({ storagePoolId })} ariaLabel={t("workspace.management.shares.fields.root")} disabled={busy} /></label>
              <label><span>{t("workspace.management.shares.fields.path")}</span><input value={dialog.draft.path} onChange={(event) => updateDraft({ path: event.target.value })} /></label>
              <label className="share-field-wide"><span>{t("workspace.management.shares.fields.description")}</span><input value={dialog.draft.description} onChange={(event) => updateDraft({ description: event.target.value })} /></label>
            </div>
            <Switch checked={dialog.draft.protocols[dialog.protocol].enabled} label={t("workspace.management.shares.states.enabled")} onCheckedChange={(enabled) => updateProtocol(dialog.protocol, { enabled })} />
            <ShareProtocolFields protocol={dialog.protocol} share={dialog.draft} update={updateProtocol} t={t} />
          </fieldset> : null}
          {dialog.kind === "delete" ? <p className="share-delete-copy">{t("workspace.management.shares.deleteConfirm", { name: dialog.share.name })}</p> : null}
          {dialogError ? <p className="share-add-form-error" role="alert"><CircleAlert size={15} aria-hidden="true" />{dialogError}</p> : null}
        </div>
        <footer className="share-add-form-actions"><button type="button" onClick={closeDialog} disabled={busy}>{t("common.actions.cancel")}</button>
          <button type="submit" className={dialog.kind === "delete" ? "is-danger" : "is-primary"} disabled={busy} aria-busy={busy || undefined}>
            {busy ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : null}{t(dialog.kind === "delete" ? "workspace.management.shares.removeShare" : "common.actions.save")}
          </button></footer>
      </form>
    </ShareDialog> : null}
  </section>;
}

export function ShareProtocolSection({ protocol, shares, summary, disabled, createDisabled = false, t, onCreate, onEdit, onToggle, onDelete }: {
  protocol: ShareProtocol; shares: ShareDefinitionFormState[]; summary: ShareSummary | null; disabled: boolean; createDisabled?: boolean; t: Translate;
  onCreate: () => void; onEdit: (share: ShareDefinitionFormState) => void; onToggle: (share: ShareDefinitionFormState, enabled: boolean) => void; onDelete: (share: ShareDefinitionFormState) => void;
}) {
  return <section className="management-section share-protocol-section" data-protocol={protocol}>
    <header className="management-section-header"><div className="share-protocol-heading">{protocolIcon(protocol, 18)}<h3>{t(`workspace.management.shares.protocolLabels.${protocol}`)}</h3>
      <span className="management-row-status" data-state={protocolSummaryTone(summary, protocol)}>{protocolSummaryLabel(summary, protocol, t)}</span></div>
      <button className="management-row-action" disabled={disabled || createDisabled} onClick={onCreate}><Plus size={14} aria-hidden="true" />{t("workspace.management.shares.addShare")}</button>
    </header>
    {protocol === "ftp" ? <p className="share-protocol-hint">{t("workspace.management.shares.ftpLimit")}</p> : null}
    {shares.length ? <div className="share-protocol-shares">{shares.map((share) => <article className="share-protocol-share-row" key={share.id}>
      <div className="share-protocol-share-copy"><strong>{share.name || share.id}</strong><small>{share.storagePoolId} / {share.path}</small><code>{connectionIdentifier(share, protocol)}</code></div>
      <div className="share-protocol-share-actions"><Switch checked={share.protocols[protocol].enabled} disabled={disabled} ariaLabel={`${t("workspace.management.shares.states.enabled")} · ${share.name}`} onCheckedChange={(enabled) => onToggle(share, enabled)} />
        <button className="management-icon-action" disabled={disabled} onClick={() => onEdit(share)} title={t("common.actions.edit")} aria-label={`${t("common.actions.edit")} · ${share.name}`}><Pencil size={15} aria-hidden="true" /></button>
        <button className="management-icon-action is-danger" disabled={disabled} onClick={() => onDelete(share)} title={t("workspace.management.shares.removeShare")} aria-label={`${t("workspace.management.shares.removeShare")} · ${share.name}`}><Trash2 size={15} aria-hidden="true" /></button>
      </div>
    </article>)}</div> : <p className="management-empty">{t("workspace.management.shares.noShares")}</p>}
    {summary?.protocols[protocol].services.filter((service) => service.status !== "active" && service.status !== "disabled" && summary.enabled && summary.protocols[protocol].enabledShares > 0).map((service) => <p className="share-service-problem" key={service.name}><CircleAlert size={14} aria-hidden="true" />{service.name}: {t(`workspace.management.shares.serviceStates.${service.status}`)}{service.error ? ` · ${service.error}` : ""}</p>)}
  </section>;
}

function ShareDialog({ title, busy, onClose, children, returnFocus, closeLabel }: { title: string; busy: boolean; onClose: () => void; children: ReactNode; returnFocus: HTMLElement | null; closeLabel: string }) {
  const ref = useRef<HTMLElement>(null);
  const returnFocusRef = useRef(returnFocus);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = returnFocusRef.current;
    const root = ref.current;
    const focusable = () => Array.from(root?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter((node) => node.getClientRects().length > 0);
    (root?.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0] ?? root)?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key === "Tab") {
        const nodes = focusable();
        const first = nodes[0]; const last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); root?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <ModalPortal className="management-modal-backdrop share-add-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={ref} tabIndex={-1} className="management-modal share-add-modal share-protocol-modal" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title" aria-busy={busy || undefined}>
      <header><h2 id="share-dialog-title">{title}</h2><button type="button" className="management-icon-action" onClick={onClose} disabled={busy} aria-label={closeLabel}><X size={16} aria-hidden="true" /></button></header>
      {children}
    </section>
  </ModalPortal>;
}

function connectionIdentifier(share: ShareDefinitionFormState, protocol: ShareProtocol): string {
  switch (protocol) {
    case "smb": return `cyberos-${share.id}`;
    case "webdav": return `:${share.protocols.webdav.port}${share.protocols.webdav.pathPrefix}`;
    case "ftp": return `:${share.protocols.ftp.port}`;
    case "nfs": return `${share.storagePoolId}/${share.path}`;
    case "dlna": return share.protocols.dlna.friendlyName;
  }
}
function protocolIcon(protocol: ShareProtocol, size: number) { const Icon = PROTOCOL_ICONS[protocol]; return <Icon size={size} aria-hidden="true" />; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function shareStatusTone(summary: ShareSummary | null, loading: boolean, error: string | null): StatusTone {
  if (loading) {
    return "neutral";
  }
  if ((error && !summary) || (summary?.issues.length ?? 0) > 0 || hasUnhealthyEnabledShareServices(summary)) {
    return "warning";
  }
  return summary?.enabled ? "ready" : "neutral";
}

export function shareStatusLabel(summary: ShareSummary | null, loading: boolean, error: string | null, t: Translate): string {
  if (loading) {
    return t("common.states.loading");
  }
  if (error && !summary) {
    return t("common.states.unavailable");
  }
  if (!summary) return t("common.states.unknown");
  return summary.enabled ? t("workspace.management.shares.states.enabled") : t("workspace.management.shares.states.disabled");
}

export function shareStatusDetail(summary: ShareSummary | null, loading: boolean, error: string | null, t: Translate): string {
  if (loading) {
    return t("workspace.management.shares.loading");
  }
  if (error && !summary) {
    return error;
  }
  if (!summary) return t("workspace.management.shares.configurationUnavailable");
  if (!summary.enabled) {
    return t("workspace.management.shares.disabledDetail");
  }
  if (summary.issues.length > 0 || hasUnhealthyEnabledShareServices(summary)) {
    return t("workspace.management.shares.partialDetail");
  }
  return t("workspace.management.shares.readyDetail");
}

function hasUnhealthyEnabledShareServices(summary: ShareSummary | null): boolean {
  if (!summary?.enabled) {
    return false;
  }

  return SHARE_PROTOCOLS.some((protocol) => {
    const protocolSummary = summary.protocols[protocol];
    return protocolSummary.enabledShares > 0 && (
      protocolSummary.services.length === 0
      || protocolSummary.services.some((service) => service.status !== "active")
    );
  });
}

function protocolSummaryTone(summary: ShareSummary | null, protocol: ShareProtocol): StatusTone {
  const protocolSummary = summary?.protocols[protocol];
  if (!summary || !protocolSummary) return "neutral";
  if (!summary.enabled || protocolSummary.enabledShares === 0) {
    return "neutral";
  }
  if (protocolSummary.services.some((service) => service.status === "failed" || service.status === "unknown")) {
    return "warning";
  }
  if (protocolSummary.services.length > 0 && protocolSummary.services.every((service) => service.status === "active")) {
    return "ready";
  }
  return "warning";
}

function protocolSummaryLabel(summary: ShareSummary | null, protocol: ShareProtocol, t: Translate): string {
  const protocolSummary = summary?.protocols[protocol];
  if (!summary || !protocolSummary) return t("common.states.unknown");
  if (!summary.enabled) {
    return t("workspace.management.shares.serviceStates.disabled");
  }
  if (protocolSummary.services.length > 0 && protocolSummary.services.every((service) => service.status === "active")) {
    return t("workspace.management.shares.serviceStates.active");
  }
  const firstProblem = protocolSummary.services.find((service) => service.status !== "active");
  return firstProblem ? t(`workspace.management.shares.serviceStates.${firstProblem.status}`) : t("common.states.unknown");
}
