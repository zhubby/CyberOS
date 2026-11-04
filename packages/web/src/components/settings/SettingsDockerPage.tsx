import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, RefreshCw, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getDockerSummary, type DockerDaemonStatus, type DockerSummary } from "../../api.js";
import type { DockerSettingsFormState } from "../../config/settings.js";
import { parseDockerDaemonEvent, reconnectingDockerDaemonStatus } from "../../lib/docker-daemon.js";
import { HelpTip } from "../common/HelpTip.js";
import { Switch } from "../common/Switch.js";
import { DockerDaemonSettingsDialog } from "../workspace/DockerDaemonSettingsDialog.js";

export function SettingsDockerPage({
  form, loading, saving, onChange, onSubmit, onClose, onNotifySuccess
}: {
  form: DockerSettingsFormState;
  loading: boolean;
  saving: boolean;
  onChange: (form: DockerSettingsFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  onNotifySuccess: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<DockerSummary | null>(null);
  const [daemonStatus, setDaemonStatus] = useState<DockerDaemonStatus | null>(null);
  const [daemonSettingsOpen, setDaemonSettingsOpen] = useState(false);
  const [daemonLoading, setDaemonLoading] = useState(true);
  const [daemonError, setDaemonError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getDockerSummary()
      .then((next) => {
        if (!active) return;
        setSummary(next);
        setDaemonStatus((current) => current ?? next.daemon);
      })
      .catch((error: unknown) => {
        if (active) setDaemonError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { if (active) setDaemonLoading(false); });

    const source = typeof EventSource === "undefined" ? null : new EventSource("/api/docker/daemon/events");
    const handleStatus = (event: MessageEvent<string>) => {
      const next = parseDockerDaemonEvent(event.data);
      if (active && next) setDaemonStatus(next);
    };
    source?.addEventListener("docker.daemon.status", handleStatus as EventListener);
    if (source) source.onerror = () => { if (active) setDaemonStatus(reconnectingDockerDaemonStatus()); };
    return () => {
      active = false;
      source?.removeEventListener("docker.daemon.status", handleStatus as EventListener);
      source?.close();
    };
  }, []);

  async function refreshSummary() {
    setDaemonLoading(true);
    setDaemonError(null);
    try {
      const next = await getDockerSummary();
      setSummary(next);
      setDaemonStatus(next.daemon);
    } catch (error) {
      setDaemonError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setDaemonLoading(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <div className="settings-content-body">
        <div className="settings-page-grid settings-docker-grid">
          <section className="settings-section-card">
            <header>
              <div>
                <h3>{t("settings.docker.runtimeTitle")}</h3>
                <p>{t("settings.docker.runtimeDescription")}</p>
              </div>
            </header>
            <fieldset className="settings-field-grid settings-docker-runtime-grid" disabled={loading || saving}>
              <span className="help-label settings-field-wide">
                <Switch
                  checked={form.enabled}
                  label={t("settings.docker.enabledField")}
                  onCheckedChange={(enabled) => onChange({ ...form, enabled })}
                />
                <HelpTip label={t("settings.docker.enabledField")} content={t("settings.docker.socketNote")} />
              </span>
            </fieldset>
            {daemonError ? <p className="settings-inline-error" role="alert">{daemonError}</p> : null}
            <div className="settings-card-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setDaemonSettingsOpen(true)}
                disabled={loading || saving || daemonLoading || summary?.capabilities.canUpdateDaemonConfiguration !== true}
                aria-busy={daemonLoading || undefined}
              >
                {daemonLoading ? <LoaderCircle aria-hidden="true" size={15} className="is-spinning" /> : <Settings2 aria-hidden="true" size={15} />}
                {t("workspace.management.docker.daemon.title")}
              </button>
              {daemonError ? (
                <button className="secondary-button" type="button" disabled={daemonLoading} onClick={() => void refreshSummary().catch(() => {})}>
                  <RefreshCw aria-hidden="true" size={15} />
                  {t("common.actions.refresh")}
                </button>
              ) : null}
            </div>
          </section>
        </div>
      </div>
      <footer className="settings-actions">
        <span role="status">{saving ? t("common.actions.saving") : null}</span>
        <div>
          <button className="secondary-button" type="button" onClick={onClose}>
            {t("common.actions.cancel")}
          </button>
          <button className="primary-button" type="submit" disabled={loading || saving} aria-busy={loading || saving || undefined}>
            {saving ? t("common.actions.saving") : t("common.actions.saveChanges")}
          </button>
        </div>
      </footer>
      {daemonSettingsOpen ? (
        <DockerDaemonSettingsDialog
          status={daemonStatus}
          onClose={() => setDaemonSettingsOpen(false)}
          onRefreshSummary={refreshSummary}
          onNotifySuccess={onNotifySuccess}
        />
      ) : null}
    </form>
  );
}
