import { ModalPortal } from "../common/ModalPortal.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Film,
  Heart,
  ListPlus,
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
  getVideoPage,
  mediaRequest,
  saveCollection,
  setEpisodeState,
  setVideoState,
} from "../../lib/video-api.js";
import { usePlayback } from "../playback/PlaybackProvider.js";
import { MusicTakeoverDialog } from "../music/MusicProvider.js";
import { PanelHeader, PanelHeaderAction } from "../workspace/PanelHeader.js";
import { useModalDialog } from "../workspace/useModalDialog.js";

type View = "home" | "movie" | "series" | "collections" | "watchlist";
export function VideoLibraryPanel({
  tv = false,
  onManage,
  requestedTitleId,
}: {
  tv?: boolean;
  onManage?: () => void;
  requestedTitleId?: string | null;
}) {
  const { t } = useTranslation();
  const playback = usePlayback();
  const [view, setView] = useState<View>("home");
  const [home, setHome] = useState<VideoHome | null>(null);
  const [page, setPage] = useState<VideoPage>({ titles: [], nextCursor: null });
  const [query, setQuery] = useState<VideoQuery>({ sort: "title" });
  const [sources, setSources] = useState<MediaSourceRecord[]>([]);
  const [collections, setCollections] = useState<MediaCollection[]>([]);
  const [detail, setDetail] = useState<VideoTitleDetail | null>(null);
  const [selected, setSelected] = useState("");
  const [season, setSeason] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
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
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const id = detail?.id;
    if (!id) return;
    const controller = new AbortController();
    const sequence = detailSequence.current;
    void getVideoDetail(id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted || sequence !== detailSequence.current)
          return;
        setDetail(next);
      })
      .catch(() => {
        /* Keep the current detail while a scan is completing. */
      });
    return () => controller.abort();
  }, [version, detail?.id]);
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
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setError(String(e.message));
          setLoading(false);
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
    query.watched !== undefined;
  const listMode =
    (view !== "home" && view !== "collections") ||
    searching ||
    !!query.collectionId;
  useEffect(() => {
    if (!listMode) return;
    const controller = new AbortController();
    setLoading(true);
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
          setPage(next);
          setLoading(false);
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setError(e instanceof Error ? e.message : String(e));
            setLoading(false);
          }
        });
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
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
    const sequence = ++detailSequence.current;
    setError(null);
    setBusy(true);
    setMatching(false);
    setCandidates([]);
    try {
      const next = await getVideoDetail(title.id);
      if (sequence !== detailSequence.current) return;
      setDetail(next);
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
  const closeDetail = () => {
    detailSequence.current++;
    setDetail(null);
    setMatching(false);
  };
  useEffect(() => {
    if (!requestedTitleId) return;
    let live = true;
    void getVideoDetail(requestedTitleId)
      .then((next) => {
        if (live) {
          setDetail(next);
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
  }, [requestedTitleId]);
  useEffect(() => {
    if (!tv) return;
    const back = () => {
      detailSequence.current++;
      setDetail(null);
      setMatching(false);
      window.requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(".video-navigation button")
          ?.focus(),
      );
    };
    window.addEventListener("cyberos:video-back", back);
    return () => window.removeEventListener("cyberos:video-back", back);
  }, [tv]);

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
    void getVideoPage({
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
    <div className={rail ? "video-poster-rail" : "video-poster-wall"}>
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
      className={`video-panel${tv ? " video-panel-tv" : ""}`}
      aria-busy={busy}
    >
      <PanelHeader
        icon={<MonitorPlay size={22} />}
        title={t("video.title")}
        subtitle={tv ? t("playback.tvOutput") : t("video.library")}
        actions={
          <div className="management-actions">
            <PanelHeaderAction
              data-tv-focusable
              label={t("video.refresh")}
              disabled={busy}
              onClick={reload}
            >
              <RefreshCw size={17} />
            </PanelHeaderAction>
            {!tv && onManage ? (
              <PanelHeaderAction label={t("video.manage")} onClick={onManage}>
                <Settings2 size={17} />
              </PanelHeaderAction>
            ) : null}
          </div>
        }
      />
      <nav className="video-navigation" aria-label={t("video.library")}>
        {(["home", "movie", "series", "collections", "watchlist"] as const).map(
          (tab) => (
            <button
              data-tv-focusable
              key={tab}
              aria-pressed={view === tab && !detail}
              onClick={() => {
                closeDetail();
                setView(tab);
                setQuery((q) => {
                  const { collectionId: _collection, ...rest } = q;
                  return rest;
                });
              }}
            >
              {t(`video.${tab}`)}
            </button>
          ),
        )}
      </nav>
      {!detail ? (
        <div className="video-toolbar">
          <label className="video-search">
            <Search size={17} />
            <input
              data-tv-focusable
              type="search"
              aria-label={t("video.search")}
              placeholder={t("video.search")}
              value={query.query ?? ""}
              onChange={(e) =>
                setQuery((q) => ({ ...q, query: e.target.value }))
              }
            />
          </label>
          <select
            data-tv-focusable
            aria-label={t("video.sort")}
            value={query.sort}
            onChange={(e) =>
              setQuery((q) => ({
                ...q,
                sort: e.target.value as NonNullable<VideoQuery["sort"]>,
              }))
            }
          >
            {(["title", "year", "added", "rating", "recent"] as const).map(
              (sort) => (
                <option key={sort} value={sort}>
                  {t(`video.sort_${sort}`)}
                </option>
              ),
            )}
          </select>
          <details className="video-filters">
            <summary data-tv-focusable tabIndex={0}>
              {t("video.filter")}
            </summary>
            <label>
              {t("video.source")}
              <select
                data-tv-focusable
                value={query.sourceId ?? ""}
                onChange={(e) =>
                  setQuery((q) => ({ ...q, sourceId: e.target.value }))
                }
              >
                <option value="">{t("video.all")}</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("video.year")}
              <input
                data-tv-focusable
                type="number"
                value={query.year ?? ""}
                onChange={(e) =>
                  setQuery((q) => {
                    const { year: _year, ...rest } = q;
                    return e.target.value
                      ? { ...rest, year: Number(e.target.value) }
                      : rest;
                  })
                }
              />
            </label>
            <label>
              {t("video.genre")}
              <input
                data-tv-focusable
                value={query.genre ?? ""}
                onChange={(e) =>
                  setQuery((q) => ({ ...q, genre: e.target.value }))
                }
              />
            </label>
            <button
              data-tv-focusable
              aria-pressed={!!query.favorite}
              onClick={() =>
                setQuery((q) => {
                  const { favorite, ...rest } = q;
                  return favorite ? rest : { ...rest, favorite: true };
                })
              }
            >
              <Heart size={16} />
              {t("video.favorites")}
            </button>
            <label>
              {t("video.watched")}
              <select
                data-tv-focusable
                value={query.watched === undefined ? "" : String(query.watched)}
                onChange={(e) =>
                  setQuery((q) => {
                    const { watched: _watched, ...rest } = q;
                    return e.target.value
                      ? { ...rest, watched: e.target.value === "true" }
                      : rest;
                  })
                }
              >
                <option value="">{t("video.all")}</option>
                <option value="true">{t("video.watched")}</option>
                <option value="false">{t("video.unwatched")}</option>
              </select>
            </label>
            <button
              data-tv-focusable
              onClick={() => setQuery({ sort: "title" })}
            >
              {t("video.reset")}
            </button>
          </details>
        </div>
      ) : null}
      {error ? (
        <p className="video-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="video-content">
        {detail ? (
          <article className="video-detail">
            <button data-tv-focusable onClick={closeDetail}>
              <ArrowLeft size={17} />
              {t("video.back")}
            </button>
            <div className="video-detail-main">
              <VideoArtwork title={detail} />
              <div>
                <h2>{detail.title}</h2>
                <p className="video-meta">
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
                    }
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
                    }
                  >
                    <ListPlus size={17} />
                    {t("video.watchlist")}
                  </button>
                  <button
                    data-tv-focusable
                    disabled={busy}
                    aria-pressed={detail.watched}
                    onClick={() => changeState({ watched: !detail.watched })}
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
                          onClick={() => play(file, true)}
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
                  <label className="video-version">
                    {t("video.version")}
                    <select
                      data-tv-focusable
                      value={selected}
                      onChange={(e) => setSelected(e.target.value)}
                    >
                      {files
                        .filter((f) => f.episodeId === file.episodeId)
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                    </select>
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
                  </label>
                ) : null}
              </div>
            </div>
            {detail.seasons.length ? (
              <section className="video-seasons">
                <nav>
                  {detail.seasons.map((s) => (
                    <button
                      data-tv-focusable
                      key={s.id}
                      aria-pressed={season === s.seasonNumber}
                      onClick={() => setSeason(s.seasonNumber)}
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
                        disabled={!e.files.length}
                        onClick={() => setSelected(e.files[0]?.id ?? "")}
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
                        }
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
                  <select
                    value=""
                    disabled={busy}
                    onChange={(e) => {
                      const c = collections.find(
                        (c) => c.id === e.target.value,
                      );
                      if (c)
                        void act(() =>
                          saveCollection(c.id, {
                            titleIds: [...new Set([...c.titleIds, detail.id])],
                          }),
                        );
                    }}
                  >
                    <option value="">{t("video.choose")}</option>
                    {collections
                      .filter((c) => c.kind === "manual")
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.titleIds.includes(detail.id) ? " ✓" : ""}
                        </option>
                      ))}
                  </select>
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
                      }
                    >
                      {t("video.removeCollection")} · {c.name}
                    </button>
                  ))}
                <button onClick={() => setMatching((v) => !v)}>
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
                      <button disabled={busy}>{t("video.search")}</button>
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
                        }
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
          <p role="status">{t("video.loading")}</p>
        ) : listMode ? (
          <>
            {posters(page.titles)}
            {!page.titles.length ? (
              <p className="video-empty">{t("video.empty")}</p>
            ) : null}
            {page.nextCursor ? (
              <button data-tv-focusable disabled={busy} onClick={more}>
                {t("video.loadMore")}
              </button>
            ) : null}
          </>
        ) : view === "collections" ? (
          <section className="video-collections">
            <header>
              <h3>{t("video.collections")}</h3>
              {!tv ? (
                <button onClick={() => setCollectionOpen(true)}>
                  <Plus size={17} />
                  {t("video.newCollection")}
                </button>
              ) : null}
            </header>
            {collections.map((c) => (
              <div key={c.id}>
                <button
                  data-tv-focusable
                  onClick={() =>
                    setQuery((q) => ({ ...q, collectionId: c.id }))
                  }
                >
                  <Film size={24} />
                  <strong>{c.name}</strong>
                  <span>{c.titleIds.length}</span>
                </button>
                {!tv && c.kind === "manual" ? (
                  <>
                    <button
                      aria-label={t("video.rename")}
                      onClick={() => setEditingCollection(c)}
                    >
                      <Pencil size={17} />
                    </button>
                    <button
                      aria-label={t("video.delete")}
                      onClick={() => setDeletingCollection(c)}
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
                  <button onClick={onManage}>{t("video.manage")}</button>
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
    <button data-tv-focusable className="video-poster" onClick={onOpen}>
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
          <button onClick={onClose} aria-label={t("video.close")}>
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
          >
            <X size={20} />
          </button>
        </header>
        <p>{t("video.deleteConfirm")}</p>
        <button disabled={busy} onClick={onConfirm}>
          <Trash2 size={17} />
          {t("video.delete")}
        </button>
      </section>
    </ModalPortal>
  );
}
