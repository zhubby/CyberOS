import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { ArchiveRestore, Check, FolderOpen, KeyRound, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  clearBackupCredential,
  getBackupDirectories,
  getBackupSettings,
  initializeBackupRepository,
  setBackupCredential,
  updateBackupSettings,
  validateBackupRepository,
  type BackupSettings
} from "../../api.js";
import { Switch } from "../common/Switch.js";
import { HelpLabel } from "../common/HelpTip.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { StorageFilePickerDialog, type StorageFilePickerPool } from "../workspace/StorageFilePickerDialog.js";

async function loadBackupDirectoryEntries(rootId: string, directory: string) {
  return (await getBackupDirectories(rootId, directory)).entries;
}

export function SettingsBackupPage({ locale }: { locale: SupportedLocale }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<BackupSettings | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedRepositoryPath, setSavedRepositoryPath] = useState<string | null>(null);
  const [pickerRoots, setPickerRoots] = useState<StorageFilePickerPool[] | null>(null);
  const repositoryPickerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let active = true;
    void getBackupSettings()
      .then((settings) => { if (active) { setForm(settings); setSavedRepositoryPath(settings.repositoryPath); setError(null); } })
      .catch((nextError: unknown) => { if (active) setError(nextError instanceof Error ? nextError.message : String(nextError)); });
    return () => { active = false; };
  }, []);

  async function run(key: string, operation: () => Promise<BackupSettings>) {
    setBusy(key);
    try {
      const next = await operation();
      setForm(next);
      setSavedRepositoryPath(next.repositoryPath);
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

  async function chooseRepository() {
    setBusy("directories");
    try {
      const { roots } = await getBackupDirectories();
      if (!roots.length) throw new Error(t("settings.backup.noLocations"));
      setPickerRoots(roots.map((root) => ({ ...root, status: "ready" })));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(null);
    }
  }

  if (!form && !error) return <div className="settings-content-body" role="status"><LoaderCircle className="is-spinning" size={18} />{t("status.loading")}</div>;

  const initialRoot = pickerRoots?.find((root) => form?.repositoryPath === root.path)
    ?? pickerRoots?.find((root) => form?.repositoryPath.startsWith(`${root.path}/`))
    ?? pickerRoots?.[0];
  const initialPath = initialRoot && form && (form.repositoryPath === initialRoot.path || form.repositoryPath.startsWith(`${initialRoot.path}/`))
    ? form.repositoryPath : initialRoot?.path;

  return <><SettingsBackupContent
    form={form}
    password={password}
    busy={busy}
    error={error}
    repositoryChanged={savedRepositoryPath !== null && form?.repositoryPath !== savedRepositoryPath}
    onChooseRepository={() => void chooseRepository()}
    repositoryPickerRef={repositoryPickerRef}
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
  />
    {pickerRoots && initialRoot ? <StorageFilePickerDialog
      pools={pickerRoots}
      initialPoolId={initialRoot.id}
      locale={locale}
      mode="directory"
      directoryPurpose="backupRepository"
      {...(initialPath ? { initialPath } : {})}
      loadEntries={loadBackupDirectoryEntries}
      returnFocusRef={repositoryPickerRef}
      onCancel={() => setPickerRoots(null)}
      onSelect={(selection) => {
        setForm((current) => !current || current.repositoryPath === selection.path ? current : {
          ...current, repositoryPath: selection.path, validatedAt: null, enabled: false
        });
        setPickerRoots(null);
      }}
    /> : null}
  </>;
}

export function SettingsBackupContent({
  form,
  password,
  busy,
  error,
  repositoryChanged = false,
  onChooseRepository,
  repositoryPickerRef,
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
  repositoryChanged?: boolean;
  onChooseRepository: () => void;
  repositoryPickerRef?: RefObject<HTMLButtonElement | null>;
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
            <label className="settings-field-wide">
              <span>{t("settings.backup.repository")}</span>
              <button ref={repositoryPickerRef} className="secondary-button settings-backup-repository-picker" type="button" onClick={onChooseRepository} disabled={busy !== null} aria-label={t("settings.backup.chooseDirectory")} aria-busy={busy === "directories" || undefined} data-tooltip={form.repositoryPath}>
                {busy === "directories" ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <FolderOpen size={15} aria-hidden="true" />}
                <span className="settings-backup-repository-path">{form.repositoryPath}</span>
                <span>{t("settings.backup.chooseDirectory")}</span>
              </button>
              {repositoryChanged ? <small role="status">{t("settings.backup.directoryPending")}</small> : null}
            </label>
            <label><span>{t("settings.backup.keepDaily")}</span><input type="number" min={1} max={365} value={form.keepDaily} onChange={(event) => onFormChange({ ...form, keepDaily: Number(event.target.value) })} /></label>
            <label><span>{t("settings.backup.keepWeekly")}</span><input type="number" min={1} max={104} value={form.keepWeekly} onChange={(event) => onFormChange({ ...form, keepWeekly: Number(event.target.value) })} /></label>
          </fieldset>
          <div className="settings-switch-row"><strong><HelpLabel label={t("settings.backup.requireMount")} content={t("settings.backup.requireMountDescription")} /></strong><Switch checked={form.requireMount} disabled={busy !== null} ariaLabel={t("settings.backup.requireMount")} onCheckedChange={(requireMount) => onFormChange({ ...form, requireMount, validatedAt: null, enabled: false })} /></div>
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
            <button className="secondary-button" type="button" disabled={busy !== null || repositoryChanged || !form.passwordConfigured} aria-busy={busy === "validate" || undefined} onClick={onValidate}>{busy === "validate" ? <LoaderCircle className="is-spinning" size={15} /> : <ShieldCheck size={15} />}{t("settings.backup.validate")}</button>
            <button className="danger-button" type="button" disabled={busy !== null || repositoryChanged || !form.passwordConfigured} aria-busy={busy === "initialize" || undefined} onClick={onInitialize}>{busy === "initialize" ? <LoaderCircle className="is-spinning" size={15} /> : <ArchiveRestore size={15} />}{t("settings.backup.initialize")}</button>
          </div>
        </section>
      </div> : null}
    </div>
  );
}
