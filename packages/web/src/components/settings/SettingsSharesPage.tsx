import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, KeyRound, LoaderCircle, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  applyShareSettings,
  getShareSettings,
  updateShareAccount,
  type ShareSettings
} from "../../api.js";
import {
  SHARE_SETTINGS_CHANGED_EVENT,
  validateShareAccountDraft
} from "../../config/share-settings.js";
import { Switch } from "../common/Switch.js";

type ShareSettingsOperation = "publishing" | "account" | null;

export function SettingsSharesPage({
  onNotifySuccess,
  onNotifyError
}: {
  onNotifySuccess: (message: string) => void;
  onNotifyError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ShareSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [busy, setBusy] = useState<ShareSettingsOperation>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getShareSettings()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setEnabled(loaded.enabled);
        setUsername(loaded.account.username);
        setError(null);
      })
      .catch((nextError: unknown) => {
        if (!active) return;
        const message = errorMessage(nextError);
        setError(message);
        onNotifyError(message);
      });
    return () => {
      active = false;
    };
  }, [onNotifyError]);

  async function savePublishing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || busy) return;
    setBusy("publishing");
    setError(null);
    try {
      const result = await applyShareSettings({ settings: { enabled } });
      setSettings(result.settings);
      setEnabled(result.settings.enabled);
      window.dispatchEvent(new Event(SHARE_SETTINGS_CHANGED_EVENT));
      onNotifySuccess(t("settings.shares.publishingSaved"));
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      onNotifyError(message);
    } finally {
      setBusy(null);
    }
  }

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || busy) return;
    const validationError = validateShareAccountDraft(username, password, passwordConfirmation);
    if (validationError) return;

    setBusy("account");
    setError(null);
    try {
      const saved = await updateShareAccount({
        username: username.trim(),
        ...(password ? { password } : {}),
        expectedUpdatedAt: settings.updatedAt
      });
      setSettings(saved);
      setUsername(saved.account.username);
      setPassword("");
      setPasswordConfirmation("");
      window.dispatchEvent(new Event(SHARE_SETTINGS_CHANGED_EVENT));
      onNotifySuccess(t("settings.shares.accountSaved"));
    } catch (nextError) {
      const message = errorStatus(nextError) === 409
        ? String(t("settings.shares.conflict"))
        : errorMessage(nextError);
      setError(message);
      onNotifyError(message);
    } finally {
      setBusy(null);
    }
  }

  if (!settings && !error) {
    return (
      <div className="settings-content-body settings-loading-state" role="status">
        <LoaderCircle className="is-spinning" aria-hidden="true" size={18} />
        <span>{t("common.states.loading")}</span>
      </div>
    );
  }

  return (
    <SettingsSharesContent
      settings={settings}
      enabled={enabled}
      username={username}
      password={password}
      passwordConfirmation={passwordConfirmation}
      busy={busy}
      error={error}
      onEnabledChange={setEnabled}
      onUsernameChange={setUsername}
      onPasswordChange={setPassword}
      onPasswordConfirmationChange={setPasswordConfirmation}
      onPublishingSubmit={savePublishing}
      onAccountSubmit={saveAccount}
    />
  );
}

export function SettingsSharesContent({
  settings,
  enabled,
  username,
  password,
  passwordConfirmation,
  busy,
  error,
  onEnabledChange,
  onUsernameChange,
  onPasswordChange,
  onPasswordConfirmationChange,
  onPublishingSubmit,
  onAccountSubmit
}: {
  settings: ShareSettings | null;
  enabled: boolean;
  username: string;
  password: string;
  passwordConfirmation: string;
  busy: ShareSettingsOperation;
  error: string | null;
  onEnabledChange: (enabled: boolean) => void;
  onUsernameChange: (username: string) => void;
  onPasswordChange: (password: string) => void;
  onPasswordConfirmationChange: (password: string) => void;
  onPublishingSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onAccountSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useTranslation();
  const validationError = useMemo(
    () => validateShareAccountDraft(username, password, passwordConfirmation),
    [password, passwordConfirmation, username]
  );
  const accountChanged = settings
    ? username.trim() !== settings.account.username || password.length > 0
    : false;
  const publishingChanged = settings ? enabled !== settings.enabled : false;
  const disabled = busy !== null || !settings;

  return (
    <div className="settings-content-body">
      {error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
      <div className="settings-page-grid settings-shares-grid">
        <form className="settings-section-card settings-field-wide" onSubmit={onPublishingSubmit}>
          <header>
            <div>
              <h3>{t("settings.shares.publishingTitle")}</h3>
              <p>{t("settings.shares.publishingDescription")}</p>
            </div>
            <Share2 aria-hidden="true" size={18} />
          </header>
          <div className="settings-switch-row">
            <div>
              <strong>{t("settings.shares.enabled")}</strong>
              <span>{enabled ? t("settings.shares.enabledDescription") : t("settings.shares.disabledDescription")}</span>
            </div>
            <Switch
              checked={enabled}
              disabled={disabled}
              ariaLabel={t("settings.shares.enabled")}
              onCheckedChange={onEnabledChange}
            />
          </div>
          <div className="settings-card-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={disabled || !publishingChanged}
              aria-busy={busy === "publishing" || undefined}
            >
              {busy === "publishing"
                ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} />
                : <Check aria-hidden="true" size={15} />}
              {t("common.actions.saveChanges")}
            </button>
          </div>
        </form>

        <form className="settings-section-card settings-field-wide" onSubmit={onAccountSubmit}>
          <header>
            <div>
              <h3>{t("settings.shares.accountTitle")}</h3>
              <p>{t("settings.shares.accountDescription")}</p>
            </div>
            <KeyRound aria-hidden="true" size={18} />
          </header>

          <div className="settings-credential-status" data-configured={settings?.account.passwordConfigured ?? false}>
            <KeyRound aria-hidden="true" size={16} />
            <div>
              <strong>
                {settings?.account.passwordConfigured
                  ? t("settings.shares.passwordConfigured")
                  : t("settings.shares.passwordNotConfigured")}
              </strong>
              <span>{t("settings.shares.passwordStatusDetail")}</span>
            </div>
          </div>

          <fieldset className="settings-field-grid" disabled={disabled}>
            <label className="settings-field-wide">
              <span>{t("settings.shares.username")}</span>
              <input
                value={username}
                autoComplete="username"
                onChange={(event) => onUsernameChange(event.target.value)}
              />
            </label>
            <label>
              <span>{t("settings.shares.newPassword")}</span>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                placeholder={settings?.account.passwordConfigured
                  ? t("settings.shares.passwordConfiguredPlaceholder")
                  : t("settings.shares.passwordPlaceholder")}
                onChange={(event) => onPasswordChange(event.target.value)}
              />
            </label>
            <label>
              <span>{t("settings.shares.confirmPassword")}</span>
              <input
                type="password"
                value={passwordConfirmation}
                autoComplete="new-password"
                onChange={(event) => onPasswordConfirmationChange(event.target.value)}
              />
            </label>
          </fieldset>

          {validationError && accountChanged ? (
            <p className="settings-inline-error" role="alert">
              {t(`settings.shares.${validationError}`)}
            </p>
          ) : null}

          <div className="settings-card-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={disabled || !accountChanged || Boolean(validationError)}
              aria-busy={busy === "account" || undefined}
            >
              {busy === "account"
                ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} />
                : <Check aria-hidden="true" size={15} />}
              {t("common.actions.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function errorStatus(error: unknown): number | null {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
