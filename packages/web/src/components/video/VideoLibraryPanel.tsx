import { ModalPortal } from "../common/ModalPortal.js";
import { useAppScroll, useAppViewState, useMobileBack } from "../../mobile/MobileNavigation.js";
import { CustomSelect } from "../common/CustomSelect.js";
import { SearchFilterPopover } from "../common/SearchFilterPopover.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Film,
  Heart,
  ListPlus,
  LoaderCircle,
  MonitorPlay,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  MediaCollection,
  MediaFileRecord,
  MediaMatchCandidate,
  MediaSourceRecord,
  MediaTitleSummary,
  VideoHome,
  VideoFilterOptions,
  VideoPage,
  VideoQuery,
  VideoTitleDetail,
} from "@cyberos/shared";
import {
  createCollection,
  deleteCollection,
  getCollections,
  getVideoDetail,
  getVideoHome,
  getVideoFilterOptions,
  getVideoPage,
  mediaRequest,
  saveCollection,
  setEpisodeState,
  setVideoState,
} from "../../lib/video-api.js";
import { usePlayback } from "../playback/PlaybackProvider.js";
import { MusicTakeoverDialog } from "../music/MusicProvider.js";
import { PanelHeader, PanelHeaderAction, PanelHeaderActions } from "../workspace/PanelHeader.js";
import { PanelContentSkeleton } from "../workspace/ManagementSkeleton.js";
import { useModalDialog } from "../workspace/useModalDialog.js";

type View = "home" | "movie" | "series" | "collections" | "watchlist";
type VideoFilters = {
  [Key in "sourceId" | "year" | "genre" | "sort" | "favorite" | "watched"]: VideoQuery[Key];
};
const DEFAULT_FILTERS: VideoFilters = {
  sourceId: undefined,
  year: undefined,
  genre: undefined,
  sort: "title",
  favorite: undefined,
  watched: undefined,
};

export function videoQueryWithFilters(query: VideoQuery, filters: VideoFilters): VideoQuery {
  const {
    sourceId: _source,
    year: _year,
    genre: _genre,
    sort: _sort,
    favorite: _favorite,
    watched: _watched,
    ...scope
  } = query;
  return {
    ...scope,
    sort: filters.sort ?? "title",
    ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
    ...(filters.year !== undefined ? { year: filters.year } : {}),
    ...(filters.genre ? { genre: filters.genre } : {}),
    ...(filters.favorite ? { favorite: true } : {}),
    ...(filters.watched !== undefined ? { watched: filters.watched } : {}),
  };
}
export function VideoLibraryPanel({
  tv = false,
  onManage,
  requestedTitleId,
  onSearch,
  onCloseRequestedTitle,
}: {
  tv?: boolean;
  onManage?: () => void;
  requestedTitleId?: string | null;
  onSearch?: () => void;
  onCloseRequestedTitle?: (restoreSearch: boolean) => void;
}) {
  const { t } = useTranslation();
  const playback = usePlayback();
  const [view, setView] = useAppViewState<View>("video.view", "home");
  const [home, setHome] = useState<VideoHome | null>(null);
  const [page, setPage] = useState<VideoPage>({ titles: [], nextCursor: null });
  const [query, setQuery] = useAppViewState<VideoQuery>("video.query", { sort: "title" });
  const [draftFilters, setDraftFilters] = useState<VideoFilters>(DEFAULT_FILTERS);
  const [sources, setSources] = useState<MediaSourceRecord[]>([]);
  const [filterOptions, setFilterOptions] = useState<VideoFilterOptions>({ years: [], genres: [] });
  const [filterState, setFilterState] = useState<"loading" | "ready" | "error">("loading");
  const [filterRetry, setFilterRetry] = useState(0);
  const [collections, setCollections] = useState<MediaCollection[]>([]);
  const [detail, setDetail] = useState<VideoTitleDetail | null>(null);
  const [detailId, setDetailId] = useAppViewState<string | null>("video.detail", null);
  const [selected, setSelected] = useAppViewState("video.selected", "");
  const [season, setSeason] = useAppViewState<number | null>("video.season", null);
  const [homeLoading, setHomeLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [editingCollection, setEditingCollection] =
    useState<MediaCollection | null>(null);
  const [deletingCollection, setDeletingCollection] =
    useState<MediaCollection | null>(null);
  const [matching, setMatching] = useState(false);
  const [candidates, setCandidates] = useState<MediaMatchCandidate[]>([]);
  const [pending, setPending] = useState<{
    file: MediaFileRecord;
    instance: string;
    sessionId: string;
  } | null>(null);
  const [homeVersion, setHomeVersion] = useState(0);
  const [version, setVersion] = useState(0);
  const moreRef = useRef(false);
  const detailSequence = useRef(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<{ element: HTMLElement; scroll: number; poster: number; titleId: string; regionIndex: number; railScroll: number } | null>(null);
  const collectionFocus = useRef<string | null>(null);
  const activeDetailId = detailId ?? detail?.id;
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (!tv) return;
    let live = true;
    setFilterState("loading");
    void getVideoFilterOptions().then(options => {
      if (live) { setFilterOptions(options); setFilterState("ready"); }
    }).catch(() => { if (live) setFilterState("error"); });
    return () => { live = false; };
  }, [tv, version, filterRetry]);
  useEffect(() => {
    const id = activeDetailId;
    if (!id) return;
    const controller = new AbortController();
    const sequence = detailSequence.current;
    setError(null);
    void getVideoDetail(id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted || sequence !== detailSequence.current)
          return;
        setDetail(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || sequence !== detailSequence.current)
          return;
        // Retain the requested detail so a temporary failure can be retried.
        setError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [version, activeDetailId]);
  useEffect(() => {
    let live = true;
    void Promise.all([
      getVideoHome(),
      getCollections(),
      mediaRequest<{ sources: MediaSourceRecord[] }>("media/sources"),
    ])
      .then(([h, c, s]) => {
        if (live) {
          setHome(h);
          setCollections(c);
          setSources(s.sources);
          setHomeLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setError(String(e.message));
          setHomeLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [version, homeVersion]);
  useEffect(() => {
    const events = new EventSource("/api/media/events");
    let stamp = "";
    let progressStamp = "";
    events.addEventListener("snapshot", (e) => {
      try {
        const { progress, ...library } = JSON.parse(
          (e as MessageEvent<string>).data,
        ) as Record<string, unknown>;
        const next = JSON.stringify(library);
        if (next !== stamp) {
          stamp = next;
          reload();
        }
        const nextProgress = JSON.stringify(progress);
        if (nextProgress !== progressStamp) {
          progressStamp = nextProgress;
          setHomeVersion((v) => v + 1);
        }
      } catch {
        /* reconnect supplies another snapshot */
      }
    });
    return () => events.close();
  }, [reload]);
  const searching =
    !!query.query ||
    !!query.favorite ||
    !!query.year ||
    !!query.genre ||
    !!query.sourceId ||
    query.watched !== undefined ||
    (query.sort !== undefined && query.sort !== "title");
  const listMode =
    (view !== "home" && view !== "collections") ||
    searching ||
    !!query.collectionId;
  const loading = listMode ? listLoading : homeLoading;
  useEffect(() => {
    if (!listMode) return;
    const controller = new AbortController();
    setListLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void getVideoPage(
        {
          ...query,
          ...(view === "movie" || view === "series" ? { kind: view } : {}),
          ...(view === "watchlist" ? { watchlist: true } : {}),
          limit: 40,
        },
        controller.signal,
      )
        .then((next) => {
          if (controller.signal.aborted) return;
          setPage(next);
          setListLoading(false);
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setError(e instanceof Error ? e.message : String(e));
            setListLoading(false);
          }
        });
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      setListLoading(false);
    };
  }, [view, query, version, listMode]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const open = async (title: MediaTitleSummary, preferred?: string) => {
    if (tv && document.activeElement instanceof HTMLElement) {
      const region = document.activeElement.closest<HTMLElement>('[data-tv-region="rail"], [data-tv-region="grid"]');
      returnFocus.current = {
        element: document.activeElement,
        scroll: contentRef.current?.scrollTop ?? 0,
        poster: [...(panelRef.current?.querySelectorAll(".video-poster") ?? [])].indexOf(document.activeElement),
        titleId: title.id,
        regionIndex: [...(panelRef.current?.querySelectorAll('[data-tv-region="rail"], [data-tv-region="grid"]') ?? [])].indexOf(region as HTMLElement),
        railScroll: region?.scrollLeft ?? 0,
      };
    }
    const sequence = ++detailSequence.current;
    setError(null);
    setBusy(true);
    setMatching(false);
    setCandidates([]);
    try {
      const next = await getVideoDetail(title.id);
      if (sequence !== detailSequence.current) return;
      setDetail(next);
      setDetailId(next.id);
      setSeason(next.seasons[0]?.seasonNumber ?? null);
      const files = [
        ...next.files,
        ...next.seasons.flatMap((s) => s.episodes.flatMap((e) => e.files)),
      ];
      const preferredSeason = next.seasons.find((s) =>
        s.episodes.some((e) =>
          e.files.some(
            (f) =>
              f.id === (preferred ?? next.nextFileId ?? next.progress?.fileId),
          ),
        ),
      );
      if (preferredSeason) setSeason(preferredSeason.seasonNumber);
      setSelected(
        files.find(
          (f) =>
            f.id === (preferred ?? next.nextFileId ?? next.progress?.fileId),
        )?.id ??
          files[0]?.id ??
          "",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (sequence === detailSequence.current) setBusy(false);
    }
  };
  const closeDetail = useCallback((restoreSearch = true) => {
    detailSequence.current++;
    setDetail(null);
    setDetailId(null);
    setMatching(false);
    setBusy(false);
    if (requestedTitleId) onCloseRequestedTitle?.(restoreSearch);
    if (tv && restoreSearch && !requestedTitleId) window.requestAnimationFrame(() => {
      const target = returnFocus.current;
      const region = target ? panelRef.current?.querySelectorAll<HTMLElement>('[data-tv-region="rail"], [data-tv-region="grid"]')[target.regionIndex] : null;
      const byTitle = [...(region?.querySelectorAll<HTMLElement>("[data-tv-title]") ?? [])].find(element => element.dataset.tvTitle === target?.titleId);
      const element = target?.element.isConnected ? target.element : byTitle ?? (target ? panelRef.current?.querySelectorAll<HTMLElement>(".video-poster")[target.poster] : null);
      if (element) {
        if (contentRef.current) contentRef.current.scrollTop = target?.scroll ?? 0;
        if (region) region.scrollLeft = target?.railScroll ?? 0;
        element.focus({ preventScroll: true });
      } else panelRef.current?.querySelector<HTMLElement>('.video-navigation button[aria-pressed="true"]')?.focus();
    });
  }, [tv, requestedTitleId, onCloseRequestedTitle, setDetailId]);
  useEffect(() => {
    if (!tv || !detail) return;
    const frame = window.requestAnimationFrame(() => (panelRef.current?.querySelector<HTMLElement>("[data-tv-detail-primary]") ?? panelRef.current?.querySelector<HTMLElement>(".video-back"))?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [tv, detail?.id]);
  useMobileBack(() => { if (detailId || detail) { closeDetail(); return true; } if (view !== "home") { setView("home"); return true; } return false; }, 10);
  useEffect(() => {
    if (!requestedTitleId) return;
    let live = true;
    void getVideoDetail(requestedTitleId)
      .then((next) => {
        if (live) {
          setDetail(next);
          setDetailId(next.id);
          setSeason(next.seasons[0]?.seasonNumber ?? null);
          setSelected(
            next.progress?.fileId ??
              next.files[0]?.id ??
              next.seasons[0]?.episodes[0]?.files[0]?.id ??
              "",
          );
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [requestedTitleId, setDetailId]);
  useEffect(() => {
    if (!tv) return;
    const back = () => {
      if (detail || detailId || busy) { closeDetail(); return; }
      if (query.collectionId) {
        setQuery(({ collectionId: _collection, ...rest }) => rest);
        window.requestAnimationFrame(() => {
          const buttons = [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-tv-collection]") ?? [])];
          (buttons.find(button => button.dataset.tvCollection === collectionFocus.current) ?? buttons[0])?.focus();
        });
      } else {
        setView("home");
        setQuery({ sort: "title" });
        window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(".video-navigation button")?.focus());
      }
    };
    const home = () => {
      closeDetail(false);
      setView("home");
      setQuery({ sort: "title" });
      if (contentRef.current) contentRef.current.scrollTop = 0;
      window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(".video-navigation button")?.focus());
    };
    window.addEventListener("cyberos:video-back", back);
    window.addEventListener("cyberos:video-home", home);
    return () => {
      window.removeEventListener("cyberos:video-back", back);
      window.removeEventListener("cyberos:video-home", home);
    };
  }, [tv, detail, detailId, busy, query.collectionId, closeDetail, setView, setQuery]);

  const startNas = async (
    file: MediaFileRecord,
    confirmation?: typeof pending,
  ) => {
    const position = detail?.fileProgress[file.id]?.completed
      ? 0
      : (detail?.fileProgress[file.id]?.positionSeconds ?? 0);
    if (confirmation) {
      const current = playback.nas;
      if (
        current?.serviceInstanceId !== confirmation.instance ||
        current.sessionId !== confirmation.sessionId
      )
        throw new Error(t("playback.stale"));
    }
    await mediaRequest(
      `media/files/${encodeURIComponent(file.id)}/play`,
      "POST",
      {
        startPositionSeconds: position,
        ...(confirmation
          ? {
              expectedSessionId: confirmation.sessionId,
              serviceInstanceId: confirmation.instance,
              playbackSessionId: confirmation.sessionId,
            }
          : {
              serviceInstanceId: playback.nas?.serviceInstanceId,
              playbackSessionId: playback.nas?.sessionId,
            }),
      },
    );
    playback.setTarget("nas");
    await playback.refresh();
    setPending(null);
  };
  const play = (file: MediaFileRecord, nas: boolean) => {
    if (!nas) {
      void act(() =>
        playback.playBrowser(file.id, detail?.title ?? file.name, {
          startPositionSeconds: detail?.fileProgress[file.id]?.completed
            ? 0
            : (detail?.fileProgress[file.id]?.positionSeconds ?? 0),
        }),
      );
      return;
    }
    if (playback.nas?.owner === "music" && playback.nas.sessionId) {
      setPending({
        file,
        instance: playback.nas.serviceInstanceId,
        sessionId: playback.nas.sessionId,
      });
      return;
    }
    void act(() => startNas(file));
  };
  const more = () => {
    if (!page.nextCursor || moreRef.current) return;
    moreRef.current = true;
    setBusy(true);
    return getVideoPage({
      ...query,
      ...(view === "movie" || view === "series" ? { kind: view } : {}),
      ...(view === "watchlist" ? { watchlist: true } : {}),
      cursor: page.nextCursor,
      limit: 40,
    })
      .then((next) =>
        setPage((old) => ({
          titles: [
            ...old.titles,
            ...next.titles.filter(
              (n) => !old.titles.some((o) => o.id === n.id),
            ),
          ],
          nextCursor: next.nextCursor,
        })),
      )
      .catch((e) => setError(e.message))
      .finally(() => {
        moreRef.current = false;
        setBusy(false);
      });
  };
  useAppScroll(contentRef, `video.scroll:${view}:${detailId ?? ""}:${JSON.stringify(query)}`, { ready: !loading && !busy && (!detailId || Boolean(detail)), canLoadMore: Boolean(page.nextCursor) && !error && !detailId, loadMore: more });
  const files = detail
    ? [
        ...detail.files,
        ...detail.seasons.flatMap((s) => s.episodes.flatMap((e) => e.files)),
      ]
    : [];
  const file = files.find((f) => f.id === selected);
  const changeState = (patch: Parameters<typeof setVideoState>[1]) => {
    if (detail)
      void act(async () => {
        await setVideoState(detail.id, patch);
        setDetail(await getVideoDetail(detail.id));
      });
  };
  const posters = (titles: MediaTitleSummary[], rail = false, next = false) => (
    <div className={rail ? "video-poster-rail" : "video-poster-wall"} data-tv-region={rail ? "rail" : "grid"}>
      {titles.map((title) => (
        <VideoPoster
          key={title.id}
          title={title}
          onOpen={() =>
            void open(
              title,
              next
                ? home?.upNext.find((n) => n.title.id === title.id)?.fileId
                : undefined,
            )
          }
        />
      ))}
    </div>
  );
  return (
    <div
      ref={panelRef}
      className={`video-panel${tv ? " video-panel-tv" : ""}`}
      aria-busy={busy || loading}
    >
      <PanelHeader
        icon={<MonitorPlay size={22} />}
        title={t("video.title")}
        subtitle={tv ? t("playback.tvOutput") : t("video.subtitle")}
        actions={
          <PanelHeaderActions className="library-header-actions" label={t("video.library")}>
            <PanelHeaderAction
              data-tv-focusable
              label={t("video.refresh")}
              disabled={busy || loading}
              aria-busy={busy || loading || undefined}
              mobilePrimary
              onClick={reload}
            >
              {busy || loading ? <LoaderCircle className="is-spinning" size={17} aria-hidden="true" /> : <RefreshCw size={17} />}
            </PanelHeaderAction>
            {!tv && onManage ? (
              <PanelHeaderAction label={t("video.manage")} onClick={onManage}>
                <Settings2 size={17} />
              </PanelHeaderAction>
            ) : null}
          </PanelHeaderActions>
        }
      />
      {!detail ? (
        <div className="library-search-toolbar" data-tv-region="filters">
          {tv ? <button type="button" className="plain-button tv-library-search" data-tv-focusable onClick={onSearch}><Search size={22} aria-hidden="true" />{t("video.search")}</button> : <form className="search" onSubmit={(event) => event.preventDefault()}>
            <Search size={17} aria-hidden="true" />
            <input
              data-tv-focusable
              type="search"
              aria-label={t("video.search")}
              placeholder={t("video.search")}
              value={query.query ?? ""}
              onChange={(event) => setQuery((current) => ({ ...current, query: event.target.value }))}
            />
          </form>}
          <SearchFilterPopover
            label={t("video.filter")}
            active={Boolean(query.sourceId || query.year || query.genre || query.favorite || query.watched !== undefined || (query.sort && query.sort !== "title"))}
            onOpen={() => setDraftFilters({
              sourceId: query.sourceId,
              year: query.year,
              genre: query.genre,
              sort: query.sort ?? "title",
              favorite: query.favorite,
              watched: query.watched,
            })}
            onApply={() => setQuery((current) => videoQueryWithFilters(current, draftFilters))}
            onReset={() => setQuery((current) => videoQueryWithFilters(current, DEFAULT_FILTERS))}
          >
            <div className="workspace-search-field">
              <span>{t("video.source")}</span>
              <CustomSelect
                value={draftFilters.sourceId ?? ""}
                ariaLabel={t("video.source")}
                options={[
                  { value: "", label: t("video.all") },
                  ...sources.map((source) => ({ value: source.id, label: source.name })),
                ]}
                onChange={(sourceId) => setDraftFilters((current) => ({ ...current, sourceId: sourceId || undefined }))}
              />
            </div>
            <div className="workspace-search-field-grid">
              <div className="workspace-search-field">
                <span>{t("video.year")}</span>
                {tv ? <CustomSelect
                  ariaLabel={t("video.year")}
                  value={String(draftFilters.year ?? "")}
                  disabled={filterState !== "ready"}
                  options={[{ value: "", label: t("video.all") }, ...filterOptions.years.map(year => ({ value: String(year), label: String(year) }))]}
                  onChange={year => setDraftFilters(current => ({ ...current, year: year ? Number(year) : undefined }))}
                /> : <input
                  aria-label={t("video.year")}
                  data-tv-focusable
                  type="number"
                  min="1"
                  max="9999"
                  value={draftFilters.year ?? ""}
                  onChange={(event) => setDraftFilters((current) => ({
                    ...current,
                    year: event.target.value ? Number(event.target.value) : undefined,
                  }))}
                />}
              </div>
              <div className="workspace-search-field">
                <span>{t("video.genre")}</span>
                {tv ? <CustomSelect
                  ariaLabel={t("video.genre")}
                  value={draftFilters.genre ?? ""}
                  disabled={filterState !== "ready"}
                  options={[{ value: "", label: t("video.all") }, ...filterOptions.genres.map(genre => ({ value: genre, label: genre }))]}
                  onChange={genre => setDraftFilters(current => ({ ...current, genre: genre || undefined }))}
                /> : <input
                  aria-label={t("video.genre")}
                  data-tv-focusable
                  value={draftFilters.genre ?? ""}
                  onChange={(event) => setDraftFilters((current) => ({ ...current, genre: event.target.value || undefined }))}
                />}
              </div>
              {tv && filterState !== "ready" ? <div className="video-filter-status" role={filterState === "error" ? "alert" : "status"}>
                {t(filterState === "error" ? "tv.filtersFailed" : "tv.loadingFilters")}
                {filterState === "error" ? <button onClick={() => setFilterRetry(v => v + 1)} className="plain-button">{t("tv.retry")}</button> : null}
              </div> : null}
              <div className="workspace-search-field">
                <span>{t("video.sort")}</span>
                <CustomSelect<NonNullable<VideoQuery["sort"]>>
                  value={draftFilters.sort ?? "title"}
                  ariaLabel={t("video.sort")}
                  options={(["title", "year", "added", "rating", "recent"] as const).map((sort) => ({
                    value: sort,
                    label: t(`video.sort_${sort}`),
                  }))}
                  onChange={(sort) => setDraftFilters((current) => ({ ...current, sort }))}
                />
              </div>
              <div className="workspace-search-field">
                <span>{t("video.watched")}</span>
                <CustomSelect
                  value={draftFilters.watched === undefined ? "" : String(draftFilters.watched)}
                  ariaLabel={t("video.watched")}
                  options={[
                    { value: "", label: t("video.all") },
                    { value: "true", label: t("video.watched") },
                    { value: "false", label: t("video.unwatched") },
                  ]}
                  onChange={(watched) => setDraftFilters((current) => ({
                    ...current,
                    watched: watched ? watched === "true" : undefined,
                  }))}
                />
              </div>
            </div>
            <label className="workspace-search-filter-check">
              <input
                data-tv-focusable
                type="checkbox"
                checked={draftFilters.favorite ?? false}
                onChange={(event) => setDraftFilters((current) => ({ ...current, favorite: event.target.checked || undefined }))}
              />
              <span>{t("video.favorites")}</span>
            </label>
          </SearchFilterPopover>
        </div>
      ) : null}
      <nav className="video-navigation" data-tv-region="navigation" aria-label={t("video.library")}>
        {(["home", "movie", "series", "collections", "watchlist"] as const).map(
          (tab) => (
            <button
              data-tv-focusable
              key={tab}
              aria-pressed={view === tab && !detail}
              onClick={() => {
                closeDetail(false);
                setView(tab);
                setQuery((q) => {
                  const { collectionId: _collection, ...rest } = q;
                  return rest;
                });
              }} className="plain-button"
            >
              {t(`video.${tab}`)}
            </button>
          ),
        )}
      </nav>
      {error ? (
        <p className="video-error" role="alert">
          {error}
        </p>
      ) : null}
      <div ref={contentRef} className="video-content">
        {detail ? (
          <article className="video-detail">
            <button className="plain-button video-back" data-tv-focusable onClick={() => closeDetail()}>
              <ArrowLeft size={17} />
              {t("video.back")}
            </button>
            <div className="video-detail-main">
              <VideoArtwork title={detail} />
              <div data-tv-region="detail">
                <h2>{detail.title}</h2>
                <p className="video-meta metadata">
                  {[
                    detail.year,
                    detail.runtimeMinutes
                      ? t("video.minutes", { count: detail.runtimeMinutes })
                      : null,
                    detail.rating === null
                      ? null
                      : `★ ${detail.rating.toFixed(1)}`,
                    ...detail.genres,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p>{detail.overview ?? t("video.noOverview")}</p>
                <div className="video-actions">
                  <button
                    data-tv-focusable
                    disabled={busy}
                    aria-pressed={detail.personal.favorite}
                    onClick={() =>
                      changeState({ favorite: !detail.personal.favorite })
                    } className="plain-button"
                  >
                    <Heart size={17} />
                    {t("video.favorites")}
                  </button>
                  <button
                    data-tv-focusable
                    disabled={busy}
                    aria-pressed={detail.personal.watchlist}
                    onClick={() =>
                      changeState({ watchlist: !detail.personal.watchlist })
                    } className="plain-button"
                  >
                    <ListPlus size={17} />
                    {t("video.watchlist")}
                  </button>
                  <button
                    data-tv-focusable
                    disabled={busy}
                    aria-pressed={detail.watched}
                    onClick={() => changeState({ watched: !detail.watched })} className="plain-button"
                  >
                    <Check size={17} />
                    {t("video.watched")}
                  </button>
                </div>
                <div className="video-actions">
                  {file ? (
                    <>
                      <button
                        className="primary-button"
                        data-tv-detail-primary={tv || undefined}
                        data-tv-focusable
                        disabled={busy}
                        onClick={() => play(file, tv)}
                      >
                        <Play size={17} />
                        {tv ? t("video.playTv") : t("video.playBrowser")}
                      </button>
                      {!tv ? (
                        <button
                          data-tv-focusable
                          disabled={busy}
                          onClick={() => play(file, true)} className="plain-button"
                        >
                          <MonitorPlay size={17} />
                          {t("video.playTv")}
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <p>{t("video.fileUnavailable")}</p>
                  )}
                </div>
                {file ? (
                  <div className="video-version">
                    <span>{t("video.version")}</span>
                    <CustomSelect
                      ariaLabel={t("video.version")}
                      value={selected}
                      onChange={setSelected}
                      options={files
                        .filter((f) => f.episodeId === file.episodeId)
                        .map((f, index) => ({ value: f.id, label: tv ? [`${t("video.version")} ${index + 1}`, ...(detail.technical[f.id] ?? []).filter(track => track.type === "video" && track.height).map(track => `${track.height}p`), f.videoCodec, `${(f.sizeBytes / 1024 ** 3).toFixed(1)} GB`].filter(Boolean).join(" · ") : f.name }))}
                    />
                    <small>
                      {[
                        file.container,
                        file.videoCodec,
                        file.audioCodec,
                        ...(detail.technical[file.id] ?? [])
                          .filter((track) => track.type === "video")
                          .flatMap((track) => [
                            track.width && track.height
                              ? `${track.width}×${track.height}`
                              : null,
                            track.hdr ? "HDR" : null,
                          ]),
                        `${(file.sizeBytes / 1024 ** 3).toFixed(1)} GB`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    {tv ? <details className="tv-file-details">
                      <summary data-tv-focusable>{t("tv.fileDetails")}</summary>
                      <p>{file.name}</p>
                      <p>{file.relativePath}</p>
                      {(detail.technical[file.id] ?? []).map((track, index) => <p key={index}>{[track.type, track.codec, track.width && track.height ? `${track.width}×${track.height}` : null, track.language, track.title, track.hdr ? "HDR" : null].filter(Boolean).join(" · ")}</p>)}
                    </details> : null}
                  </div>
                ) : null}
              </div>
            </div>
            {detail.seasons.length ? (
              <section className="video-seasons" data-tv-region="episodes">
                <nav>
                  {detail.seasons.map((s) => (
                    <button
                      data-tv-focusable
                      key={s.id}
                      aria-pressed={season === s.seasonNumber}
                      onClick={() => setSeason(s.seasonNumber)} className="plain-button"
                    >
                      {s.name ?? `${t("video.season")} ${s.seasonNumber}`}
                    </button>
                  ))}
                </nav>
                {detail.seasons
                  .find((s) => s.seasonNumber === season)
                  ?.episodes.map((e) => (
                    <div
                      key={e.id}
                      className={`video-episode${e.files.some((f) => f.id === selected) ? " is-selected" : ""}`}
                    >
                      <button
                        data-tv-focusable
                        disabled={busy || !e.files.length}
                        onClick={() => {
                          const episodeFile = e.files.find((f) => f.id === selected) ?? e.files[0];
                          if (!episodeFile) return;
                          setSelected(episodeFile.id);
                          if (tv) play(episodeFile, true);
                        }} className="plain-button"
                      >
                        <span>{String(e.episodeNumber).padStart(2, "0")}</span>
                        <span>
                          <strong>
                            {e.name ??
                              `${t("video.episode")} ${e.episodeNumber}`}
                          </strong>
                          <small>{e.overview}</small>
                        </span>
                        <Play size={17} />
                      </button>
                      <button
                        data-tv-focusable
                        disabled={busy}
                        aria-label={t("video.watched")}
                        data-tooltip={t("video.watched")}
                        aria-pressed={
                          detail.episodeWatched[e.id] ??
                          e.files.some(
                            (f) => detail.fileProgress[f.id]?.completed,
                          )
                        }
                        onClick={() =>
                          void act(async () => {
                            await setEpisodeState(
                              e.id,
                              !(
                                detail.episodeWatched[e.id] ??
                                e.files.some(
                                  (f) => detail.fileProgress[f.id]?.completed,
                                )
                              ),
                            );
                            setDetail(await getVideoDetail(detail.id));
                          })
                        } className="plain-button"
                      >
                        <Check size={17} />
                      </button>
                    </div>
                  ))}
              </section>
            ) : null}
            {detail.credits.length ? (
              <section>
                <h3>{t("video.credits")}</h3>
                <p>
                  {detail.credits
                    .map((c) => `${c.name} · ${c.role}`)
                    .join(" / ")}
                </p>
              </section>
            ) : null}
            {!tv ? (
              <div className="video-management">
                <label>
                  {t("video.addCollection")}
                  <CustomSelect
                    value={""}
                    disabled={busy}
                    onChange={(selectedValue) => {
                      const c = collections.find(
                        (c) => c.id === selectedValue,
                      );
                      if (c)
                        void act(() =>
                          saveCollection(c.id, {
                            titleIds: [...new Set([...c.titleIds, detail.id])],
                          }),
                        );
                    }}
                    ariaLabel={t("video.addCollection")}
                    options={[{ value: "", label: t("video.choose") }, ...(collections
                      .filter((c) => c.kind === "manual").map((c) => ({ value: c.id, label: `${c.name}${c.titleIds.includes(detail.id) ? " ✓" : ""}` })))]}
                  />
                </label>
                {collections
                  .filter(
                    (c) =>
                      c.kind === "manual" && c.titleIds.includes(detail.id),
                  )
                  .map((c) => (
                    <button
                      key={c.id}
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          saveCollection(c.id, {
                            titleIds: c.titleIds.filter(
                              (id) => id !== detail.id,
                            ),
                          }),
                        )
                      } className="plain-button"
                    >
                      {t("video.removeCollection")} · {c.name}
                    </button>
                  ))}
                <button onClick={() => setMatching((v) => !v)} className="plain-button">
                  {t("video.correctMatch")}
                </button>
                {matching ? (
                  <div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const q = String(
                          new FormData(e.currentTarget).get("query") ?? "",
                        );
                        void act(async () =>
                          setCandidates(
                            (
                              await mediaRequest<{
                                candidates: MediaMatchCandidate[];
                              }>(
                                `media/titles/${encodeURIComponent(detail.id)}/match-candidates?query=${encodeURIComponent(q)}`,
                              )
                            ).candidates,
                          ),
                        );
                      }}
                    >
                      <input
                        name="query"
                        defaultValue={detail.title}
                        aria-label={t("video.search")}
                      />
                      <button disabled={busy} className="plain-button">{t("video.search")}</button>
                    </form>
                    {candidates.map((c) => (
                      <button
                        key={c.tmdbId}
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await mediaRequest(
                              `media/titles/${encodeURIComponent(detail.id)}/match`,
                              "PUT",
                              { tmdbId: c.tmdbId },
                            );
                            setDetail(await getVideoDetail(detail.id));
                          })
                        } className="plain-button"
                      >
                        {c.title} · {c.year}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </article>
        ) : loading ? (
          <PanelContentSkeleton />
        ) : listMode ? (
          <>
            {posters(page.titles)}
            {!page.titles.length ? (
              <p className="video-empty">{t("video.empty")}</p>
            ) : null}
            {page.nextCursor ? (
              <button data-tv-focusable disabled={busy} onClick={more} className="plain-button">
                {t("video.loadMore")}
              </button>
            ) : null}
          </>
        ) : view === "collections" ? (
          <section className="video-collections" data-tv-region="collections">
            <header>
              <h3>{t("video.collections")}</h3>
              {!tv ? (
                <button onClick={() => setCollectionOpen(true)} className="plain-button">
                  <Plus size={17} />
                  {t("video.newCollection")}
                </button>
              ) : null}
            </header>
            {collections.map((c) => (
              <div key={c.id}>
                <button
                  data-tv-focusable
                  data-tv-collection={c.id}
                  onClick={() => {
                    collectionFocus.current = c.id;
                    setQuery((q) => ({ ...q, collectionId: c.id }));
                  }} className="plain-button"
                >
                  <Film size={24} />
                  <strong>{c.name}</strong>
                  <span>{c.titleIds.length}</span>
                </button>
                {!tv && c.kind === "manual" ? (
                  <>
                    <button
                      aria-label={t("video.rename")}
                      data-tooltip={t("video.rename")}
                      onClick={() => setEditingCollection(c)} className="plain-button"
                    >
                      <Pencil size={17} />
                    </button>
                    <button
                      aria-label={t("video.delete")}
                      data-tooltip={t("video.delete")}
                      onClick={() => setDeletingCollection(c)} className="plain-button"
                    >
                      <Trash2 size={17} />
                    </button>
                  </>
                ) : null}
              </div>
            ))}
          </section>
        ) : home ? (
          <>
            {[
              ["continue", home.continueWatching],
              ["upNext", home.upNext.map((n) => n.title)],
              ["recent", home.recentlyAdded],
              ["watchlist", home.watchlist],
            ].map(([name, titles]) =>
              (titles as MediaTitleSummary[]).length ? (
                <section className="video-home-row" key={name as string}>
                  <h3>
                    {t(
                      `video.${name as "continue" | "upNext" | "recent" | "watchlist"}`,
                    )}
                  </h3>
                  {posters(
                    titles as MediaTitleSummary[],
                    true,
                    name === "upNext",
                  )}
                </section>
              ) : null,
            )}
            {!home.recentlyAdded.length ? (
              <div className="video-empty">
                <Film size={42} />
                <h3>{t("video.empty")}</h3>
                {onManage && !tv ? (
                  <button onClick={onManage} className="plain-button">{t("video.manage")}</button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {collectionOpen ? (
        <CollectionDialog
          busy={busy}
          onClose={() => setCollectionOpen(false)}
          onSave={(name) =>
            void act(async () => {
              await createCollection(name);
              setCollectionOpen(false);
            })
          }
        />
      ) : null}
      {editingCollection ? (
        <CollectionDialog
          initialName={editingCollection.name}
          busy={busy}
          onClose={() => setEditingCollection(null)}
          onSave={(name) =>
            void act(async () => {
              await saveCollection(editingCollection.id, { name });
              setEditingCollection(null);
            })
          }
        />
      ) : null}
      {deletingCollection ? (
        <DeleteCollectionDialog
          collection={deletingCollection}
          busy={busy}
          onClose={() => setDeletingCollection(null)}
          onConfirm={() =>
            void act(async () => {
              await deleteCollection(deletingCollection.id);
              setDeletingCollection(null);
            })
          }
        />
      ) : null}
      {pending ? (
        <MusicTakeoverDialog
          title={t("music.takeoverTitle")}
          body={t("music.takeoverMusic")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() =>
            void act(async () => {
              try {
                await startNas(pending.file, pending);
              } finally {
                setPending(null);
              }
            })
          }
        />
      ) : null}
    </div>
  );
}
function VideoArtwork({ title }: { title: MediaTitleSummary }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [title.id, title.posterKey]);
  return (
    <div className="video-artwork">
      {title.posterKey && !failed ? (
        <img
          loading="lazy"
          alt=""
          src={`/api/media/titles/${encodeURIComponent(title.id)}/artwork/poster?v=${encodeURIComponent(title.posterKey)}`}
          onError={() => setFailed(true)}
        />
      ) : (
        <Film size={36} aria-hidden="true" />
      )}
    </div>
  );
}
function VideoPoster({
  title,
  onOpen,
}: {
  title: MediaTitleSummary;
  onOpen: () => void;
}) {
  return (
    <button data-tv-focusable data-tv-title={title.id} className="plain-button video-poster" onClick={onOpen}>
      <VideoArtwork title={title} />
      <strong>{title.title}</strong>
      <small>
        {title.year ?? "—"}
        {title.progress?.completed ? <Check size={13} /> : null}
      </small>
      {title.progress?.durationSeconds && !title.progress.completed ? (
        <progress
          value={title.progress.positionSeconds}
          max={title.progress.durationSeconds}
          aria-label={title.title}
        />
      ) : null}
    </button>
  );
}
function CollectionDialog({
  onClose,
  onSave,
  busy,
  initialName,
}: {
  initialName?: string;
  onClose: () => void;
  onSave: (name: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const ref = useModalDialog(onClose, busy);
  return (
    <ModalPortal className="management-dialog-backdrop">
      <section
        className="music-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(initialName ? "video.rename" : "video.newCollection")}
        tabIndex={-1}
        ref={ref}
      >
        <header>
          <h2>{t(initialName ? "video.rename" : "video.newCollection")}</h2>
          <button onClick={onClose} aria-label={t("video.close")} data-tooltip={t("video.close")} className="plain-button">
            <X size={20} />
          </button>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(String(new FormData(e.currentTarget).get("name") ?? ""));
          }}
        >
          <input
            name="name"
            defaultValue={initialName}
            required
            maxLength={120}
            aria-label={t("video.name")}
          />
          <button className="primary-button" disabled={busy}>
            <Plus size={16} />
            {t(initialName ? "video.save" : "video.create")}
          </button>
        </form>
      </section>
    </ModalPortal>
  );
}

function DeleteCollectionDialog({
  collection,
  busy,
  onClose,
  onConfirm,
}: {
  collection: MediaCollection;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const ref = useModalDialog(onClose, busy);
  return (
    <ModalPortal className="management-dialog-backdrop">
      <section
        className="music-dialog"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t("video.delete")}
        tabIndex={-1}
      >
        <header>
          <h2>{collection.name}</h2>
          <button
            disabled={busy}
            onClick={onClose}
            aria-label={t("video.close")}
            data-tooltip={t("video.close")} className="plain-button"
          >
            <X size={20} />
          </button>
        </header>
        <p>{t("video.deleteConfirm")}</p>
        <button disabled={busy} onClick={onConfirm} className="plain-button">
          <Trash2 size={17} />
          {t("video.delete")}
        </button>
      </section>
    </ModalPortal>
  );
}
