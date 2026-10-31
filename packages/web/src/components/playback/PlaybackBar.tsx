import { useEffect, useState } from "react";
import { ChevronDown, ListMusic, LoaderCircle, MonitorPlay, Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
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

export function PlaybackBar({ onOpenBluetoothSettings }: { onOpenBluetoothSettings: () => void }) {
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
  const canPlay = !busy && (browser ? browser.session.state === "ready" : musicBar ? !!music.status?.queue.length : !!sessionId);
  const canSeek = !busy && duration > 0 && (browser ? browser.session.state === "ready" : musicBar ? music.status?.owner === "music" : !!sessionId);

  useEffect(() => {
    let live = true;
    const refresh = () => void getBluetoothSettings().then((result) => {
      if (live) setDevices(result.audioDevices);
    }).catch(() => {});
    refresh();
    const timer = p.barVisible ? window.setInterval(refresh, 15000) : undefined;
    return () => { live = false; window.clearInterval(timer); };
  }, [p.barVisible, p.nas?.output.effective.deviceId]);
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
  const progress = (detail = false) => <div className={`playback-progress${detail ? " is-detail" : ""}`}>
    <span className="playback-time">{musicTime(position)}</span>
    <PlaybackSlider key={`${browser?.session.id ?? sessionId}:${detail}`} className="playback-seek" max={Math.max(1, duration)} step={0.1} value={position} label={t("music.seek")} disabled={!canSeek} onCommit={seek} />
    <span className="playback-time">{musicTime(duration || null)}</span>
  </div>;
  const transport = (detail = false) => <div className="playback-transport">
    {musicBar ? <button className="playback-secondary" disabled={busy || !music.status?.queue.length} aria-label={t("music.previous")} onClick={() => void music.execute({ type: "previous" })}><SkipBack size={18} aria-hidden="true" /></button> : null}
    <button data-playback-primary={detail ? undefined : true} disabled={!canPlay} aria-label={t(playing ? "music.pause" : "music.play")} onClick={toggle}>
      {busy ? <LoaderCircle size={20} className="is-spinning" aria-hidden="true" /> : playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
    </button>
    {musicBar ? <button className="playback-secondary" disabled={busy || !music.status?.queue.length} aria-label={t("music.next")} onClick={() => void music.execute({ type: "next" })}><SkipForward size={18} aria-hidden="true" /></button> : null}
  </div>;

  return <>
    <MusicPlayerDetails onOpenBluetoothSettings={onOpenBluetoothSettings} />
    {p.barVisible ? <div id="playback-dock" className="playback-shell" data-playback-kind={browser ? "browser" : musicBar ? "music" : "video"}>
      <section className="shared-player-bar" aria-label={t("playback.nowPlaying")} aria-busy={busy}>
        <button className="playback-title" title={title} aria-label={`${t("playback.details")}: ${title}`} onClick={() => {
          if (browser) p.setPlayerOpen(true);
          else if (musicBar) music.setDrawerOpen(true);
          else setDetailsOpen(true);
        }}>
          {musicBar ? <MusicCover coverKey={currentTrack?.coverKey ?? null} /> : <MonitorPlay size={22} aria-hidden="true" />}
          <span><strong>{title}</strong><small>{browser ? t("playback.browser") : musicBar ? currentTrack?.artist ?? t("music.nasPlayer") : t("playback.tvOutput")}</small></span>
        </button>
        <div className="playback-target-compact"><PlaybackTargetSelect /></div>
        {transport()}
        {progress()}
        <PlaybackOutputPopover key={`${browser?.session.id ?? sessionId}:${musicBar}`} busy={busy}>
          <label className="playback-output-volume"><span>{t("music.volume")}</span>
            <PlaybackSlider max={100} value={browser ? browser.volume * 100 : musicBar ? music.status?.volume ?? 100 : video?.volume ?? 100} label={t("music.volume")} disabled={busy} onCommit={(volume) => {
              if (browser) p.updateBrowser({ volume: volume / 100 });
              else if (musicBar) void music.execute({ type: "volume", volume });
              else if (sessionId) run({ type: "set-volume", sessionId, volume });
            }} />
          </label>
          {browser ? <p className="playback-output-device">{t("playback.localOutput")}</p> : <>
            <label>{t("music.output")}<OutputDeviceSelect value={output || null} devices={devices} disabled={busy} defaultLabel={t(musicBar ? "music.defaultOutput" : "playback.tvOutput")} onChange={(deviceId) => setOutput(deviceId ?? "")} /></label>
            <button disabled={busy || (!musicBar && !sessionId)} onClick={() => {
              if (musicBar) void music.execute({ type: "output", audioDeviceId: output || null });
              else if (sessionId) run({ type: "set-output", sessionId, audioDeviceId: output || null });
            }}>{t("playback.switchOutput")}</button>
            {!musicBar && sessionId ? <>
              <label>{t("playback.audioDelay")}<PlaybackSlider min={-5000} max={5000} step={50} value={nas?.preferences.audioDelays[nas.audioDelayKey] ?? 0} label={t("playback.audioDelay")} disabled={busy} onCommit={(milliseconds) => run({ type: "set-audio-delay", sessionId, milliseconds })} /><span>{nas?.preferences.audioDelays[nas.audioDelayKey] ?? 0} ms</span></label>
              <label>{t("video.audio")}<CustomSelect ariaLabel={t("video.audio")} value={String(video?.selectedAudioTrackId ?? "")} disabled={busy} options={(video?.audioTracks ?? []).map((track) => ({ value: String(track.id), label: String(track.title ?? track.language ?? track.id) }))} onChange={(trackId) => run({ type: "set-audio-track", sessionId, trackId: Number(trackId) })} /></label>
              <label>{t("video.subtitles")}<CustomSelect ariaLabel={t("video.subtitles")} value={String(video?.selectedSubtitleTrackId ?? "off")} disabled={busy} options={[{ value: "off", label: t("video.off") }, ...(video?.subtitleTracks ?? []).map((track) => ({ value: String(track.id), label: String(track.title ?? track.language ?? track.id) }))]} onChange={(trackId) => run({ type: "set-subtitle-track", sessionId, trackId: trackId === "off" ? null : Number(trackId) })} /></label>
            </> : null}
            {sessionId && nas?.owner ? <button disabled={busy} aria-pressed={musicBar ? nas.preferences.musicMuted : nas.preferences.videoMuted} onClick={() => run({ type: "set-muted", sessionId, muted: !(musicBar ? nas.preferences.musicMuted : nas.preferences.videoMuted) })}>{t("playback.mute")}</button> : null}
          </>}
          {currentError ? <p role="alert" className="playback-error">{currentError}</p> : null}
        </PlaybackOutputPopover>
        {music.status?.queue.length ? <button className="playback-secondary" aria-label={t("music.queue")} title={t("music.queue")} onClick={() => music.setDrawerOpen(true)}><ListMusic size={18} aria-hidden="true" /></button> : null}
        {!musicBar ? <button className="playback-secondary" disabled={busy} aria-label={t("video.stop")} title={t("video.stop")} onClick={stop}><Square size={17} aria-hidden="true" /></button> : null}
        <button className="playback-collapse" aria-label={t("playback.collapse")} title={t("playback.collapse")} onClick={p.collapseBar}><ChevronDown size={18} aria-hidden="true" /></button>
        {currentError ? <span className="visually-hidden" role="alert">{currentError}</span> : null}
      </section>
    </div> : null}
    {detailsOpen && !browser && !musicBar ? <MusicDialog title={t("playback.details")} onClose={() => setDetailsOpen(false)}>
      <h3>{title}</h3><PlaybackTargetSelect onChange={() => setDetailsOpen(false)} />
      <div className="playback-detail-controls">{transport(true)}{progress(true)}<button disabled={busy} aria-label={t("video.stop")} onClick={stop}><Square size={18} aria-hidden="true" />{t("video.stop")}</button></div>
      {music.status?.queue.length ? <button onClick={() => { setDetailsOpen(false); music.setDrawerOpen(true); }}><ListMusic size={18} aria-hidden="true" />{t("music.queue")}</button> : null}
      {currentError ? <p role="alert">{currentError}</p> : null}
    </MusicDialog> : null}
  </>;
}
