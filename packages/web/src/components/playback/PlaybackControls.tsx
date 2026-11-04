import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, CirclePlay, Headphones, ListMusic, LoaderCircle, MonitorPlay, Pause, Play, SkipBack, SkipForward, Square, Volume2 } from "lucide-react";
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
    {c.musicBar ? <button className="plain-button playback-secondary" disabled={c.busy || !c.music.status?.queue.length} aria-label={c.t("music.previous")} data-tooltip={c.t("music.previous")} onClick={() => void c.music.execute({ type: "previous" })}><SkipBack size={18} aria-hidden="true" /></button> : null}
    <button data-playback-primary={detail ? undefined : true} disabled={!c.canPlay} aria-busy={c.busy || undefined} aria-label={c.t(c.playing ? "music.pause" : "music.play")} data-tooltip={c.t(c.playing ? "music.pause" : "music.play")} onClick={c.toggle} className="plain-button">
      {c.busy ? <LoaderCircle size={20} className="is-spinning" aria-hidden="true" /> : c.playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
    </button>
    {c.musicBar ? <button className="plain-button playback-secondary" disabled={c.busy || !c.music.status?.queue.length} aria-label={c.t("music.next")} data-tooltip={c.t("music.next")} onClick={() => void c.music.execute({ type: "next" })}><SkipForward size={18} aria-hidden="true" /></button> : null}
  </div>;
}

function PlaybackVolume({ c, compact = false }: { c: Controls; compact?: boolean }) {
  const { t, browser, musicBar, music, video, sessionId, busy, run } = c;
  const volume = browser ? browser.volume * 100 : musicBar ? music.status?.volume ?? 100 : video?.volume ?? 100;
  return <label className={`playback-output-volume${compact ? " is-compact" : ""}`}>
      {compact ? <Volume2 size={17} aria-hidden="true" /> : <span>{t("music.volume")}</span>}
      <PlaybackSlider max={100} value={volume} label={t("music.volume")} disabled={busy || !c.available} onCommit={(volume) => {
        if (browser) c.p.updateBrowser({ volume: volume / 100 });
        else if (musicBar) void music.execute({ type: "volume", volume });
        else if (sessionId) run({ type: "set-volume", sessionId, volume });
      }} />
      {compact ? <span className="playback-volume-value">{Math.round(volume)}%</span> : null}
    </label>;
}

function PlaybackOutput({ c, includeVolume = true }: { c: Controls; includeVolume?: boolean }) {
  const { t, browser, musicBar, nas, video, sessionId, busy, run } = c;
  return <>
    {includeVolume ? <PlaybackVolume c={c} /> : null}
    {browser ? <p className="playback-output-device">{t("playback.localOutput")}</p> : <>
      <label>{t("music.output")}<OutputDeviceSelect value={c.output || null} devices={c.devices} disabled={busy} defaultLabel={t(musicBar ? "music.defaultOutput" : "playback.tvOutput")} onChange={(deviceId) => c.setOutput(deviceId ?? "")} /></label>
      <button disabled={busy || !c.available} onClick={() => {
        if (musicBar) void c.music.execute({ type: "output", audioDeviceId: c.output || null });
        else if (sessionId) run({ type: "set-output", sessionId, audioDeviceId: c.output || null });
      }} className="plain-button">{t("playback.switchOutput")}</button>
      {!musicBar && sessionId ? <>
        <label>{t("playback.audioDelay")}<PlaybackSlider min={-5000} max={5000} step={50} value={nas?.preferences.audioDelays[nas.audioDelayKey] ?? 0} label={t("playback.audioDelay")} disabled={busy} onCommit={(milliseconds) => run({ type: "set-audio-delay", sessionId, milliseconds })} /><span>{nas?.preferences.audioDelays[nas.audioDelayKey] ?? 0} ms</span></label>
        <label>{t("video.audio")}<CustomSelect ariaLabel={t("video.audio")} value={String(video?.selectedAudioTrackId ?? "")} disabled={busy} options={(video?.audioTracks ?? []).map((track) => ({ value: String(track.id), label: String(track.title ?? track.language ?? track.id) }))} onChange={(trackId) => run({ type: "set-audio-track", sessionId, trackId: Number(trackId) })} /></label>
        <label>{t("video.subtitles")}<CustomSelect ariaLabel={t("video.subtitles")} value={String(video?.selectedSubtitleTrackId ?? "off")} disabled={busy} options={[{ value: "off", label: t("video.off") }, ...(video?.subtitleTracks ?? []).map((track) => ({ value: String(track.id), label: String(track.title ?? track.language ?? track.id) }))]} onChange={(trackId) => run({ type: "set-subtitle-track", sessionId, trackId: trackId === "off" ? null : Number(trackId) })} /></label>
      </> : null}
      {sessionId && nas?.owner ? <button disabled={busy} aria-pressed={musicBar ? nas.preferences.musicMuted : nas.preferences.videoMuted} onClick={() => run({ type: "set-muted", sessionId, muted: !(musicBar ? nas.preferences.musicMuted : nas.preferences.videoMuted) })} className="plain-button">{t("playback.mute")}</button> : null}
    </>}
  </>;
}

function PlaybackTitle({ c, onClick, card = false }: { c: Controls; onClick: () => void; card?: boolean }) {
  return <button className="plain-button playback-title" data-tooltip={c.title} aria-label={`${c.t("playback.details")}: ${c.title}`} onClick={onClick}>
    {c.musicBar ? <MusicCover coverKey={c.currentTrack?.coverKey ?? null} /> : card ? <span className="music-cover"><MonitorPlay size={22} aria-hidden="true" /></span> : <MonitorPlay size={22} aria-hidden="true" />}
    <span><strong>{c.title}</strong><small>{c.browser ? c.t("playback.browser") : c.musicBar ? c.currentTrack?.artist ?? c.t("music.nasPlayer") : c.t("playback.tvOutput")}</small></span>
  </button>;
}

function playbackOutputName(c: Controls) {
  const { t, music, browser, musicBar } = c;
  if (browser) return t("playback.localOutput");
  const unavailable = musicBar ? music.status?.errorCode === "AUDIO_UNAVAILABLE" : c.nas?.output.effective.kind === "unavailable";
  if (unavailable) return t("music.unavailableOutput");
  const effectiveId = musicBar ? music.status?.effectiveAudioDeviceId : c.nas?.output.effective.deviceId;
  if (effectiveId) {
    const device = c.devices.find((item) => item.id === effectiveId);
    return device ? `${device.name}${device.connected ? "" : ` · ${t("music.disconnected")}`}` : t("playback.bluetoothOutput");
  }
  const defaultOutput = musicBar ? music.status?.owner === "music" && ["playing", "paused"].includes(music.status.state) : c.nas?.output.effective.kind === "default";
  return t(defaultOutput ? musicBar ? "music.defaultOutput" : "playback.tvOutput" : "playback.outputUnknown");
}

function PlaybackCard({ c, beforeDetails }: { c: Controls; beforeDetails: (() => void) | undefined }) {
  const [outputOpen, setOutputOpen] = useState(false);
  const outputId = useId();
  const { t, music, browser, musicBar } = c;
  const outputName = playbackOutputName(c);
  return <section className="playback-menu-controls" aria-label={t("playback.nowPlaying")} aria-busy={c.busy} data-playback-kind={browser ? "browser" : musicBar ? "music" : "video"} data-playback-state={c.state}>
    {c.available ? <>
      <PlaybackTitle c={c} card onClick={() => { beforeDetails?.(); c.openDetails(); }} />
      <PlaybackProgress c={c} />
      <PlaybackTransport c={c} />
      <PlaybackVolume c={c} compact />
      <div className="playback-card-tools">
        {browser ? <p className="playback-output-summary"><Headphones size={17} aria-hidden="true" /><span>{outputName}</span></p> : <button type="button" className="plain-button playback-output-summary" aria-label={`${t("music.output")}: ${outputName}`} data-tooltip={`${t("music.output")}: ${outputName}`} aria-expanded={outputOpen} aria-controls={outputOpen ? outputId : undefined} onClick={() => {
          if (!outputOpen) c.setOutput((musicBar ? music.status?.audioDeviceId : c.nas?.output.requested.deviceId) ?? "");
          setOutputOpen((current) => !current);
        }}>
          <Headphones size={17} aria-hidden="true" /><span>{outputName}</span><ChevronDown size={15} aria-hidden="true" />
        </button>}
        {music.status?.queue.length ? <button type="button" className="plain-button playback-secondary playback-queue" aria-label={t("music.queue")} data-tooltip={t("music.queue")} onClick={() => { beforeDetails?.(); music.setDrawerOpen(true); }}><ListMusic size={19} aria-hidden="true" /></button> : null}
        {!musicBar ? <button type="button" className="plain-button playback-secondary playback-stop" disabled={c.busy} aria-label={t("video.stop")} data-tooltip={t("video.stop")} onClick={c.stop}><Square size={15} aria-hidden="true" /><span>{t("video.stop")}</span></button> : null}
      </div>
      {outputOpen && !browser ? <div id={outputId} className="playback-output-fields"><PlaybackOutput c={c} includeVolume={false} /></div> : null}
    </> : <div className="playback-menu-empty"><CirclePlay size={32} aria-hidden="true" /><p>{t("playback.empty")}</p></div>}
    {c.currentError ? <p className="playback-error" role="alert">{c.currentError}</p> : null}
  </section>;
}

export function PlaybackControls({ c, variant, beforeDetails, trailingControl }: {
  c: Controls;
  variant: "bar" | "menu";
  beforeDetails?: () => void;
  trailingControl?: ReactNode;
}) {
  const { t, music, browser, musicBar } = c;
  if (variant === "menu") return <PlaybackCard key={`${c.p.target}:${browser?.session.id ?? c.sessionId}:${musicBar}`} c={c} beforeDetails={beforeDetails} />;
  const openDetails = () => { beforeDetails?.(); c.openDetails(); };
  const openQueue = () => { beforeDetails?.(); music.setDrawerOpen(true); };
  return <section className="shared-player-bar" aria-label={t("playback.nowPlaying")} aria-busy={c.busy} data-playback-kind={browser ? "browser" : musicBar ? "music" : "video"}>
      <PlaybackTitle c={c} onClick={openDetails} />
      <div className="playback-target-compact"><PlaybackTargetSelect compact /></div>
      <PlaybackTransport c={c} />
      <PlaybackProgress c={c} />
      <PlaybackOutputPopover key={`${browser?.session.id ?? c.sessionId}:${musicBar}`} busy={c.busy}>
        <PlaybackOutput c={c} />
        {c.currentError ? <p role="alert" className="playback-error">{c.currentError}</p> : null}
      </PlaybackOutputPopover>
    {music.status?.queue.length ? <button className="plain-button playback-secondary playback-queue" aria-label={t("music.queue")} data-tooltip={t("music.queue")} onClick={openQueue}><ListMusic size={18} aria-hidden="true" /></button> : null}
    {!musicBar && c.available ? <button className="plain-button playback-secondary playback-stop" disabled={c.busy} aria-label={t("video.stop")} data-tooltip={t("video.stop")} onClick={c.stop}><Square size={17} aria-hidden="true" /></button> : null}
    {trailingControl}
    {c.currentError ? <p className="visually-hidden" role="alert">{c.currentError}</p> : null}
  </section>;
}

export function PlaybackDetails({ c, onOpenBluetoothSettings }: { c: Controls; onOpenBluetoothSettings: () => void }) {
  const { t } = c;
  return <>
    <MusicPlayerDetails onOpenBluetoothSettings={onOpenBluetoothSettings} />
    {c.detailsOpen && !c.browser && !c.musicBar ? <MusicDialog title={t("playback.details")} onClose={() => c.setDetailsOpen(false)}>
      <h3>{c.title}</h3><PlaybackTargetSelect onChange={() => c.setDetailsOpen(false)} />
      <div className="playback-detail-controls"><PlaybackTransport c={c} detail /><PlaybackProgress c={c} detail /><button disabled={c.busy} aria-label={t("video.stop")} data-tooltip={t("video.stop")} onClick={c.stop} className="plain-button"><Square size={18} aria-hidden="true" />{t("video.stop")}</button></div>
      {c.music.status?.queue.length ? <button onClick={() => { c.setDetailsOpen(false); c.music.setDrawerOpen(true); }} className="plain-button"><ListMusic size={18} aria-hidden="true" />{t("music.queue")}</button> : null}
      {c.currentError ? <p role="alert">{c.currentError}</p> : null}
    </MusicDialog> : null}
  </>;
}
