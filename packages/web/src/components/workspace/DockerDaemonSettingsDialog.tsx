import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, LoaderCircle, RotateCw, Save, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DockerDaemonApiError,
  getDockerDaemonConfig,
  updateDockerDaemonConfig,
  type DockerDaemonConfigSnapshot,
  type DockerDaemonStatus
} from "../../api.js";
import { dockerDaemonTone, validateDockerDaemonJson } from "../../lib/docker-daemon.js";

interface DockerDaemonSettingsDialogProps {
  status: DockerDaemonStatus | null;
  onClose: () => void;
  onRefreshSummary: () => Promise<void>;
  onNotifySuccess: (message: string) => void;
}

export function DockerDaemonSettingsDialog({
  status,
  onClose,
  onRefreshSummary,
  onNotifySuccess
}: DockerDaemonSettingsDialogProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<DockerDaemonConfigSnapshot | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"edit" | "confirm">("edit");
  const jsonValidation = useMemo(() => validateDockerDaemonJson(content), [content]);
  const tooLarge = new TextEncoder().encode(content).byteLength > 256 * 1024;
  const changed = snapshot !== null && content !== snapshot.content;
  const unavailable = status?.state === "not_installed";
  const valid = jsonValidation.valid && !tooLarge;
  const canSave = Boolean(snapshot && changed && valid && !loading && !submitting && !conflict && !unavailable);
  const canRestart = Boolean(
    snapshot &&
      (changed || snapshot.restartPending) &&
      valid &&
      !loading &&
      !submitting &&
      !conflict &&
      !unavailable
  );

  useEffect(() => {
    let active = true;
    void getDockerDaemonConfig()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setContent(next.content);
      })
      .catch((nextError: unknown) => {
        if (active) setError(errorMessage(nextError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        if (phase === "confirm") setPhase("edit");
        else onClose();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, phase, submitting]);

  async function submit(restart: boolean) {
    if (!snapshot || !valid) return;
    setSubmitting(true);
    setConflict(false);
    setError(null);
    try {
      const result = await updateDockerDaemonConfig({
        content,
        expectedRevision: snapshot.revision,
        restart,
        confirmed: restart
      });
      setSnapshot(result.snapshot);
      setContent(result.snapshot.content);
      if (restart) {
        await onRefreshSummary();
        onNotifySuccess(String(t("workspace.management.docker.daemon.restartSucceeded")));
        onClose();
      } else {
        onNotifySuccess(String(t("workspace.management.docker.daemon.saveSucceeded")));
      }
    } catch (nextError) {
      if (nextError instanceof DockerDaemonApiError) {
        setConflict(nextError.statusCode === 409);
        if (nextError.result) {
          setSnapshot(nextError.result.snapshot);
          setContent(nextError.result.snapshot.content);
          setError(
            String(
              t(
                nextError.result.rollback === "succeeded"
                  ? "workspace.management.docker.daemon.restartFailedRolledBack"
                  : "workspace.management.docker.daemon.restartFailedRollbackFailed"
              )
            )
          );
        } else {
          setError(errorMessage(nextError));
        }
      } else {
        setError(errorMessage(nextError));
      }
      setPhase("edit");
    } finally {
      setSubmitting(false);
    }
  }

  const validationMessage = tooLarge
    ? t("workspace.management.docker.daemon.validation.tooLarge")
    : jsonValidation.reason === "syntax"
      ? t("workspace.management.docker.daemon.validation.syntax")
      : jsonValidation.reason === "object"
        ? t("workspace.management.docker.daemon.validation.object")
        : t("workspace.management.docker.daemon.validation.valid");

  return (
    <div
      className="management-modal-backdrop docker-daemon-settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <section
        className="management-modal docker-daemon-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="docker-daemon-settings-title"
      >
        <header>
          <div>
            <span className="eyebrow">{t("workspace.management.docker.daemon.eyebrow")}</span>
            <h2 id="docker-daemon-settings-title">{t("workspace.management.docker.daemon.title")}</h2>
          </div>
          <button
            type="button"
            className="management-icon-action"
            onClick={onClose}
            disabled={submitting}
            aria-label={t("common.actions.close")}
            title={t("common.actions.close")}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        {phase === "confirm" ? (
          <div className="docker-daemon-confirmation">
            <AlertTriangle aria-hidden="true" size={24} />
            <div>
              <h3>{t("workspace.management.docker.daemon.confirmTitle")}</h3>
              <p>{t("workspace.management.docker.daemon.confirmDescription")}</p>
            </div>
            <dl>
              <div>
                <dt>{t("workspace.management.docker.daemon.path")}</dt>
                <dd>/etc/docker/daemon.json</dd>
              </div>
              <div>
                <dt>{t("workspace.management.docker.daemon.service")}</dt>
                <dd>docker.service</dd>
              </div>
            </dl>
            {error ? <p className="docker-daemon-error">{error}</p> : null}
          </div>
        ) : (
          <div className="docker-daemon-settings-body">
            <div className="docker-daemon-settings-meta">
              <div>
                <span>{t("workspace.management.docker.daemon.path")}</span>
                <code>{snapshot?.path ?? "/etc/docker/daemon.json"}</code>
              </div>
              <div>
                <span>{t("workspace.management.docker.daemon.serviceStatus")}</span>
                <strong data-state={status ? dockerDaemonTone(status.state) : "neutral"}>
                  {t(`workspace.management.docker.daemon.states.${status?.state ?? "reconnecting"}`)}
                </strong>
              </div>
            </div>

            {snapshot?.restartPending ? (
              <p className="docker-daemon-pending-note">{t("workspace.management.docker.daemon.restartPending")}</p>
            ) : null}
            {unavailable ? (
              <p className="docker-daemon-error">{t("workspace.management.docker.daemon.notInstalledHelp")}</p>
            ) : null}
            {error ? <p className="docker-daemon-error">{error}</p> : null}

            <label className="docker-daemon-editor-field">
              <span>{t("workspace.management.docker.daemon.editorLabel")}</span>
              <textarea
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  if (!conflict) setError(null);
                }}
                disabled={loading || submitting}
                spellCheck={false}
                aria-describedby="docker-daemon-validation"
              />
            </label>
            <div
              id="docker-daemon-validation"
              className="docker-daemon-validation"
              data-state={valid ? "ready" : "warning"}
            >
              <span>{validationMessage}</span>
              <small>{new TextEncoder().encode(content).byteLength.toLocaleString()} / 262,144 B</small>
            </div>
          </div>
        )}

        <footer className="docker-daemon-settings-footer">
          {phase === "confirm" ? (
            <>
              <button type="button" onClick={() => setPhase("edit")} disabled={submitting}>
                {t("common.actions.cancel")}
              </button>
              <button type="button" className="is-danger" onClick={() => void submit(true)} disabled={submitting} aria-busy={submitting || undefined}>
                {submitting ? <LoaderCircle aria-hidden="true" size={15} /> : <RotateCw aria-hidden="true" size={15} />}
                <span>{t("workspace.management.docker.daemon.confirmRestart")}</span>
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={submitting}>
                {t("common.actions.cancel")}
              </button>
              <div>
                <button type="button" onClick={() => void submit(false)} disabled={!canSave} aria-busy={submitting || undefined}>
                  {submitting ? <LoaderCircle aria-hidden="true" size={15} /> : <Save aria-hidden="true" size={15} />}
                  <span>{t("workspace.management.docker.daemon.save")}</span>
                </button>
                <button type="button" className="is-primary" onClick={() => setPhase("confirm")} disabled={!canRestart}>
                  <RotateCw aria-hidden="true" size={15} />
                  <span>{t("workspace.management.docker.daemon.saveRestart")}</span>
                </button>
              </div>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
