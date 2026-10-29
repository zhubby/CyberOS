import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, GitBranch, LoaderCircle, Package, Plus, RefreshCw, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  deleteAgentSkill,
  getAgentSkills,
  importAgentSkill,
  installGitAgentSkill,
  setAgentSkillEnabled,
  updateAgentSkill,
  type AgentSkill,
  type AgentSkillsSettings
} from "../../api.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { Switch } from "../common/Switch.js";
import {
  StorageFilePickerDialog,
  type StorageFilePickerPool,
  type StorageFileSelection
} from "../workspace/StorageFilePickerDialog.js";

export function SettingsSkillsPage({
  activeSessionId,
  storagePools,
  locale
}: {
  activeSessionId: string;
  storagePools: StorageFilePickerPool[];
  locale: SupportedLocale;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AgentSkillsSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerTarget, setPickerTarget] = useState<AgentSkill | "new" | null>(null);
  const [gitTarget, setGitTarget] = useState<AgentSkill | "new" | null>(null);
  const [gitDraft, setGitDraft] = useState({ url: "https://", ref: "", subdirectory: "" });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSettings(await getAgentSkills(activeSessionId || undefined));
    } catch (nextError) {
      setError(message(nextError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [activeSessionId]);

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

  function replaceSkill(skill: AgentSkill) {
    setSettings((current) => current ? {
      ...current,
      global: current.global.some((entry) => entry.id === skill.id)
        ? current.global.map((entry) => entry.id === skill.id ? skill : entry)
        : [...current.global, skill].sort((left, right) => left.name.localeCompare(right.name))
    } : current);
  }

  async function chooseZip(selection: StorageFileSelection) {
    if (!window.confirm(t("settings.skills.confirmInstall"))) return;
    const target = pickerTarget;
    setPickerTarget(null);
    await run(target === "new" ? "install" : target?.id ?? "install", async () => {
      replaceSkill(await importAgentSkill({
        storagePoolId: selection.storagePoolId,
        path: selection.path,
        ...(target && target !== "new" ? { replaceId: target.id } : {})
      }));
    });
  }

  async function installGit(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm(t("settings.skills.confirmInstall"))) return;
    const target = gitTarget;
    await run(target === "new" ? "install" : target?.id ?? "install", async () => {
      replaceSkill(await installGitAgentSkill({
        url: gitDraft.url.trim(),
        ...(gitDraft.ref.trim() ? { ref: gitDraft.ref.trim() } : {}),
        ...(gitDraft.subdirectory.trim() ? { subdirectory: gitDraft.subdirectory.trim() } : {}),
        ...(target && target !== "new" ? { replaceId: target.id } : {})
      }));
      setGitTarget(null);
    });
  }

  async function toggle(skill: AgentSkill, enabled: boolean) {
    if (enabled && !window.confirm(t("settings.skills.confirmEnable", { name: skill.name }))) return;
    await run(skill.id, async () => replaceSkill(await setAgentSkillEnabled(skill.id, enabled)));
  }

  async function update(skill: AgentSkill) {
    if (!window.confirm(t("settings.skills.confirmUpdate", { name: skill.name }))) return;
    await run(skill.id, async () => replaceSkill(await updateAgentSkill(skill.id)));
  }

  async function remove(skill: AgentSkill) {
    if (!window.confirm(t("settings.skills.confirmDelete", { name: skill.name }))) return;
    await run(skill.id, async () => {
      await deleteAgentSkill(skill.id);
      setSettings((current) => current ? {
        ...current,
        global: current.global.filter((entry) => entry.id !== skill.id)
      } : current);
    });
  }

  function replace(skill: AgentSkill) {
    if (skill.sourceType === "zip") setPickerTarget(skill);
    else {
      setGitDraft({
        url: skill.sourceUrl ?? "https://",
        ref: skill.sourceRef ?? "",
        subdirectory: skill.sourceSubdirectory ?? ""
      });
      setGitTarget(skill);
    }
  }

  if (loading && !settings) {
    return <div className="settings-resource-state" role="status"><LoaderCircle className="spin" aria-hidden="true" />{t("common.states.loading")}</div>;
  }

  return (
    <div className="settings-content-body settings-resource-page">
      {error ? <p className="settings-inline-alert" role="alert"><AlertTriangle aria-hidden="true" size={16} />{error}</p> : null}
      <section className="settings-section-card">
        <header>
          <div><h3>{t("settings.skills.globalTitle")}</h3><p>{t("settings.skills.globalDescription")}</p></div>
          <div className="settings-inline-actions">
            <button type="button" onClick={() => setPickerTarget("new")} disabled={storagePools.length === 0}><Upload aria-hidden="true" size={15} />{t("settings.skills.importZip")}</button>
            <button type="button" onClick={() => { setGitDraft({ url: "https://", ref: "", subdirectory: "" }); setGitTarget("new"); }}><Plus aria-hidden="true" size={15} />{t("settings.skills.installGit")}</button>
          </div>
        </header>
        <div className="settings-resource-list">
          {settings?.global.length ? settings.global.map((skill) => (
            <article className="settings-resource-row settings-skill-row" key={skill.id} data-state={skill.diagnostics.length ? "error" : "ready"}>
              <span className="settings-resource-icon" aria-hidden="true">{skill.sourceType === "git" ? <GitBranch size={18} /> : <Package size={18} />}</span>
              <div className="settings-resource-copy">
                <strong>{skill.name}{skill.version ? <small> v{skill.version}</small> : null}</strong>
                <span>{skill.description}</span>
                <small>{skill.sourceType === "git" ? skill.resolvedCommit?.slice(0, 12) ?? t("common.states.unknown") : `${skill.sourceStoragePoolId}:${skill.sourcePath}`}</small>
                {skill.diagnostics.map((diagnostic) => <em key={diagnostic} role="alert">{diagnostic}</em>)}
              </div>
              <div className="settings-resource-actions">
                {skill.sourceType === "git" ? <button type="button" title={t("common.actions.update")} aria-label={t("common.actions.update")} onClick={() => void update(skill)} disabled={busyId === skill.id}><RefreshCw aria-hidden="true" size={15} /></button> : null}
                <button type="button" title={t("settings.skills.replace")} aria-label={t("settings.skills.replace")} onClick={() => replace(skill)} disabled={busyId === skill.id}><Upload aria-hidden="true" size={15} /></button>
                <button className="is-danger" type="button" title={t("common.actions.delete")} aria-label={t("common.actions.delete")} onClick={() => void remove(skill)} disabled={busyId === skill.id}><Trash2 aria-hidden="true" size={15} /></button>
              </div>
              <Switch checked={skill.enabled} onCheckedChange={(checked) => void toggle(skill, checked)} ariaLabel={t("settings.skills.toggle", { name: skill.name })} compact busy={busyId === skill.id} />
            </article>
          )) : <div className="settings-resource-empty"><Package aria-hidden="true" size={20} /><span>{t("settings.skills.empty")}</span></div>}
        </div>
      </section>

      <section className="settings-section-card">
        <header><div><h3>{t("settings.skills.projectTitle")}</h3><p>{t("settings.skills.projectDescription")}</p></div><span className="settings-resource-status" data-state={settings?.project.trusted ? "ready" : "attention"}><ShieldCheck aria-hidden="true" size={14} />{settings?.project.trusted ? t("settings.skills.trusted") : t("settings.skills.untrusted")}</span></header>
        <div className="settings-resource-list">
          {settings?.project.skills.length ? settings.project.skills.map((skill) => (
            <article className="settings-resource-row settings-project-skill" key={skill.path} data-state={skill.valid ? "ready" : "error"}>
              <span className="settings-resource-icon" aria-hidden="true"><Package size={18} /></span>
              <div className="settings-resource-copy"><strong>{skill.name}</strong><span>{skill.description || skill.path}</span><small>{skill.path}</small>{skill.diagnostics.map((diagnostic) => <em key={diagnostic}>{diagnostic}</em>)}</div>
              <span>{t("settings.skills.readOnly")}</span>
            </article>
          )) : <div className="settings-resource-empty"><Package aria-hidden="true" size={20} /><span>{activeSessionId ? t("settings.skills.noProjectSkills") : t("settings.skills.noSession")}</span></div>}
        </div>
      </section>

      {gitTarget ? <form className="settings-section-card settings-resource-editor" onSubmit={(event) => void installGit(event)}><header><div><h3>{gitTarget === "new" ? t("settings.skills.installGit") : t("settings.skills.replace")}</h3><p>{t("settings.skills.securityNotice")}</p></div><button type="button" aria-label={t("common.actions.close")} onClick={() => setGitTarget(null)}><X aria-hidden="true" size={16} /></button></header><div className="settings-field-grid settings-resource-fields"><label className="settings-field-wide"><span>{t("settings.skills.gitUrl")}</span><input type="url" required value={gitDraft.url} onChange={(event) => setGitDraft((current) => ({ ...current, url: event.target.value }))} /></label><label><span>{t("settings.skills.gitRef")}</span><input value={gitDraft.ref} onChange={(event) => setGitDraft((current) => ({ ...current, ref: event.target.value }))} /></label><label><span>{t("settings.skills.gitSubdirectory")}</span><input value={gitDraft.subdirectory} onChange={(event) => setGitDraft((current) => ({ ...current, subdirectory: event.target.value }))} /></label></div><footer className="settings-inline-actions"><button type="button" className="secondary-button" onClick={() => setGitTarget(null)}>{t("common.actions.cancel")}</button><button type="submit" className="primary-button" disabled={busyId !== null}>{t("settings.skills.install")}</button></footer></form> : null}

      {pickerTarget ? <StorageFilePickerDialog pools={storagePools} initialPoolId={storagePools[0]?.id ?? ""} locale={locale} mode="skill-zip" onCancel={() => setPickerTarget(null)} onSelect={(selection) => void chooseZip(selection)} /> : null}
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
