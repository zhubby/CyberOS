import {
  ArrowLeft,
  Clock3,
  Delete,
  Languages,
  Play,
  Search,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from "react";
import { useTranslation } from "react-i18next";
import type { MediaFileRecord, MediaHome, MediaTitleDetail, MediaTitleSummary, VodPlayerCommand, VodPlayerStatus } from "@zos/shared";
import { acceptVodPlayerStatus } from "../lib/vod-player-status.js";
import {
  getMediaHome,
  getMediaTitle,
  getTvModeStatus,
  getVodPlayerStatus,
  mediaArtworkUrl,
  playMediaFile,
  searchMedia,
  sendVodPlayerCommand
} from "./api.js";
import type { PinyinImeElement } from "./pinyin-ime.js";
import { gamepadConnectionTransition, isActiveVodPlayback, playbackCommandForKey, vodPlayerPollDelay } from "./player-controls.js";

const VIRTUAL_KEYS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"]
];

type ViewState = { kind: "home" } | { kind: "detail"; title: MediaTitleDetail };

export function TvApp() {
  const { t, i18n } = useTranslation();
  const [home, setHome] = useState<MediaHome | null>(null);
  const [view, setView] = useState<ViewState>({ kind: "home" });
  const [featured, setFeatured] = useState<MediaTitleSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [playerStatus, setPlayerStatus] = useState<VodPlayerStatus | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const mainRef = useRef<HTMLElement>(null);
  const playerStatusRef = useRef<VodPlayerStatus | null>(null);
  const playerWasActiveRef = useRef(false);
  const lastProgressRefreshRef = useRef(0);
  const gamepadStateRef = useRef<"ready" | "degraded" | "unavailable" | null>(null);
  const noticeTimeoutRef = useRef<number | null>(null);

  const showNotice = useCallback((message: string, duration?: number) => {
    if (noticeTimeoutRef.current) window.clearTimeout(noticeTimeoutRef.current);
    noticeTimeoutRef.current = null;
    setNotice(message);
    if (duration !== undefined) {
      noticeTimeoutRef.current = window.setTimeout(() => {
        noticeTimeoutRef.current = null;
        setNotice(null);
      }, duration);
    }
  }, []);

  useEffect(() => () => {
    if (noticeTimeoutRef.current) window.clearTimeout(noticeTimeoutRef.current);
  }, []);

  const loadHome = useCallback(async () => {
    try {
      const next = await getMediaHome();
      setHome(next);
      setFeatured((current) => current ?? firstTitle(next));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("tv.unavailableBody"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const openTitle = useCallback(async (summary: MediaTitleSummary, pushHistory = true) => {
    try {
      const title = await getMediaTitle(summary.id);
      setView({ kind: "detail", title });
      setSearchOpen(false);
      if (pushHistory) {
        window.history.pushState({ tvTitleId: title.id }, "", `/tv/?title=${encodeURIComponent(title.id)}`);
      }
      window.requestAnimationFrame(() => focusFirst());
    } catch (loadError) {
      showNotice(loadError instanceof Error ? loadError.message : t("tv.unavailableBody"));
    }
  }, [showNotice, t]);

  const applyPlayerStatus = useCallback((next: VodPlayerStatus) => {
    const accepted = acceptVodPlayerStatus(playerStatusRef.current, next);
    playerStatusRef.current = accepted;
    setPlayerStatus(accepted);
    return accepted;
  }, []);

  const returnHome = useCallback(() => {
    setSearchOpen(false);
    setView({ kind: "home" });
    window.requestAnimationFrame(() => focusFirst());
  }, []);

  const back = useCallback(() => {
    if (searchOpen) {
      setSearchOpen(false);
      window.requestAnimationFrame(() => focusFirst());
      return;
    }
    if (view.kind === "detail") {
      if (new URL(window.location.href).searchParams.has("title")) window.history.back();
      else returnHome();
    }
  }, [returnHome, searchOpen, view.kind]);

  const playFile = useCallback(async (file: MediaFileRecord, position?: number) => {
    showNotice(t("tv.playing"));
    try {
      applyPlayerStatus(await playMediaFile(file.id, position));
      showNotice(t("tv.playing"), 1_800);
    } catch (playError) {
      showNotice(playError instanceof Error ? playError.message : t("tv.playFailed"));
    }
  }, [applyPlayerStatus, showNotice, t]);

  const playTitle = useCallback(async (summary: MediaTitleSummary) => {
    try {
      const detail = await getMediaTitle(summary.id);
      const progress = summary.progress?.completed ? null : summary.progress;
      const file = preferredFile(detail, progress?.fileId);
      if (!file) throw new Error(t("tv.playFailed"));
      await playFile(file, progress?.positionSeconds);
    } catch (playError) {
      showNotice(playError instanceof Error ? playError.message : t("tv.playFailed"));
    }
  }, [playFile, showNotice, t]);

  useEffect(() => {
    void loadHome();
    const events = new EventSource("/api/media/events");
    events.addEventListener("snapshot", () => void loadHome());
    return () => events.close();
  }, [loadHome]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await getVodPlayerStatus();
        if (!active) return;
        const next = applyPlayerStatus(response);
        if (isActiveVodPlayback(next) && Date.now() - lastProgressRefreshRef.current >= 5_000) {
          lastProgressRefreshRef.current = Date.now();
          void loadHome();
        }
        timer = window.setTimeout(poll, vodPlayerPollDelay(next));
      } catch {
        if (active) timer = window.setTimeout(poll, 5_000);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [applyPlayerStatus, loadHome]);

  useEffect(() => {
    const active = isActiveVodPlayback(playerStatus);
    if (playerWasActiveRef.current && !active) {
      void loadHome();
      window.requestAnimationFrame(() => focusFirst());
    }
    playerWasActiveRef.current = active;
  }, [loadHome, playerStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await getTvModeStatus();
        if (!active) return;
        const transition = gamepadConnectionTransition(gamepadStateRef.current, status.gamepad.state);
        gamepadStateRef.current = status.gamepad.state;
        if (transition) {
          showNotice(t(`tv.gamepad.${transition}`), 2_000);
        }
      } catch {
        // Media and playback polling provide their own availability feedback.
      }
      if (active) timer = window.setTimeout(poll, 5_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [showNotice, t]);

  useEffect(() => {
    const syncLocation = () => {
      const titleId = new URL(window.location.href).searchParams.get("title");
      if (!titleId) {
        returnHome();
        return;
      }
      void getMediaTitle(titleId).then((title) => {
        setView({ kind: "detail", title });
        window.requestAnimationFrame(() => focusFirst());
      }).catch(() => returnHome());
    };
    window.addEventListener("popstate", syncLocation);
    syncLocation();
    return () => window.removeEventListener("popstate", syncLocation);
  }, [returnHome]);

  useRemoteNavigation({
    playerStatus,
    onPlayerCommand: async (command) => {
      try {
        applyPlayerStatus(await sendVodPlayerCommand(command));
      } catch (commandError) {
        showNotice(commandError instanceof Error ? commandError.message : t("tv.playFailed"));
      }
    },
    onBack: back,
    onSearch: () => setSearchOpen(true),
    onPlay: () => {
      if (view.kind === "detail") {
        const progress = view.title.progress?.completed ? null : view.title.progress;
        const file = preferredFile(view.title, progress?.fileId);
        if (file) void playFile(file, progress?.positionSeconds);
      } else if (featured) {
        void playTitle(featured);
      }
    }
  });

  useLayoutEffect(() => {
    if (!loading && !searchOpen) focusFirst();
  }, [loading, searchOpen, view.kind]);

  const rows = useMemo(() => home ? [
    { id: "continue", label: t("tv.continueWatching"), titles: home.continueWatching },
    { id: "recent", label: t("tv.recentlyAdded"), titles: home.recentlyAdded },
    { id: "movies", label: t("tv.movies"), titles: home.movies },
    { id: "series", label: t("tv.series"), titles: home.series }
  ].filter((row) => row.titles.length > 0) : [], [home, t]);

  if (loading) {
    return <TvStatus label={t("tv.loading")} />;
  }

  if (error && !home) {
    return <TvStatus label={t("tv.unavailableTitle")} detail={t("tv.unavailableBody")} error />;
  }

  return (
    <div className="tv-app" data-view={view.kind}>
      {view.kind === "home" && featured ? (
        <img
          className="tv-backdrop"
          src={mediaArtworkUrl(featured.id, "backdrop")}
          alt=""
          aria-hidden="true"
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      ) : null}
      <header className="tv-header">
        <button className="tv-brand" type="button" data-tv-focusable onClick={returnHome} aria-label={t("tv.library")}>
          <img src="/zos-icon.svg" alt="" aria-hidden="true" />
          <span>ZOS</span>
        </button>
        <div className="tv-header-actions">
          <button
            className="tv-icon-button"
            type="button"
            data-tv-focusable
            onClick={() => setSearchOpen(true)}
            aria-label={t("tv.search")}
            title={t("tv.search")}
          >
            <Search aria-hidden="true" />
          </button>
          <span className="tv-clock"><Clock3 aria-hidden="true" />{formatClock(clock, i18n.resolvedLanguage)}</span>
        </div>
      </header>

      {view.kind === "home" ? (
        <main className="tv-main" ref={mainRef}>
          {featured ? (
            <section className="tv-feature" aria-labelledby="tv-feature-title">
              <p>{featured.kind === "movie" ? t("tv.movies") : t("tv.series")}</p>
              <h1 id="tv-feature-title">{featured.title}</h1>
              <div className="tv-feature-meta">{titleMetadata(
                featured,
                featured.runtimeMinutes ? t("tv.minutes", { count: featured.runtimeMinutes }) : null
              )}</div>
              {featured.overview ? <p className="tv-feature-overview">{featured.overview}</p> : null}
              <div className="tv-feature-actions">
                <button className="tv-primary-action" type="button" data-tv-focusable onClick={() => void playTitle(featured)}>
                  <Play fill="currentColor" aria-hidden="true" />
                  {featured.progress && !featured.progress.completed ? t("tv.resume") : t("tv.play")}
                </button>
                <button className="tv-secondary-action" type="button" data-tv-focusable onClick={() => void openTitle(featured)}>
                  {t("tv.open")}
                </button>
              </div>
            </section>
          ) : null}

          {rows.length ? rows.map((row) => (
            <MediaRow
              key={row.id}
              label={row.label}
              titles={row.titles}
              onFocus={setFeatured}
              onOpen={openTitle}
            />
          )) : (
            <section className="tv-empty">
              <h1>{t("tv.emptyTitle")}</h1>
              <p>{t("tv.emptyBody")}</p>
            </section>
          )}
        </main>
      ) : (
        <DetailView title={view.title} onBack={back} onPlay={playFile} />
      )}

      {searchOpen ? <SearchOverlay onClose={back} onOpen={openTitle} /> : null}
      {notice ? <div className="tv-notice" role="status">{notice}</div> : null}
    </div>
  );
}

function MediaRow({
  label,
  titles,
  onFocus,
  onOpen
}: {
  label: string;
  titles: MediaTitleSummary[];
  onFocus: (title: MediaTitleSummary) => void;
  onOpen: (title: MediaTitleSummary) => void;
}) {
  return (
    <section className="tv-row" aria-label={label}>
      <h2>{label}</h2>
      <div className="tv-poster-strip">
        {titles.map((title) => (
          <button
            className="tv-poster"
            type="button"
            data-tv-focusable
            key={title.id}
            onFocus={() => onFocus(title)}
            onClick={() => onOpen(title)}
            aria-label={title.title}
          >
            <span className="tv-poster-art">
              <img
                src={mediaArtworkUrl(title.id, "poster")}
                alt=""
                loading="lazy"
                onError={(event) => { event.currentTarget.hidden = true; }}
              />
              <span className="tv-poster-fallback" aria-hidden="true">{title.title.slice(0, 1)}</span>
              {title.progress && !title.progress.completed ? (
                <span className="tv-progress" aria-hidden="true">
                  <span style={{ width: `${progressPercent(title)}%` }} />
                </span>
              ) : null}
            </span>
            <strong>{title.title}</strong>
            <small>{title.year ?? (title.kind === "movie" ? "Movie" : "Series")}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function DetailView({
  title,
  onBack,
  onPlay
}: {
  title: MediaTitleDetail;
  onBack: () => void;
  onPlay: (file: MediaFileRecord, position?: number) => void;
}) {
  const { t } = useTranslation();
  const progress = title.progress?.completed ? null : title.progress;
  const primary = preferredFile(title, progress?.fileId);
  return (
    <main className="tv-detail">
      <img
        className="tv-detail-backdrop"
        src={mediaArtworkUrl(title.id, "backdrop")}
        alt=""
        aria-hidden="true"
        onError={(event) => { event.currentTarget.hidden = true; }}
      />
      <div className="tv-detail-content">
        <button className="tv-back-button" type="button" data-tv-focusable onClick={onBack} aria-label={t("tv.back")}>
          <ArrowLeft aria-hidden="true" />
        </button>
        <p className="tv-detail-kind">{title.kind === "movie" ? t("tv.movies") : t("tv.series")}</p>
        <h1>{title.title}</h1>
        <div className="tv-feature-meta">{titleMetadata(
          title,
          title.runtimeMinutes ? t("tv.minutes", { count: title.runtimeMinutes }) : null
        )}</div>
        {title.overview ? <p className="tv-detail-overview">{title.overview}</p> : null}
        {primary ? (
          <button
            className="tv-primary-action"
            type="button"
            data-tv-focusable
            onClick={() => onPlay(primary, progress?.positionSeconds)}
          >
            <Play fill="currentColor" aria-hidden="true" />
            {progress ? t("tv.resume") : t("tv.play")}
          </button>
        ) : null}

        {title.seasons.map((season) => (
          <section className="tv-season" key={season.id}>
            <h2>{season.name ?? t("tv.season", { number: season.seasonNumber })}</h2>
            <div className="tv-episode-list">
              {season.episodes.map((episode) => {
                const file = episode.files[0];
                return (
                  <button
                    className="tv-episode"
                    type="button"
                    data-tv-focusable
                    disabled={!file}
                    key={episode.id}
                    onClick={() => file && onPlay(file)}
                  >
                    <span>{String(episode.episodeNumber).padStart(2, "0")}</span>
                    <strong>{episode.name ?? t("tv.episode", { number: episode.episodeNumber })}</strong>
                    {episode.runtimeMinutes ? <small>{t("tv.minutes", { count: episode.runtimeMinutes })}</small> : null}
                    <Play aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

function SearchOverlay({
  onClose,
  onOpen
}: {
  onClose: () => void;
  onOpen: (title: MediaTitleSummary) => void;
}) {
  const { t } = useTranslation();
  const editorRef = useRef<PinyinImeElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MediaTitleSummary[]>([]);
  const [chinese, setChinese] = useState(true);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.enabled = chinese;
    const change = (event: Event) => setQuery((event as CustomEvent<{ value: string }>).detail.value);
    editor.addEventListener("change", change);
    editor.focus();
    return () => editor.removeEventListener("change", change);
  }, [chinese]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.value !== query) editor.value = query;
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchMedia(query, controller.signal)
        .then((page) => setResults(page.titles))
        .catch(() => {
          if (!controller.signal.aborted) setResults([]);
        });
    }, 240);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <div className="tv-search" role="dialog" aria-modal="true" aria-label={t("tv.search")}>
      <div className="tv-search-header">
        <Search aria-hidden="true" />
        <pinyin-ime-editor
          ref={editorRef}
          value={query}
          enabled={chinese}
          editor-type="input"
          page-size="7"
          popup-position="bottom"
          placeholder={t("tv.searchPlaceholder")}
          data-tv-focusable
        />
        {query ? (
          <button className="tv-icon-button" type="button" data-tv-focusable onClick={() => setQuery("")} aria-label={t("tv.clearSearch")}>
            <X aria-hidden="true" />
          </button>
        ) : null}
        <button className="tv-icon-button" type="button" data-tv-focusable onClick={onClose} aria-label={t("tv.closeSearch")}>
          <ArrowLeft aria-hidden="true" />
        </button>
      </div>

      <VirtualKeyboard editorRef={editorRef} chinese={chinese} onToggleLanguage={() => setChinese((value) => !value)} />

      {query ? (
        <section className="tv-search-results">
          <h2>{t("tv.searchResults")}</h2>
          {results.length ? (
            <div className="tv-search-grid">
              {results.map((title) => (
                <button className="tv-search-result" type="button" data-tv-focusable key={title.id} onClick={() => onOpen(title)}>
                  <img
                    src={mediaArtworkUrl(title.id, "poster")}
                    alt=""
                    onError={(event) => { event.currentTarget.hidden = true; }}
                  />
                  <span><strong>{title.title}</strong><small>{title.year ?? ""}</small></span>
                </button>
              ))}
            </div>
          ) : <p className="tv-search-empty">{t("tv.noResults")}</p>}
        </section>
      ) : null}
    </div>
  );
}

function VirtualKeyboard({
  editorRef,
  chinese,
  onToggleLanguage
}: {
  editorRef: RefObject<PinyinImeElement | null>;
  chinese: boolean;
  onToggleLanguage: () => void;
}) {
  const { t } = useTranslation();
  const sendKey = (key: string) => {
    const input = editorRef.current?.shadowRoot?.querySelector<HTMLInputElement>("input");
    if (!input) return;
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, composed: true }));
  };
  return (
    <div className="tv-keyboard" aria-label={t("tv.keyboard")}>
      {VIRTUAL_KEYS.map((row) => (
        <div className="tv-keyboard-row" key={row.join("")}>
          {row.map((key) => (
            <button type="button" data-tv-focusable key={key} onClick={() => sendKey(key)}>{key.toUpperCase()}</button>
          ))}
        </div>
      ))}
      <div className="tv-keyboard-row tv-keyboard-tools">
        <button type="button" data-tv-focusable onClick={onToggleLanguage} aria-pressed={chinese}>
          <Languages aria-hidden="true" />{t("tv.keyboardLanguage")}
        </button>
        <button type="button" data-tv-focusable onClick={() => sendKey(" ")}>{t("tv.keyboardSpace")}</button>
        <button type="button" data-tv-focusable onClick={() => sendKey("Backspace")} aria-label={t("tv.keyboardDelete")}>
          <Delete aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function TvStatus({ label, detail, error = false }: { label: string; detail?: string; error?: boolean }) {
  return (
    <main className="tv-status" data-error={error || undefined}>
      <img src="/zos-icon.svg" alt="" />
      <h1>{label}</h1>
      {detail ? <p>{detail}</p> : <span className="tv-loader" aria-hidden="true" />}
    </main>
  );
}

function useRemoteNavigation({
  playerStatus,
  onPlayerCommand,
  onBack,
  onSearch,
  onPlay
}: {
  playerStatus: VodPlayerStatus | null;
  onPlayerCommand: (command: Exclude<VodPlayerCommand, { type: "play" }>) => void;
  onBack: () => void;
  onSearch: () => void;
  onPlay: () => void;
}) {
  const current = useRef({ playerStatus, onPlayerCommand, onBack, onSearch, onPlay });
  useEffect(() => {
    current.current = { playerStatus, onPlayerCommand, onBack, onSearch, onPlay };
  }, [onBack, onPlay, onPlayerCommand, onSearch, playerStatus]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const state = current.current;
      const playbackCommand = playbackCommandForKey(state.playerStatus, event.key);
      if (playbackCommand) {
        event.preventDefault();
        event.stopPropagation();
        state.onPlayerCommand(playbackCommand);
        return;
      }
      if (["Escape", "BrowserBack", "GoBack"].includes(event.key) || event.keyCode === 461) {
        event.preventDefault();
        state.onBack();
        return;
      }
      if (["MediaPlayPause", "MediaPlay"].includes(event.key)) {
        event.preventDefault();
        state.onPlay();
        return;
      }
      if (event.key === "F8") {
        event.preventDefault();
        event.stopPropagation();
        state.onSearch();
        return;
      }
      if (event.key === "Enter") {
        const active = document.activeElement;
        if (active instanceof HTMLButtonElement) {
          event.preventDefault();
          active.click();
        }
        return;
      }
      const direction = directionForKey(event.key);
      if (direction) {
        const path = event.composedPath();
        const insideIme = path.some((node) => node instanceof HTMLElement && node.tagName === "PINYIN-IME-EDITOR");
        if (insideIme && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;
        event.preventDefault();
        moveFocus(direction);
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, []);
}

type Direction = "left" | "right" | "up" | "down";

function directionForKey(key: string): Direction | null {
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  return null;
}

function moveFocus(direction: Direction): void {
  const candidates = [...document.querySelectorAll<HTMLElement>("[data-tv-focusable]:not(:disabled)")]
    .filter((element) => element.offsetParent !== null);
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!active || !candidates.includes(active)) {
    candidates[0]?.focus();
    return;
  }
  const origin = center(active.getBoundingClientRect());
  const scored = candidates.filter((candidate) => candidate !== active).map((candidate) => {
    const point = center(candidate.getBoundingClientRect());
    const primary = direction === "left" ? origin.x - point.x
      : direction === "right" ? point.x - origin.x
        : direction === "up" ? origin.y - point.y
          : point.y - origin.y;
    const secondary = direction === "left" || direction === "right"
      ? Math.abs(point.y - origin.y)
      : Math.abs(point.x - origin.x);
    return { candidate, primary, score: primary + secondary * 1.8 };
  }).filter((item) => item.primary > 4).sort((left, right) => left.score - right.score);
  const next = scored[0]?.candidate;
  if (next) {
    next.focus({ preventScroll: true });
    next.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }
}

function center(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function focusFirst(): void {
  document.querySelector<HTMLElement>("[data-tv-focusable]:not(:disabled)")?.focus();
}

function firstTitle(home: MediaHome): MediaTitleSummary | null {
  return home.continueWatching[0] ?? home.recentlyAdded[0] ?? home.movies[0] ?? home.series[0] ?? null;
}

function preferredFile(title: MediaTitleDetail, preferredId?: string | null): MediaFileRecord | null {
  const files = [
    ...title.files,
    ...title.seasons.flatMap((season) => season.episodes.flatMap((episode) => episode.files))
  ];
  return files.find((file) => file.id === preferredId) ?? files[0] ?? null;
}

function progressPercent(title: MediaTitleSummary): number {
  const progress = title.progress;
  if (!progress?.durationSeconds) return 0;
  return Math.max(0, Math.min(100, progress.positionSeconds / progress.durationSeconds * 100));
}

function titleMetadata(title: MediaTitleSummary, runtime: string | null): string {
  return [
    title.year,
    runtime,
    ...title.genres.slice(0, 3)
  ].filter(Boolean).join("  ·  ");
}

function formatClock(date: Date, language: string | undefined): string {
  return new Intl.DateTimeFormat(language ?? "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
