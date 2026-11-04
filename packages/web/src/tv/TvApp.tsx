import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PlaybackProvider, usePlayback } from "../components/playback/PlaybackProvider.js";
import { PlaybackBar } from "../components/playback/PlaybackBar.js";
import { MusicProvider, useMusicRemote } from "../components/music/MusicProvider.js";
import { VideoLibraryPanel } from "../components/video/VideoLibraryPanel.js";
import { getTvModeStatus } from "./api.js";
import { gamepadConnectionTransition, isActiveVodPlayback } from "./player-controls.js";
import { SearchOverlay } from "./SearchOverlay.js";
import { useRemoteNavigation } from "./remote-navigation.js";

export function TvApp() { return <PlaybackProvider><MusicProvider><TvLibrary /></MusicProvider></PlaybackProvider>; }
function TvLibrary() {
  const { t, i18n } = useTranslation();
  const playback = usePlayback();
  const music = useMusicRemote();
  const [searchOpen, setSearchOpen] = useState(false);
  const [titleId, setTitleId] = useState<string | null>(new URL(window.location.href).searchParams.get("title"));
  const [clock, setClock] = useState(new Date());
  const [notice, setNotice] = useState<string | null>(null);
  const gamepad = useRef<"ready" | "degraded" | "unavailable" | null>(null);
  const transportBusy = useRef(false);
  const titleFromSearch = useRef(false);
  const nativeHome = useRef<{ instance: string; request: string | undefined } | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30000);
    document.querySelector<HTMLElement>(".tv-brand")?.focus();
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    const poll = () => void getTvModeStatus().then(status => {
      if (!live) return;
      const transition = gamepadConnectionTransition(gamepad.current, status.gamepad.state);
      gamepad.current = status.gamepad.state;
      if (transition) setNotice(t("tv.gamepad." + transition as "tv.gamepad.connected" | "tv.gamepad.disconnected"));
    }).catch(() => {});
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [t]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const back = useCallback(() => window.dispatchEvent(new Event("cyberos:video-back")), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const navigateHome = useCallback(() => {
    titleFromSearch.current = false;
    setSearchOpen(false);
    setTitleId(null);
    window.dispatchEvent(new Event("cyberos:video-home"));
  }, []);
  const home = useCallback(() => {
    navigateHome();
    const video = playback.nas?.video;
    if (playback.nas?.owner === "video" && video?.sessionId && isActiveVodPlayback(video)) {
      void playback.control({ type: "stop", sessionId: video.sessionId }).catch(error => setNotice(error.message));
    }
  }, [playback.nas, playback.control, navigateHome]);
  useEffect(() => {
    const status = playback.nas;
    if (!status) return;
    const previous = nativeHome.current;
    const request = status.video.tvHomeRequestId;
    nativeHome.current = { instance: status.serviceInstanceId, request };
    if (previous?.instance === status.serviceInstanceId && request && request !== previous.request) navigateHome();
  }, [playback.nas, navigateHome]);
  const closeRequestedTitle = useCallback((restoreSearch: boolean) => {
    setTitleId(null);
    if (restoreSearch && titleFromSearch.current) setSearchOpen(true);
    titleFromSearch.current = false;
  }, []);
  const transport = async (key: string) => {
    if (transportBusy.current) return;
    transportBusy.current = true;
    try {
      if (playback.target === "browser" && playback.browser) {
        if (key === "MediaStop") playback.stopBrowser();
        else if (key === "MediaPlayPause" || (key === "MediaPlay") !== playback.browser.playing) await playback.toggleBrowser();
      } else if (playback.nas?.owner === "video" && playback.nas.sessionId) {
        const playing = playback.nas.video.state === "playing";
        await playback.control({ type: key === "MediaStop" ? "stop" : key === "MediaPause" || (key === "MediaPlayPause" && playing) ? "pause" : "resume", sessionId: playback.nas.sessionId });
      } else if (music.status?.queue.length) {
        if (key === "MediaStop" && playback.nas?.sessionId) await playback.control({ type: "stop", sessionId: playback.nas.sessionId });
        else if (key !== "MediaStop") await music.execute({ type: key === "MediaPause" || (key === "MediaPlayPause" && music.status.state === "playing") ? "pause" : "resume" });
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { transportBusy.current = false; }
  };
  useRemoteNavigation({ onBack: back, onHome: home, onSearch: openSearch, onTransport: key => void transport(key) });
  return <div className="tv-app tv-library-shell">
    <header className="tv-header" data-tv-region="header">
      <button className="tv-brand" data-tv-focusable onClick={home}><img src="/cyberos-icon.svg" alt="" /><span>CyberOS</span></button>
      <div className="tv-header-actions"><button className="tv-icon-button" data-tv-focusable onClick={openSearch} aria-label={t("tv.search")} data-tooltip={t("tv.search")}><Search /></button><span className="tv-clock"><Clock3 />{new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(clock)}</span></div>
    </header>
    <VideoLibraryPanel tv requestedTitleId={titleId} onSearch={openSearch} onCloseRequestedTitle={closeRequestedTitle} />
    <PlaybackBar onOpenBluetoothSettings={() => setNotice(t("video.manage"))} />
    <SearchOverlay open={searchOpen} onClose={closeSearch} onOpen={title => { titleFromSearch.current = true; setTitleId(title.id); setSearchOpen(false); }} />
    {notice ? <div className="tv-notice" role="status">{notice}</div> : null}
  </div>;
}
