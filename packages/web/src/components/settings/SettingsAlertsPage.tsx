import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BellRing, Check, CircleAlert, LoaderCircle, Mail, Pencil, Plus, Send, Trash2, Users, X } from "lucide-react";
import {
  createMonitoringAlertContact,
  createMonitoringOncallOverride,
  deleteMonitoringAlertContact,
  deleteMonitoringAlertGroup,
  deleteMonitoringAlertSilence,
  deleteMonitoringEscalationPolicy,
  deleteMonitoringOncallOverride,
  deleteMonitoringOncallSchedule,
  getMonitoringAlertContacts,
  getMonitoringAlertDelivery,
  getMonitoringAlertGroups,
  getMonitoringAlertSilences,
  getMonitoringEscalationPolicies,
  getMonitoringHealthRouting,
  getMonitoringOncallSchedules,
  getMonitoringSmtpSettings,
  saveMonitoringAlertGroup,
  saveMonitoringEscalationPolicy,
  saveMonitoringHealthRouting,
  saveMonitoringOncallSchedule,
  saveMonitoringSmtpSettings,
  testMonitoringEmail,
  updateMonitoringAlertContact,
  type MonitoringAlertContact,
  type MonitoringAlertContactGroup,
  type MonitoringAlertSilence,
  type MonitoringEscalationPolicy,
  type MonitoringHealthRouting,
  type MonitoringOncallSchedule,
  type MonitoringSmtpSettings,
  type MonitoringSmtpSettingsInput
} from "../../api.js";
import { formatDate } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { CustomSelect } from "../common/CustomSelect.js";
import { Switch } from "../common/Switch.js";

interface DirectoryState {
  contacts: MonitoringAlertContact[];
  groups: MonitoringAlertContactGroup[];
  schedules: MonitoringOncallSchedule[];
  policies: MonitoringEscalationPolicy[];
  silences: MonitoringAlertSilence[];
}

const EMPTY_DIRECTORY: DirectoryState = { contacts: [], groups: [], schedules: [], policies: [], silences: [] };
const WEEKDAY_KEYS = [
  "settings.alerts.oncall.weekdays.monday",
  "settings.alerts.oncall.weekdays.tuesday",
  "settings.alerts.oncall.weekdays.wednesday",
  "settings.alerts.oncall.weekdays.thursday",
  "settings.alerts.oncall.weekdays.friday",
  "settings.alerts.oncall.weekdays.saturday",
  "settings.alerts.oncall.weekdays.sunday"
] as const;

export function SettingsAlertsPage({ locale }: { locale: SupportedLocale }) {
  const { t } = useTranslation();
  const [smtp, setSmtp] = useState<MonitoringSmtpSettings | null>(null);
  const [smtpForm, setSmtpForm] = useState<MonitoringSmtpSettingsInput>({ enabled: false, host: "", port: 587, security: "starttls", username: "", password: "", from: "" });
  const [routing, setRouting] = useState<MonitoringHealthRouting | null>(null);
  const [directory, setDirectory] = useState<DirectoryState>(EMPTY_DIRECTORY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testRecipient, setTestRecipient] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSmtp, contacts, groups, schedules, policies, silences, nextRouting] = await Promise.all([
        getMonitoringSmtpSettings(),
        getMonitoringAlertContacts(),
        getMonitoringAlertGroups(),
        getMonitoringOncallSchedules(),
        getMonitoringEscalationPolicies(),
        getMonitoringAlertSilences(),
        getMonitoringHealthRouting()
      ]);
      setSmtp(nextSmtp);
      setSmtpForm({ enabled: nextSmtp.enabled, host: nextSmtp.host, port: nextSmtp.port, security: nextSmtp.security, username: nextSmtp.username, password: "", from: nextSmtp.from });
      setDirectory({ contacts, groups, schedules, policies, silences });
      setRouting(nextRouting);
      setError(null);
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (nextError) {
      if (isRevisionConflict(nextError)) {
        await refresh();
        setError(String(t("settings.alerts.revisionConflict")));
      } else {
        setError(message(nextError));
      }
    } finally {
      setBusy(null);
    }
  }

  async function saveSmtp() {
    if (!smtp) return;
    await run("smtp", async () => {
      const saved = await saveMonitoringSmtpSettings(smtp.revision, smtpForm);
      setSmtp(saved);
      setSmtpForm((current) => ({ ...current, password: "" }));
      setNotice(String(t("settings.alerts.saved")));
    });
  }

  async function sendTest() {
    await run("test", async () => {
      const deliveryId = await testMonitoringEmail(testRecipient);
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const delivery = await getMonitoringAlertDelivery(deliveryId);
        if (delivery.status === "succeeded" || delivery.status === "failed" || delivery.status === "cancelled") {
          const key = delivery.status === "succeeded"
            ? "settings.alerts.delivery.succeeded"
            : delivery.status === "failed"
              ? "settings.alerts.delivery.failed"
              : "settings.alerts.delivery.cancelled";
          setNotice(String(t(key)));
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      setNotice(String(t("settings.alerts.delivery.pending")));
    });
  }

  if (loading) return <div className="settings-content-body settings-alerts-loading" role="status"><LoaderCircle className="is-spinning" size={20} />{t("common.states.loading")}</div>;

  return (
    <div className="settings-content-body settings-alerts-page">
      {error ? <div className="settings-inline-alert" role="alert"><CircleAlert size={16} /><span>{error}</span></div> : null}
      {notice ? <div className="settings-inline-alert" data-tone="success" role="status"><Check size={16} /><span>{notice}</span></div> : null}

      <section className="settings-section-card settings-alerts-section">
        <header><div><h3>{t("settings.alerts.smtp.title")}</h3><p>{t("settings.alerts.smtp.description")}</p></div><Mail size={17} /></header>
        <fieldset className="settings-field-grid" disabled={busy === "smtp"}>
          <Switch className="settings-field-wide" checked={smtpForm.enabled} label={t("settings.alerts.smtp.enabled")} onCheckedChange={(enabled) => setSmtpForm({ ...smtpForm, enabled })} />
          <Field label={String(t("settings.alerts.smtp.host"))}><input value={smtpForm.host} onChange={(event) => setSmtpForm({ ...smtpForm, host: event.target.value })} /></Field>
          <Field label={String(t("settings.alerts.smtp.port"))}><input type="number" min={1} max={65535} value={smtpForm.port} onChange={(event) => setSmtpForm({ ...smtpForm, port: Number(event.target.value) })} /></Field>
          <Field label={String(t("settings.alerts.smtp.security"))}><CustomSelect<MonitoringSmtpSettingsInput["security"]> value={smtpForm.security} ariaLabel={t("settings.alerts.smtp.security")} disabled={busy === "smtp"} options={[{ value: "starttls", label: "STARTTLS" }, { value: "tls", label: "TLS" }, { value: "none", label: "None" }]} onChange={(security) => setSmtpForm({ ...smtpForm, security })} /></Field>
          <Field label={String(t("settings.alerts.smtp.username"))}><input autoComplete="username" value={smtpForm.username} onChange={(event) => setSmtpForm({ ...smtpForm, username: event.target.value })} /></Field>
          <Field label={String(t("settings.alerts.smtp.password"))}><input type="password" autoComplete="new-password" value={smtpForm.password ?? ""} placeholder={smtp?.credentialConfigured ? String(t("settings.alerts.smtp.passwordConfigured")) : ""} onChange={(event) => setSmtpForm({ ...smtpForm, password: event.target.value })} /></Field>
          <Field label={String(t("settings.alerts.smtp.from"))}><input type="email" value={smtpForm.from} onChange={(event) => setSmtpForm({ ...smtpForm, from: event.target.value })} /></Field>
        </fieldset>
        <div className="settings-alerts-actions"><button className="primary-button" type="button" disabled={busy !== null} onClick={() => void saveSmtp()}>{busy === "smtp" ? <LoaderCircle className="is-spinning" size={15} /> : <Check size={15} />}{t("common.actions.save")}</button></div>
        <div className="settings-alerts-test"><input type="email" value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} placeholder={String(t("settings.alerts.smtp.testRecipient"))} /><button className="secondary-button" type="button" disabled={busy !== null || !testRecipient || !smtp?.enabled} title={!smtp?.enabled ? String(t("settings.alerts.smtp.testDisabled")) : undefined} onClick={() => void sendTest()}>{busy === "test" ? <LoaderCircle className="is-spinning" size={15} /> : <Send size={15} />}{t("settings.alerts.smtp.sendTest")}</button></div>
      </section>

      <ContactsSection directory={directory} busy={busy} run={run} setDirectory={setDirectory} />
      <GroupsSection directory={directory} busy={busy} run={run} setDirectory={setDirectory} />
      <SchedulesSection directory={directory} busy={busy} run={run} setDirectory={setDirectory} locale={locale} />
      <PoliciesSection directory={directory} busy={busy} run={run} setDirectory={setDirectory} />
      <RoutingSection routing={routing} policies={directory.policies} busy={busy} run={run} setRouting={setRouting} />
      <SilencesSection silences={directory.silences} busy={busy} run={run} setDirectory={setDirectory} locale={locale} />
    </div>
  );
}

function ContactsSection({ directory, busy, run, setDirectory }: SectionProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [editing, setEditing] = useState<MonitoringAlertContact | null>(null);
  function reset() { setName(""); setEmail(""); setEditing(null); }
  async function save() {
    await run(editing ? `contact:${editing.id}` : "contact-new", async () => {
      const contact = editing
        ? await updateMonitoringAlertContact({ ...editing, name, email })
        : await createMonitoringAlertContact({ name, email, enabled: true });
      setDirectory((current) => ({
        ...current,
        contacts: editing
          ? current.contacts.map((item) => item.id === contact.id ? contact : item)
          : [...current.contacts, contact]
      }));
      reset();
    });
  }
  return <section className="settings-section-card settings-alerts-section"><header><div><h3>{t("settings.alerts.contacts.title")}</h3><p>{t("settings.alerts.contacts.description")}</p></div><Users size={17} /></header>
    <div className="settings-alerts-create"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={String(t("settings.alerts.contacts.name"))} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={String(t("settings.alerts.contacts.email"))} /><button type="button" className="primary-button" disabled={busy !== null || !name || !email} onClick={() => void save()}>{editing ? <Check size={15} /> : <Plus size={15} />}{editing ? t("common.actions.save") : t("settings.alerts.add")}</button>{editing ? <CancelButton onClick={reset} /> : null}</div>
    <ResourceList items={directory.contacts} render={(contact) => <><span><strong>{contact.name}</strong><small>{contact.email}</small></span><div><Switch compact checked={contact.enabled} disabled={busy !== null} label={contact.enabled ? t("settings.alerts.enabled") : t("settings.alerts.disabled")} onCheckedChange={() => void run(`contact:${contact.id}`, async () => { const saved = await updateMonitoringAlertContact({ ...contact, enabled: !contact.enabled }); setDirectory((current) => ({ ...current, contacts: current.contacts.map((item) => item.id === saved.id ? saved : item) })); })} /><EditButton onClick={() => { setEditing(contact); setName(contact.name); setEmail(contact.email); }} /><DeleteButton disabled={busy !== null} onClick={() => void run(`contact:${contact.id}`, async () => { await deleteMonitoringAlertContact(contact.id, contact.revision); setDirectory((current) => ({ ...current, contacts: current.contacts.filter((item) => item.id !== contact.id) })); })} /></div></>} />
  </section>;
}

function GroupsSection({ directory, busy, run, setDirectory }: SectionProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<MonitoringAlertContactGroup | null>(null);
  function reset() { setName(""); setContactIds([]); setEditing(null); }
  async function save() {
    await run(editing ? `group:${editing.id}` : "group-new", async () => {
      const group = await saveMonitoringAlertGroup({ ...editing, name, contactIds });
      setDirectory((current) => ({
        ...current,
        groups: editing
          ? current.groups.map((item) => item.id === group.id ? group : item)
          : [...current.groups, group]
      }));
      reset();
    });
  }
  return <section className="settings-section-card settings-alerts-section"><header><div><h3>{t("settings.alerts.groups.title")}</h3><p>{t("settings.alerts.groups.description")}</p></div></header>
    <div className="settings-alerts-create is-stacked"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={String(t("settings.alerts.groups.name"))} /><CheckList items={directory.contacts.map((item) => ({ id: item.id, label: item.name }))} selected={contactIds} onChange={setContactIds} /><div className="settings-alerts-actions"><button type="button" className="primary-button" disabled={busy !== null || !name || contactIds.length === 0} onClick={() => void save()}>{editing ? <Check size={15} /> : <Plus size={15} />}{editing ? t("common.actions.save") : t("settings.alerts.add")}</button>{editing ? <CancelButton onClick={reset} /> : null}</div></div>
    <ResourceList items={directory.groups} render={(group) => <><span><strong>{group.name}</strong><small>{t("settings.alerts.memberCount", { count: group.contactIds.length })}</small></span><div><EditButton onClick={() => { setEditing(group); setName(group.name); setContactIds(group.contactIds); }} /><DeleteButton disabled={busy !== null} onClick={() => void run(`group:${group.id}`, async () => { await deleteMonitoringAlertGroup(group.id, group.revision); setDirectory((current) => ({ ...current, groups: current.groups.filter((item) => item.id !== group.id) })); })} /></div></>} />
  </section>;
}

function SchedulesSection({ directory, busy, run, setDirectory, locale }: SectionProps & { locale: SupportedLocale }) {
  const { t } = useTranslation();
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const weekday = useMemo(() => { const day = new Date(`${today}T00:00:00Z`).getUTCDay(); return day === 0 ? 7 : day; }, [today]);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [handoffWeekday, setHandoffWeekday] = useState(weekday);
  const [handoffTime, setHandoffTime] = useState("09:00");
  const [anchorDate, setAnchorDate] = useState(today);
  const [editing, setEditing] = useState<MonitoringOncallSchedule | null>(null);
  const [overrideSchedule, setOverrideSchedule] = useState("");
  const [overrideContact, setOverrideContact] = useState("");
  const [overrideStartsAt, setOverrideStartsAt] = useState(() => localDateTimeValue(new Date()));
  const [overrideEndsAt, setOverrideEndsAt] = useState(() => localDateTimeValue(new Date(Date.now() + 24 * 60 * 60_000)));
  const [overrideReason, setOverrideReason] = useState("");
  function reset() { setName(""); setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"); setContactIds([]); setHandoffWeekday(weekday); setHandoffTime("09:00"); setAnchorDate(today); setEditing(null); }
  async function save() {
    await run(editing ? `schedule:${editing.id}` : "schedule-new", async () => {
      const schedule = await saveMonitoringOncallSchedule({ ...editing, name, timezone, handoffWeekday, handoffTime, anchorDate, contactIds });
      setDirectory((current) => ({
        ...current,
        schedules: editing
          ? current.schedules.map((item) => item.id === schedule.id ? schedule : item)
          : [...current.schedules, schedule]
      }));
      reset();
    });
  }
  return <section className="settings-section-card settings-alerts-section"><header><div><h3>{t("settings.alerts.oncall.title")}</h3><p>{t("settings.alerts.oncall.description")}</p></div></header>
    <div className="settings-alerts-create is-stacked"><div className="settings-field-grid"><Field label={String(t("settings.alerts.oncall.name"))}><input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label={String(t("settings.alerts.oncall.timezone"))}><input value={timezone} onChange={(event) => setTimezone(event.target.value)} /></Field><Field label={String(t("settings.alerts.oncall.weekday"))}><CustomSelect value={String(handoffWeekday)} ariaLabel={t("settings.alerts.oncall.weekday")} options={WEEKDAY_KEYS.map((key, index) => ({ value: String(index + 1), label: t(key) }))} onChange={(value) => setHandoffWeekday(Number(value))} /></Field><Field label={String(t("settings.alerts.oncall.handoffTime"))}><input type="time" value={handoffTime} onChange={(event) => setHandoffTime(event.target.value)} /></Field><Field label={String(t("settings.alerts.oncall.anchorDate"))}><input type="date" value={anchorDate} onChange={(event) => setAnchorDate(event.target.value)} /></Field></div><CheckList items={directory.contacts.map((item) => ({ id: item.id, label: item.name }))} selected={contactIds} onChange={setContactIds} /><div className="settings-alerts-actions"><button className="primary-button" type="button" disabled={busy !== null || !name || !timezone || !anchorDate || contactIds.length === 0} onClick={() => void save()}>{editing ? <Check size={15} /> : <Plus size={15} />}{editing ? t("common.actions.save") : t("settings.alerts.add")}</button>{editing ? <CancelButton onClick={reset} /> : null}</div></div>
    <ResourceList items={directory.schedules} render={(schedule) => <><span><strong>{schedule.name}</strong><small>{schedule.timezone} · {schedule.handoffTime} · {t("settings.alerts.memberCount", { count: schedule.contactIds.length })}</small>{schedule.overrides.map((item) => <small key={item.id}>{t("settings.alerts.oncall.overrideUntil", { value: formatDate(item.endsAt, locale) })}<button type="button" onClick={() => void run(`override:${item.id}`, async () => { await deleteMonitoringOncallOverride(item.id, item.revision); setDirectory((current) => ({ ...current, schedules: current.schedules.map((entry) => entry.id === schedule.id ? { ...entry, overrides: entry.overrides.filter((override) => override.id !== item.id) } : entry) })); })} title={t("common.actions.delete")} aria-label={t("common.actions.delete")}><Trash2 size={12} /></button></small>)}</span><div><EditButton onClick={() => { setEditing(schedule); setName(schedule.name); setTimezone(schedule.timezone); setHandoffWeekday(schedule.handoffWeekday); setHandoffTime(schedule.handoffTime); setAnchorDate(schedule.anchorDate); setContactIds(schedule.contactIds); }} /><DeleteButton disabled={busy !== null} onClick={() => void run(`schedule:${schedule.id}`, async () => { await deleteMonitoringOncallSchedule(schedule.id, schedule.revision); setDirectory((current) => ({ ...current, schedules: current.schedules.filter((item) => item.id !== schedule.id) })); })} /></div></>} />
    {directory.schedules.length && directory.contacts.length ? <div className="settings-alerts-create is-stacked"><div className="settings-field-grid"><Field label={String(t("settings.alerts.oncall.schedule"))}><CustomSelect value={overrideSchedule} ariaLabel={t("settings.alerts.oncall.schedule")} options={[{ value: "", label: t("settings.alerts.oncall.schedule") }, ...directory.schedules.map((item) => ({ value: item.id, label: item.name }))]} onChange={setOverrideSchedule} /></Field><Field label={String(t("settings.alerts.oncall.contact"))}><CustomSelect value={overrideContact} ariaLabel={t("settings.alerts.oncall.contact")} options={[{ value: "", label: t("settings.alerts.oncall.contact") }, ...directory.contacts.map((item) => ({ value: item.id, label: item.name }))]} onChange={setOverrideContact} /></Field><Field label={String(t("settings.alerts.oncall.startsAt"))}><input type="datetime-local" value={overrideStartsAt} onChange={(event) => setOverrideStartsAt(event.target.value)} /></Field><Field label={String(t("settings.alerts.oncall.endsAt"))}><input type="datetime-local" value={overrideEndsAt} onChange={(event) => setOverrideEndsAt(event.target.value)} /></Field><Field label={String(t("settings.alerts.oncall.reason"))}><input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></Field></div><button className="secondary-button" type="button" disabled={!overrideSchedule || !overrideContact || !overrideStartsAt || !overrideEndsAt || !overrideReason || busy !== null} onClick={() => void run("override-new", async () => { const override = await createMonitoringOncallOverride(overrideSchedule, { contactId: overrideContact, startsAt: new Date(overrideStartsAt).toISOString(), endsAt: new Date(overrideEndsAt).toISOString(), reason: overrideReason }); setDirectory((current) => ({ ...current, schedules: current.schedules.map((item) => item.id === overrideSchedule ? { ...item, overrides: [...item.overrides, override] } : item) })); setOverrideReason(""); })}><Plus size={15} />{t("settings.alerts.oncall.addOverride")}</button></div> : null}
  </section>;
}

function PoliciesSection({ directory, busy, run, setDirectory }: SectionProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [stages, setStages] = useState<MonitoringEscalationPolicy["stages"]>([emptyStage(0)]);
  const [editing, setEditing] = useState<MonitoringEscalationPolicy | null>(null);
  const targets = [
    ...directory.contacts.map((item) => ({ type: "contact" as const, id: item.id, label: item.name })),
    ...directory.groups.map((item) => ({ type: "group" as const, id: item.id, label: item.name })),
    ...directory.schedules.map((item) => ({ type: "oncall" as const, id: item.id, label: item.name }))
  ];
  function reset() { setName(""); setEnabled(true); setStages([emptyStage(0)]); setEditing(null); }
  function updateStage(index: number, value: MonitoringEscalationPolicy["stages"][number]) {
    setStages((current) => current.map((stage, stageIndex) => stageIndex === index ? value : stage));
  }
  async function save() {
    await run(editing ? `policy:${editing.id}` : "policy-new", async () => {
      const policy = await saveMonitoringEscalationPolicy({ ...editing, name, enabled, stages });
      setDirectory((current) => ({
        ...current,
        policies: editing
          ? current.policies.map((item) => item.id === policy.id ? policy : item)
          : [...current.policies, policy]
      }));
      reset();
    });
  }
  return <section className="settings-section-card settings-alerts-section"><header><div><h3>{t("settings.alerts.policies.title")}</h3><p>{t("settings.alerts.policies.description")}</p></div></header>
    <div className="settings-alerts-create is-stacked">
      <div className="settings-field-grid"><Field label={String(t("settings.alerts.policies.name"))}><input value={name} onChange={(event) => setName(event.target.value)} /></Field><Switch checked={enabled} label={t("settings.alerts.enabled")} onCheckedChange={setEnabled} /></div>
      <div className="settings-alerts-stages">{stages.map((stage, index) => <fieldset key={index} className="settings-alerts-stage"><legend>{t("settings.alerts.policies.stage", { count: index + 1 })}</legend><div className="settings-field-grid"><Field label={String(t("settings.alerts.policies.delay"))}><input type="number" min={index === 0 ? 0 : (stages[index - 1]?.delaySeconds ?? 0) + 1} max={604800} value={stage.delaySeconds} onChange={(event) => updateStage(index, { ...stage, delaySeconds: Number(event.target.value) })} /></Field>{index === stages.length - 1 ? <><Field label={String(t("settings.alerts.policies.repeatInterval"))}><input type="number" min={300} max={604800} value={stage.repeatIntervalSeconds ?? ""} onChange={(event) => updateStage(index, { ...stage, repeatIntervalSeconds: event.target.value ? Number(event.target.value) : null, repeatCount: event.target.value ? Math.max(1, stage.repeatCount) : 0 })} /></Field><Field label={String(t("settings.alerts.policies.repeatCount"))}><input type="number" min={0} max={10} value={stage.repeatCount} disabled={stage.repeatIntervalSeconds === null} onChange={(event) => updateStage(index, { ...stage, repeatCount: Number(event.target.value) })} /></Field></> : null}</div><CheckList items={targets.map((target) => ({ id: targetKey(target), label: target.label }))} selected={stage.targets.map(targetKey)} onChange={(values) => updateStage(index, { ...stage, targets: values.map(parseTargetKey) })} />{stages.length > 1 ? <button type="button" className="secondary-button" onClick={() => setStages((current) => current.filter((_, stageIndex) => stageIndex !== index))}><Trash2 size={14} />{t("settings.alerts.policies.removeStage")}</button> : null}</fieldset>)}</div>
      <div className="settings-alerts-actions">{stages.length < 5 ? <button type="button" className="secondary-button" onClick={() => setStages((current) => [...current, emptyStage((current.at(-1)?.delaySeconds ?? 0) + 300)])}><Plus size={15} />{t("settings.alerts.policies.addStage")}</button> : null}<button className="primary-button" type="button" disabled={!name || stages.some((stage) => stage.targets.length === 0) || busy !== null} onClick={() => void save()}>{editing ? <Check size={15} /> : <Plus size={15} />}{editing ? t("common.actions.save") : t("settings.alerts.add")}</button>{editing ? <CancelButton onClick={reset} /> : null}</div>
    </div>
    <ResourceList items={directory.policies} render={(policy) => <><span><strong>{policy.name}</strong><small>{t("settings.alerts.policies.stageCount", { count: policy.stages.length })} · {policy.enabled ? t("settings.alerts.enabled") : t("settings.alerts.disabled")}</small></span><div><EditButton onClick={() => { setEditing(policy); setName(policy.name); setEnabled(policy.enabled); setStages(policy.stages); }} /><DeleteButton disabled={busy !== null} onClick={() => void run(`policy:${policy.id}`, async () => { await deleteMonitoringEscalationPolicy(policy.id, policy.revision); setDirectory((current) => ({ ...current, policies: current.policies.filter((item) => item.id !== policy.id) })); })} /></div></>} />
  </section>;
}

function RoutingSection({ routing, policies, busy, run, setRouting }: { routing: MonitoringHealthRouting | null; policies: MonitoringEscalationPolicy[]; busy: string | null; run: Run; setRouting: (value: MonitoringHealthRouting) => void }) {
  const { t } = useTranslation();
  if (!routing) return null;
  return <section className="settings-section-card settings-alerts-section"><header><div><h3>{t("settings.alerts.routing.title")}</h3><p>{t("settings.alerts.routing.description")}</p></div><BellRing size={17} /></header><div className="settings-field-grid"><PolicySelect label={String(t("settings.alerts.routing.warning"))} value={routing.warningPolicyId} policies={policies} onChange={(warningPolicyId) => setRouting({ ...routing, warningPolicyId })} /><PolicySelect label={String(t("settings.alerts.routing.critical"))} value={routing.criticalPolicyId} policies={policies} onChange={(criticalPolicyId) => setRouting({ ...routing, criticalPolicyId })} /></div><div className="settings-alerts-actions"><button className="primary-button" type="button" disabled={busy !== null} onClick={() => void run("routing", async () => setRouting(await saveMonitoringHealthRouting(routing)))}><Check size={15} />{t("common.actions.save")}</button></div></section>;
}

function SilencesSection({ silences, busy, run, setDirectory, locale }: { silences: MonitoringAlertSilence[]; busy: string | null; run: Run; setDirectory: React.Dispatch<React.SetStateAction<DirectoryState>>; locale: SupportedLocale }) {
  const { t } = useTranslation();
  return <section className="settings-section-card settings-alerts-section"><header><div><h3>{t("settings.alerts.silences.title")}</h3><p>{t("settings.alerts.silences.description")}</p></div></header><ResourceList items={silences} render={(silence) => <><span><strong>{silence.reason}</strong><small>{formatDate(silence.startsAt, locale)} – {formatDate(silence.endsAt, locale)}</small></span><DeleteButton disabled={busy !== null} onClick={() => void run(`silence:${silence.id}`, async () => { await deleteMonitoringAlertSilence(silence.id, silence.revision); setDirectory((current) => ({ ...current, silences: current.silences.filter((item) => item.id !== silence.id) })); })} /></>} /></section>;
}

type Run = (key: string, action: () => Promise<void>) => Promise<void>;
interface SectionProps { directory: DirectoryState; busy: string | null; run: Run; setDirectory: React.Dispatch<React.SetStateAction<DirectoryState>> }

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label><span>{label}</span>{children}</label>; }
function DeleteButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) { const { t } = useTranslation(); return <button type="button" className="settings-alerts-delete" disabled={disabled} onClick={() => { if (window.confirm(String(t("settings.alerts.confirmDelete")))) onClick(); }} title={t("common.actions.delete")} aria-label={t("common.actions.delete")}><Trash2 size={14} /></button>; }
function EditButton({ onClick }: { onClick: () => void }) { const { t } = useTranslation(); return <button type="button" onClick={onClick} title={t("common.actions.edit")} aria-label={t("common.actions.edit")}><Pencil size={14} /></button>; }
function CancelButton({ onClick }: { onClick: () => void }) { const { t } = useTranslation(); return <button className="secondary-button" type="button" onClick={onClick}><X size={14} />{t("common.actions.cancel")}</button>; }
function ResourceList<T extends { id: string }>({ items, render }: { items: T[]; render: (item: T) => React.ReactNode }) { const { t } = useTranslation(); return items.length ? <div className="settings-alerts-list">{items.map((item) => <div key={item.id}>{render(item)}</div>)}</div> : <p className="settings-empty-note">{t("settings.alerts.empty")}</p>; }
function CheckList({ items, selected, onChange }: { items: Array<{ id: string; label: string }>; selected: string[]; onChange: (ids: string[]) => void }) { return <div className="settings-alerts-check-list">{items.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => onChange(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} /><span>{item.label}</span></label>)}</div>; }
function PolicySelect({ label, value, policies, onChange }: { label: string; value: string | null; policies: MonitoringEscalationPolicy[]; onChange: (id: string | null) => void }) { const { t } = useTranslation(); return <Field label={label}><CustomSelect value={value ?? ""} ariaLabel={label} options={[{ value: "", label: t("workspace.monitoring.alerts.noPolicy") }, ...policies.map((policy) => ({ value: policy.id, label: policy.name }))]} onChange={(id) => onChange(id || null)} /></Field>; }
type EscalationTarget = MonitoringEscalationPolicy["stages"][number]["targets"][number];
function emptyStage(delaySeconds: number): MonitoringEscalationPolicy["stages"][number] { return { delaySeconds, repeatIntervalSeconds: null, repeatCount: 0, targets: [] }; }
function targetKey(target: EscalationTarget): string { return `${target.type}:${target.id}`; }
function parseTargetKey(value: string): EscalationTarget {
  const separator = value.indexOf(":");
  return { type: value.slice(0, separator) as EscalationTarget["type"], id: value.slice(separator + 1) };
}
function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function isRevisionConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409;
}
