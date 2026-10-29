import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BellOff,
  Check,
  CheckCheck,
  CircleAlert,
  Eye,
  LoaderCircle,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import {
  acknowledgeMonitoringAlertIncident,
  createMonitoringAlertRule,
  createMonitoringAlertSilence,
  deleteMonitoringAlertRule,
  getMonitoringAlertIncidents,
  getMonitoringAlertIncident,
  getMonitoringAlertRules,
  getMonitoringCatalog,
  getMonitoringEscalationPolicies,
  readMonitoringAlertIncident,
  updateMonitoringAlertRule,
  type MonitoringAlertIncident,
  type MonitoringAlertIncidentDetail,
  type MonitoringAlertRule,
  type MonitoringAlertRuleInput,
  type MonitoringEscalationPolicy,
  type MonitoringCatalog
} from "../../api.js";
import { formatDate, formatLocaleNumber } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { Switch } from "../common/Switch.js";
import { useModalDialog } from "./useModalDialog.js";

type AlertView = "rules" | "incidents";
type IncidentFilter = "all" | "firing" | "resolved";

const DEFAULT_RULE: MonitoringAlertRuleInput = {
  name: "",
  enabled: false,
  metric: "cyberos_host_cpu_usage_ratio",
  selector: {},
  transform: "value",
  aggregation: "avg",
  windowSeconds: 300,
  comparator: ">",
  triggerThreshold: 0.9,
  recoveryThreshold: 0.8,
  triggerDurationSeconds: 300,
  recoveryDurationSeconds: 300,
  severity: "warning",
  noDataPolicy: "ignore",
  escalationPolicyId: null
};

export function MonitoringAlertsView({ view, locale }: { view: AlertView; locale: SupportedLocale }) {
  return view === "rules" ? <RulesView /> : <IncidentsView locale={locale} />;
}

function RulesView() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<MonitoringAlertRule[]>([]);
  const [policies, setPolicies] = useState<MonitoringEscalationPolicy[]>([]);
  const [catalog, setCatalog] = useState<MonitoringCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MonitoringAlertRule | "new" | null>(null);
  const [draft, setDraft] = useState<MonitoringAlertRuleInput>(DEFAULT_RULE);
  const [selectorText, setSelectorText] = useState("{}");
  const refreshRequestId = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestId.current;
    setLoading(true);
    try {
      const [nextRules, nextPolicies, nextCatalog] = await Promise.all([
        getMonitoringAlertRules(),
        getMonitoringEscalationPolicies(),
        getMonitoringCatalog()
      ]);
      if (requestId !== refreshRequestId.current) return;
      setRules(nextRules);
      setPolicies(nextPolicies);
      setCatalog(nextCatalog);
      setError(null);
    } catch (nextError) {
      if (requestId === refreshRequestId.current) setError(errorMessage(nextError));
    } finally {
      if (requestId === refreshRequestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  function beginEdit(rule: MonitoringAlertRule | "new") {
    setEditing(rule);
    const input = rule === "new" ? DEFAULT_RULE : rule;
    setDraft({
      name: input.name,
      enabled: input.enabled,
      metric: input.metric,
      selector: input.selector,
      transform: input.transform,
      aggregation: input.aggregation,
      windowSeconds: input.windowSeconds,
      comparator: input.comparator,
      triggerThreshold: input.triggerThreshold,
      recoveryThreshold: input.recoveryThreshold,
      triggerDurationSeconds: input.triggerDurationSeconds,
      recoveryDurationSeconds: input.recoveryDurationSeconds,
      severity: input.severity,
      noDataPolicy: input.noDataPolicy,
      escalationPolicyId: input.escalationPolicyId
    });
    setSelectorText(JSON.stringify(input.selector));
    setError(null);
  }

  async function saveRule() {
    if (!editing) return;
    setBusyId(editing === "new" ? "new" : editing.id);
    try {
      const selector = JSON.parse(selectorText) as unknown;
      if (!selector || typeof selector !== "object" || Array.isArray(selector)) throw new Error(String(t("workspace.monitoring.alerts.rules.selectorError")));
      const input = { ...draft, selector: selector as Record<string, string> };
      const saved = editing === "new"
        ? await createMonitoringAlertRule(input)
        : await updateMonitoringAlertRule({ ...editing, ...input });
      setRules((current) => {
        const exists = current.some((rule) => rule.id === saved.id);
        return exists ? current.map((rule) => rule.id === saved.id ? saved : rule) : [...current, saved];
      });
      setEditing(null);
      setError(null);
    } catch (nextError) {
      await handleRuleError(nextError);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleRule(rule: MonitoringAlertRule) {
    setBusyId(rule.id);
    try {
      const saved = await updateMonitoringAlertRule({ ...rule, enabled: !rule.enabled });
      setRules((current) => current.map((item) => item.id === saved.id ? saved : item));
      setError(null);
    } catch (nextError) {
      await handleRuleError(nextError);
    } finally {
      setBusyId(null);
    }
  }

  async function removeRule(rule: MonitoringAlertRule) {
    if (!window.confirm(String(t("workspace.monitoring.alerts.rules.confirmDelete")))) return;
    setBusyId(rule.id);
    try {
      await deleteMonitoringAlertRule(rule.id, rule.revision);
      setRules((current) => current.filter((item) => item.id !== rule.id));
      setError(null);
    } catch (nextError) {
      await handleRuleError(nextError);
    } finally {
      setBusyId(null);
    }
  }

  async function handleRuleError(error: unknown) {
    if (isRevisionConflict(error)) {
      await refresh();
      setEditing(null);
      setError(String(t("workspace.monitoring.alerts.revisionConflict")));
      return;
    }
    setError(errorMessage(error));
  }

  if (editing) {
    return <RuleEditor
      draft={draft}
      selectorText={selectorText}
      metrics={catalog?.metrics ?? []}
      policies={policies}
      busy={busyId !== null}
      builtin={editing !== "new" && editing.builtin}
      error={error}
      onChange={setDraft}
      onSelectorChange={setSelectorText}
      onCancel={() => setEditing(null)}
      onSave={() => void saveRule()}
    />;
  }

  return (
    <div className="monitoring-alert-page" role="tabpanel">
      <header className="monitoring-alert-page-header">
        <div><h3>{t("workspace.monitoring.alerts.rules.title")}</h3><p>{t("workspace.monitoring.alerts.rules.description")}</p></div>
        <div>
          <button className="icon-button" type="button" onClick={() => void refresh()} title={t("common.actions.refresh")} aria-label={t("common.actions.refresh")}>
            <RefreshCw aria-hidden="true" size={16} />
          </button>
          <button className="primary-button monitoring-alert-add" type="button" onClick={() => beginEdit("new")}>
            <Plus aria-hidden="true" size={15} />{t("workspace.monitoring.alerts.rules.add")}
          </button>
        </div>
      </header>
      {error ? <div className="monitoring-alert-error" role="alert"><CircleAlert size={16} />{error}</div> : null}
      {loading ? <LoadingState /> : rules.length === 0 ? <EmptyState text={String(t("workspace.monitoring.alerts.rules.empty"))} /> : (
        <div className="monitoring-alert-table-wrap">
          <table className="monitoring-alert-table">
            <thead><tr><th>{t("workspace.monitoring.alerts.fields.rule")}</th><th>{t("workspace.monitoring.alerts.fields.condition")}</th><th>{t("workspace.monitoring.alerts.fields.severity")}</th><th>{t("workspace.monitoring.alerts.fields.delivery")}</th><th><span className="sr-only">{t("workspace.monitoring.alerts.fields.actions")}</span></th></tr></thead>
            <tbody>{rules.map((rule) => (
              <tr key={rule.id} data-enabled={rule.enabled ? "true" : "false"}>
                <td>
                  <strong>{rule.name}</strong><small>{rule.metric}</small>
                  {rule.evaluationError ? <small className="monitoring-alert-rule-error" title={rule.evaluationError}>
                    <CircleAlert aria-hidden="true" size={12} />
                    <span>{t("workspace.monitoring.alerts.rules.evaluationError")}: {rule.evaluationError}</span>
                  </small> : null}
                </td>
                <td><span className="is-mono">{rule.aggregation}({rule.windowSeconds / 60}m) {rule.comparator} {rule.triggerThreshold}</span><small>{formatSelector(rule.selector)}</small></td>
                <td><span className="monitoring-alert-severity" data-severity={rule.severity}>{t(`workspace.monitoring.alerts.severity.${rule.severity}`)}</span></td>
                <td><Switch className="monitoring-alert-switch" compact checked={rule.enabled} disabled={busyId === rule.id} label={rule.enabled ? t("workspace.monitoring.alerts.enabled") : t("workspace.monitoring.alerts.disabled")} onCheckedChange={() => void toggleRule(rule)} /></td>
                <td><div className="monitoring-alert-row-actions">
                  <button type="button" onClick={() => beginEdit(rule)} title={t("common.actions.edit")} aria-label={t("common.actions.edit")}><Pencil size={15} /></button>
                  {!rule.builtin ? <button type="button" data-danger="true" disabled={busyId === rule.id} onClick={() => void removeRule(rule)} title={t("common.actions.delete")} aria-label={t("common.actions.delete")}><Trash2 size={15} /></button> : null}
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RuleEditor({ draft, selectorText, metrics, policies, busy, builtin, error, onChange, onSelectorChange, onCancel, onSave }: {
  draft: MonitoringAlertRuleInput;
  selectorText: string;
  metrics: MonitoringCatalog["metrics"];
  policies: MonitoringEscalationPolicy[];
  busy: boolean;
  builtin: boolean;
  error: string | null;
  onChange: (value: MonitoringAlertRuleInput) => void;
  onSelectorChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const metric = metrics.find((item) => item.name === draft.metric);
  return (
    <div className="monitoring-alert-page" role="tabpanel">
      <header className="monitoring-alert-page-header"><div><h3>{t("workspace.monitoring.alerts.editor.title")}</h3><p>{t("workspace.monitoring.alerts.editor.description")}</p></div></header>
      {error ? <div className="monitoring-alert-error" role="alert"><CircleAlert size={16} />{error}</div> : null}
      <form className="monitoring-alert-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
        <fieldset disabled={busy}>
          <label className="span-2"><span>{t("workspace.monitoring.alerts.fields.name")}</span><input required maxLength={120} value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
          <label><span>{t("workspace.monitoring.alerts.fields.metric")}</span><select value={draft.metric} onChange={(event) => {
            const selected = metrics.find((item) => item.name === event.target.value);
            onChange({ ...draft, metric: event.target.value, transform: selected?.kind === "counter" ? "rate" : "value", selector: {} });
            onSelectorChange("{}");
          }}>{metrics.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
          <label><span>{t("workspace.monitoring.alerts.fields.selector")}</span><input className="is-mono" value={selectorText} onChange={(event) => onSelectorChange(event.target.value)} placeholder="{}" /></label>
          <label><span>{t("workspace.monitoring.alerts.fields.transform")}</span><select value={draft.transform} disabled={metric?.kind === "counter"} onChange={(event) => onChange({ ...draft, transform: event.target.value as "value" | "rate" })}><option value="value">value</option><option value="rate">rate</option></select></label>
          <label><span>{t("workspace.monitoring.alerts.fields.aggregation")}</span><select value={draft.aggregation} onChange={(event) => onChange({ ...draft, aggregation: event.target.value as MonitoringAlertRuleInput["aggregation"] })}>{["last", "avg", "min", "max"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>{t("workspace.monitoring.alerts.fields.window")}</span><select value={draft.windowSeconds} onChange={(event) => onChange({ ...draft, windowSeconds: Number(event.target.value) as MonitoringAlertRuleInput["windowSeconds"] })}>{[60, 300, 900, 1800, 3600].map((value) => <option key={value} value={value}>{value / 60}m</option>)}</select></label>
          <label><span>{t("workspace.monitoring.alerts.fields.comparator")}</span><select value={draft.comparator} onChange={(event) => onChange({ ...draft, comparator: event.target.value as MonitoringAlertRuleInput["comparator"] })}>{[">", ">=", "<", "<="].map((item) => <option key={item}>{item}</option>)}</select></label>
          <NumberField label={String(t("workspace.monitoring.alerts.fields.triggerThreshold"))} value={draft.triggerThreshold} onChange={(value) => onChange({ ...draft, triggerThreshold: value })} />
          <NumberField label={String(t("workspace.monitoring.alerts.fields.recoveryThreshold"))} value={draft.recoveryThreshold} onChange={(value) => onChange({ ...draft, recoveryThreshold: value })} />
          <NumberField label={String(t("workspace.monitoring.alerts.fields.triggerDuration"))} value={draft.triggerDurationSeconds} min={0} max={86400} onChange={(value) => onChange({ ...draft, triggerDurationSeconds: value })} />
          <NumberField label={String(t("workspace.monitoring.alerts.fields.recoveryDuration"))} value={draft.recoveryDurationSeconds} min={0} max={86400} onChange={(value) => onChange({ ...draft, recoveryDurationSeconds: value })} />
          <label><span>{t("workspace.monitoring.alerts.fields.severity")}</span><select value={draft.severity} onChange={(event) => onChange({ ...draft, severity: event.target.value as MonitoringAlertRuleInput["severity"] })}><option value="warning">{t("workspace.monitoring.alerts.severity.warning")}</option><option value="critical">{t("workspace.monitoring.alerts.severity.critical")}</option></select></label>
          <label><span>{t("workspace.monitoring.alerts.fields.noData")}</span><select value={draft.noDataPolicy} onChange={(event) => onChange({ ...draft, noDataPolicy: event.target.value as MonitoringAlertRuleInput["noDataPolicy"] })}><option value="ignore">ignore</option><option value="firing">firing</option></select></label>
          <label className="span-2"><span>{t("workspace.monitoring.alerts.fields.policy")}</span><select value={draft.escalationPolicyId ?? ""} onChange={(event) => onChange({ ...draft, escalationPolicyId: event.target.value || null })}><option value="">{t("workspace.monitoring.alerts.noPolicy")}</option>{policies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name}</option>)}</select></label>
          <Switch className="monitoring-alert-check span-2" checked={draft.enabled} onCheckedChange={(enabled) => onChange({ ...draft, enabled })} label={`${t("workspace.monitoring.alerts.enabled")}${builtin ? ` · ${t("workspace.monitoring.alerts.builtin")}` : ""}`} />
        </fieldset>
        <footer><button className="secondary-button" type="button" onClick={onCancel}><X size={15} />{t("common.actions.cancel")}</button><button className="primary-button" type="submit" disabled={busy} aria-busy={busy || undefined}>{busy ? <LoaderCircle className="is-spinning" size={15} /> : <Check size={15} />}{t("common.actions.save")}</button></footer>
      </form>
    </div>
  );
}

function IncidentsView({ locale }: { locale: SupportedLocale }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<IncidentFilter>("all");
  const [incidents, setIncidents] = useState<MonitoringAlertIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailIncident, setDetailIncident] = useState<MonitoringAlertIncident | null>(null);
  const [detail, setDetail] = useState<MonitoringAlertIncidentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showSilence, setShowSilence] = useState(false);
  const refreshRequestId = useRef(0);
  const detailRequestId = useRef(0);
  const detailIncidentId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestId.current;
    setLoading(true);
    try {
      const nextIncidents = await getMonitoringAlertIncidents(filter === "all" ? undefined : filter);
      if (requestId !== refreshRequestId.current) return;
      setIncidents(nextIncidents);
      setError(null);
    } catch (nextError) {
      if (requestId === refreshRequestId.current) setError(errorMessage(nextError));
    } finally {
      if (requestId === refreshRequestId.current) setLoading(false);
    }
  }, [filter]);
  useEffect(() => void refresh(), [refresh]);

  async function openDetail(incident: MonitoringAlertIncident, silence = false) {
    const requestId = ++detailRequestId.current;
    detailIncidentId.current = incident.id;
    setDetailIncident(incident);
    setDetail(null);
    setDetailError(null);
    setShowSilence(silence);
    setDetailLoading(true);
    try {
      const nextDetail = await getMonitoringAlertIncident(incident.id);
      if (requestId === detailRequestId.current) setDetail(nextDetail);
    } catch (nextError) {
      if (requestId === detailRequestId.current) setDetailError(errorMessage(nextError));
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false);
    }
  }

  function closeDetail() {
    if (busyId) return;
    detailRequestId.current += 1;
    detailIncidentId.current = null;
    setDetailIncident(null);
    setDetail(null);
    setDetailError(null);
    setShowSilence(false);
  }

  async function apply(incident: MonitoringAlertIncident, action: "read" | "ack") {
    setBusyId(incident.id);
    try {
      const updated = action === "read"
        ? await readMonitoringAlertIncident(incident.id)
        : await acknowledgeMonitoringAlertIncident(incident.id);
      setIncidents((current) => current.map((item) => {
        if (item.id === updated.id) return updated;
        if (action === "read" && updated.source === "health"
          && item.source === "health" && item.seriesKey === updated.seriesKey) {
          return { ...item, readAt: updated.readAt, updatedAt: updated.updatedAt };
        }
        return item;
      }));
      if (detailIncidentId.current === incident.id) {
        const requestId = ++detailRequestId.current;
        const nextDetail = await getMonitoringAlertIncident(incident.id);
        if (requestId === detailRequestId.current && detailIncidentId.current === incident.id) {
          setDetail(nextDetail);
          setDetailIncident(updated);
        }
      }
      setError(null);
      setDetailError(null);
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      if (detailIncidentId.current === incident.id) setDetailError(message);
    } finally {
      setBusyId(null);
    }
  }

  async function createSilence(input: { scope: "series" | "rule"; startsAt: string; endsAt: string; reason: string }) {
    const incident = detail?.incident ?? detailIncident;
    if (!incident?.ruleId) return;
    setBusyId(incident.id);
    try {
      await createMonitoringAlertSilence({
        ruleId: incident.ruleId,
        seriesKey: input.scope === "series" ? incident.seriesKey : null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason: input.reason
      });
      const requestId = ++detailRequestId.current;
      const nextDetail = await getMonitoringAlertIncident(incident.id);
      if (requestId === detailRequestId.current && detailIncidentId.current === incident.id) {
        setDetail(nextDetail);
        setShowSilence(false);
      }
      setError(null);
    } catch (nextError) {
      setDetailError(errorMessage(nextError));
    } finally {
      setBusyId(null);
    }
  }

  const counts = useMemo(() => ({
    firing: incidents.filter((item) => item.status === "firing").length,
    unread: incidents.filter((item) => item.readAt === null).length
  }), [incidents]);

  return (
    <div className="monitoring-alert-page" role="tabpanel">
      <header className="monitoring-alert-page-header">
        <div><h3>{t("workspace.monitoring.alerts.incidents.title")}</h3><p>{t("workspace.monitoring.alerts.incidents.description", counts)}</p></div>
        <button className="icon-button" type="button" onClick={() => void refresh()} title={t("common.actions.refresh")} aria-label={t("common.actions.refresh")}><RefreshCw size={16} /></button>
      </header>
      <div className="monitoring-alert-filters" role="group" aria-label={t("workspace.monitoring.alerts.incidents.filterLabel")}>
        {(["all", "firing", "resolved"] as const).map((item) => <button key={item} type="button" aria-pressed={filter === item} className={filter === item ? "is-active" : ""} onClick={() => setFilter(item)}>{t(`workspace.monitoring.alerts.incidents.filters.${item}`)}</button>)}
      </div>
      {error ? <div className="monitoring-alert-error" role="alert"><CircleAlert size={16} />{error}</div> : null}
      {loading ? <LoadingState /> : incidents.length === 0 ? <EmptyState text={String(t("workspace.monitoring.alerts.incidents.empty"))} /> : (
        <div className="monitoring-incident-list">{incidents.map((incident) => (
          <article key={incident.id} data-status={incident.status} data-unread={incident.readAt === null ? "true" : "false"}>
            <span className="monitoring-incident-marker" aria-hidden="true" />
            <div className="monitoring-incident-main">
              <header><strong>{incident.title}</strong><span className="monitoring-alert-severity" data-severity={incident.severity}>{t(`workspace.monitoring.alerts.severity.${incident.severity}`)}</span></header>
              <p>{formatSelector(incident.labels)}{incident.currentValue === null ? "" : ` · ${formatLocaleNumber(incident.currentValue, locale, { maximumFractionDigits: 3 })}`}</p>
              <time dateTime={incident.firingAt}>{formatDate(incident.firingAt, locale)}</time>
            </div>
            <div className="monitoring-alert-row-actions">
              {incident.readAt === null ? <button type="button" disabled={busyId === incident.id} onClick={() => void apply(incident, "read")} title={t("workspace.monitoring.alerts.incidents.markRead")} aria-label={t("workspace.monitoring.alerts.incidents.markRead")}><Check size={15} /></button> : null}
              {incident.status === "firing" && incident.acknowledgedAt === null ? <button type="button" disabled={busyId === incident.id} onClick={() => void apply(incident, "ack")} title={t("workspace.monitoring.alerts.incidents.acknowledge")} aria-label={t("workspace.monitoring.alerts.incidents.acknowledge")}><CheckCheck size={15} /></button> : null}
              <button type="button" disabled={busyId === incident.id} onClick={() => void openDetail(incident)} title={t("workspace.monitoring.alerts.incidents.details")} aria-label={t("workspace.monitoring.alerts.incidents.details")}><Eye size={15} /></button>
              {incident.status === "firing" && incident.ruleId ? <button type="button" disabled={busyId === incident.id} onClick={() => void openDetail(incident, true)} title={t("workspace.monitoring.alerts.incidents.silence")} aria-label={t("workspace.monitoring.alerts.incidents.silence")}><BellOff size={15} /></button> : null}
            </div>
          </article>
        ))}</div>
      )}
      {detailIncident ? <IncidentDetailDialog
        incident={detail?.incident ?? detailIncident}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        locale={locale}
        busy={busyId === detailIncident.id}
        showSilence={showSilence}
        onShowSilence={setShowSilence}
        onClose={closeDetail}
        onRead={(incident) => void apply(incident, "read")}
        onAcknowledge={(incident) => void apply(incident, "ack")}
        onCreateSilence={(input) => void createSilence(input)}
      /> : null}
    </div>
  );
}

function IncidentDetailDialog({
  incident,
  detail,
  loading,
  error,
  locale,
  busy,
  showSilence,
  onShowSilence,
  onClose,
  onRead,
  onAcknowledge,
  onCreateSilence
}: {
  incident: MonitoringAlertIncident;
  detail: MonitoringAlertIncidentDetail | null;
  loading: boolean;
  error: string | null;
  locale: SupportedLocale;
  busy: boolean;
  showSilence: boolean;
  onShowSilence: (show: boolean) => void;
  onClose: () => void;
  onRead: (incident: MonitoringAlertIncident) => void;
  onAcknowledge: (incident: MonitoringAlertIncident) => void;
  onCreateSilence: (input: { scope: "series" | "rule"; startsAt: string; endsAt: string; reason: string }) => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useModalDialog(onClose, busy);
  const silenceScopeRef = useRef<HTMLSelectElement>(null);
  const silenceTriggerRef = useRef<HTMLButtonElement>(null);
  const previousShowSilence = useRef(false);
  const [scope, setScope] = useState<"series" | "rule">("series");
  const [startsAt, setStartsAt] = useState(() => localDateTime(new Date()));
  const [endsAt, setEndsAt] = useState(() => localDateTime(new Date(Date.now() + 60 * 60_000)));
  const [reason, setReason] = useState("");
  const validSilence = reason.trim().length > 0
    && Number.isFinite(new Date(startsAt).getTime())
    && new Date(endsAt).getTime() > new Date(startsAt).getTime();

  useEffect(() => {
    const wasVisible = previousShowSilence.current;
    previousShowSilence.current = showSilence;
    if (wasVisible === showSilence) return;
    const frame = window.requestAnimationFrame(() => {
      if (showSilence) silenceScopeRef.current?.focus();
      else (silenceTriggerRef.current ?? dialogRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dialogRef, showSilence]);

  return <div className="management-modal-backdrop monitoring-incident-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="management-modal monitoring-incident-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="monitoring-incident-detail-title">
      <header>
        <div><span className="eyebrow">{t("workspace.monitoring.alerts.incidents.detailEyebrow")}</span><h2 id="monitoring-incident-detail-title">{incident.title}</h2></div>
        <button type="button" className="management-icon-action" onClick={onClose} disabled={busy} title={t("common.actions.close")} aria-label={t("common.actions.close")}><X size={16} /></button>
      </header>
      <div className="monitoring-incident-detail-body">
        {error ? <div className="monitoring-alert-error" role="alert"><CircleAlert size={16} />{error}</div> : null}
        {loading ? <LoadingState /> : detail ? <>
          <section className="monitoring-incident-detail-section">
            <h3>{t("workspace.monitoring.alerts.incidents.overview")}</h3>
            <dl className="monitoring-incident-detail-list">
              <div><dt>{t("workspace.monitoring.alerts.fields.severity")}</dt><dd>{t(`workspace.monitoring.alerts.severity.${incident.severity}`)}</dd></div>
              <div><dt>{t("workspace.monitoring.alerts.incidents.status")}</dt><dd>{t(`workspace.monitoring.alerts.incidents.statuses.${incident.status}`)}</dd></div>
              <div><dt>{t("workspace.monitoring.alerts.incidents.series")}</dt><dd className="is-mono">{incident.seriesKey}</dd></div>
              <div><dt>{t("workspace.monitoring.alerts.incidents.firedAt")}</dt><dd>{formatDate(incident.firingAt, locale)}</dd></div>
              <div><dt>{t("workspace.monitoring.alerts.incidents.currentValue")}</dt><dd>{incident.currentValue === null ? t("common.dash") : formatLocaleNumber(incident.currentValue, locale, { maximumFractionDigits: 3 })}</dd></div>
              <div><dt>{t("workspace.monitoring.alerts.fields.selector")}</dt><dd className="is-mono">{formatSelector(incident.labels)}</dd></div>
            </dl>
          </section>
          <section className="monitoring-incident-detail-section">
            <h3>{t("workspace.monitoring.alerts.incidents.timeline")}</h3>
            <ol className="monitoring-incident-timeline">{detail.events.map((event) => <li key={event.id}><span aria-hidden="true" /><div><strong>{t(`workspace.monitoring.alerts.incidents.events.${event.type}`)}</strong><time dateTime={event.createdAt}>{formatDate(event.createdAt, locale)}</time>{Object.keys(event.details).length ? <code>{JSON.stringify(event.details)}</code> : null}</div></li>)}</ol>
          </section>
          <section className="monitoring-incident-detail-section">
            <h3>{t("workspace.monitoring.alerts.incidents.deliveries")}</h3>
            {detail.deliveries.length ? <div className="monitoring-incident-deliveries">{detail.deliveries.map((delivery) => <article key={delivery.id}><Mail size={15} aria-hidden="true" /><div><strong>{t(`workspace.monitoring.alerts.incidents.deliveryKinds.${delivery.kind}`)}</strong><span>{t(`workspace.monitoring.alerts.incidents.deliveryStatuses.${delivery.status}`)} · {t("workspace.monitoring.alerts.incidents.attempts", { count: delivery.attemptCount })}</span>{delivery.lastError ? <small>{delivery.lastError}</small> : null}</div></article>)}</div> : <p className="monitoring-incident-detail-empty">{t("workspace.monitoring.alerts.incidents.noDeliveries")}</p>}
          </section>
          <section className="monitoring-incident-detail-section monitoring-incident-snapshots">
            <h3>{t("workspace.monitoring.alerts.incidents.snapshots")}</h3>
            <details><summary>{t("workspace.monitoring.alerts.incidents.ruleSnapshot")}</summary><pre>{JSON.stringify(detail.ruleSnapshot, null, 2)}</pre></details>
            {detail.policySnapshot ? <details><summary>{t("workspace.monitoring.alerts.incidents.policySnapshot")}</summary><pre>{JSON.stringify(detail.policySnapshot, null, 2)}</pre></details> : <p className="monitoring-incident-detail-empty">{t("workspace.monitoring.alerts.incidents.noPolicySnapshot")}</p>}
          </section>
          {showSilence && incident.ruleId ? <form className="monitoring-incident-silence-form" onSubmit={(event) => { event.preventDefault(); if (validSilence) onCreateSilence({ scope, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), reason: reason.trim() }); }}>
            <h3>{t("workspace.monitoring.alerts.incidents.createSilence")}</h3>
            <div className="monitoring-incident-silence-grid">
              <label><span>{t("workspace.monitoring.alerts.incidents.silenceScope")}</span><select ref={silenceScopeRef} value={scope} onChange={(event) => setScope(event.target.value as "series" | "rule")}><option value="series">{t("workspace.monitoring.alerts.incidents.scopeSeries")}</option><option value="rule">{t("workspace.monitoring.alerts.incidents.scopeRule")}</option></select></label>
              <label><span>{t("workspace.monitoring.alerts.incidents.silenceStarts")}</span><input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
              <label><span>{t("workspace.monitoring.alerts.incidents.silenceEnds")}</span><input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
              <label className="span-2"><span>{t("workspace.monitoring.alerts.incidents.silenceReason")}</span><input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></label>
            </div>
            <div className="monitoring-incident-detail-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => onShowSilence(false)}>{t("common.actions.cancel")}</button><button type="submit" className="primary-button" disabled={busy || !validSilence}>{busy ? <LoaderCircle className="is-spinning" size={15} /> : <BellOff size={15} />}{t("workspace.monitoring.alerts.incidents.silence")}</button></div>
          </form> : null}
        </> : null}
      </div>
      <footer className="monitoring-incident-detail-footer">
        {incident.readAt === null ? <button type="button" className="secondary-button" disabled={busy} onClick={() => onRead(incident)}><Check size={15} />{t("workspace.monitoring.alerts.incidents.markRead")}</button> : null}
        {incident.status === "firing" && incident.acknowledgedAt === null ? <button type="button" className="secondary-button" disabled={busy} onClick={() => onAcknowledge(incident)}><CheckCheck size={15} />{t("workspace.monitoring.alerts.incidents.acknowledge")}</button> : null}
        {incident.status === "firing" && incident.ruleId && !showSilence ? <button ref={silenceTriggerRef} type="button" className="primary-button" disabled={busy} onClick={() => onShowSilence(true)}><BellOff size={15} />{t("workspace.monitoring.alerts.incidents.silence")}</button> : null}
      </footer>
    </section>
  </div>;
}

function localDateTime(value: Date): string {
  const offsetMs = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offsetMs).toISOString().slice(0, 16);
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" step="any" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function LoadingState() {
  const { t } = useTranslation();
  return <div className="monitoring-alert-empty" role="status"><LoaderCircle className="is-spinning" size={20} /><span>{t("common.states.loading")}</span></div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="monitoring-alert-empty"><CircleAlert size={20} /><span>{text}</span></div>;
}

function formatSelector(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(", ") : "-";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRevisionConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409;
}
