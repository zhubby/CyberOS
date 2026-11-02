import { useEffect, useState, type ReactNode } from "react";
import { CirclePlay, ListMusic, LoaderCircle, MonitorPlay, Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { VodPlayerCommand } from "@cyberos/shared";
import { getBluetoothSettings, type BluetoothAudioDevice } from "../../api.js";
import { musicTime } from "../../lib/music-state.js";
import { CustomSelect } from "../common/CustomSelect.js";
import { MusicDialog } from "../music/MusicDialogs.js";
import { MusicCover, MusicPlayerDetails } from "../music/MusicPlayer.js";
import { useMusicRemote } from "../music/MusicProvider.js";
import { OutputDeviceSelect } from "./OutputDeviceSelect.js";
import { PlaybackOutputPopover } from "./PlaybackOutputPopover.js";
import { usePlayback } from "./PlaybackProvider.js";
import { PlaybackSlider } from "./PlaybackSlider.js";
import { PlaybackTargetSelect } from "./PlaybackTargetSelect.js";

// Keep the controller and detail hosts mounted independently of their control surface.
export function usePlaybackControls(active?: boolean) {
  const p = usePlayback();
  const music = useMusicRemote();
  const { t } = useTranslation();
  const [devices, setDevices] = useState<BluetoothAudioDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [localBusy, setBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const browser = p.target === "browser" && p.browser ? p.browser : null;
  const musicBar = !browser && p.nas?.owner !== "video";
  const nas = p.nas;
  const video = nas?.video;
  const sessionId = nas?.sessionId;
  const currentTrack = music.status?.queue.find((item) => item.id === music.status?.currentItemId);
  const playing = browser ? browser.playing : musicBar ? music.status?.owner === "music" && music.status.state === "playing" : video?.state === "playing";
  const busy = localBusy || (musicBar && music.busy);
  const requestedOutput = musicBar ? music.status?.audioDeviceId : nas?.output.requested.deviceId;
  const duration = (browser ? browser.session.durationSeconds : musicBar ? music.status?.durationSeconds : video?.durationSeconds) ?? 0;
  const position = browser?.position ?? (musicBar ? music.status?.positionSeconds : video?.positionSeconds) ?? 0;
  const title = browser?.title ?? (musicBar ? currentTrack?.title ?? t("music.queue") : video?.fileName ?? t("video.title"));
  const currentError = error ?? (browser ? browser.session.error : musicBar ? music.error ?? music.status?.error ?? p.error : p.error ?? video?.error);
  const available = !!browser || (musicBar ? !!music.status?.queue.length : !!sessionId);
  const state: "idle" | "playing" | "paused" | "error" = currentError ? "error" : !available ? "idle" : playing ? "playing" : "paused";
  const canPlay = !busy && (browser ? browser.session.state === "ready" : musicBar ? !!music.status?.queue.length : !!sessionId);
  const canSeek = !busy && duration > 0 && (browser ? browser.session.state === "ready" : musicBar ? music.status?.owner === "music" : !!sessionId);
  const visible = active ?? p.barVisible;

  useEffect(() => {
    if (!visible || browser) return;
    let live = true;
    const refresh = () => void getBluetoothSettings().then((result) => {
      if (live) setDevices(result.audioDevices);
    }).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => { live = false; window.clearInterval(timer); };
  }, [visible, !!browser, nas?.output.effective.deviceId]);
  useEffect(() => { setError(null); setDetailsOpen(false); }, [p.target, p.browser?.session.id, sessionId]);
  useEffect(() => { setOutput(requestedOutput ?? ""); }, [requestedOutput, musicBar]);

  const run = (command: VodPlayerCommand) => {
    setBusy(true);
    setError(null);
    void p.control(command).catch((failure) => setError(failure instanceof Error ? failure.message : String(failure))).finally(() => setBusy(false));
  };
  const toggle = () => {
    if (browser) {
      setBusy(true);
      setError(null);
      void p.toggleBrowser().catch((failure) => setError(failure instanceof Error ? failure.message : String(failure))).finally(() => setBusy(false));
    } else if (musicBar) void music.execute({ type: playing ? "pause" : "resume" });
    else if (sessionId) run({ type: playing ? "pause" : "resume", sessionId });
  };
  const seek = (seconds: number) => {
    if (browser) {
      if (browser.session.mode === "direct" && p.videoRef.current) {
        p.videoRef.current.currentTime = seconds;
        p.updateBrowser({ position: seconds });
      } else {
        setBusy(true);
        void p.playBrowser(browser.fileId, browser.title, { ...browser.options, startPositionSeconds: seconds })
          .then(() => p.setPlayerOpen(false))
          .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)))
          .finally(() => setBusy(false));
      }
    } else if (musicBar) void music.execute({ type: "seek", seconds });
    else if (sessionId) run({ type: "seek", sessionId, seconds });
  };
  const stop = () => {
    if (browser) p.stopBrowser();
    else if (sessionId) run({ type: "stop-video", sessionId });
    setDetailsOpen(false);
  };
  const openDetails = () => {
    if (browser) p.setPlayerOpen(true);
    else if (musicBar) music.setDrawerOpen(true);
    else setDetailsOpen(true);
  };
  return { p, music, t, devices, output, setOutput, detailsOpen, setDetailsOpen, browser, musicBar, nas, video, sessionId, currentTrack, playing, busy, duration, position, title, currentError, available, state, canPlay, canSeek, run, toggle, seek, stop, openDetails };
}

type Controls = ReturnType<typeof usePlaybackControls>;

function PlaybackProgress({ c, detail = false }: { c: Controls; detail?: boolean }) {
  return <div className={`playback-progress${detail ? " is-detail" : ""}`}>
    <span className="playback-time">{musicTime(c.position)}</span>
    <PlaybackSlider key={`${c.browser?.session.id ?? c.sessionId}:${detail}`} className="playback-seek" max={Math.max(1, c.duration)} step={0.1} value={c.position} label={c.t("music.seek")} disabled={!c.canSeek} onCommit={c.seek} />
    <span className="playback-time">{musicTime(c.duration || null)}</span>
  </div>;
}

function PlaybackTransport({ c, detail = false }: { c: Controls; detail?: boolean }) {
  return <div className="playback-transport">
    {c.musicBar ? <button className="playback-secondary" disabled={c.busy || !c.music.status?.queue.length} aria-label={c.t("music.previous")} title={c.t("music.previous")} onClick={() => void c.music.execute({ type: "previous" })}><SkipBack size={18} aria-hidden="true" /></button> : null}
    <button data-playback-primary={detail ? undefined : true} disabled={!c.canPlay} aria-busy={c.busy || undefined} aria-label={c.t(c.playing ? "music.pause" : "music.play")} title={c.t(c.playing ? "music.pause" : "music.play")} onClick={c.toggle}>
      {c.busy ? <LoaderCircle size={20} className="is-spinning" aria-hidden="true" /> : c.playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
    </button>
    {c.musicBar ? <button className="playback-secondary" disabled={c.busy || !c.music.status?.queue.length} aria-label={c.t("music.next")} title={c.t("music.next")} onClick={() => void c.music.execute({ type: "next" })}><SkipForward size={18} aria-hidden="true" /></button> : null}
  </div>;
}

function PlaybackOutput({ c }: { c: Controls }) {
  const { t, browser, musicBar, music, nas, video, sessionId, busy, run } = c;
  return <>
    <label className="playback-output-volume"><span>{t("music.volume")}</span>
      <PlaybackSlider max={100} value={browser ? browser.volume * 100 : musicBar ? music.status?.volume ?? 100 : video?.volume ?? 100} label={t("music.volume")} disabled={busy || !c.available} onCommit={(volume) => {
        if (browser) c.p.updateBrowser({ volume: volume / 100 });
        else if (musicBar) void music.execute({ type: "volume", volume });
        else if (sessionId) run({ type: "set-volume", sessionId, volume });
      }} />
    </label>
    {browser ? <p className="playback-output-device">{t("playback.localOutput")}</p> : <>
      <label>{t("music.output")}<OutputDeviceSelect value={c.output || null} devices={c.devices} disabled={busy} defaultLabel={t(musicBar ? "music.defaultOutput" : "playback.tvOutput")} onChange={(deviceId) => c.setOutput(deviceId ?? "")} /></label>
      <button disabled={busy || !c.available} onClick={() => {
        if (musicBar) void music.execute({ type: "output", audioDeviceId: c.output || null });
        else if (sessionId) run({ type: "set-output", sessionId, audioDeviceId: c.output || null });
      }}>{t("playback.switchOutput")}</button>
      {!musicBar && sessionId ? <>
        <label>{t("playback.audioDelay")}<PlaybackSlider min={-5000} max={5000} step={50} value={nas?.preferences.audioDelays[nas.audioDelayKey] ?? 0} label={t("playback.audioDelay")} disabled={busy} onCommit={(milliseconds) => run({ type: "set-audio-delay", sessionId, milliseconds })} /><span>{nas?.preferences.audioDelays[nas.audioDelayKey] ?? 0} ms</span></label>
        <label>{t("video.audio")}<CustomSelect ariaLabel={t("video.audio")} value={String(video?.selectedAudioTrackId ?? "")} disabled={busy} options={(video?.audioTracks ?? []).map((track) => ({ value: String(track.id), label: String(track.title ?? track.language ?? track.id) }))} onChange={(trackId) => run({ type: "set-audio-track", sessionId, trackId: Number(trackId) })} /></label>
        <label>{t("video.subtitles")}<CustomSelect ariaLabel={t("video.subtitles")} value={String(video?.selectedSubtitleTrackId ?? "off")} disabled={busy} options={[{ value: "off", label: t("video.off") }, ...(video?.subtitleTracks ?? []).map((track) => ({ value: String(track.id), label: String(track.title ?? track.language ?? track.id) }))]} onChange={(trackId) => run({ type: "set-subtitle-track", sessionId, trackId: trackId === "off" ? null : Number(trackId) })} /></label>
      </> : null}
      {sessionId && nas?.owner ? <button disabled={busy} aria-pressed={musicBar ? nas.preferences.musicMuted : nas.preferences.videoMuted} onClick={() => run({ type: "set-muted", sessionId, muted: !(musicBar ? nas.preferences.musicMuted : nas.preferences.videoMuted) })}>{t("playback.mute")}</button> : null}
    </>}
  </>;
}

export function PlaybackControls({ c, variant, beforeDetails, trailingControl }: {
  c: Controls;
  variant: "bar" | "menu";
  beforeDetails?: () => void;
  trailingControl?: ReactNode;
}) {
  const { t, music, browser, musicBar, title, currentTrack } = c;
  const openDetails = () => { beforeDetails?.(); c.openDetails(); };
  const openQueue = () => { beforeDetails?.(); music.setDrawerOpen(true); };
  return <section className={variant === "bar" ? "shared-player-bar" : "playback-menu-controls"} aria-label={t("playback.nowPlaying")} aria-busy={c.busy} data-playback-kind={browser ? "browser" : musicBar ? "music" : "video"}>
    {variant === "menu" ? <div className="playback-menu-status">
      <span data-playback-state={c.state}>{t(`playback.state.${c.state}`)}</span><PlaybackTargetSelect />
    </div> : null}
    {c.available || variant === "bar" ? <>
      <button className="playback-title" title={title} aria-label={`${t("playback.details")}: ${title}`} onClick={openDetails}>
        {musicBar ? <MusicCover coverKey={currentTrack?.coverKey ?? null} /> : <MonitorPlay size={22} aria-hidden="true" />}
        <span><strong>{title}</strong><small>{browser ? t("playback.browser") : musicBar ? currentTrack?.artist ?? t("music.nasPlayer") : t("playback.tvOutput")}</small></span>
      </button>
      {variant === "bar" ? <div className="playback-target-compact"><PlaybackTargetSelect /></div> : null}
      <PlaybackTransport c={c} />
      <PlaybackProgress c={c} />
      {variant === "bar" ? <PlaybackOutputPopover key={`${browser?.session.id ?? c.sessionId}:${musicBar}`} busy={c.busy}>
        <PlaybackOutput c={c} />
        {c.currentError ? <p role="alert" className="playback-error">{c.currentError}</p> : null}
      </PlaybackOutputPopover> : <div className="playback-output-fields"><PlaybackOutput c={c} /></div>}
    </> : <div className="playback-menu-empty"><CirclePlay size={28} aria-hidden="true" /><p>{t("playback.empty")}</p></div>}
    {music.status?.queue.length ? <button className="playback-secondary playback-queue" aria-label={t("music.queue")} title={t("music.queue")} onClick={openQueue}><ListMusic size={18} aria-hidden="true" />{variant === "menu" ? t("music.queue") : null}</button> : null}
    {!musicBar && c.available ? <button className="playback-secondary playback-stop" disabled={c.busy} aria-label={t("video.stop")} title={t("video.stop")} onClick={c.stop}><Square size={17} aria-hidden="true" />{variant === "menu" ? t("video.stop") : null}</button> : null}
    {trailingControl}
    {c.currentError ? <p className={variant === "bar" ? "visually-hidden" : "playback-error"} role="alert">{c.currentError}</p> : null}
  </section>;
}

export function PlaybackDetails({ c, onOpenBluetoothSettings }: { c: Controls; onOpenBluetoothSettings: () => void }) {
  const { t } = c;
  return <>
    <MusicPlayerDetails onOpenBluetoothSettings={onOpenBluetoothSettings} />
    {c.detailsOpen && !c.browser && !c.musicBar ? <MusicDialog title={t("playback.details")} onClose={() => c.setDetailsOpen(false)}>
      <h3>{c.title}</h3><PlaybackTargetSelect onChange={() => c.setDetailsOpen(false)} />
      <div className="playback-detail-controls"><PlaybackTransport c={c} detail /><PlaybackProgress c={c} detail /><button disabled={c.busy} aria-label={t("video.stop")} title={t("video.stop")} onClick={c.stop}><Square size={18} aria-hidden="true" />{t("video.stop")}</button></div>
      {c.music.status?.queue.length ? <button onClick={() => { c.setDetailsOpen(false); c.music.setDrawerOpen(true); }}><ListMusic size={18} aria-hidden="true" />{t("music.queue")}</button> : null}
      {c.currentError ? <p role="alert">{c.currentError}</p> : null}
    </MusicDialog> : null}
  </>;
}
