import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { FolderPlus, LoaderCircle, Music2, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MusicLibraryStatus, MusicSource } from "@cyberos/shared";
import { musicRequest } from "../../lib/music-api.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import { Switch } from "../common/Switch.js";
import { MusicDialog } from "../music/MusicDialogs.js";
import {
  StorageFilePickerDialog,
  type StorageFilePickerPool,
  type StorageFileSelection,
} from "../workspace/StorageFilePickerDialog.js";

interface MusicLibraryData {
  sources: MusicSource[];
  library: MusicLibraryStatus;
}

export function SettingsMusicLibraryCard({ pools, locale, onNotifySuccess, onNotifyError }: {
  pools: StorageFilePickerPool[];
  locale: SupportedLocale;
  onNotifySuccess: (message: string) => void;
  onNotifyError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<MusicLibraryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removeSource, setRemoveSource] = useState<MusicSource | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const restoreAddFocus = useRef(false);
  const availablePool = pools.find((pool) => pool.status !== "offline");

  const load = useCallback(async (showLoading = false) => {
    if (!showLoading && controller.current && !controller.current.signal.aborted) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    if (showLoading) setLoading(true);
    try {
      const [sources, status] = await Promise.all([
        musicRequest<{ sources: MusicSource[] }>("/sources", "GET", undefined, request.signal),
        musicRequest<{ status: MusicLibraryStatus }>("/status", "GET", undefined, request.signal),
      ]);
      if (request.signal.aborted) return;
      setData({ sources: sources.sources, library: status.status });
      setError(null);
    } catch (failure) {
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!request.signal.aborted) setLoading(false);
      if (controller.current === request) controller.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => { if (!busyRef.current) void load(); }, 5_000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      controller.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (busy !== null || pickerOpen || removeSource || !restoreAddFocus.current) return;
    const frame = window.requestAnimationFrame(() => {
      restoreAddFocus.current = false;
      addButton.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [busy, pickerOpen, removeSource]);

  async function run(key: string, operation: () => Promise<unknown>, success: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    controller.current?.abort();
    setBusy(key);
    let shouldRestoreAddFocus = key === "add";
    try {
      await operation();
      if (!mounted.current) return;
      if (key.startsWith("remove-")) {
        setRemoveSource(null);
        shouldRestoreAddFocus = true;
      }
      await load();
      if (mounted.current) onNotifySuccess(success);
    } catch (failure) {
      if (mounted.current) onNotifyError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        restoreAddFocus.current = shouldRestoreAddFocus;
        setBusy(null);
      }
    }
  }

  function addSource(selection: StorageFileSelection) {
    setPickerOpen(false);
    void run("add", () => musicRequest("/sources", "POST", {
      name: selection.name,
      storagePoolId: selection.storagePoolId,
      path: selection.path,
    }), t("settings.media.musicSourceAdded"));
  }

  return (
    <>
      <SettingsMusicLibraryContent
        data={data}
        loading={loading}
        error={error}
        busy={busy}
        canAdd={Boolean(availablePool)}
        addButtonRef={addButton}
        onAdd={() => setPickerOpen(true)}
        onRetry={() => void load(true)}
        onToggle={(source, enabled) => void run(`source-${source.id}`, () => musicRequest(
          `/sources/${encodeURIComponent(source.id)}`, "PATCH", { enabled },
        ), t("settings.media.musicSourceUpdated"))}
        onScan={(source) => void run(`scan-${source.id}`, () => musicRequest(
          `/sources/${encodeURIComponent(source.id)}/scan`, "POST",
        ), t("settings.media.musicScanQueued"))}
        onRemove={setRemoveSource}
      />
      {pickerOpen ? (
        <StorageFilePickerDialog
          pools={pools}
          initialPoolId={availablePool?.id ?? ""}
          locale={locale}
          mode="directory"
          directoryPurpose="musicLibrary"
          returnFocusRef={addButton}
          onCancel={() => setPickerOpen(false)}
          onSelect={addSource}
        />
      ) : null}
      {removeSource ? (
        <MusicDialog title={t("settings.media.removeMusicSource")} onClose={() => { if (!busyRef.current) setRemoveSource(null); }}>
          <p><strong>{removeSource.name}</strong></p>
          <p>{t("music.removeSourceConfirm")}</p>
          <footer>
            <button type="button" disabled={busy !== null} onClick={() => setRemoveSource(null)}>{t("common.actions.cancel")}</button>
            <button type="button" className="danger-button" disabled={busy !== null} aria-busy={busy !== null} onClick={() => {
              const source = removeSource;
              void run(`remove-${source.id}`, () => musicRequest(`/sources/${encodeURIComponent(source.id)}`, "DELETE"), t("settings.media.musicSourceRemoved"));
            }}>{t("music.remove")}</button>
          </footer>
        </MusicDialog>
      ) : null}
    </>
  );
}

export function SettingsMusicLibraryContent({ data, loading, error, busy, canAdd, addButtonRef, onAdd, onRetry, onToggle, onScan, onRemove }: {
  data: MusicLibraryData | null;
  loading: boolean;
  error: string | null;
  busy: string | null;
  canAdd: boolean;
  addButtonRef?: RefObject<HTMLButtonElement | null>;
  onAdd: () => void;
  onRetry: () => void;
  onToggle: (source: MusicSource, enabled: boolean) => void;
  onScan: (source: MusicSource) => void;
  onRemove: (source: MusicSource) => void;
}) {
  const { t } = useTranslation();
  const disabled = busy !== null || loading || data === null;
  return (
    <section id="settings-music-library" className="settings-section-card settings-field-wide settings-music-library" aria-busy={loading || busy !== null}>
      <header>
        <div>
          <h3><Music2 aria-hidden="true" size={18} />{t("settings.media.musicTitle")}</h3>
          <p>{t("settings.media.musicDescription")}</p>
        </div>
        <button ref={addButtonRef} type="button" className="secondary-button settings-music-add" disabled={disabled || !canAdd} onClick={onAdd}>
          <FolderPlus aria-hidden="true" size={15} />{t("music.addSource")}
        </button>
      </header>
      {error ? (
        <div className="settings-music-feedback" role="alert">
          <span>{error}</span>
          <button type="button" disabled={loading || busy !== null} onClick={onRetry}>{t("settings.media.musicRetry")}</button>
        </div>
      ) : null}
      {loading && !data ? <div className="settings-media-loading" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" size={18} />{t("settings.media.musicLoading")}</div> : null}
      {data ? (
        <>
          <dl className="settings-metric-grid">
            <div><strong>{data.library.trackCount}</strong><span>{t("music.views.tracks")}</span></div>
            <div><strong>{data.library.albumCount}</strong><span>{t("music.views.albums")}</span></div>
            <div><strong>{data.library.artistCount}</strong><span>{t("music.views.artists")}</span></div>
          </dl>
          {data.sources.length === 0 ? <p className="settings-media-empty">{t("settings.media.musicEmpty")}</p> : (
            <div className="settings-media-list">
              {data.sources.map((source) => {
                const scan = data.library.scans.find((scan) => scan.sourceId === source.id);
                return (
                  <article key={source.id} className="settings-media-source settings-music-source" aria-label={source.name}>
                    <div className="settings-media-source-main settings-music-source-main">
                      <span className="settings-media-source-icon"><Music2 aria-hidden="true" size={17} /></span>
                      <div>
                        <strong data-tooltip={source.name}>{source.name}</strong>
                        <span data-tooltip={source.path}>{source.path}</span>
                        <span className="settings-music-scan-state">{scan ? `${t(`music.scanStates.${scan.status}`)} · ${t("music.trackCount", { count: scan.scanned })}` : t("settings.media.notScanned")}</span>
                      </div>
                    </div>
                    <Switch className="settings-media-toggle" compact checked={source.enabled} disabled={disabled} label={t("music.sourceEnabled")} onCheckedChange={(enabled) => onToggle(source, enabled)} />
                    <div className="settings-media-row-actions">
                      <button type="button" disabled={disabled || !source.enabled} onClick={() => onScan(source)} aria-label={`${t("music.scan")}: ${source.name}`} data-tooltip={t("music.scan")}>
                        <RefreshCw aria-hidden="true" size={15} className={busy === `scan-${source.id}` ? "is-spinning" : undefined} />
                      </button>
                      <button type="button" disabled={disabled} onClick={() => onRemove(source)} aria-label={`${t("music.remove")}: ${source.name}`} data-tooltip={t("music.remove")}>
                        <Trash2 aria-hidden="true" size={15} />
                      </button>
                    </div>
                    {scan?.error ? <p className="settings-music-scan-error" role="alert">{scan.error}</p> : null}
                  </article>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
