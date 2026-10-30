import { useModalDialog } from "../components/workspace/useModalDialog.js";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeft, Clock3, Delete, Languages, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MediaTitleSummary, VodPlayerCommand, VodPlayerStatus } from "@cyberos/shared";
import { PlaybackProvider, usePlayback } from "../components/playback/PlaybackProvider.js";
import { PlaybackBar } from "../components/playback/PlaybackBar.js";
import { MusicProvider } from "../components/music/MusicProvider.js";
import { VideoLibraryPanel } from "../components/video/VideoLibraryPanel.js";
import { getTvModeStatus, mediaArtworkUrl, searchMedia } from "./api.js";
import type { PinyinImeElement } from "./pinyin-ime.js";
import { gamepadConnectionTransition, playbackCommandForKey } from "./player-controls.js";
const VIRTUAL_KEYS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"]
];
export function TvApp() { return <PlaybackProvider><MusicProvider><TvLibrary /></MusicProvider></PlaybackProvider>; }
function TvLibrary() {
  const { t, i18n } = useTranslation(); const playback = usePlayback();
  const [searchOpen, setSearchOpen] = useState(false); const [titleId, setTitleId] = useState<string | null>(new URL(window.location.href).searchParams.get("title"));
  const [clock, setClock] = useState(new Date()); const [notice, setNotice] = useState<string | null>(null);
  const gamepad = useRef<"ready" | "degraded" | "unavailable" | null>(null);
  useEffect(() => { const timer = window.setInterval(() => setClock(new Date()), 30000); focusFirst(); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    let live = true; const poll = () => void getTvModeStatus().then(s => {
      if (!live) return; const transition = gamepadConnectionTransition(gamepad.current, s.gamepad.state); gamepad.current = s.gamepad.state;
      if (transition) setNotice(t("tv.gamepad." + transition as "tv.gamepad.connected" | "tv.gamepad.disconnected"));
    }).catch(() => {});
    poll(); const timer = window.setInterval(poll, 5000); return () => { live = false; window.clearInterval(timer); };
  }, [t]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 4000); return () => window.clearTimeout(timer); }, [notice]);
  const back = () => { if (searchOpen) { setSearchOpen(false); window.requestAnimationFrame(focusFirst); } else window.dispatchEvent(new Event("cyberos:video-back")); };
  useRemoteNavigation({
    playerStatus: playback.nas?.owner === "video" ? playback.nas.video : null,
    onPlayerCommand: c => void playback.control(c).catch(e => setNotice(e.message)),
    onBack: back, onSearch: () => setSearchOpen(true),
    onPlay: () => { const active = document.activeElement; if (active instanceof HTMLButtonElement) active.click(); }
  });
  return <div className="tv-app tv-library-shell">
    <header className="tv-header"><button className="tv-brand" data-tv-focusable onClick={() => window.dispatchEvent(new Event("cyberos:video-back"))}><img src="/cyberos-icon.svg" alt="" /><span>CyberOS</span></button><div className="tv-header-actions"><button className="tv-icon-button" data-tv-focusable onClick={() => setSearchOpen(true)} aria-label={t("tv.search")}><Search /></button><span className="tv-clock"><Clock3 />{formatClock(clock, i18n.resolvedLanguage)}</span></div></header>
    <VideoLibraryPanel tv requestedTitleId={titleId} />
    <PlaybackBar onOpenBluetoothSettings={() => setNotice(t("video.manage"))} />
    {searchOpen ? <SearchOverlay onClose={back} onOpen={title => { setTitleId(title.id); setSearchOpen(false); }} /> : null}
    {notice ? <div className="tv-notice" role="status">{notice}</div> : null}
  </div>;
}
function SearchOverlay({
  onClose,
  onOpen
}: {
  onClose: () => void;
  onOpen: (title: MediaTitleSummary) => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useModalDialog(onClose);
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
    <section ref={dialogRef} tabIndex={-1} className="tv-search" role="dialog" aria-modal="true" aria-label={t("tv.search")}>
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
    </section>
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
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".workspace-search-filter-menu")) {
        if (["Escape", "BrowserBack", "GoBack"].includes(event.key)) return;
        if (target.closest(".custom-select") && ["ArrowUp", "ArrowDown", "Home", "End", "Enter", " "].includes(event.key)) return;
        if (target instanceof HTMLInputElement && target.type === "checkbox" && event.key === "Enter") {
          event.preventDefault();
          target.click();
          return;
        }
      }
      const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (modal && !directionForKey(event.key) && event.key !== "Enter") return;
      const playbackCommand = modal ? null : playbackCommandForKey(state.playerStatus, event.key);
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
  const modal = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].at(-1);
  const candidates = [...(modal ?? document).querySelectorAll<HTMLElement>("[data-tv-focusable]:not(:disabled), button:not(:disabled), input:not(:disabled), select:not(:disabled), summary")]
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
  document.querySelector<HTMLElement>("[data-tv-focusable]:not(:disabled), button:not(:disabled), input:not(:disabled), select:not(:disabled), summary")?.focus();
}

function formatClock(date: Date, language: string | undefined): string {
  return new Intl.DateTimeFormat(language ?? "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
