import { useEffect, useState, type FormEvent } from "react";
import { Check, LoaderCircle, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getSystemProfileSettings,
  updateSystemProfileSettings,
  type SystemProfileSettings
} from "../../api.js";

export function SettingsSystemProfilePage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SystemProfileSettings | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getSystemProfileSettings()
      .then((next) => {
        if (!active) return;
        setSettings(next);
        setDisplayName(next.adminDisplayName);
        setError(null);
      })
      .catch((nextError: unknown) => {
        if (active) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const next = await updateSystemProfileSettings({ adminDisplayName: displayName });
      setSettings(next);
      setDisplayName(next.adminDisplayName);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  if (!settings && !error) {
    return <div className="settings-content-body" role="status"><LoaderCircle className="is-spinning" size={18} />{t("status.loading")}</div>;
  }

  return <SettingsSystemProfileContent
    displayName={displayName}
    busy={busy}
    error={error}
    onDisplayNameChange={setDisplayName}
    onSubmit={save}
  />;
}

export function SettingsSystemProfileContent({
  displayName,
  busy,
  error,
  onDisplayNameChange,
  onSubmit
}: {
  displayName: string;
  busy: boolean;
  error: string | null;
  onDisplayNameChange: (displayName: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <form className="settings-content-body" onSubmit={onSubmit}>
      {error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
      <div className="settings-page-grid">
        <section className="settings-section-card">
          <header><div><h3>{t("settings.systemProfile.title")}</h3><p>{t("settings.systemProfile.description")}</p></div><UserRound size={18} aria-hidden="true" /></header>
          <label className="settings-field-wide">
            <span>{t("settings.systemProfile.adminDisplayName")}</span>
            <input required maxLength={80} value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} />
          </label>
          <div className="settings-card-actions">
            <button className="primary-button" type="submit" disabled={busy || !displayName.trim()} aria-busy={busy || undefined}>
              {busy ? <LoaderCircle className="is-spinning" size={15} /> : <Check size={15} />}
              {t("common.actions.saveChanges")}
            </button>
          </div>
        </section>
      </div>
    </form>
  );
}
