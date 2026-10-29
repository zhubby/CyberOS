import { useEffect, useState, type FormEvent } from "react";
import { Activity, Check, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getMonitoringSettings,
  updateMonitoringSettings,
  type MonitoringSettings
} from "../../api.js";
import { Switch } from "../common/Switch.js";

const MIB = 1024 * 1024;

export function SettingsMonitoringPage() {
  const { t } = useTranslation();
  const [form, setForm] = useState<MonitoringSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getMonitoringSettings()
      .then((settings) => { if (active) { setForm(settings); setError(null); } })
      .catch((nextError: unknown) => { if (active) setError(nextError instanceof Error ? nextError.message : String(nextError)); });
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    try {
      setForm(await updateMonitoringSettings({
        enabled: form.enabled,
        rawRetentionDays: form.rawRetentionDays,
        minuteRetentionDays: form.minuteRetentionDays,
        hourRetentionDays: form.hourRetentionDays,
        maxDatabaseBytes: form.maxDatabaseBytes
      }));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  if (!form && !error) return <div className="settings-content-body" role="status"><LoaderCircle className="is-spinning" size={18} />{t("status.loading")}</div>;

  return <SettingsMonitoringContent form={form} busy={busy} error={error} onFormChange={setForm} onSubmit={save} />;
}

export function SettingsMonitoringContent({
  form,
  busy,
  error,
  onFormChange,
  onSubmit
}: {
  form: MonitoringSettings | null;
  busy: boolean;
  error: string | null;
  onFormChange: (form: MonitoringSettings) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <form className="settings-content-body" onSubmit={onSubmit}>
      {error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
      {form ? <div className="settings-page-grid">
        <section className="settings-section-card settings-field-wide">
          <header><div><h3>{t("settings.monitoring.title")}</h3><p>{t("settings.monitoring.description")}</p></div><Activity size={18} aria-hidden="true" /></header>
          <div className="settings-switch-row"><div><strong>{t("settings.monitoring.enabled")}</strong><span>{t("settings.monitoring.enabledDescription")}</span></div><Switch checked={form.enabled} disabled={busy} ariaLabel={t("settings.monitoring.enabled")} onCheckedChange={(enabled) => onFormChange({ ...form, enabled })} /></div>
          <fieldset className="settings-field-grid" disabled={busy}>
            <NumberField label={t("settings.monitoring.rawRetention")} value={form.rawRetentionDays} min={1} max={14} onChange={(rawRetentionDays) => onFormChange({ ...form, rawRetentionDays })} />
            <NumberField label={t("settings.monitoring.minuteRetention")} value={form.minuteRetentionDays} min={7} max={180} onChange={(minuteRetentionDays) => onFormChange({ ...form, minuteRetentionDays })} />
            <NumberField label={t("settings.monitoring.hourRetention")} value={form.hourRetentionDays} min={30} max={1825} onChange={(hourRetentionDays) => onFormChange({ ...form, hourRetentionDays })} />
            <NumberField label={t("settings.monitoring.maxDatabaseMiB")} value={Math.round(form.maxDatabaseBytes / MIB)} min={16} max={16384} onChange={(value) => onFormChange({ ...form, maxDatabaseBytes: value * MIB })} />
          </fieldset>
          <div className="settings-card-actions"><button className="primary-button" type="submit" disabled={busy} aria-busy={busy || undefined}>{busy ? <LoaderCircle className="is-spinning" size={15} /> : <Check size={15} />}{t("common.actions.saveChanges")}</button></div>
        </section>
      </div> : null}
    </form>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
