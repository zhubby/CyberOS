import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import { useTranslation } from "react-i18next";
import { Activity, AlertTriangle, Clock3, LoaderCircle, Play, Wrench } from "lucide-react";
import {
  getSystemOperations,
  runSystemOperation,
  type OpsRun,
  type OpsTask,
  type OpsTaskOverview,
  type SystemOperations
} from "../../api.js";
import { formatDate } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";

type HistoryFilter = "all" | OpsTask;

export const OPERATIONS_HISTORY_LIMIT = 5;

export function SettingsOperationsPage({
  locale,
  onClose,
  initialData = null,
  loadOperations = getSystemOperations,
  runOperation = runSystemOperation
}: {
  locale: SupportedLocale;
  onClose: () => void;
  initialData?: SystemOperations | null;
  loadOperations?: (task?: OpsTask, limit?: number) => Promise<SystemOperations>;
  runOperation?: (task: OpsTask, confirmed?: boolean) => Promise<{ task: OpsTask; accepted: true }>;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<SystemOperations | null>(initialData);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [loading, setLoading] = useState(initialData === null);
  const [error, setError] = useState<string | null>(null);
  const [runningTask, setRunningTask] = useState<OpsTask | null>(null);
  const [pendingTask, setPendingTask] = useState<OpsTask | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const maintenanceButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousRunRef = useRef<string | null>(null);

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const next = await loadOperations(filter === "all" ? undefined : filter, OPERATIONS_HISTORY_LIMIT);
      setData(next);
      setError(null);
      if (pendingTask) {
        const latest = next.tasks[pendingTask];
        if (latest.lastRunAt && latest.lastRunAt !== previousRunRef.current) {
          setPendingTask(null);
        }
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(t("settings.operations.loadFailed")));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [filter, loadOperations, pendingTask, t]);

  const active = pendingTask !== null
    || data?.tasks.health.status === "running"
    || data?.tasks.maintenance.status === "running";

  useEffect(() => {
    let disposed = false;
    const update = async (showLoading = false) => {
      if (disposed) return;
      await refresh(showLoading);
    };
    void update(data === null);
    const interval = window.setInterval(() => void update(false), operationsPollInterval(Boolean(active)));
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [active, data === null, refresh]);

  useEffect(() => {
    if (!confirmOpen) return;
    window.requestAnimationFrame(() => confirmButtonRef.current?.focus());
  }, [confirmOpen]);

  const runs = useMemo(() => data?.runs.slice(0, OPERATIONS_HISTORY_LIMIT) ?? [], [data]);

  async function trigger(task: OpsTask, confirmed = false) {
    if (runningTask || pendingTask) return;
    setRunningTask(task);
    setError(null);
    previousRunRef.current = data?.tasks[task].lastRunAt ?? null;
    try {
      await runOperation(task, confirmed);
      setPendingTask(task);
      setConfirmOpen(false);
      window.setTimeout(() => void refresh(false), 750);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(t("settings.operations.runFailed")));
    } finally {
      setRunningTask(null);
      if (task === "maintenance") restoreMaintenanceFocus(maintenanceButtonRef);
    }
  }

  function closeConfirmation() {
    setConfirmOpen(false);
    restoreMaintenanceFocus(maintenanceButtonRef);
  }

  function handleConfirmKeyDown(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeConfirmation();
      return;
    }
    if (event.key !== "Tab") return;
    const first = cancelConfirmRef.current;
    const last = confirmButtonRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="settings-form settings-operations-page">
      <div className="settings-content-body">
        <div className="settings-page-grid settings-operations-grid">
          <section className="settings-section-card settings-operations-tasks">
            <header>
              <div>
                <h3>{t("settings.operations.tasksTitle")}</h3>
                <p>{t("settings.operations.tasksDescription")}</p>
              </div>
              <Activity aria-hidden="true" size={17} />
            </header>
            <div className="settings-operations-task-list">
              <TaskRow
                icon={<Activity aria-hidden="true" size={16} />}
                task="health"
                overview={data?.tasks.health ?? null}
                schedule={String(t("settings.operations.healthSchedule"))}
                locale={locale}
                busy={runningTask === "health" || pendingTask === "health"}
                disabled={Boolean(runningTask || pendingTask)}
                onRun={() => void trigger("health")}
              />
              <TaskRow
                icon={<Wrench aria-hidden="true" size={16} />}
                task="maintenance"
                overview={data?.tasks.maintenance ?? null}
                schedule={String(t("settings.operations.maintenanceSchedule"))}
                locale={locale}
                busy={runningTask === "maintenance" || pendingTask === "maintenance"}
                disabled={Boolean(runningTask || pendingTask)}
                buttonRef={maintenanceButtonRef}
                onRun={() => setConfirmOpen(true)}
              />
            </div>
          </section>

          <section className="settings-section-card settings-operations-history">
            <header>
              <div>
                <h3>{t("settings.operations.historyTitle")}</h3>
                <p>{t("settings.operations.historyDescription")}</p>
              </div>
              <Clock3 aria-hidden="true" size={17} />
            </header>
            <div className="settings-operations-tabs" role="tablist" aria-label={t("settings.operations.historyTitle")}>
              {(["all", "health", "maintenance"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={filter === value}
                  className={filter === value ? "is-active" : undefined}
                  onClick={() => setFilter(value)}
                >
                  {t(`settings.operations.tabs.${value}`)}
                </button>
              ))}
            </div>
            {error ? (
              <div className="settings-operations-error" role="alert">
                <AlertTriangle aria-hidden="true" size={15} />
                <span>{error}</span>
                <button type="button" className="secondary-button" onClick={() => void refresh(true)}>
                  {t("common.actions.refresh")}
                </button>
              </div>
            ) : null}
            {loading && !data ? (
              <div className="settings-operations-empty" aria-busy="true">{t("common.states.loading")}</div>
            ) : runs.length === 0 ? (
              <div className="settings-operations-empty">{t("settings.operations.noHistory")}</div>
            ) : (
              <div className="settings-operations-run-list">
                {runs.map((run) => <RunRow key={run.id} run={run} locale={locale} />)}
              </div>
            )}
          </section>
        </div>
      </div>

      <footer className="settings-actions">
        <span>{error ? t("settings.operations.refreshFailed") : t("settings.operations.polling")}</span>
        <div>
          <button className="secondary-button" type="button" onClick={onClose}>{t("common.actions.close")}</button>
        </div>
      </footer>

      {confirmOpen ? (
        <div className="settings-ops-confirm-backdrop" role="presentation" onMouseDown={closeConfirmation}>
          <section
            className="settings-ops-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="settings-ops-confirm-title"
            aria-describedby="settings-ops-confirm-description"
            onKeyDown={handleConfirmKeyDown}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <AlertTriangle aria-hidden="true" size={18} />
              <div>
                <h3 id="settings-ops-confirm-title">{t("settings.operations.confirmTitle")}</h3>
                <p id="settings-ops-confirm-description">{t("settings.operations.confirmDescription")}</p>
              </div>
            </header>
            <footer>
              <button ref={cancelConfirmRef} className="secondary-button" type="button" onClick={closeConfirmation}>
                {t("common.actions.cancel")}
              </button>
              <button
                ref={confirmButtonRef}
                className="danger-button"
                type="button"
                disabled={runningTask === "maintenance"}
                onClick={() => void trigger("maintenance", true)}
              >
                {runningTask === "maintenance" ? <LoaderCircle aria-hidden="true" size={14} className="is-spinning" /> : <Play aria-hidden="true" size={14} />}
                {t("settings.operations.confirmRun")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function TaskRow({ icon, task, overview, schedule, locale, busy, disabled, buttonRef, onRun }: {
  icon: ReactNode;
  task: OpsTask;
  overview: OpsTaskOverview | null;
  schedule: string;
  locale: SupportedLocale;
  busy: boolean;
  disabled: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  const status = overview?.status ?? "never_run";
  return (
    <article className="settings-operations-task">
      <div className="settings-operations-task-icon">{icon}</div>
      <div className="settings-operations-task-main">
        <div className="settings-operations-task-title">
          <strong>{t(`settings.operations.tasks.${task}`)}</strong>
          <span data-state={status}>{t(`settings.operations.states.${status}`)}</span>
        </div>
        <small>{schedule}</small>
        <dl>
          <div><dt>{t("settings.operations.lastSuccess")}</dt><dd>{overview?.lastSuccessAt ? formatDate(overview.lastSuccessAt, locale) : t("settings.operations.never")}</dd></div>
          <div><dt>{t("settings.operations.lastDuration")}</dt><dd>{formatDurationMs(overview?.lastDurationMs ?? null, locale, String(t("settings.operations.never")))}</dd></div>
        </dl>
        {overview?.error ? <p className="settings-operations-task-error">{overview.error}</p> : null}
      </div>
      <button
        ref={buttonRef}
        type="button"
        className="settings-icon-button settings-operations-run-button"
        disabled={disabled}
        aria-busy={busy || undefined}
        aria-label={busy ? t("settings.operations.starting") : t("settings.operations.runNow")}
        title={busy ? t("settings.operations.starting") : t("settings.operations.runNow")}
        onClick={onRun}
      >
        {busy ? <LoaderCircle aria-hidden="true" size={14} className="is-spinning" /> : <Play aria-hidden="true" size={14} />}
      </button>
    </article>
  );
}

function RunRow({ run, locale }: { run: OpsRun; locale: SupportedLocale }) {
  const { t } = useTranslation();
  const duration = run.finishedAt
    ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))
    : null;
  return (
    <article className="settings-operations-run">
      <span className="settings-operations-run-icon" data-state={run.status} aria-hidden="true">
        {run.status === "running" ? <LoaderCircle size={14} className="is-spinning" /> : run.status === "completed" ? <Activity size={14} /> : <AlertTriangle size={14} />}
      </span>
      <span>
        <strong>{t(`settings.operations.tasks.${run.task}`)}</strong>
        <small>{formatDate(run.startedAt, locale)}</small>
      </span>
      <span className="settings-operations-run-result">
        <em data-state={run.status}>{t(`settings.operations.runStates.${run.status}`)}</em>
        <small>{formatDurationMs(duration, locale, String(t("settings.operations.inProgress")))}</small>
      </span>
      {run.error ? <p>{run.error}</p> : null}
    </article>
  );
}

export function operationsPollInterval(active: boolean): number {
  return active ? 5_000 : 30_000;
}

function formatDurationMs(value: number | null, locale: SupportedLocale, fallback: string): string {
  if (value === null) return fallback;
  if (value < 60_000) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1000)}s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  return `${new Intl.NumberFormat(locale).format(minutes)}m ${new Intl.NumberFormat(locale).format(seconds)}s`;
}

function restoreMaintenanceFocus(buttonRef: RefObject<HTMLButtonElement | null>) {
  window.requestAnimationFrame(() => buttonRef.current?.focus());
}
