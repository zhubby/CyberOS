import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BellOff,
  Check,
  CheckCheck,
  CircleAlert,
  LoaderCircle,
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
  getMonitoringAlertRules,
  getMonitoringCatalog,
  getMonitoringEscalationPolicies,
  readMonitoringAlertIncident,
  updateMonitoringAlertRule,
  type MonitoringAlertIncident,
  type MonitoringAlertRule,
  type MonitoringAlertRuleInput,
  type MonitoringEscalationPolicy,
  type MonitoringCatalog
} from "../../api.js";
import { formatDate, formatLocaleNumber, formatTime } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";

type AlertView = "rules" | "incidents";
type IncidentFilter = "all" | "firing" | "resolved";

const DEFAULT_RULE: MonitoringAlertRuleInput = {
  name: "",
  enabled: false,
  metric: "zos_host_cpu_usage_ratio",
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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextRules, nextPolicies, nextCatalog] = await Promise.all([
        getMonitoringAlertRules(),
        getMonitoringEscalationPolicies(),
        getMonitoringCatalog()
      ]);
      setRules(nextRules);
      setPolicies(nextPolicies);
      setCatalog(nextCatalog);
      setError(null);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoading(false);
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
                <td><button className="monitoring-alert-switch" type="button" role="switch" aria-checked={rule.enabled} disabled={busyId === rule.id} onClick={() => void toggleRule(rule)}><span />{rule.enabled ? t("workspace.monitoring.alerts.enabled") : t("workspace.monitoring.alerts.disabled")}</button></td>
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
          <label className="monitoring-alert-check span-2"><input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} /><span>{t("workspace.monitoring.alerts.enabled")}{builtin ? ` · ${t("workspace.monitoring.alerts.builtin")}` : ""}</span></label>
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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setIncidents(await getMonitoringAlertIncidents(filter === "all" ? undefined : filter));
      setError(null);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [filter]);
  useEffect(() => void refresh(), [refresh]);

  async function apply(incident: MonitoringAlertIncident, action: "read" | "ack" | "silence") {
    setBusyId(incident.id);
    try {
      if (action === "silence") {
        if (!incident.ruleId) return;
        const startsAt = new Date();
        await createMonitoringAlertSilence({
          ruleId: incident.ruleId,
          seriesKey: incident.seriesKey,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
          reason: String(t("workspace.monitoring.alerts.incidents.silenceReason"))
        });
        return;
      }
      const updated = action === "read"
        ? await readMonitoringAlertIncident(incident.id)
        : await acknowledgeMonitoringAlertIncident(incident.id);
      setIncidents((current) => current.map((item) => item.id === updated.id ? updated : item));
      setError(null);
    } catch (nextError) {
      setError(errorMessage(nextError));
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
              <time dateTime={incident.firingAt}>{formatDate(incident.firingAt, locale)} {formatTime(incident.firingAt, locale)}</time>
            </div>
            <div className="monitoring-alert-row-actions">
              {incident.readAt === null ? <button type="button" disabled={busyId === incident.id} onClick={() => void apply(incident, "read")} title={t("workspace.monitoring.alerts.incidents.markRead")} aria-label={t("workspace.monitoring.alerts.incidents.markRead")}><Check size={15} /></button> : null}
              {incident.status === "firing" && incident.acknowledgedAt === null ? <button type="button" disabled={busyId === incident.id} onClick={() => void apply(incident, "ack")} title={t("workspace.monitoring.alerts.incidents.acknowledge")} aria-label={t("workspace.monitoring.alerts.incidents.acknowledge")}><CheckCheck size={15} /></button> : null}
              {incident.status === "firing" && incident.ruleId ? <button type="button" disabled={busyId === incident.id} onClick={() => void apply(incident, "silence")} title={t("workspace.monitoring.alerts.incidents.silence")} aria-label={t("workspace.monitoring.alerts.incidents.silence")}><BellOff size={15} /></button> : null}
            </div>
          </article>
        ))}</div>
      )}
    </div>
  );
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
