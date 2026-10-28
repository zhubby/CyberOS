import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AlertTriangle,
  Check,
  Code2,
  LoaderCircle,
  Plus,
  Rocket,
  Save,
  Trash2,
  X
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createDockerComposeApp,
  deleteDockerComposeApp,
  getDockerComposeApp,
  updateDockerComposeApp,
  validateDockerComposeApp,
  type DockerComposeApp,
  type DockerComposeAppDetail
} from "../../api.js";
import {
  dockerComposeAppForm,
  dockerComposeAppFormError,
  dockerComposeCreateEnvironment,
  dockerComposeProjectKey,
  dockerComposeUpdateEnvironment,
  initialDockerComposeAppForm,
  type DockerComposeAppForm
} from "../../lib/docker-compose-apps.js";
import { HostAccessPicker } from "./HostAccessPicker.js";

interface DockerComposeAppDialogProps {
  app: DockerComposeApp | null;
  engineReady: boolean;
  canDeploy: boolean;
  deleteInitially?: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onRequestDeploy: (app: DockerComposeApp) => Promise<boolean>;
  onNotifySuccess: (message: string) => void;
}

type SubmitAction = "save" | "deploy" | null;

export function DockerComposeAppDialog({
  app,
  engineReady,
  canDeploy,
  deleteInitially = false,
  onClose,
  onRefresh,
  onRequestDeploy,
  onNotifySuccess
}: DockerComposeAppDialogProps) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<DockerComposeAppDetail | null>(null);
  const [form, setForm] = useState<DockerComposeAppForm>(initialDockerComposeAppForm);
  const [loading, setLoading] = useState(Boolean(app));
  const [dirty, setDirty] = useState(false);
  const [keyEdited, setKeyEdited] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<Awaited<ReturnType<typeof validateDockerComposeApp>> | null>(null);
  const [submitAction, setSubmitAction] = useState<SubmitAction>(null);
  const [confirmDelete, setConfirmDelete] = useState(deleteInitially);
  const [deleting, setDeleting] = useState(false);
  const [composeUnavailable, setComposeUnavailable] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hostAccessService, setHostAccessService] = useState("");
  const [hostAccessBlocked, setHostAccessBlocked] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const formError = useMemo(() => dockerComposeAppFormError(form), [form]);
  const busy = loading || validating || submitAction !== null || deleting;
  const managedPath = `/cyberos/apps/${form.projectKey || "..."}`;

  useEffect(() => {
    if (!app) return;
    let active = true;
    setLoading(true);
    void getDockerComposeApp(app.id)
      .then((nextDetail) => {
        if (!active) return;
        setDetail(nextDetail);
        setForm(dockerComposeAppForm(nextDetail));
        setDirty(false);
      })
      .catch((nextError) => {
        if (active) setError(errorMessage(nextError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [app?.id]);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => focusDialog(dialogRef.current));
    return () => {
      window.cancelAnimationFrame(frame);
      const target = previousFocus.current;
      if (target?.isConnected) window.requestAnimationFrame(() => target.focus());
    };
  }, []);

  useEffect(() => {
    if (busy) return;
    const frame = window.requestAnimationFrame(() => focusDialog(dialogRef.current));
    return () => window.cancelAnimationFrame(frame);
  }, [busy, confirmDelete]);

  function updateForm<Key extends keyof DockerComposeAppForm>(key: Key, value: DockerComposeAppForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setValidation(null);
    setNotice(null);
    setError(null);
  }

  function updateName(name: string) {
    setForm((current) => ({
      ...current,
      name,
      ...(!detail && !keyEdited ? { projectKey: dockerComposeProjectKey(name) } : {})
    }));
    setValidation(null);
    setDirty(true);
    setNotice(null);
    setError(null);
  }

  function updateEnvironment(index: number, key: "key" | "value", value: string) {
    updateForm("environment", form.environment.map((entry, entryIndex) => (
      entryIndex === index ? { ...entry, [key]: value, ...(key === "value" ? { valueChanged: true } : {}) } : entry
    )));
  }

  async function validate() {
    if (formError || busy || composeUnavailable) return;
    setValidating(true);
    setError(null);
    setNotice(null);
    try {
      const result = await validateDockerComposeApp({
        ...(detail ? { appId: detail.id, expectedRevision: detail.revision } : {}),
        projectKey: form.projectKey.trim(),
        composeContent: form.composeContent,
        environment: detail
          ? dockerComposeUpdateEnvironment(form.environment)
          : dockerComposeCreateEnvironment(form.environment),
        hostAccess: form.hostAccess
      });
      setValidation(result);
      setNotice(String(t("workspace.management.docker.apps.validationSucceeded")));
    } catch (nextError) {
      handleRequestError(nextError, true);
    } finally {
      setValidating(false);
    }
  }

  async function save(action: Exclude<SubmitAction, null>) {
    if (formError || busy || composeUnavailable || (action === "deploy" && !canDeploy)) return;
    setSubmitAction(action);
    setError(null);
    setNotice(null);
    try {
      const saved = detail
        ? await updateDockerComposeApp(detail.id, {
            name: form.name.trim(),
            composeContent: form.composeContent,
            environment: dockerComposeUpdateEnvironment(form.environment),
            hostAccess: form.hostAccess,
            expectedRevision: detail.revision
          })
        : await createDockerComposeApp({
            name: form.name.trim(),
            projectKey: form.projectKey.trim(),
            composeContent: form.composeContent,
            environment: dockerComposeCreateEnvironment(form.environment),
            hostAccess: form.hostAccess
          });
      setDetail(saved);
      setForm(dockerComposeAppForm(saved));
      setValidation(saved);
      setDirty(false);
      setConflicted(false);
      await onRefresh();
      if (action === "deploy") {
        const requested = await onRequestDeploy(saved);
        if (requested) {
          onClose();
          return;
        }
        setNotice(String(t("workspace.management.docker.apps.savedDeployFailed")));
      } else {
        const message = String(t("workspace.management.docker.apps.saved"));
        setNotice(message);
        onNotifySuccess(message);
      }
    } catch (nextError) {
      handleRequestError(nextError, true);
    } finally {
      setSubmitAction(null);
    }
  }

  async function remove() {
    if (!detail || !engineReady || busy) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteDockerComposeApp(detail.id, { expectedRevision: detail.revision, confirmed: true });
      await onRefresh();
      onNotifySuccess(String(t("workspace.management.docker.apps.deleted")));
      onClose();
    } catch (nextError) {
      handleRequestError(nextError);
    } finally {
      setDeleting(false);
    }
  }

  function handleRequestError(nextError: unknown, mayBeComposeUnavailable = false) {
    if (mayBeComposeUnavailable && statusCode(nextError) === 503) setComposeUnavailable(true);
    if (detail && statusCode(nextError) === 409) setConflicted(true);
    setError(errorMessage(nextError));
  }

  async function reload() {
    if (!detail || busy) return;
    setLoading(true);
    setError(null);
    try {
      const nextDetail = await getDockerComposeApp(detail.id);
      setDetail(nextDetail);
      setForm(dockerComposeAppForm(nextDetail));
      setValidation(nextDetail);
      setDirty(false);
      setConflicted(false);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }

  const validationResult = validation ?? (!dirty ? detail : null);
  const hostAccessServices = validationResult?.services ?? detail?.services ?? [];
  const activeHostAccessService = hostAccessServices.includes(hostAccessService)
    ? hostAccessService
    : hostAccessServices[0] ?? "";
  const activeHostAccessGrants = form.hostAccess.find((entry) => entry.service === activeHostAccessService)?.grants ?? [];
  const hostAccessCoverage = validationResult?.hostAccessCoverage ?? detail?.hostAccessCoverage;
  const hasContainers = (detail?.containerCount ?? app?.containerCount ?? 0) > 0;
  const disableSave = Boolean(formError) || busy || composeUnavailable || conflicted;
  const disableSubmit = disableSave || hostAccessBlocked;
  const loadFailed = Boolean(app && !detail && !loading);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      if (confirmDelete) {
        setConfirmDelete(false);
        setError(null);
      } else {
        onClose();
      }
      return;
    }
    trapDialogFocus(event, dialogRef.current);
  }

  return (
    <div className="management-modal-backdrop docker-compose-app-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section
        ref={dialogRef}
        className="management-modal docker-compose-app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="docker-compose-app-title"
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header>
          <div className="docker-compose-app-heading">
            <span className="docker-compose-app-icon"><Code2 aria-hidden="true" size={19} /></span>
            <div>
              <span className="eyebrow">{t("workspace.management.docker.apps.eyebrow")}</span>
              <h2 id="docker-compose-app-title">
                {detail ? t("workspace.management.docker.apps.editTitle") : t("workspace.management.docker.apps.createTitle")}
              </h2>
            </div>
          </div>
          <button type="button" className="management-icon-action" onClick={onClose} disabled={busy} aria-label={t("common.actions.close")}>
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        {confirmDelete && detail ? (
          <div className="docker-compose-delete-confirmation">
            <AlertTriangle aria-hidden="true" size={26} />
            <div>
              <h3>{t("workspace.management.docker.apps.deleteTitle")}</h3>
              <p>{t("workspace.management.docker.apps.deleteDescription", { name: detail.name })}</p>
            </div>
            <dl>
              <div><dt>{t("workspace.management.docker.apps.projectKey")}</dt><dd><code>{detail.projectKey}</code></dd></div>
              <div><dt>{t("workspace.management.docker.apps.managedPath")}</dt><dd><code>{detail.managedPath}</code></dd></div>
            </dl>
            {hasContainers ? <p className="docker-compose-app-error">{t("workspace.management.docker.apps.deleteBlocked")}</p> : null}
            {!engineReady ? <p className="docker-compose-app-error">{t("workspace.management.docker.apps.deleteEngineRequired")}</p> : null}
            {error ? <p className="docker-compose-app-error">{error}</p> : null}
          </div>
        ) : (
          <div className="docker-compose-app-body">
            {loading ? (
              <div className="docker-compose-app-loading"><LoaderCircle className="is-spinning" aria-hidden="true" size={20} />{t("workspace.management.docker.apps.loading")}</div>
            ) : loadFailed ? (
              <p className="docker-compose-app-error">{error}</p>
            ) : (
              <>
                <div className="docker-compose-app-meta-grid">
                  <label>
                    <span>{t("workspace.management.docker.apps.name")}</span>
                    <input value={form.name} maxLength={128} onChange={(event) => updateName(event.target.value)} disabled={busy} />
                  </label>
                  <label>
                    <span>{t("workspace.management.docker.apps.projectKey")}</span>
                    <input
                      value={form.projectKey}
                      maxLength={63}
                      onChange={(event) => {
                        setKeyEdited(true);
                        updateForm("projectKey", event.target.value.toLowerCase());
                      }}
                      disabled={busy || Boolean(detail)}
                    />
                  </label>
                  <label className="docker-compose-app-path">
                    <span>{t("workspace.management.docker.apps.managedPath")}</span>
                    <input value={managedPath} readOnly />
                  </label>
                </div>

                <label className="docker-compose-editor-field">
                  <span>{t("workspace.management.docker.apps.composeLabel")}</span>
                  <textarea
                    value={form.composeContent}
                    onChange={(event) => updateForm("composeContent", event.target.value)}
                    spellCheck={false}
                    disabled={busy}
                  />
                </label>

                <section className="docker-compose-environment">
                  <div>
                    <div>
                      <h3>{t("workspace.management.docker.apps.environmentTitle")}</h3>
                      <p>{t("workspace.management.docker.apps.environmentDescription")}</p>
                    </div>
                    <button type="button" onClick={() => updateForm("environment", [
                      ...form.environment,
                      { key: "", value: "", valueConfigured: false, originalKey: null, valueChanged: false }
                    ])} disabled={busy}>
                      <Plus aria-hidden="true" size={14} />
                      <span>{t("workspace.management.docker.apps.addEnvironment")}</span>
                    </button>
                  </div>
                  {form.environment.length ? (
                    <div className="docker-compose-environment-list">
                      {form.environment.map((entry, index) => (
                        <div key={index} className="docker-compose-environment-row">
                          <label>
                            <span className="visually-hidden">{t("workspace.management.docker.apps.environmentKey")}</span>
                            <input value={entry.key} placeholder={t("workspace.management.docker.apps.environmentKey")} onChange={(event) => updateEnvironment(index, "key", event.target.value)} disabled={busy} />
                          </label>
                          <label>
                            <span className="visually-hidden">{t("workspace.management.docker.apps.environmentValue")}</span>
                            <textarea
                              value={entry.value}
                              placeholder={entry.valueConfigured
                                ? t("workspace.management.docker.apps.environmentConfigured")
                                : t("workspace.management.docker.apps.environmentValue")}
                              onChange={(event) => updateEnvironment(index, "value", event.target.value)}
                              disabled={busy}
                              autoComplete="new-password"
                              rows={1}
                            />
                          </label>
                          {entry.valueConfigured && !entry.value ? <span><Check aria-hidden="true" size={13} />{t("workspace.management.docker.apps.configured")}</span> : null}
                          <button type="button" className="management-icon-action is-danger" onClick={() => updateForm(
                            "environment",
                            form.environment.filter((_, entryIndex) => entryIndex !== index)
                          )} disabled={busy} aria-label={t("workspace.management.docker.apps.removeEnvironment")}>
                            <Trash2 aria-hidden="true" size={15} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : <p className="docker-compose-environment-empty">{t("workspace.management.docker.apps.noEnvironment")}</p>}
                </section>

                <section className="docker-compose-host-access">
                  <label>
                    <span>{t("workspace.management.docker.hostAccess.service")}</span>
                    <select
                      value={activeHostAccessService}
                      onChange={(event) => setHostAccessService(event.target.value)}
                      disabled={busy || !hostAccessServices.length}
                    >
                      {hostAccessServices.map((service) => <option key={service} value={service}>{service}</option>)}
                    </select>
                  </label>
                  {activeHostAccessService ? (
                    <HostAccessPicker
                      grants={activeHostAccessGrants}
                      {...(hostAccessCoverage ? { coverage: hostAccessCoverage } : {})}
                      onChange={(grants) => updateForm("hostAccess", [
                        ...form.hostAccess.filter((entry) => entry.service !== activeHostAccessService),
                        ...(grants.length ? [{ service: activeHostAccessService, grants }] : [])
                      ].sort((left, right) => left.service.localeCompare(right.service)))}
                      onBlockingChange={setHostAccessBlocked}
                      disabled={busy}
                    />
                  ) : (
                    <p className="docker-compose-environment-empty">{t("workspace.management.docker.hostAccess.validateServices")}</p>
                  )}
                </section>

                {validationResult ? (
                  <div className="docker-compose-validation" data-risk={validationResult.risk}>
                    <Check aria-hidden="true" size={16} />
                    <div>
                      <strong>{t("workspace.management.docker.apps.validationSummary", { count: validationResult.services.length })}</strong>
                      <span>{validationResult.services.join(", ")}</span>
                      {validationResult.warnings.map((warning) => <small key={warning}>{composeWarningLabel(warning, t)}</small>)}
                    </div>
                  </div>
                ) : null}
                {formError ? <p className="docker-compose-app-error">{composeFormErrorLabel(formError, t)}</p> : null}
                {composeUnavailable ? <p className="docker-compose-app-error">{t("workspace.management.docker.apps.composeUnavailable")}</p> : null}
                {conflicted ? <p className="docker-compose-app-error">{t("workspace.management.docker.apps.conflict")}</p> : null}
                {error ? <p className="docker-compose-app-error">{error}</p> : null}
                {notice ? <p className="docker-compose-app-notice">{notice}</p> : null}
              </>
            )}
          </div>
        )}

        <footer className="docker-compose-app-footer">
          {loadFailed ? (
            <button type="button" onClick={onClose}>{t("common.actions.close")}</button>
          ) : confirmDelete && detail ? (
            <>
              <button type="button" onClick={() => { setConfirmDelete(false); setError(null); }} disabled={deleting}>{t("common.actions.cancel")}</button>
              <button type="button" className="is-danger" onClick={() => void remove()} disabled={deleting || hasContainers || !engineReady}>
                {deleting ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : <Trash2 aria-hidden="true" size={15} />}
                <span>{t("workspace.management.docker.apps.confirmDelete")}</span>
              </button>
            </>
          ) : (
            <>
              <div>
                {detail ? (
                  <button type="button" className="is-danger is-quiet" onClick={() => setConfirmDelete(true)} disabled={busy}>
                    <Trash2 aria-hidden="true" size={15} />
                    <span>{t("common.actions.delete")}</span>
                  </button>
                ) : null}
              </div>
              <div>
                {conflicted ? (
                  <button type="button" onClick={() => void reload()} disabled={busy}>
                    <span>{t("workspace.management.docker.apps.reload")}</span>
                  </button>
                ) : null}
                <button type="button" onClick={() => void validate()} disabled={disableSave}>
                  {validating ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : <Check aria-hidden="true" size={15} />}
                  <span>{t("workspace.management.docker.apps.validate")}</span>
                </button>
                <button type="button" onClick={() => void save("save")} disabled={disableSubmit}>
                  {submitAction === "save" ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : <Save aria-hidden="true" size={15} />}
                  <span>{t("workspace.management.docker.apps.save")}</span>
                </button>
                <button type="button" className="is-primary" onClick={() => void save("deploy")} disabled={disableSubmit || !canDeploy}>
                  {submitAction === "deploy" ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : <Rocket aria-hidden="true" size={15} />}
                  <span>{t("workspace.management.docker.apps.saveDeploy")}</span>
                </button>
              </div>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function statusCode(error: unknown): number | null {
  return typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function composeWarningLabel(warning: string, t: (key: string, options?: Record<string, unknown>) => unknown): string {
  const nasBind = /^Service (.+) uses a NAS bind mount$/u.exec(warning);
  if (nasBind) return String(t("workspace.management.docker.apps.warningNasBind", { service: nasBind[1] }));
  const elevated = /^Service (.+) requests elevated host access$/u.exec(warning);
  if (elevated) return String(t("workspace.management.docker.apps.warningElevated", { service: elevated[1] }));
  return warning;
}

function composeFormErrorLabel(error: string, t: (key: string) => unknown): string {
  switch (error) {
    case "name": return String(t("workspace.management.docker.apps.errors.name"));
    case "projectKey": return String(t("workspace.management.docker.apps.errors.projectKey"));
    case "composeContent": return String(t("workspace.management.docker.apps.errors.composeContent"));
    case "composeTooLarge": return String(t("workspace.management.docker.apps.errors.composeTooLarge"));
    case "environmentKey": return String(t("workspace.management.docker.apps.errors.environmentKey"));
    case "environmentDuplicate": return String(t("workspace.management.docker.apps.errors.environmentDuplicate"));
    case "environmentValue": return String(t("workspace.management.docker.apps.errors.environmentValue"));
    default: return String(t("workspace.management.docker.apps.errors.environmentTooLarge"));
  }
}

function focusDialog(dialog: HTMLElement | null): void {
  if (!dialog || dialog.contains(document.activeElement)) return;
  const first = focusableElements(dialog)[0];
  if (first) first.focus();
  else dialog.focus();
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>, dialog: HTMLElement | null): void {
  if (event.key !== "Tab" || !dialog) return;
  const focusable = focusableElements(dialog);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  )].filter((element) => element.getClientRects().length > 0);
}
