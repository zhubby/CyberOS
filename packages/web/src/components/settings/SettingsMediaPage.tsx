import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Check,
  Film,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  Tv,
  X
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createMediaSource,
  deleteMediaSource,
  getMediaLibrarySettings,
  getMediaLibraryStatus,
  getMediaMatchCandidates,
  getMediaScans,
  getMediaSources,
  getMediaTitles,
  getTvStatus,
  requestMediaScan,
  updateMediaLibrarySettings,
  updateMediaMatch,
  updateMediaSource,
  type MediaLibrarySettings,
  type MediaLibraryStatus,
  type MediaMatchCandidate,
  type MediaScanRun,
  type MediaSource,
  type MediaSourceKind,
  type MediaTitleSummary,
  type TvModeStatus
} from "../../api.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import {
  StorageFilePickerDialog,
  type StorageFilePickerPool,
  type StorageFileSelection
} from "../workspace/StorageFilePickerDialog.js";

interface MediaPageData {
  settings: MediaLibrarySettings;
  sources: MediaSource[];
  status: MediaLibraryStatus;
  scans: MediaScanRun[];
  unmatched: MediaTitleSummary[];
  tvStatus: TvModeStatus;
}

export function SettingsMediaPage({
  pools,
  locale,
  onNotifySuccess,
  onNotifyError
}: {
  pools: StorageFilePickerPool[];
  locale: SupportedLocale;
  onNotifySuccess: (message: string) => void;
  onNotifyError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<MediaPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickerKind, setPickerKind] = useState<MediaSourceKind | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [selectedTitleId, setSelectedTitleId] = useState<string | null>(null);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidates, setCandidates] = useState<MediaMatchCandidate[]>([]);
  const [tmdbToken, setTmdbToken] = useState("");
  const [clearTmdbToken, setClearTmdbToken] = useState(false);
  const [language, setLanguage] = useState("zh-CN");
  const [region, setRegion] = useState("CN");
  const loadSequence = useRef(0);
  const candidateSearchSequence = useRef(0);

  const load = useCallback(async (reportError = true, syncForm = false) => {
    const sequence = ++loadSequence.current;
    try {
      const [settings, sources, status, scans, pending, unmatched, tvStatus] = await Promise.all([
        getMediaLibrarySettings(),
        getMediaSources(),
        getMediaLibraryStatus(),
        getMediaScans(undefined, 30),
        getMediaTitles({ matchStatus: "pending", limit: 100 }),
        getMediaTitles({ matchStatus: "unmatched", limit: 100 }),
        getTvStatus()
      ]);
      if (sequence !== loadSequence.current) return;
      setData({
        settings,
        sources,
        status,
        scans,
        unmatched: [...pending, ...unmatched].filter((title, index, titles) =>
          titles.findIndex((candidate) => candidate.id === title.id) === index),
        tvStatus
      });
      if (syncForm) {
        setLanguage(settings.language);
        setRegion(settings.region ?? "");
      }
      setError(null);
    } catch (nextError) {
      if (sequence !== loadSequence.current) return;
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setError(message);
      if (reportError) onNotifyError(message);
    }
  }, [onNotifyError]);

  useEffect(() => {
    void load(true, true);
    const timer = window.setInterval(() => void load(false), 5_000);
    return () => {
      window.clearInterval(timer);
      loadSequence.current += 1;
      candidateSearchSequence.current += 1;
    };
  }, [load]);

  async function run(key: string, operation: () => Promise<void>, successMessage: string) {
    setBusy(key);
    try {
      await operation();
      await load(false);
      onNotifySuccess(successMessage);
    } catch (nextError) {
      onNotifyError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("settings", async () => {
      const nextSettings = await updateMediaLibrarySettings({
        ...(clearTmdbToken
          ? { tmdbReadAccessToken: null }
          : tmdbToken.trim()
            ? { tmdbReadAccessToken: tmdbToken.trim() }
            : {}),
        language: language.trim(),
        region: region.trim() || null
      });
      setData((current) => current ? { ...current, settings: nextSettings } : current);
      setTmdbToken("");
      setClearTmdbToken(false);
    }, t("settings.media.settingsSaved"));
  }

  async function addSource(selection: StorageFileSelection) {
    const kind = pickerKind;
    if (!kind) return;
    setPickerKind(null);
    await run(`add-${kind}`, async () => {
      await createMediaSource({
        name: selection.name,
        kind,
        rootId: selection.rootId,
        storagePoolId: selection.storagePoolId,
        path: selection.path
      });
    }, t("settings.media.sourceAdded"));
  }

  async function searchCandidates(title: MediaTitleSummary, query = candidateQuery) {
    const sequence = ++candidateSearchSequence.current;
    setSelectedTitleId(title.id);
    setBusy(`candidates-${title.id}`);
    try {
      const nextCandidates = await getMediaMatchCandidates(title.id, query);
      if (sequence === candidateSearchSequence.current) setCandidates(nextCandidates);
    } catch (nextError) {
      if (sequence !== candidateSearchSequence.current) return;
      setCandidates([]);
      onNotifyError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (sequence === candidateSearchSequence.current) setBusy(null);
    }
  }

  async function applyMatch(title: MediaTitleSummary, candidate: MediaMatchCandidate | null) {
    candidateSearchSequence.current += 1;
    await run(`match-${title.id}`, async () => {
      await updateMediaMatch(title.id, candidate ? { tmdbId: candidate.tmdbId, excluded: false } : { excluded: true });
      await requestMediaScan(title.sourceId);
      setSelectedTitleId(null);
      setCandidates([]);
    }, candidate ? t("settings.media.matchSaved") : t("settings.media.titleExcluded"));
  }

  if (!data) {
    return (
      <div className="settings-content-body settings-media-loading" role={error ? "alert" : "status"}>
        {error ? error : <><LoaderCircle className="is-spinning" aria-hidden="true" size={18} />{t("settings.media.loading")}</>}
      </div>
    );
  }

  return (
    <>
      <SettingsMediaContent
        data={data}
        busy={busy}
        deleteId={deleteId}
        selectedTitleId={selectedTitleId}
        candidates={candidates}
        candidateQuery={candidateQuery}
        tmdbToken={tmdbToken}
        clearTmdbToken={clearTmdbToken}
        language={language}
        region={region}
        onTmdbTokenChange={(value) => { setTmdbToken(value); setClearTmdbToken(false); }}
        onClearTmdbTokenChange={(value) => { setClearTmdbToken(value); if (value) setTmdbToken(""); }}
        onLanguageChange={setLanguage}
        onRegionChange={setRegion}
        onSaveSettings={saveSettings}
        onAddSource={setPickerKind}
        onToggleSource={(source) => void run(`source-${source.id}`, async () => {
          await updateMediaSource(source.id, { enabled: !source.enabled });
        }, t("settings.media.sourceUpdated"))}
        onScanSource={(source) => void run(`scan-${source.id}`, async () => {
          await requestMediaScan(source.id);
        }, t("settings.media.scanQueued"))}
        onDeleteSource={(source) => {
          if (deleteId !== source.id) {
            setDeleteId(source.id);
            return;
          }
          setDeleteId(null);
          void run(`delete-${source.id}`, async () => deleteMediaSource(source.id), t("settings.media.sourceDeleted"));
        }}
        onCancelDelete={() => setDeleteId(null)}
        onCandidateQueryChange={setCandidateQuery}
        onSearchCandidates={(title) => void searchCandidates(title)}
        onSelectTitle={(title) => {
          setCandidateQuery(title.title);
          void searchCandidates(title, title.title);
        }}
        onApplyMatch={(title, candidate) => void applyMatch(title, candidate)}
      />
      {pickerKind ? (
        <StorageFilePickerDialog
          pools={pools}
          initialPoolId={pools.find((pool) => pool.status !== "offline")?.id ?? ""}
          locale={locale}
          mode="directory"
          directoryPurpose="mediaLibrary"
          onCancel={() => setPickerKind(null)}
          onSelect={(selection) => void addSource(selection)}
        />
      ) : null}
    </>
  );
}

export function SettingsMediaContent({
  data,
  busy,
  deleteId,
  selectedTitleId,
  candidates,
  candidateQuery,
  tmdbToken,
  clearTmdbToken,
  language,
  region,
  onTmdbTokenChange,
  onClearTmdbTokenChange,
  onLanguageChange,
  onRegionChange,
  onSaveSettings,
  onAddSource,
  onToggleSource,
  onScanSource,
  onDeleteSource,
  onCancelDelete,
  onCandidateQueryChange,
  onSearchCandidates,
  onSelectTitle,
  onApplyMatch
}: {
  data: MediaPageData;
  busy: string | null;
  deleteId: string | null;
  selectedTitleId: string | null;
  candidates: MediaMatchCandidate[];
  candidateQuery: string;
  tmdbToken: string;
  clearTmdbToken: boolean;
  language: string;
  region: string;
  onTmdbTokenChange: (value: string) => void;
  onClearTmdbTokenChange: (value: boolean) => void;
  onLanguageChange: (value: string) => void;
  onRegionChange: (value: string) => void;
  onSaveSettings: (event: FormEvent<HTMLFormElement>) => void;
  onAddSource: (kind: MediaSourceKind) => void;
  onToggleSource: (source: MediaSource) => void;
  onScanSource: (source: MediaSource) => void;
  onDeleteSource: (source: MediaSource) => void;
  onCancelDelete: () => void;
  onCandidateQueryChange: (value: string) => void;
  onSearchCandidates: (title: MediaTitleSummary) => void;
  onSelectTitle: (title: MediaTitleSummary) => void;
  onApplyMatch: (title: MediaTitleSummary, candidate: MediaMatchCandidate | null) => void;
}) {
  const { t } = useTranslation();
  const scansBySource = useMemo(() => new Map(data.sources.map((source) => [
    source.id,
    data.scans.find((scan) => scan.sourceId === source.id) ?? null
  ])), [data.scans, data.sources]);
  return (
    <div className="settings-content-body">
      <div className="settings-page-grid settings-media-page">
        <form className="settings-section-card" onSubmit={onSaveSettings}>
          <header>
            <div>
              <h3>{t("settings.media.metadataTitle")}</h3>
              <p>{t("settings.media.metadataDescription")}</p>
            </div>
          </header>
          <fieldset className="settings-field-grid settings-media-metadata" disabled={busy === "settings"}>
            <label className="settings-field-wide">
              <span>{t("settings.media.tmdbToken")}</span>
              <input
                type="password"
                value={tmdbToken}
                placeholder={data.settings.tmdbTokenConfigured
                  ? t("settings.media.tokenConfigured")
                  : t("settings.media.tokenMissing")}
                onChange={(event) => onTmdbTokenChange(event.target.value)}
              />
            </label>
            <label className="settings-check settings-field-wide">
              <input
                type="checkbox"
                checked={clearTmdbToken}
                onChange={(event) => onClearTmdbTokenChange(event.target.checked)}
              />
              <span>{t("settings.media.clearToken")}</span>
            </label>
            <label>
              <span>{t("settings.media.language")}</span>
              <input required value={language} onChange={(event) => onLanguageChange(event.target.value)} />
            </label>
            <label>
              <span>{t("settings.media.region")}</span>
              <input value={region} onChange={(event) => onRegionChange(event.target.value)} />
            </label>
          </fieldset>
          <div className="settings-card-actions">
            <button className="primary-button" type="submit" disabled={busy === "settings"} aria-busy={busy === "settings" || undefined}>
              {busy === "settings" ? t("common.actions.saving") : t("common.actions.saveChanges")}
            </button>
          </div>
        </form>

        <section className="settings-section-card settings-media-status">
          <header>
            <div>
              <h3>{t("settings.media.statusTitle")}</h3>
              <p>{t("settings.media.statusDescription")}</p>
            </div>
          </header>
          <dl className="settings-metric-grid">
            <div><strong>{data.status.movies}</strong><span>{t("settings.media.movies")}</span></div>
            <div><strong>{data.status.series}</strong><span>{t("settings.media.series")}</span></div>
            <div><strong>{data.status.unmatched}</strong><span>{t("settings.media.unmatched")}</span></div>
            <div><strong>{t(`settings.media.states.${data.status.state}`)}</strong><span>{t("settings.media.library")}</span></div>
          </dl>
        </section>

        <section className="settings-section-card settings-field-wide settings-tv-status">
          <header>
            <div>
              <h3>{t("settings.media.tvStatusTitle")}</h3>
              <p>{t("settings.media.tvStatusDescription")}</p>
            </div>
            <strong className={`settings-tv-overall is-${data.tvStatus.state}`}>
              {t(`settings.media.tvStates.${data.tvStatus.state}`)}
            </strong>
          </header>
          <dl className="settings-tv-components">
            {(["weston", "chromium", "vodPlayer", "cec"] as const).map((component) => {
              const health = data.tvStatus[component];
              return (
                <div key={component}>
                  <dt>{t(`settings.media.tvComponents.${component}`)}</dt>
                  <dd className={`is-${health.state}`}>{t(`settings.media.componentStates.${health.state}`)}</dd>
                  <small title={health.detail ?? undefined}>{health.detail ?? t("settings.media.noStatusDetail")}</small>
                </div>
              );
            })}
          </dl>
        </section>

        <section className="settings-section-card settings-field-wide">
          <header>
            <div>
              <h3>{t("settings.media.sourcesTitle")}</h3>
              <p>{t("settings.media.sourcesDescription")}</p>
            </div>
            <div className="settings-media-header-actions">
              <button type="button" className="secondary-button" onClick={() => onAddSource("movie")}>
                <Film aria-hidden="true" size={15} />{t("settings.media.addMovies")}
              </button>
              <button type="button" className="secondary-button" onClick={() => onAddSource("series")}>
                <Tv aria-hidden="true" size={15} />{t("settings.media.addSeries")}
              </button>
            </div>
          </header>
          {data.sources.length === 0 ? <p className="settings-media-empty">{t("settings.media.noSources")}</p> : (
            <div className="settings-media-list">
              {data.sources.map((source) => {
                const scan = scansBySource.get(source.id);
                const sourceBusy = busy?.endsWith(source.id) ?? false;
                return (
                  <article className="settings-media-source" key={source.id}>
                    <div className="settings-media-source-main">
                      <span className="settings-media-source-icon">{source.kind === "movie" ? <Film aria-hidden="true" size={17} /> : <Tv aria-hidden="true" size={17} />}</span>
                      <div>
                        <strong>{source.name}</strong>
                        <span title={source.path}>{source.path}</span>
                      </div>
                    </div>
                    <div className="settings-media-source-state">
                      <span>{scan ? t(`settings.media.scanStates.${scan.status}`) : t("settings.media.notScanned")}</span>
                      {scan?.status === "running" ? <small>{scan.scanned}</small> : null}
                    </div>
                    <label className="settings-check settings-media-toggle">
                      <input type="checkbox" checked={source.enabled} disabled={sourceBusy} onChange={() => onToggleSource(source)} />
                      <span>{t("settings.media.enabled")}</span>
                    </label>
                    <div className="settings-media-row-actions">
                      <button type="button" title={t("settings.media.scan")} aria-label={t("settings.media.scan")} disabled={sourceBusy} onClick={() => onScanSource(source)}>
                        <RefreshCw className={busy === `scan-${source.id}` ? "is-spinning" : undefined} aria-hidden="true" size={15} />
                      </button>
                      <button className={deleteId === source.id ? "danger-button" : ""} type="button" title={t("common.actions.delete")} aria-label={t("common.actions.delete")} disabled={sourceBusy} onClick={() => onDeleteSource(source)}>
                        {deleteId === source.id ? <Check aria-hidden="true" size={15} /> : <Trash2 aria-hidden="true" size={15} />}
                      </button>
                      {deleteId === source.id ? (
                        <button type="button" title={t("common.actions.cancel")} aria-label={t("common.actions.cancel")} onClick={onCancelDelete}>
                          <X aria-hidden="true" size={15} />
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="settings-section-card settings-field-wide">
          <header>
            <div>
              <h3>{t("settings.media.matchingTitle")}</h3>
              <p>{t("settings.media.matchingDescription")}</p>
            </div>
          </header>
          {data.unmatched.length === 0 ? <p className="settings-media-empty">{t("settings.media.noUnmatched")}</p> : (
            <div className="settings-media-match-list">
              {data.unmatched.map((title) => (
                <article className="settings-media-match" key={title.id}>
                  <button type="button" className="settings-media-match-title" aria-expanded={selectedTitleId === title.id} onClick={() => onSelectTitle(title)}>
                    <span>{title.title}</span>
                    <small>{[title.year, t(`settings.media.kinds.${title.kind}`)].filter(Boolean).join(" · ")}</small>
                  </button>
                  <button type="button" className="secondary-button" onClick={() => onApplyMatch(title, null)}>{t("settings.media.exclude")}</button>
                  {selectedTitleId === title.id ? (
                    <div className="settings-media-candidates">
                      <form onSubmit={(event) => { event.preventDefault(); onSearchCandidates(title); }}>
                        <label>
                          <Search aria-hidden="true" size={15} />
                          <input value={candidateQuery} onChange={(event) => onCandidateQueryChange(event.target.value)} aria-label={t("settings.media.searchCandidates")} />
                        </label>
                        <button className="secondary-button" type="submit" disabled={busy === `candidates-${title.id}`}>
                          {t("settings.media.search")}
                        </button>
                      </form>
                      {busy === `candidates-${title.id}` ? <p role="status">{t("settings.media.searching")}</p> : null}
                      {busy !== `candidates-${title.id}` && candidates.length === 0 ? <p>{t("settings.media.noCandidates")}</p> : null}
                      {candidates.map((candidate) => (
                        <button className="settings-media-candidate" type="button" key={candidate.tmdbId} onClick={() => onApplyMatch(title, candidate)}>
                          {candidate.posterUrl ? <img src={candidate.posterUrl} alt="" /> : <span className="settings-media-poster-placeholder"><Film aria-hidden="true" size={18} /></span>}
                          <span><strong>{candidate.title}</strong><small>{candidate.year ?? t("common.states.unknown")}</small><em>{candidate.overview || t("settings.media.noOverview")}</em></span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
