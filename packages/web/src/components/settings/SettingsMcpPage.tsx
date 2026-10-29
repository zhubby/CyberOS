import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createAgentMcpServer,
  deleteAgentMcpCredentials,
  deleteAgentMcpServer,
  getAgentMcpSettings,
  saveAgentMcpCredentials,
  saveBuiltInAgentMcpSettings,
  testAgentMcpServer,
  updateAgentMcpServer,
  type AgentMcpServer,
  type AgentMcpServerInput,
  type AgentMcpSettings,
  type McpAuthMode,
  type McpExposure
} from "../../api.js";
import { CustomSelect } from "../common/CustomSelect.js";
import { Switch } from "../common/Switch.js";

const EXPOSURE_OPTIONS: McpExposure[] = ["codemode", "deferred", "direct"];
const AUTH_OPTIONS: McpAuthMode[] = ["none", "bearer", "headers"];

interface McpDraft extends AgentMcpServerInput {
  bearerToken: string;
  secretHeaders: string;
}

const EMPTY_DRAFT: McpDraft = {
  name: "",
  description: "",
  url: "https://",
  timeoutSeconds: 30,
  exposure: "codemode",
  authMode: "none",
  allowInsecureHttp: false,
  bearerToken: "",
  secretHeaders: ""
};

export function SettingsMcpPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AgentMcpSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentMcpServer | "new" | null>(null);
  const [draft, setDraft] = useState<McpDraft>(EMPTY_DRAFT);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSettings(await getAgentMcpSettings());
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openEditor(server?: AgentMcpServer) {
    setError(null);
    setEditing(server ?? "new");
    setDraft(server ? {
      name: server.name,
      description: server.description,
      url: server.url,
      timeoutSeconds: server.timeoutSeconds,
      exposure: server.exposure,
      authMode: server.authMode,
      allowInsecureHttp: server.allowInsecureHttp,
      bearerToken: "",
      secretHeaders: ""
    } : EMPTY_DRAFT);
  }

  async function run(id: string, operation: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await operation();
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleBuiltIn(enabled: boolean) {
    if (!window.confirm(t("settings.mcp.confirmBuiltIn"))) return;
    await run("builtin", async () => {
      const builtIn = await saveBuiltInAgentMcpSettings(enabled);
      setSettings((current) => current ? { ...current, builtIn } : current);
    });
  }

  async function toggleServer(server: AgentMcpServer, enabled: boolean) {
    if (enabled && !window.confirm(t("settings.mcp.confirmEnable", { name: server.name }))) return;
    await run(server.id, async () => {
      const updated = await updateAgentMcpServer(server.id, { enabled });
      replaceServer(updated);
    });
  }

  async function testConnection(server: AgentMcpServer) {
    await run(server.id, async () => replaceServer(await testAgentMcpServer(server.id)));
  }

  async function removeServer(server: AgentMcpServer) {
    if (!window.confirm(t("settings.mcp.confirmDelete", { name: server.name }))) return;
    await run(server.id, async () => {
      await deleteAgentMcpServer(server.id);
      setSettings((current) => current ? {
        ...current,
        servers: current.servers.filter((entry) => entry.id !== server.id)
      } : current);
    });
  }

  async function clearCredentials(server: AgentMcpServer) {
    if (!window.confirm(t("settings.mcp.confirmCredentials", { name: server.name }))) return;
    await run(server.id, async () => replaceServer(await deleteAgentMcpCredentials(server.id)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm(t("settings.mcp.confirmSave"))) return;
    await run(editing === "new" ? "new" : editing?.id ?? "editor", async () => {
      const input: AgentMcpServerInput = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        url: draft.url.trim(),
        timeoutSeconds: draft.timeoutSeconds,
        exposure: draft.exposure,
        authMode: draft.authMode,
        allowInsecureHttp: draft.allowInsecureHttp
      };
      let server = editing === "new"
        ? await createAgentMcpServer(input)
        : await updateAgentMcpServer(editing!.id, input);
      replaceServer(server);
      if (editing === "new") setEditing(server);
      if (draft.authMode === "bearer" && draft.bearerToken) {
        server = await saveAgentMcpCredentials(server.id, { bearerToken: draft.bearerToken });
      } else if (draft.authMode === "headers" && draft.secretHeaders.trim()) {
        server = await saveAgentMcpCredentials(server.id, {
          headers: parseSecretHeaders(draft.secretHeaders, t("settings.mcp.invalidHeaders"))
        });
      }
      replaceServer(server);
      setEditing(null);
    });
  }

  function replaceServer(server: AgentMcpServer) {
    setSettings((current) => current ? {
      ...current,
      servers: current.servers.some((entry) => entry.id === server.id)
        ? current.servers.map((entry) => entry.id === server.id ? server : entry)
        : [...current.servers, server].sort((left, right) => left.name.localeCompare(right.name))
    } : current);
  }

  if (loading && !settings) {
    return <div className="settings-resource-state" role="status"><LoaderCircle className="spin" aria-hidden="true" />{t("common.states.loading")}</div>;
  }

  return (
    <div className="settings-content-body settings-resource-page">
      {error ? <p className="settings-inline-alert" role="alert"><AlertTriangle aria-hidden="true" size={16} />{error}</p> : null}

      <section className="settings-section-card settings-resource-primary">
        <header>
          <div><h3>{t("settings.mcp.builtInTitle")}</h3><p>{t("settings.mcp.builtInDescription")}</p></div>
          <Switch
            checked={settings?.builtIn.enabled ?? false}
            onCheckedChange={(checked) => void toggleBuiltIn(checked)}
            ariaLabel={t("settings.mcp.builtInToggle")}
            compact
            busy={busyId === "builtin"}
            disabled={!settings?.builtIn.available}
          />
        </header>
        <ResourceStatus
          status={settings?.builtIn.status ?? "unavailable"}
          label={settings?.builtIn.paired ? t("settings.mcp.paired") : t("settings.mcp.needsRepair")}
        />
      </section>

      <section className="settings-section-card">
        <header>
          <div><h3>{t("settings.mcp.externalTitle")}</h3><p>{t("settings.mcp.externalDescription")}</p></div>
          <button className="settings-resource-command" type="button" onClick={() => openEditor()}>
            <Plus aria-hidden="true" size={15} />{t("settings.mcp.addServer")}
          </button>
        </header>
        <div className="settings-resource-list">
          {settings?.servers.length ? settings.servers.map((server) => (
            <article className="settings-resource-row" key={server.id} data-state={server.testStatus}>
              <span className="settings-resource-icon" aria-hidden="true"><Server size={18} /></span>
              <div className="settings-resource-copy">
                <strong>{server.name}</strong>
                <span>{server.description || server.url}</span>
                <small>{t(`settings.mcp.exposure.${server.exposure}`)} · {t("settings.mcp.tools", { count: server.toolCount })} · {server.credentialsConfigured ? t("settings.mcp.credentialsReady") : t("settings.mcp.credentialsMissing")}</small>
                {server.lastError ? <em role="alert">{server.lastError}</em> : null}
              </div>
              <ResourceStatus status={server.testStatus} label={t(`settings.mcp.testStatus.${server.testStatus}`)} />
              <div className="settings-resource-actions">
                <button type="button" title={t("settings.mcp.test")} aria-label={t("settings.mcp.test")} onClick={() => void testConnection(server)} disabled={busyId === server.id}><RefreshCw aria-hidden="true" size={15} /></button>
                <button type="button" title={t("common.actions.edit")} aria-label={t("common.actions.edit")} onClick={() => openEditor(server)} disabled={busyId === server.id}><Pencil aria-hidden="true" size={15} /></button>
                {server.authMode !== "none" && server.credentialsConfigured ? <button type="button" title={t("settings.mcp.clearCredentials")} aria-label={t("settings.mcp.clearCredentials")} onClick={() => void clearCredentials(server)} disabled={busyId === server.id}><KeyRound aria-hidden="true" size={15} /></button> : null}
                <button className="is-danger" type="button" title={t("common.actions.delete")} aria-label={t("common.actions.delete")} onClick={() => void removeServer(server)} disabled={busyId === server.id}><Trash2 aria-hidden="true" size={15} /></button>
              </div>
              <Switch
                checked={server.enabled}
                onCheckedChange={(checked) => void toggleServer(server, checked)}
                ariaLabel={t("settings.mcp.toggleServer", { name: server.name })}
                compact
                busy={busyId === server.id}
                disabled={busyId === server.id || (!server.enabled && (
                  server.testStatus !== "ready" || (server.authMode !== "none" && !server.credentialsConfigured)
                ))}
              />
            </article>
          )) : <div className="settings-resource-empty"><Server aria-hidden="true" size={20} /><span>{t("settings.mcp.empty")}</span></div>}
        </div>
      </section>

      {editing ? (
        <form className="settings-section-card settings-resource-editor" onSubmit={(event) => void submit(event)}>
          <header><div><h3>{editing === "new" ? t("settings.mcp.addServer") : t("settings.mcp.editServer")}</h3><p>{t("settings.mcp.securityNotice")}</p></div><button type="button" title={t("common.actions.close")} aria-label={t("common.actions.close")} onClick={() => setEditing(null)}><X aria-hidden="true" size={16} /></button></header>
          <div className="settings-field-grid settings-resource-fields">
            <label><span>{t("settings.mcp.name")}</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required maxLength={63} pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" /></label>
            <label><span>{t("settings.mcp.url")}</span><input type="url" value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} required /></label>
            <label className="settings-field-wide"><span>{t("settings.mcp.description")}</span><input value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
            <label><span>{t("settings.mcp.exposureLabel")}</span><CustomSelect value={draft.exposure} options={EXPOSURE_OPTIONS.map((value) => ({ value, label: t(`settings.mcp.exposure.${value}`) }))} onChange={(exposure) => setDraft((current) => ({ ...current, exposure }))} ariaLabel={t("settings.mcp.exposureLabel")} /></label>
            <label><span>{t("settings.mcp.authLabel")}</span><CustomSelect value={draft.authMode} options={AUTH_OPTIONS.map((value) => ({ value, label: t(`settings.mcp.auth.${value}`) }))} onChange={(authMode) => setDraft((current) => ({ ...current, authMode }))} ariaLabel={t("settings.mcp.authLabel")} /></label>
            <label><span>{t("settings.mcp.timeout")}</span><input type="number" min={1} max={300} value={draft.timeoutSeconds} onChange={(event) => setDraft((current) => ({ ...current, timeoutSeconds: Number(event.target.value) }))} /></label>
            <Switch checked={draft.allowInsecureHttp} onCheckedChange={(allowInsecureHttp) => setDraft((current) => ({ ...current, allowInsecureHttp }))} label={t("settings.mcp.allowHttp")} description={t("settings.mcp.allowHttpHelp")} />
            {draft.authMode === "bearer" ? <label className="settings-field-wide"><span>{t("settings.mcp.bearerToken")}</span><input type="password" autoComplete="new-password" value={draft.bearerToken} onChange={(event) => setDraft((current) => ({ ...current, bearerToken: event.target.value }))} placeholder={editing === "new" ? "" : t("settings.mcp.keepCredential")} /></label> : null}
            {draft.authMode === "headers" ? <label className="settings-field-wide"><span>{t("settings.mcp.secretHeaders")}</span><textarea value={draft.secretHeaders} onChange={(event) => setDraft((current) => ({ ...current, secretHeaders: event.target.value }))} placeholder={t("settings.mcp.secretHeadersPlaceholder")} /></label> : null}
          </div>
          <footer className="settings-inline-actions"><button type="button" className="secondary-button" onClick={() => setEditing(null)}>{t("common.actions.cancel")}</button><button type="submit" className="primary-button" disabled={busyId !== null}>{t("common.actions.saveChanges")}</button></footer>
        </form>
      ) : null}
    </div>
  );
}

function ResourceStatus({ status, label }: { status: string; label: string }) {
  const ready = status === "ready";
  return <span className="settings-resource-status" data-state={status}>{ready ? <CheckCircle2 aria-hidden="true" size={14} /> : <AlertTriangle aria-hidden="true" size={14} />}{label}</span>;
}

function parseSecretHeaders(value: string, invalidMessage: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of value.split(/\r?\n/u).filter((entry) => entry.trim())) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(invalidMessage);
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
