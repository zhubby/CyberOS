import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ShareProtocol } from "@zos/shared";
import {
  CircleAlert,
  Database,
  Folder,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Lock,
  Network,
  Plus,
  RefreshCw,
  Server,
  Share2,
  Trash2,
  X,
  type LucideIcon
} from "lucide-react";
import {
  getShareSettings,
  getShareSummary,
  proposeShareSettings,
  type NasRoot,
  type PendingApproval,
  type ShareSummary
} from "../../api.js";
import {
  DLNA_MEDIA_TYPES,
  SHARE_PROTOCOLS,
  authenticatedProtocolCount,
  createShareFormState,
  enabledProtocolCount,
  shareFormToInput,
  shareSettingsToForm,
  toggleDlnaMediaType,
  validateShareForm,
  type ShareDefinitionFormState,
  type ShareFormValidationIssue,
  type ShareProtocolFormState,
  type ShareSettingsFormState
} from "../../config/share-settings.js";
import { formatDate, formatLocaleNumber } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import {
  ManagementDashboardControls,
  ManagementDashboardGrid,
  useManagementDashboard
} from "./ManagementDashboard.js";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "./PanelHeader.js";
import { ShareAccountDialog } from "./ShareAccountDialog.js";

type StatusTone = "ready" | "warning" | "offline" | "neutral";
type Translate = (key: string, options?: Record<string, unknown>) => string;

const PROTOCOL_ICONS = {
  smb: Server,
  webdav: Network,
  ftp: HardDrive,
  nfs: Folder,
  dlna: Database
} as const satisfies Record<ShareProtocol, LucideIcon>;

export function ShareManagementPanel({
  roots,
  sessionId,
  pendingApprovals,
  locale,
  onWorkQueuesChanged,
  onNotifyError,
  onNotifyWarning
}: {
  roots: NasRoot[];
  sessionId: string | null;
  pendingApprovals: PendingApproval[];
  locale: SupportedLocale;
  onWorkQueuesChanged: () => void | Promise<void>;
  onNotifyError: (message: string | null) => void;
  onNotifyWarning: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const dashboard = useManagementDashboard("shares");
  const [form, setForm] = useState<ShareSettingsFormState>(() => shareSettingsToForm(null, roots));
  const [summary, setSummary] = useState<ShareSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newShare, setNewShare] = useState<ShareDefinitionFormState | null>(null);
  const [newShareError, setNewShareError] = useState<string | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const reportedIssueSignature = useRef<string | null>(null);
  const reportedPendingApprovalId = useRef<string | null>(null);
  const pendingShareApproval = pendingApprovals.find((approval) => approval.kind === "share_operation") ?? null;
  const validationIssues = useMemo(() => validateShareForm(form, roots), [form, roots]);
  const submitDisabled = loading || submitting || Boolean(pendingShareApproval) || !sessionId;
  const statusTone = shareStatusTone(summary, loading, error);
  const metrics = summary?.metrics ?? {
    shares: form.shares.length,
    enabledProtocols: enabledProtocolCount(form),
    authenticatedProtocols: authenticatedProtocolCount(form)
  };
  const serviceIssueCount = summary?.issues.length ?? 0;
  const addShareOpen = newShare !== null;
  const displayedShares = newShare ? [...form.shares, newShare] : form.shares;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void loadShareData().finally(() => {
      if (active) {
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };

    async function loadShareData() {
      try {
        const [settings, nextSummary] = await Promise.all([getShareSettings(), getShareSummary()]);
        if (!active) {
          return;
        }
        setForm(shareSettingsToForm(settings, roots));
        setSummary(nextSummary);
        notifySummaryIssues(nextSummary.issues, onNotifyError, reportedIssueSignature);
      } catch (nextError) {
        if (active) {
          const message = errorMessage(nextError);
          setError(message);
          onNotifyError(message);
        }
      }
    }
  }, [roots]);

  useEffect(() => {
    if (!pendingShareApproval) {
      reportedPendingApprovalId.current = null;
      return;
    }
    if (reportedPendingApprovalId.current === pendingShareApproval.id) {
      return;
    }
    reportedPendingApprovalId.current = pendingShareApproval.id;
    onNotifyWarning(t("workspace.management.shares.pendingApproval"));
  }, [onNotifyWarning, pendingShareApproval, t]);

  useEffect(() => {
    if (!addShareOpen) {
      return;
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setNewShare(null);
        setNewShareError(null);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [addShareOpen]);

  async function refreshShareData() {
    setRefreshing(true);
    setError(null);
    try {
      const [settings, nextSummary] = await Promise.all([getShareSettings(), getShareSummary()]);
      setForm(shareSettingsToForm(settings, roots));
      setSummary(nextSummary);
      notifySummaryIssues(nextSummary.issues, onNotifyError, reportedIssueSignature);
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      onNotifyError(message);
    } finally {
      setRefreshing(false);
    }
  }

  async function submitProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newShare) {
      confirmAddShare();
      return;
    }
    if (!sessionId) {
      const message = t("workspace.management.shares.errors.noSession");
      setError(message);
      onNotifyError(message);
      return;
    }
    if (validationIssues.length > 0) {
      const message = validationIssueText(validationIssues[0]!, t);
      setError(message);
      onNotifyError(message);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await proposeShareSettings({
        sessionId,
        settings: shareFormToInput(form)
      });
      onNotifyWarning(t("workspace.management.shares.proposalCreated"));
      setForm((current) => ({
        ...current,
        account: {
          ...current.account,
          password: "",
          clearPassword: false
        }
      }));
      await onWorkQueuesChanged();
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      onNotifyError(message);
    } finally {
      setSubmitting(false);
    }
  }

  function updateShare(index: number, patch: Partial<ShareDefinitionFormState>) {
    if (newShare && index === form.shares.length) {
      updateNewShare(patch);
      return;
    }
    setForm((current) => ({
      ...current,
      shares: current.shares.map((share, shareIndex) =>
        shareIndex === index
          ? {
              ...share,
              ...patch
            }
          : share
      )
    }));
  }

  function updateShareProtocol<Protocol extends ShareProtocol>(
    index: number,
    protocol: Protocol,
    patch: Partial<ShareProtocolFormState[Protocol]>
  ) {
    if (newShare && index === form.shares.length) {
      updateNewShareProtocol(protocol, patch);
      return;
    }
    setForm((current) => ({
      ...current,
      shares: current.shares.map((share, shareIndex) => {
        if (shareIndex !== index) {
          return share;
        }
        return {
          ...share,
          protocols: {
            ...share.protocols,
            [protocol]: {
              ...share.protocols[protocol],
              ...patch
            }
          } as ShareProtocolFormState
        };
      })
    }));
  }

  function openAddShare() {
    setNewShare(createShareFormState(roots, form.shares));
    setNewShareError(null);
  }

  function closeAddShare() {
    setNewShare(null);
    setNewShareError(null);
  }

  function confirmAddShare() {
    if (!newShare) {
      return;
    }
    const issue = newShareValidationIssue(form, newShare, roots);
    if (issue) {
      setNewShareError(validationIssueText(issue, t));
      return;
    }
    setForm((current) => ({
      ...current,
      shares: [...current.shares, newShare]
    }));
    closeAddShare();
  }

  function updateNewShare(patch: Partial<ShareDefinitionFormState>) {
    setNewShare((current) => (current ? { ...current, ...patch } : current));
    setNewShareError(null);
  }

  function updateNewShareProtocol<Protocol extends ShareProtocol>(
    protocol: Protocol,
    patch: Partial<ShareProtocolFormState[Protocol]>
  ) {
    setNewShare((current) =>
      current
        ? {
            ...current,
            protocols: {
              ...current.protocols,
              [protocol]: {
                ...current.protocols[protocol],
                ...patch
              }
            } as ShareProtocolFormState
          }
        : current
    );
    setNewShareError(null);
  }

  function removeShare(index: number) {
    if (newShare && index === form.shares.length) {
      closeAddShare();
      return;
    }
    setForm((current) => ({
      ...current,
      shares: current.shares.filter((_, shareIndex) => shareIndex !== index)
    }));
  }

  return (
    <section className="workspace-management workspace-share-management" aria-label={t("workspace.management.shares.title")}>
      <PanelHeader
        icon={<Share2 aria-hidden="true" size={20} />}
        title={t("workspace.management.shares.title")}
        subtitle={t("workspace.management.shares.description")}
        actions={<PanelHeaderActions label={t("workspace.management.actions.label")}>
          <ManagementDashboardControls dashboard={dashboard} disabled={loading || submitting} />
          <PanelHeaderAction
            label={t("workspace.management.shares.editAccount")}
            type="button"
            onClick={() => setAccountDialogOpen(true)}
            disabled={loading || submitting}
          >
            <KeyRound aria-hidden="true" size={17} />
          </PanelHeaderAction>
          <PanelHeaderAction
            label={t("common.actions.refresh")}
            type="button"
            onClick={refreshShareData}
            disabled={loading || refreshing || submitting}
            aria-busy={loading || refreshing || undefined}
          >
            {loading || refreshing ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <RefreshCw aria-hidden="true" size={17} />}
          </PanelHeaderAction>
          <PanelHeaderAction
            label={pendingShareApproval ? t("workspace.management.actions.pendingApproval") : t("workspace.management.shares.requestApproval")}
            type="submit"
            form="share-management-form"
            disabled={submitDisabled}
            aria-busy={submitting || undefined}
          >
            {submitting ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <Share2 aria-hidden="true" size={17} />}
          </PanelHeaderAction>
        </PanelHeaderActions>}
      />

      <form id="share-management-form" className="management-body share-management-body" onSubmit={submitProposal}>
        <ManagementDashboardGrid
          dashboard={dashboard}
          loading={loading}
          items={[
              {
                id: "overview",
                title: String(t("workspace.management.shares.commandTitle")),
                content: <section className="management-command-panel">
          <div className="management-emblem" aria-hidden="true">
            <Share2 size={31} />
          </div>
          <div className="management-command-copy">
            <div>
              <span className="management-status-pill" data-state={statusTone}>
                {shareStatusLabel(summary, loading, error, t)}
              </span>
              <h3>{t("workspace.management.shares.commandTitle")}</h3>
              <p>{shareStatusDetail(summary, loading, error, t)}</p>
            </div>
            <dl className="management-fact-list">
              <div>
                <dt>{t("workspace.management.shares.facts.account")}</dt>
                <dd>{form.account.username || t("common.dash")}</dd>
              </div>
              <div>
                <dt>{t("workspace.management.shares.facts.password")}</dt>
                <dd>
                  {form.account.passwordConfigured || form.account.password
                    ? t("common.states.configured")
                    : t("settings.modelProvider.notConfiguredPlaceholder")}
                </dd>
              </div>
              <div>
                <dt>{t("workspace.management.shares.facts.updated")}</dt>
                <dd>{settingsUpdatedAtLabel(form.updatedAt, locale, t)}</dd>
              </div>
            </dl>
          </div>
        </section>
              },
              {
                id: "metric-shares",
                title: String(t("workspace.management.shares.metrics.shares")),
                content: <ShareMetric
                  Icon={Folder}
                  label={t("workspace.management.shares.metrics.shares")}
                  value={formatLocaleNumber(metrics.shares, locale)}
                  detail={t("workspace.management.shares.metrics.sharesDetail")}
                  state={metrics.shares > 0 ? "ready" : "neutral"}
                />
              },
              {
                id: "metric-protocols",
                title: String(t("workspace.management.shares.metrics.protocols")),
                content: <ShareMetric
                  Icon={Share2}
                  label={t("workspace.management.shares.metrics.protocols")}
                  value={formatLocaleNumber(metrics.enabledProtocols, locale)}
                  detail={t("workspace.management.shares.metrics.protocolsDetail")}
                  state={metrics.enabledProtocols > 0 ? "ready" : "neutral"}
                />
              },
              {
                id: "metric-authenticated",
                title: String(t("workspace.management.shares.metrics.authenticated")),
                content: <ShareMetric
                  Icon={Lock}
                  label={t("workspace.management.shares.metrics.authenticated")}
                  value={formatLocaleNumber(metrics.authenticatedProtocols, locale)}
                  detail={t("workspace.management.shares.metrics.authenticatedDetail")}
                  state={metrics.authenticatedProtocols > 0 ? "warning" : "neutral"}
                />
              },
              {
                id: "metric-issues",
                title: String(t("workspace.management.shares.metrics.issues")),
                content: <ShareMetric
                  Icon={CircleAlert}
                  label={t("workspace.management.shares.metrics.issues")}
                  value={formatLocaleNumber(serviceIssueCount, locale)}
                  detail={t("workspace.management.shares.metrics.issuesDetail")}
                  state={serviceIssueCount > 0 ? "warning" : "ready"}
                />
              },
              {
                id: "account",
                title: String(t("workspace.management.shares.publishingTitle")),
                content: <section className="management-section share-account-section">
          <SectionHeader title={t("workspace.management.shares.publishingTitle")} description={t("workspace.management.shares.publishingDescription")} />
          <fieldset className="share-field-grid share-global-settings-grid">
            <div className="share-form-field">
              <span className="share-field-label">{t("workspace.management.shares.fields.enabled")}</span>
              <SwitchControl
                checked={form.enabled}
                label={form.enabled ? t("workspace.management.shares.states.enabled") : t("workspace.management.shares.states.disabled")}
                accessibilityLabel={t("workspace.management.shares.fields.enabled")}
                onChange={(enabled) => {
                  setForm((current) => ({ ...current, enabled }));
                }}
              />
            </div>
          </fieldset>
        </section>
              },
              {
                id: "services",
                title: String(t("workspace.management.shares.servicesTitle")),
                content: <section className="management-section share-services-section">
          <SectionHeader title={t("workspace.management.shares.servicesTitle")} description={t("workspace.management.shares.servicesDescription")} />
          <div className="share-service-list">
            {SHARE_PROTOCOLS.map((protocol) => (
              <article key={protocol} className="share-service-row">
                {protocolIcon(protocol, 16)}
                <div>
                  <strong>{t(`workspace.management.shares.protocolLabels.${protocol}`)}</strong>
                  <span>{t("workspace.management.shares.enabledShares", { count: summary?.protocols[protocol].enabledShares ?? 0 })}</span>
                </div>
                <span className="management-row-status" data-state={protocolSummaryTone(summary, protocol)}>
                  {protocolSummaryLabel(summary, protocol, t)}
                </span>
              </article>
            ))}
          </div>
        </section>
              },
              {
                id: "directories",
                title: String(t("workspace.management.shares.directoriesTitle")),
                content: <section className="management-section share-directory-section">
          <header className="management-section-header">
            <div>
              <h3>{t("workspace.management.shares.directoriesTitle")}</h3>
              <p>{t("workspace.management.shares.directoriesDescription")}</p>
            </div>
            <button
              type="button"
              className="management-row-action"
              onClick={openAddShare}
              disabled={roots.length === 0 || loading || submitting}
              title={t("workspace.management.shares.addShare")}
              aria-label={t("workspace.management.shares.addShare")}
            >
              <Plus aria-hidden="true" size={13} />
              <span>{t("workspace.management.shares.addShare")}</span>
            </button>
          </header>

          <div className="share-directory-list">
            {displayedShares.length ? (
              displayedShares.map((share, index) => {
                const isNewShare = Boolean(newShare && index === form.shares.length);
                const shareCard = (
                <article key={`share-${index}`} className="share-directory-card">
                  <header className="share-directory-card-header">
                    <div>
                      <Folder aria-hidden="true" size={17} />
                      <span>
                        <strong>{share.name || share.id || t("workspace.management.shares.untitledShare")}</strong>
                        <small>
                          {rootDisplayName(share.rootId, roots)} / {share.path || "."}
                        </small>
                      </span>
                    </div>
                    <button
                      type="button"
                      className="management-icon-action is-danger"
                      onClick={() => removeShare(index)}
                      title={t("workspace.management.shares.removeShare")}
                      aria-label={t("workspace.management.shares.removeShare")}
                    >
                      <Trash2 aria-hidden="true" size={13} />
                    </button>
                  </header>

                  <div className="share-directory-fields">
                    <label>
                      <span>{t("workspace.management.shares.fields.shareName")}</span>
                      <input
                        value={share.name}
                        autoFocus={isNewShare}
                        onChange={(event) => updateShare(index, { name: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{t("workspace.management.shares.fields.shareId")}</span>
                      <input value={share.id} onChange={(event) => updateShare(index, { id: event.target.value })} />
                    </label>
                    <label>
                      <span>{t("workspace.management.shares.fields.root")}</span>
                      <select value={share.rootId} onChange={(event) => updateShare(index, { rootId: event.target.value })}>
                        {roots.length ? null : <option value="">{t("workspace.management.shares.noRoots")}</option>}
                        {roots.map((root) => (
                          <option key={root.id} value={root.id}>
                            {root.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{t("workspace.management.shares.fields.path")}</span>
                      <input value={share.path} onChange={(event) => updateShare(index, { path: event.target.value })} placeholder="." />
                    </label>
                    <label className="share-field-wide">
                      <span>{t("workspace.management.shares.fields.description")}</span>
                      <input value={share.description} onChange={(event) => updateShare(index, { description: event.target.value })} />
                    </label>
                  </div>

                  <div className="share-protocol-grid" aria-label={t("workspace.management.shares.protocolsTitle")}>
                    <ProtocolCard
                      protocol="smb"
                      enabled={share.protocols.smb.enabled}
                      t={t}
                      onEnabledChange={(enabled) => updateShareProtocol(index, "smb", { enabled })}
                    >
                      <SwitchField
                        label={t("workspace.management.shares.fields.readOnly")}
                        checked={share.protocols.smb.readOnly}
                        onChange={(readOnly) => updateShareProtocol(index, "smb", { readOnly })}
                      />
                      <SwitchField
                        label={t("workspace.management.shares.fields.browseable")}
                        checked={share.protocols.smb.browseable}
                        onChange={(browseable) => updateShareProtocol(index, "smb", { browseable })}
                      />
                      <SwitchField
                        label={t("workspace.management.shares.fields.allowGuest")}
                        checked={share.protocols.smb.allowGuest}
                        onChange={(allowGuest) => updateShareProtocol(index, "smb", { allowGuest })}
                      />
                    </ProtocolCard>

                    <ProtocolCard
                      protocol="webdav"
                      enabled={share.protocols.webdav.enabled}
                      t={t}
                      onEnabledChange={(enabled) => updateShareProtocol(index, "webdav", { enabled })}
                    >
                      <TextField
                        label={t("workspace.management.shares.fields.port")}
                        value={share.protocols.webdav.port}
                        inputMode="numeric"
                        onChange={(port) => updateShareProtocol(index, "webdav", { port })}
                      />
                      <TextField
                        label={t("workspace.management.shares.fields.pathPrefix")}
                        value={share.protocols.webdav.pathPrefix}
                        onChange={(pathPrefix) => updateShareProtocol(index, "webdav", { pathPrefix })}
                      />
                      <SwitchField
                        label={t("workspace.management.shares.fields.readOnly")}
                        checked={share.protocols.webdav.readOnly}
                        onChange={(readOnly) => updateShareProtocol(index, "webdav", { readOnly })}
                      />
                      <SwitchField
                        label={t("workspace.management.shares.fields.allowGuest")}
                        checked={share.protocols.webdav.allowGuest}
                        onChange={(allowGuest) => updateShareProtocol(index, "webdav", { allowGuest })}
                      />
                    </ProtocolCard>

                    <ProtocolCard
                      protocol="ftp"
                      enabled={share.protocols.ftp.enabled}
                      t={t}
                      onEnabledChange={(enabled) => updateShareProtocol(index, "ftp", { enabled })}
                    >
                      <TextField
                        label={t("workspace.management.shares.fields.port")}
                        value={share.protocols.ftp.port}
                        inputMode="numeric"
                        onChange={(port) => updateShareProtocol(index, "ftp", { port })}
                      />
                      <TextField
                        label={t("workspace.management.shares.fields.passiveStart")}
                        value={share.protocols.ftp.passivePortStart}
                        inputMode="numeric"
                        onChange={(passivePortStart) => updateShareProtocol(index, "ftp", { passivePortStart })}
                      />
                      <TextField
                        label={t("workspace.management.shares.fields.passiveEnd")}
                        value={share.protocols.ftp.passivePortEnd}
                        inputMode="numeric"
                        onChange={(passivePortEnd) => updateShareProtocol(index, "ftp", { passivePortEnd })}
                      />
                      <SwitchField
                        label={t("workspace.management.shares.fields.readOnly")}
                        checked={share.protocols.ftp.readOnly}
                        onChange={(readOnly) => updateShareProtocol(index, "ftp", { readOnly })}
                      />
                      <SwitchField
                        label={t("workspace.management.shares.fields.allowGuest")}
                        checked={share.protocols.ftp.allowGuest}
                        onChange={(allowGuest) => updateShareProtocol(index, "ftp", { allowGuest })}
                      />
                    </ProtocolCard>

                    <ProtocolCard
                      protocol="nfs"
                      enabled={share.protocols.nfs.enabled}
                      t={t}
                      onEnabledChange={(enabled) => updateShareProtocol(index, "nfs", { enabled })}
                    >
                      <label className="share-field-wide">
                        <span>{t("workspace.management.shares.fields.allowedCidrs")}</span>
                        <textarea
                          value={share.protocols.nfs.allowedCidrs}
                          onChange={(event) => updateShareProtocol(index, "nfs", { allowedCidrs: event.target.value })}
                          placeholder="192.168.1.0/24"
                        />
                      </label>
                      <SwitchField
                        label={t("workspace.management.shares.fields.readOnly")}
                        checked={share.protocols.nfs.readOnly}
                        onChange={(readOnly) => updateShareProtocol(index, "nfs", { readOnly })}
                      />
                      <SwitchField
                        label={t("workspace.management.shares.fields.rootSquash")}
                        checked={share.protocols.nfs.rootSquash}
                        onChange={(rootSquash) => updateShareProtocol(index, "nfs", { rootSquash })}
                      />
                    </ProtocolCard>

                    <ProtocolCard
                      protocol="dlna"
                      enabled={share.protocols.dlna.enabled}
                      t={t}
                      onEnabledChange={(enabled) => updateShareProtocol(index, "dlna", { enabled })}
                    >
                      <TextField
                        label={t("workspace.management.shares.fields.friendlyName")}
                        value={share.protocols.dlna.friendlyName}
                        onChange={(friendlyName) => updateShareProtocol(index, "dlna", { friendlyName })}
                      />
                      <TextField
                        label={t("workspace.management.shares.fields.bindInterface")}
                        value={share.protocols.dlna.bindInterface}
                        onChange={(bindInterface) => updateShareProtocol(index, "dlna", { bindInterface })}
                        placeholder="eth0"
                      />
                      <TextField
                        label={t("workspace.management.shares.fields.bindAddress")}
                        value={share.protocols.dlna.bindAddress}
                        onChange={(bindAddress) => updateShareProtocol(index, "dlna", { bindAddress })}
                        placeholder="192.168.1.10"
                      />
                      <div className="share-media-type-group">
                        <span>{t("workspace.management.shares.fields.mediaTypes")}</span>
                        <div>
                          {DLNA_MEDIA_TYPES.map((mediaType) => (
                            <CheckField
                              key={mediaType}
                              label={t(`workspace.management.shares.mediaTypes.${mediaType}`)}
                              checked={share.protocols.dlna.mediaTypes.includes(mediaType)}
                              onChange={() =>
                                updateShareProtocol(index, "dlna", {
                                  mediaTypes: toggleDlnaMediaType(share.protocols.dlna.mediaTypes, mediaType)
                                })
                              }
                            />
                          ))}
                        </div>
                      </div>
                    </ProtocolCard>
                  </div>
                </article>
                );
                if (!isNewShare) {
                  return shareCard;
                }
                return (
                  <div
                    key="add-share-modal"
                    className="management-modal-backdrop share-add-modal-backdrop"
                    role="presentation"
                    onMouseDown={(event) => event.currentTarget === event.target && closeAddShare()}
                  >
                    <section
                      className="management-modal share-add-modal"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="share-add-title"
                    >
                      <header>
                        <div>
                          <span className="eyebrow">{t("workspace.management.shares.eyebrow")}</span>
                          <h2 id="share-add-title">{t("workspace.management.shares.addShare")}</h2>
                        </div>
                        <button
                          type="button"
                          className="management-icon-action"
                          onClick={closeAddShare}
                          title={t("common.actions.cancel")}
                          aria-label={t("common.actions.cancel")}
                        >
                          <X aria-hidden="true" size={15} />
                        </button>
                      </header>
                      <div className="share-add-form">
                        <div className="share-add-form-body">
                          {shareCard}
                          {newShareError ? (
                            <p className="share-add-form-error" role="alert">
                              <CircleAlert aria-hidden="true" size={15} />
                              <span>{newShareError}</span>
                            </p>
                          ) : null}
                        </div>
                        <footer className="share-add-form-actions">
                          <button type="button" onClick={closeAddShare}>
                            {t("common.actions.cancel")}
                          </button>
                          <button type="button" className="is-primary" onClick={confirmAddShare}>
                            <Plus aria-hidden="true" size={15} />
                            <span>{t("workspace.management.shares.addShare")}</span>
                          </button>
                        </footer>
                      </div>
                    </section>
                  </div>
                );
              })
            ) : (
              <p className="management-empty">{t("workspace.management.shares.noShares")}</p>
            )}
          </div>
        </section>
              }
          ]}
        />
      </form>
      {accountDialogOpen ? (
        <ShareAccountDialog
          settings={{
            account: {
              username: form.account.username,
              passwordConfigured: form.account.passwordConfigured
            },
            updatedAt: form.updatedAt
          }}
          onClose={() => setAccountDialogOpen(false)}
          onSaved={(settings) => {
            setForm((current) => ({
              ...current,
              account: {
                username: settings.account.username,
                password: "",
                clearPassword: false,
                passwordConfigured: settings.account.passwordConfigured
              },
              updatedAt: settings.updatedAt
            }));
            void getShareSummary()
              .then((nextSummary) => {
                setSummary(nextSummary);
                notifySummaryIssues(nextSummary.issues, onNotifyError, reportedIssueSignature);
              })
              .catch((nextError) => {
                const message = errorMessage(nextError);
                setError(message);
                onNotifyError(message);
              });
          }}
        />
      ) : null}
    </section>
  );
}

function ShareMetric({
  Icon,
  label,
  value,
  detail,
  state
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  state: StatusTone;
}) {
  return (
    <article className="management-metric" data-state={state}>
      <Icon aria-hidden="true" size={18} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function ProtocolCard({
  protocol,
  enabled,
  t,
  onEnabledChange,
  children
}: {
  protocol: ShareProtocol;
  enabled: boolean;
  t: Translate;
  onEnabledChange: (enabled: boolean) => void;
  children: ReactNode;
}) {
  return (
    <section className="share-protocol-card" data-enabled={enabled}>
      <header>
        <SwitchControl
          className="share-protocol-toggle"
          checked={enabled}
          label={
            <>
              {protocolIcon(protocol, 15)}
              <span>{t(`workspace.management.shares.protocolLabels.${protocol}`)}</span>
            </>
          }
          accessibilityLabel={t(`workspace.management.shares.protocolLabels.${protocol}`)}
          onChange={onEnabledChange}
        />
        <span className="management-row-status" data-state={enabled ? "ready" : "neutral"}>
          {enabled ? t("workspace.management.shares.states.enabled") : t("workspace.management.shares.states.disabled")}
        </span>
      </header>
      <div className="share-protocol-fields">{children}</div>
    </section>
  );
}

function TextField({
  label,
  value,
  placeholder,
  inputMode,
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  inputMode?: "numeric" | "text";
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} placeholder={placeholder} inputMode={inputMode} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="share-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function SwitchField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <SwitchControl checked={checked} label={label} accessibilityLabel={label} onChange={onChange} />;
}

function SwitchControl({
  checked,
  disabled = false,
  label,
  accessibilityLabel,
  className,
  onChange
}: {
  checked: boolean;
  disabled?: boolean;
  label: ReactNode;
  accessibilityLabel: string;
  className?: string;
  onChange: (checked: boolean) => void;
}) {
  const classes = ["share-switch", disabled ? "is-disabled" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <label className={classes}>
      <input
        type="checkbox"
        role="switch"
        aria-label={accessibilityLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="share-switch-track" aria-hidden="true" />
      <span className="share-switch-copy">{label}</span>
    </label>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="management-section-header">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </header>
  );
}

function protocolIcon(protocol: ShareProtocol, size: number) {
  const Icon = PROTOCOL_ICONS[protocol];
  return <Icon aria-hidden="true" size={size} />;
}

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
  return summary?.enabled ? t("workspace.management.shares.states.enabled") : t("workspace.management.shares.states.disabled");
}

export function shareStatusDetail(summary: ShareSummary | null, loading: boolean, error: string | null, t: Translate): string {
  if (loading) {
    return t("workspace.management.shares.loading");
  }
  if (error && !summary) {
    return error;
  }
  if (!summary?.enabled) {
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
  if (!summary?.enabled || !protocolSummary || protocolSummary.enabledShares === 0) {
    return "neutral";
  }
  if (protocolSummary.services.some((service) => service.status === "failed" || service.status === "unknown")) {
    return "warning";
  }
  if (protocolSummary.services.every((service) => service.status === "active")) {
    return "ready";
  }
  return "warning";
}

function protocolSummaryLabel(summary: ShareSummary | null, protocol: ShareProtocol, t: Translate): string {
  const protocolSummary = summary?.protocols[protocol];
  if (!summary?.enabled || !protocolSummary || protocolSummary.enabledShares === 0) {
    return t("workspace.management.shares.serviceStates.disabled");
  }
  if (protocolSummary.services.every((service) => service.status === "active")) {
    return t("workspace.management.shares.serviceStates.active");
  }
  const firstProblem = protocolSummary.services.find((service) => service.status !== "active");
  return firstProblem ? t(`workspace.management.shares.serviceStates.${firstProblem.status}`) : t("common.states.unknown");
}

function settingsUpdatedAtLabel(updatedAt: string, locale: SupportedLocale, t: Translate): string {
  if (!updatedAt || updatedAt === new Date(0).toISOString()) {
    return t("workspace.management.shares.notSaved");
  }
  return formatDate(updatedAt, locale);
}

function rootDisplayName(rootId: string, roots: NasRoot[]): string {
  return roots.find((root) => root.id === rootId)?.name ?? (rootId || "-");
}

function newShareValidationIssue(
  form: ShareSettingsFormState,
  share: ShareDefinitionFormState,
  roots: NasRoot[]
): ShareFormValidationIssue | null {
  const [shareIssue] = validateShareForm(
    {
      ...form,
      enabled: false,
      account: {
        ...form.account,
        username: "zos-share"
      },
      shares: [share]
    },
    roots
  );
  if (shareIssue) {
    return shareIssue;
  }
  const id = share.id.trim();
  if (form.shares.some((existingShare) => existingShare.id.trim() === id)) {
    return {
      code: "duplicateId",
      shareName: share.name.trim() || id || "share",
      value: id
    };
  }
  if (share.protocols.ftp.enabled && form.shares.some((existingShare) => existingShare.protocols.ftp.enabled)) {
    return { code: "multipleFtp" };
  }
  return null;
}

function validationIssueText(issue: ShareFormValidationIssue, t: Translate): string {
  return t(`workspace.management.shares.validation.${issue.code}`, {
    share: issue.shareName ?? t("common.dash"),
    value: issue.value ?? t("common.dash")
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifySummaryIssues(
  issues: Array<{ source: string; message: string }>,
  onNotifyError: (message: string | null) => void,
  reportedIssueSignature: { current: string | null }
): void {
  const signature = issues.map((issue) => `${issue.source}:${issue.message}`).join("\u0000");
  if (!signature) {
    reportedIssueSignature.current = null;
    return;
  }
  if (reportedIssueSignature.current === signature) {
    return;
  }
  reportedIssueSignature.current = signature;
  onNotifyError(
    issues
      .slice(0, 3)
      .map((issue) => `${issue.source}: ${issue.message}`)
      .join(" · ")
  );
}
