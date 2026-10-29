import { useEffect, useState, type FormEvent } from "react";
import { ArchiveRestore, Check, KeyRound, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  clearBackupCredential,
  getBackupSettings,
  initializeBackupRepository,
  setBackupCredential,
  updateBackupSettings,
  validateBackupRepository,
  type BackupSettings
} from "../../api.js";
import { Switch } from "../common/Switch.js";

export function SettingsBackupPage() {
  const { t } = useTranslation();
  const [form, setForm] = useState<BackupSettings | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getBackupSettings()
      .then((settings) => { if (active) { setForm(settings); setError(null); } })
      .catch((nextError: unknown) => { if (active) setError(nextError instanceof Error ? nextError.message : String(nextError)); });
    return () => { active = false; };
  }, []);

  async function run(key: string, operation: () => Promise<BackupSettings>) {
    setBusy(key);
    try {
      setForm(await operation());
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(null);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    await run("settings", () => updateBackupSettings({
      enabled: form.enabled,
      repositoryPath: form.repositoryPath,
      requireMount: form.requireMount,
      keepDaily: form.keepDaily,
      keepWeekly: form.keepWeekly
    }));
  }

  if (!form && !error) return <div className="settings-content-body" role="status"><LoaderCircle className="is-spinning" size={18} />{t("status.loading")}</div>;

  return <SettingsBackupContent
    form={form}
    password={password}
    busy={busy}
    error={error}
    onFormChange={setForm}
    onPasswordChange={setPassword}
    onSubmit={save}
    onClearCredential={() => void run("clear", () => clearBackupCredential())}
    onSaveCredential={() => void run("credential", async () => {
      const next = await setBackupCredential(password);
      setPassword("");
      return next;
    })}
    onValidate={() => void run("validate", () => validateBackupRepository())}
    onInitialize={() => {
      if (window.confirm(t("settings.backup.initializeConfirm"))) {
        void run("initialize", () => initializeBackupRepository(true));
      }
    }}
  />;
}

export function SettingsBackupContent({
  form,
  password,
  busy,
  error,
  onFormChange,
  onPasswordChange,
  onSubmit,
  onClearCredential,
  onSaveCredential,
  onValidate,
  onInitialize
}: {
  form: BackupSettings | null;
  password: string;
  busy: string | null;
  error: string | null;
  onFormChange: (form: BackupSettings) => void;
  onPasswordChange: (password: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClearCredential: () => void;
  onSaveCredential: () => void;
  onValidate: () => void;
  onInitialize: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-content-body">
      {error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
      {form ? <div className="settings-page-grid">
        <form className="settings-section-card settings-field-wide" onSubmit={onSubmit}>
          <header><div><h3>{t("settings.backup.title")}</h3><p>{t("settings.backup.description")}</p></div><ArchiveRestore size={18} aria-hidden="true" /></header>
          <div className="settings-switch-row"><div><strong>{t("settings.backup.enabled")}</strong><span>{form.validatedAt ? t("settings.backup.validated") : t("settings.backup.validationRequired")}</span></div><Switch checked={form.enabled} disabled={busy !== null || (!form.validatedAt && !form.enabled)} ariaLabel={t("settings.backup.enabled")} onCheckedChange={(enabled) => onFormChange({ ...form, enabled })} /></div>
          <fieldset className="settings-field-grid" disabled={busy !== null}>
            <label className="settings-field-wide"><span>{t("settings.backup.repository")}</span><input required value={form.repositoryPath} onChange={(event) => onFormChange({ ...form, repositoryPath: event.target.value, validatedAt: null, enabled: false })} /></label>
            <label><span>{t("settings.backup.keepDaily")}</span><input type="number" min={1} max={365} value={form.keepDaily} onChange={(event) => onFormChange({ ...form, keepDaily: Number(event.target.value) })} /></label>
            <label><span>{t("settings.backup.keepWeekly")}</span><input type="number" min={1} max={104} value={form.keepWeekly} onChange={(event) => onFormChange({ ...form, keepWeekly: Number(event.target.value) })} /></label>
          </fieldset>
          <div className="settings-switch-row"><div><strong>{t("settings.backup.requireMount")}</strong><span>{t("settings.backup.requireMountDescription")}</span></div><Switch checked={form.requireMount} disabled={busy !== null} ariaLabel={t("settings.backup.requireMount")} onCheckedChange={(requireMount) => onFormChange({ ...form, requireMount, validatedAt: null, enabled: false })} /></div>
          <div className="settings-card-actions"><button className="primary-button" type="submit" disabled={busy !== null} aria-busy={busy === "settings" || undefined}>{busy === "settings" ? <LoaderCircle className="is-spinning" size={15} /> : <Check size={15} />}{t("common.actions.saveChanges")}</button></div>
        </form>

        <section className="settings-section-card">
          <header><div><h3>{t("settings.backup.credentialTitle")}</h3><p>{form.passwordConfigured ? t("settings.backup.credentialConfigured") : t("settings.backup.credentialMissing")}</p></div><KeyRound size={18} aria-hidden="true" /></header>
          <label className="settings-field-wide"><span>{t("settings.backup.password")}</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => onPasswordChange(event.target.value)} /></label>
          <div className="settings-card-actions">
            <button className="secondary-button" type="button" disabled={busy !== null || !form.passwordConfigured} onClick={onClearCredential}><Trash2 size={15} />{t("common.actions.clear")}</button>
            <button className="primary-button" type="button" disabled={busy !== null || !password} aria-busy={busy === "credential" || undefined} onClick={onSaveCredential}>{busy === "credential" ? <LoaderCircle className="is-spinning" size={15} /> : <Check size={15} />}{t("common.actions.save")}</button>
          </div>
        </section>

        <section className="settings-section-card">
          <header><div><h3>{t("settings.backup.repositoryActions")}</h3><p>{t("settings.backup.repositoryActionsDescription")}</p></div><ShieldCheck size={18} aria-hidden="true" /></header>
          <div className="settings-card-actions is-stacked">
            <button className="secondary-button" type="button" disabled={busy !== null || !form.passwordConfigured} aria-busy={busy === "validate" || undefined} onClick={onValidate}>{busy === "validate" ? <LoaderCircle className="is-spinning" size={15} /> : <ShieldCheck size={15} />}{t("settings.backup.validate")}</button>
            <button className="danger-button" type="button" disabled={busy !== null || !form.passwordConfigured} aria-busy={busy === "initialize" || undefined} onClick={onInitialize}>{busy === "initialize" ? <LoaderCircle className="is-spinning" size={15} /> : <ArchiveRestore size={15} />}{t("settings.backup.initialize")}</button>
          </div>
        </section>
      </div> : null}
    </div>
  );
}
