import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { updateShareAccount, type ShareSettings } from "../../api.js";
import { useModalDialog } from "./useModalDialog.js";

const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;

export type ShareAccountValidationError =
  | "invalidUsername"
  | "invalidPassword"
  | "passwordMismatch"
  | null;

export function validateShareAccountDraft(
  username: string,
  password: string,
  passwordConfirmation: string
): ShareAccountValidationError {
  if (!USERNAME_PATTERN.test(username.trim())) {
    return "invalidUsername";
  }
  if (password.includes("\0") || password.includes("\n") || password.length > 256) {
    return "invalidPassword";
  }
  if (password !== passwordConfirmation) {
    return "passwordMismatch";
  }
  return null;
}

export function ShareAccountDialog({
  settings,
  onClose,
  onSaved
}: {
  settings: Pick<ShareSettings, "account" | "updatedAt">;
  onClose: () => void;
  onSaved: (settings: ShareSettings) => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState(settings.account.username);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useModalDialog(onClose, submitting);
  const validationError = useMemo(
    () => validateShareAccountDraft(username, password, passwordConfirmation),
    [password, passwordConfirmation, username]
  );
  const unchanged = username.trim() === settings.account.username && password.length === 0;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => usernameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || validationError || unchanged) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const saved = await updateShareAccount({
        username: username.trim(),
        ...(password ? { password } : {}),
        expectedUpdatedAt: settings.updatedAt
      });
      onSaved(saved);
      onClose();
    } catch (nextError) {
      setError(
        errorStatus(nextError) === 409
          ? String(t("workspace.management.shares.accountDialog.conflict"))
          : errorMessage(nextError)
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="management-modal-backdrop share-account-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="management-modal share-account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-account-dialog-title"
        tabIndex={-1}
      >
        <header>
          <div className="share-account-dialog-heading">
            <span className="share-account-dialog-icon" aria-hidden="true">
              <KeyRound size={17} />
            </span>
            <div>
              <span className="eyebrow">{t("workspace.management.shares.eyebrow")}</span>
              <h2 id="share-account-dialog-title">{t("workspace.management.shares.accountDialog.title")}</h2>
            </div>
          </div>
          <button
            type="button"
            className="management-icon-action"
            onClick={onClose}
            disabled={submitting}
            title={t("common.actions.close")}
            aria-label={t("common.actions.close")}
          >
            <X aria-hidden="true" size={15} />
          </button>
        </header>

        <form onSubmit={submit}>
          <div className="share-account-dialog-body">
            <div className="share-account-credential-status" data-configured={settings.account.passwordConfigured}>
              <KeyRound aria-hidden="true" size={16} />
              <div>
                <strong>
                  {settings.account.passwordConfigured
                    ? t("workspace.management.shares.accountDialog.passwordConfigured")
                    : t("workspace.management.shares.accountDialog.passwordNotConfigured")}
                </strong>
                <span>{t("workspace.management.shares.accountDialog.passwordStatusDetail")}</span>
              </div>
            </div>

            <label className="share-account-dialog-field">
              <span>{t("workspace.management.shares.fields.username")}</span>
              <input
                ref={usernameRef}
                value={username}
                autoComplete="username"
                disabled={submitting}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <label className="share-account-dialog-field">
              <span>{t("workspace.management.shares.accountDialog.newPassword")}</span>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                disabled={submitting}
                placeholder={
                  settings.account.passwordConfigured
                    ? t("workspace.management.shares.passwordConfiguredPlaceholder")
                    : t("workspace.management.shares.passwordPlaceholder")
                }
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <label className="share-account-dialog-field">
              <span>{t("workspace.management.shares.accountDialog.confirmPassword")}</span>
              <input
                type="password"
                value={passwordConfirmation}
                autoComplete="new-password"
                disabled={submitting}
                onChange={(event) => {
                  setPasswordConfirmation(event.target.value);
                  setError(null);
                }}
              />
            </label>

            {validationError && !unchanged ? (
              <p className="share-account-dialog-error" role="alert">
                {t(`workspace.management.shares.accountDialog.${validationError}`)}
              </p>
            ) : null}
            {error ? <p className="share-account-dialog-error" role="alert">{error}</p> : null}
          </div>

          <footer className="share-account-dialog-actions">
            <button type="button" onClick={onClose} disabled={submitting}>
              {t("common.actions.cancel")}
            </button>
            <button
              type="submit"
              className="is-primary"
              disabled={submitting || Boolean(validationError) || unchanged}
              aria-busy={submitting || undefined}
            >
              {submitting
                ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} />
                : <Save aria-hidden="true" size={15} />}
              <span>{t("common.actions.save")}</span>
            </button>
          </footer>
        </form>
      </section>
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
