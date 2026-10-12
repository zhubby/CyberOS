import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Database, RefreshCw } from "lucide-react";
import type { IndexerOverview, IndexerSettings, NasRoot } from "../../api.js";
import { formatBytes, formatDate } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";

type IndexerSettingsDraft = Omit<IndexerSettings, "updatedAt">;

export function SettingsIndexerPage({
  settings,
  status,
  roots,
  loading,
  locale,
  onSettingsChange,
  onReindex,
  onClose
}: {
  settings: IndexerSettings | null;
  status: IndexerOverview | null;
  roots: NasRoot[];
  loading: boolean;
  locale: SupportedLocale;
  onSettingsChange: (patch: Partial<IndexerSettingsDraft>) => Promise<void>;
  onReindex: (rootId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<IndexerSettingsDraft>(() => indexerSettingsDraft(settings));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reindexingRootId, setReindexingRootId] = useState<string | null>(null);

  useEffect(() => {
    setDraft(indexerSettingsDraft(settings));
    setSaved(false);
  }, [settings]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || saving || !settings) return;
    setSaving(true);
    setSaved(false);
    try {
      await onSettingsChange(draft);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  async function reindex(rootId: string) {
    if (reindexingRootId) return;
    setReindexingRootId(rootId);
    try {
      await onReindex(rootId);
    } finally {
      setReindexingRootId(null);
    }
  }

  const disabled = loading || saving || !settings;
  return (
    <form className="settings-form" onSubmit={(event) => void submit(event)}>
      <div className="settings-content-body">
        <div className="settings-page-grid settings-indexer-grid">
          <div className="settings-main-stack">
            <section className="settings-section-card">
              <header>
                <div>
                  <h3>{t("settings.indexer.workersTitle")}</h3>
                  <p>{t("settings.indexer.workersDescription")}</p>
                </div>
              </header>
              <fieldset className="settings-field-grid" disabled={disabled}>
                <NumberField label={t("settings.indexer.scanConcurrency")} value={draft.scanConcurrency} min={1} max={16} onChange={(value) => setDraft((current) => ({ ...current, scanConcurrency: value }))} />
                <NumberField label={t("settings.indexer.extractionConcurrency")} value={draft.extractionConcurrency} min={1} max={8} onChange={(value) => setDraft((current) => ({ ...current, extractionConcurrency: value }))} />
                <NumberField label={t("settings.indexer.reconciliationMinutes")} value={draft.reconciliationIntervalMs / 60_000} min={1} max={1440} onChange={(value) => setDraft((current) => ({ ...current, reconciliationIntervalMs: value * 60_000 }))} />
                <NumberField label={t("settings.indexer.commandTimeoutSeconds")} value={draft.commandTimeoutMs / 1000} min={5} max={900} onChange={(value) => setDraft((current) => ({ ...current, commandTimeoutMs: value * 1000 }))} />
              </fieldset>
            </section>

            <section className="settings-section-card">
              <header>
                <div>
                  <h3>{t("settings.indexer.limitsTitle")}</h3>
                  <p>{t("settings.indexer.limitsDescription")}</p>
                </div>
              </header>
              <fieldset className="settings-field-grid" disabled={disabled}>
                <NumberField label={t("settings.indexer.textLimitMiB")} value={draft.maxExtractedTextBytes / 1024 ** 2} min={0.0625} max={16} step={0.0625} onChange={(value) => setDraft((current) => ({ ...current, maxExtractedTextBytes: Math.round(value * 1024 ** 2) }))} />
                <NumberField label={t("settings.indexer.documentLimitMiB")} value={draft.maxSourceDocumentBytes / 1024 ** 2} min={1} max={2 * 1024 ** 2} onChange={(value) => setDraft((current) => ({ ...current, maxSourceDocumentBytes: Math.round(value * 1024 ** 2) }))} />
                <NumberField label={t("settings.indexer.pdfPages")} value={draft.maxPdfTextPages} min={1} max={5000} onChange={(value) => setDraft((current) => ({ ...current, maxPdfTextPages: value }))} />
                <NumberField label={t("settings.indexer.ocrPages")} value={draft.maxOcrPages} min={1} max={100} onChange={(value) => setDraft((current) => ({ ...current, maxOcrPages: value }))} />
              </fieldset>
            </section>

            <section className="settings-section-card">
              <header>
                <div>
                  <h3>{t("settings.indexer.rootsTitle")}</h3>
                  <p>{t("settings.indexer.rootsDescription")}</p>
                </div>
              </header>
              <div className="settings-indexer-roots">
                {roots.map((root) => {
                  const ocrEnabled = draft.ocrRootIds.includes(root.id);
                  const rebuilding = reindexingRootId === root.id;
                  return (
                    <div key={root.id} className="settings-indexer-root">
                      <span>
                        <strong>{root.name}</strong>
                        <small>{root.path}</small>
                      </span>
                      <label className="settings-indexer-ocr">
                        <input
                          type="checkbox"
                          checked={ocrEnabled}
                          disabled={disabled}
                          onChange={(event) => setDraft((current) => ({
                            ...current,
                            ocrRootIds: event.target.checked
                              ? [...new Set([...current.ocrRootIds, root.id])]
                              : current.ocrRootIds.filter((rootId) => rootId !== root.id)
                          }))}
                        />
                        <span>{t("settings.indexer.ocr")}</span>
                      </label>
                      <button
                        type="button"
                        className="secondary-button settings-indexer-rebuild"
                        disabled={loading || Boolean(reindexingRootId)}
                        aria-busy={rebuilding || undefined}
                        onClick={() => void reindex(root.id)}
                      >
                        <RefreshCw aria-hidden="true" size={14} className={rebuilding ? "is-spinning" : undefined} />
                        {rebuilding ? t("settings.indexer.reindexing") : t("settings.indexer.reindex")}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <aside className="settings-side-stack" aria-label={t("settings.indexer.statusTitle")}>
            <section className="settings-section-card settings-route-card">
              <header>
                <div>
                  <h3>{t("settings.indexer.statusTitle")}</h3>
                  <p>{t("settings.indexer.statusDescription")}</p>
                </div>
                <Database aria-hidden="true" size={17} />
              </header>
              <dl className="settings-summary-list">
                <StatusRow label={t("settings.indexer.service")} value={status ? t(`settings.indexer.states.${status.service.status}`) : t("common.states.unavailable")} />
                <StatusRow label={t("settings.indexer.watcher")} value={status ? t(`settings.indexer.states.${status.watcher.status}`) : t("common.states.unavailable")} />
                <StatusRow label={t("settings.indexer.queue")} value={status ? t("settings.indexer.queueSummary", { queued: status.queue.queued, running: status.queue.running, failed: status.queue.failed }) : t("common.states.unavailable")} />
                <StatusRow label={t("settings.indexer.rebuild")} value={status ? t("settings.indexer.rebuildSummary", { copied: status.rebuild.copied, total: status.rebuild.total }) : t("common.states.unavailable")} />
                <StatusRow label={t("settings.indexer.textLimit")} value={settings ? formatBytes(settings.maxExtractedTextBytes, locale) : t("common.states.unavailable")} />
                <StatusRow label={t("settings.modelProvider.updated")} value={settings ? formatDate(settings.updatedAt, locale) : t("settings.indexer.notLoaded")} />
              </dl>
            </section>
          </aside>
        </div>
      </div>

      <footer className="settings-actions">
        <span>{saved ? t("settings.indexer.saved") : settings ? t("settings.indexer.ready") : t("settings.indexer.notLoaded")}</span>
        <div>
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>{t("common.actions.cancel")}</button>
          <button className="primary-button" type="submit" disabled={disabled} aria-busy={saving || undefined}>
            {saving ? t("common.actions.saving") : saved ? <><Check aria-hidden="true" size={14} />{t("settings.indexer.saved")}</> : t("common.actions.saveChanges")}
          </button>
        </div>
      </footer>
    </form>
  );
}

function NumberField({ label, value, min, max, step = 1, onChange }: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="settings-preference-field">
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function StatusRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function indexerSettingsDraft(settings: IndexerSettings | null): IndexerSettingsDraft {
  if (settings) {
    const { updatedAt: _updatedAt, ...draft } = settings;
    return draft;
  }
  return {
    scanConcurrency: 4,
    extractionConcurrency: 2,
    reconciliationIntervalMs: 30 * 60_000,
    maxExtractedTextBytes: 2 * 1024 ** 2,
    maxSourceDocumentBytes: 512 * 1024 ** 2,
    commandTimeoutMs: 120_000,
    maxPdfTextPages: 500,
    maxOcrPages: 20,
    ocrRootIds: []
  };
}
