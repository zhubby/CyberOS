import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Delete, Languages, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { createPinyinEngine, PinyinIMEController, type CandidateItem, type PinyinEngine } from "pinyin-ime";
import type { MediaTitleSummary } from "@cyberos/shared";
import { useModalDialog } from "../components/workspace/useModalDialog.js";
import { isBackKey } from "../lib/remote-keys.js";
import { mediaArtworkUrl, searchMedia } from "./api.js";

const KEYS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"];

export function SearchOverlay({ open, onClose, onOpen }: {
  open: boolean;
  onClose: () => void;
  onOpen: (title: MediaTitleSummary) => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useModalDialog(onClose, false, open);
  const inputRef = useRef<HTMLInputElement>(null);
  const engine = useRef<PinyinEngine | null>(null);
  const value = useRef("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MediaTitleSummary[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [retry, setRetry] = useState(0);
  const [dictionary, setDictionary] = useState<"loading" | "ready" | "error">("loading");
  const [dictionaryRetry, retryDictionary] = useState(0);
  const resultFocus = useRef<string | null>(null);
  const completedSearch = useRef<{ query: string; retry: number } | null>(null);
  const scroll = useRef(0);
  const lastKey = useRef<HTMLButtonElement | null>(null);
  const change = useCallback((next: string) => {
    if (value.current !== next) resultFocus.current = null;
    value.current = next;
    if (inputRef.current) inputRef.current.value = next;
    setQuery(next);
  }, []);
  const [controller] = useState(() => new PinyinIMEController<HTMLInputElement>({
    getValue: () => value.current,
    onValueChange: change,
    getElement: () => inputRef.current,
    getEngine: () => engine.current,
    pageSize: 7,
  }));
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const snapshot = useSyncExternalStore(subscribe, () => controller.getSnapshot());
  const cancelComposition = () => controller.handleKeyDown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

  useEffect(() => {
    if (!open || engine.current) return;
    let live = true;
    setDictionary("loading");
    void import("pinyin-ime/dictionary/google_pinyin_dict").then(({ dict }) => {
      if (!live) return;
      engine.current = createPinyinEngine(dict);
      controller.setOptions({ getEngine: () => engine.current });
      setDictionary("ready");
    }).catch(() => { if (live) setDictionary("error"); });
    return () => { live = false; };
  }, [controller, dictionaryRetry, open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const result = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("[data-tv-search-title]") ?? [])].find(element => element.dataset.tvSearchTitle === resultFocus.current);
      const active = document.activeElement;
      if (result || !active || active === dialogRef.current || !dialogRef.current?.contains(active)) (result ?? inputRef.current)?.focus({ preventScroll: true });
      if (dialogRef.current) dialogRef.current.scrollTop = scroll.current;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, dialogRef]);

  useEffect(() => {
    if (!open) return;
    if (!query.trim()) { setState("idle"); return; }
    if (completedSearch.current?.query === query && completedSearch.current.retry === retry) { setState("ready"); return; }
    const abort = new AbortController();
    setState("loading");
    const timer = setTimeout(() => {
      void searchMedia(query, abort.signal).then(page => {
        if (abort.signal.aborted) return;
        setResults(page.titles);
        completedSearch.current = { query, retry };
        setState("ready");
      }).catch(() => { if (!abort.signal.aborted) setState("error"); });
    }, 240);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [query, open, retry]);

  function keepKeyboardFocus(target: HTMLElement | null, caret?: number) {
    requestAnimationFrame(() => {
      if (caret !== undefined) inputRef.current?.setSelectionRange(caret, caret);
      const next = target?.isConnected ? target : lastKey.current?.isConnected ? lastKey.current : inputRef.current;
      next?.focus({ preventScroll: true });
    });
  }
  function choose(item: CandidateItem, target: HTMLElement | null) {
    controller.selectCandidate(item);
    keepKeyboardFocus(target);
  }
  function sendKey(key: string, target: HTMLButtonElement) {
    lastKey.current = target;
    let caret: number | undefined;
    if (snapshot.hasActiveComposition || (snapshot.chineseMode && /^[a-z']$/i.test(key))) {
      controller.handleKeyDown(new KeyboardEvent("keydown", { key, cancelable: true }));
    } else {
      const input = inputRef.current;
      if (!input) return;
      const start = input.selectionStart ?? value.current.length;
      const end = input.selectionEnd ?? start;
      const from = key === "Backspace" && start === end ? Math.max(0, start - 1) : start;
      const text = key === "Backspace" ? "" : key;
      change(value.current.slice(0, from) + text + value.current.slice(end));
      caret = from + text.length;
    }
    keepKeyboardFocus(target, caret);
  }
  function toggleLanguage(target: HTMLButtonElement) {
    cancelComposition();
    controller.handleKeyDown(new KeyboardEvent("keydown", { key: "Shift" }));
    controller.handleKeyUp(new KeyboardEvent("keyup", { key: "Shift" }));
    keepKeyboardFocus(target);
  }

  if (!open) return null;
  return <section ref={dialogRef} tabIndex={-1} className="tv-search" role="dialog" aria-modal="true" aria-label={t("tv.search")}
    onScroll={event => { scroll.current = event.currentTarget.scrollTop; }}
    onKeyDown={event => {
      if (isBackKey(event) && controller.getSnapshot().hasActiveComposition) {
        event.preventDefault(); event.stopPropagation(); cancelComposition();
        inputRef.current?.focus();
      }
    }}>
    <div className="tv-search-header" data-tv-region="search-header">
      <Search aria-hidden="true" />
      <input ref={inputRef} className="tv-search-input" data-tv-focusable data-tv-text-input data-tv-composing={snapshot.hasActiveComposition}
        value={query} aria-label={t("tv.searchPlaceholder")} data-tooltip={t("tv.keyboardLanguage")} placeholder={t("tv.searchPlaceholder")}
        onChange={event => { resultFocus.current = null; change(event.target.value); }}
        onKeyDown={event => {
          const snap = controller.getSnapshot();
          if (event.key === "Enter" && snap.hasActiveComposition && snap.candidates.length) {
            event.preventDefault(); event.stopPropagation();
            const candidate = snap.candidates[snap.highlightedCandidateIndex ?? snap.page * snap.pageSize];
            if (candidate) choose(candidate, inputRef.current);
          } else controller.handleKeyDown(event.nativeEvent);
        }}
        onBeforeInput={event => controller.handleBeforeInput(event.nativeEvent as InputEvent)}
        onKeyUp={event => controller.handleKeyUp(event.nativeEvent)}
        onBlur={() => controller.resetShiftGestureState()}
      />
      {query ? <button className="tv-icon-button" data-tv-focusable aria-label={t("tv.clearSearch")} data-tooltip={t("tv.clearSearch")} onClick={() => { cancelComposition(); change(""); inputRef.current?.focus(); }}><X /></button> : null}
      <button className="tv-icon-button" data-tv-focusable onClick={onClose} aria-label={t("tv.closeSearch")} data-tooltip={t("tv.closeSearch")}><ArrowLeft /></button>
    </div>
    {snapshot.hasActiveComposition ? <section className="tv-ime" aria-label={t("tv.candidates")}>
      <div className="tv-ime-composition" role="status">{snapshot.pinyinInput}</div>
      {dictionary === "loading" ? <p role="status">{t("tv.loadingInput")}</p> : dictionary === "error" ? <div role="alert">{t("tv.inputFailed")} <button onClick={() => retryDictionary(v => v + 1)}>{t("tv.retry")}</button></div> :
        <div className="tv-ime-candidates" data-tv-region="candidates">
          <button disabled={snapshot.page === 0} aria-label={t("tv.previousCandidates")} onClick={() => controller.addPage(-1)}><ChevronLeft /></button>
          {snapshot.displayCandidates.map(item => <button key={item.word} data-tv-candidate data-tv-focusable onClick={() => choose(item, lastKey.current)}>{item.word}</button>)}
          <button disabled={(snapshot.page + 1) * snapshot.pageSize >= snapshot.candidates.length} aria-label={t("tv.nextCandidates")} onClick={() => controller.addPage(1)}><ChevronRight /></button>
        </div>}
    </section> : null}
    <div className="tv-keyboard" aria-label={t("tv.keyboard")}>
      {KEYS.map(row => <div className="tv-keyboard-row" data-tv-region="keyboard-row" key={row}>
        {[...row].map(letter => <button data-tv-focusable key={letter} onClick={event => sendKey(letter, event.currentTarget)}>{letter.toUpperCase()}</button>)}
      </div>)}
      <div className="tv-keyboard-row tv-keyboard-tools" data-tv-region="keyboard-row">
        <button data-tv-focusable aria-pressed={snapshot.chineseMode} onClick={event => toggleLanguage(event.currentTarget)}><Languages />{t(snapshot.chineseMode ? "tv.chineseInput" : "tv.englishInput")}</button>
        <button data-tv-focusable onClick={event => sendKey(" ", event.currentTarget)}>{t(snapshot.hasActiveComposition ? "tv.keyboardSpace" : "tv.space")}</button>
        <button data-tv-focusable onClick={event => sendKey("Backspace", event.currentTarget)} aria-label={t("tv.keyboardDelete")} data-tooltip={t("tv.keyboardDelete")}><Delete /></button>
      </div>
    </div>
    {query.trim() ? <section className="tv-search-results" aria-busy={state === "loading"}>
      <h2>{t("tv.searchResults")}</h2>
      {state === "loading" ? <p role="status">{t("tv.searching")}</p> : state === "error" ? <div className="tv-search-error" role="alert">{t("tv.searchFailed")} <button onClick={() => setRetry(v => v + 1)}>{t("tv.retry")}</button></div> :
        results.length ? <div className="tv-search-grid" data-tv-region="search-results">{results.map(title => <button className="tv-search-result" data-tv-focusable data-tv-search-title={title.id} key={title.id} onClick={() => { resultFocus.current = title.id; onOpen(title); }}>
          <img src={mediaArtworkUrl(title.id, "poster")} alt="" onError={event => { event.currentTarget.hidden = true; }} />
          <span><strong>{title.title}</strong><small>{title.year ?? ""}</small></span>
        </button>)}</div> : state === "ready" ? <p className="tv-search-empty">{t("tv.noResults")}</p> : null}
    </section> : null}
  </section>;
}
