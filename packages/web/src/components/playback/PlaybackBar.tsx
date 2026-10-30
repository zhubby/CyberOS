import { OutputDeviceSelect } from "./OutputDeviceSelect.js";
import { PlaybackSlider } from "./PlaybackSlider.js";
import { useEffect, useState } from "react";
import {
  ListMusic,
  MonitorPlay,
  Pause,
  Play,
  Square,
  Volume2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePlayback } from "./PlaybackProvider.js";
import { useMusicRemote } from "../music/MusicProvider.js";
import { MusicPlayer } from "../music/MusicPlayer.js";
import { getBluetoothSettings, type BluetoothAudioDevice } from "../../api.js";
import { musicTime } from "../../lib/music-state.js";
import type { VodPlayerCommand } from "@cyberos/shared";

export function PlaybackBar({
  onOpenBluetoothSettings,
}: {
  onOpenBluetoothSettings: () => void;
}) {
  const p = usePlayback();
  const music = useMusicRemote();
  const { t } = useTranslation();
  const [devices, setDevices] = useState<BluetoothAudioDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void getBluetoothSettings()
        .then((r) => {
          if (live) setDevices(r.audioDevices);
        })
        .catch(() => {});
    refresh();
    const timer =
      p.nas?.owner === "video" ? window.setInterval(refresh, 15000) : undefined;
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [p.nas?.output.effective.deviceId, p.nas?.owner]);
  useEffect(() => setError(null), [p.target, p.browser?.session.id]);
  useEffect(() => {
    setOutput(p.nas?.output.requested.deviceId ?? "");
  }, [p.nas?.output.requested.deviceId]);
  const exists = !!p.browser || !!p.nas?.owner || !!music.status?.queue.length;
  const browser = p.target === "browser" && p.browser ? p.browser : null;
  const musicBar = !browser && p.nas?.owner !== "video";
  const nas = p.nas;
  const video = nas?.video;
  const sessionId = nas?.sessionId;
  const run = (command: VodPlayerCommand) => {
    setBusy(true);
    setError(null);
    void p
      .control(command)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  if (!exists || p.fullscreen)
    return (
      <MusicPlayer hideBar onOpenBluetoothSettings={onOpenBluetoothSettings} />
    );
  const playing = browser ? browser.playing : video?.state === "playing";
  return (
    <div className="playback-shell">
      <nav
        className="playback-targets"
        aria-label={t("playback.controlTarget")}
      >
        {p.browser ? (
          <button
            aria-pressed={!!browser}
            onClick={() => p.setTarget("browser")}
          >
            {t("playback.browser")}
          </button>
        ) : null}
        <button aria-pressed={!browser} onClick={() => p.setTarget("nas")}>
          NAS ·{" "}
          {nas?.owner === "video"
            ? t("video.title")
            : t("workspace.panels.music")}
        </button>
        {music.status?.queue.length ? (
          <button
            onClick={() => music.setDrawerOpen(true)}
            aria-label={t("music.queue")}
          >
            <ListMusic size={17} />
          </button>
        ) : null}
      </nav>
      <MusicPlayer
        hideBar={!musicBar}
        onOpenBluetoothSettings={onOpenBluetoothSettings}
      />
      {!musicBar ? (
        <section
          className="shared-player-bar"
          aria-label={t("playback.controlTarget")}
          aria-busy={busy}
        >
          <button
            className="playback-title"
            onClick={() => {
              if (browser) p.setPlayerOpen(true);
            }}
          >
            <MonitorPlay size={22} />
            <span>
              <strong>
                {browser?.title ?? video?.fileName ?? t("video.title")}
              </strong>
              <small>
                {browser
                  ? t("playback.localOutput")
                  : nas?.output.effective.kind === "unavailable"
                    ? t("music.outputUnavailable")
                    : (devices.find(
                        (d) => d.id === nas?.output.effective.deviceId,
                      )?.name ?? t("playback.tvOutput"))}
              </small>
            </span>
          </button>
          <button
            disabled={
              busy ||
              (browser ? browser.session.state !== "ready" : !sessionId)
            }
            aria-label={playing ? t("music.pause") : t("music.play")}
            onClick={() => {
              if (browser) {
                setBusy(true);
                void p
                  .toggleBrowser()
                  .catch((e) =>
                    setError(e instanceof Error ? e.message : String(e)),
                  )
                  .finally(() => setBusy(false));
              } else if (sessionId)
                run({ type: playing ? "pause" : "resume", sessionId });
            }}
          >
            {playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <span className="playback-time">
            {musicTime(browser?.position ?? video?.positionSeconds ?? 0)} /{" "}
            {musicTime(
              browser?.session.durationSeconds ??
                video?.durationSeconds ??
                null,
            )}
          </span>
          <PlaybackSlider
            className="playback-seek"
            label={t("music.seek")}
            max={
              browser?.session.durationSeconds ?? video?.durationSeconds ?? 1
            }
            value={browser?.position ?? video?.positionSeconds ?? 0}
            disabled={
              busy ||
              (browser
                ? browser.session.state !== "ready" ||
                  !browser.session.durationSeconds
                : !sessionId || !video?.durationSeconds)
            }
            onCommit={(positionSeconds) => {
              if (browser) {
                if (browser.session.mode === "direct" && p.videoRef.current) {
                  p.videoRef.current.currentTime = positionSeconds;
                  p.updateBrowser({ position: positionSeconds });
                } else {
                  setBusy(true);
                  void p
                    .playBrowser(browser.fileId, browser.title, {
                      ...browser.options,
                      startPositionSeconds: positionSeconds,
                    })
                    .then(() => p.setPlayerOpen(false))
                    .catch((e) =>
                      setError(e instanceof Error ? e.message : String(e)),
                    )
                    .finally(() => setBusy(false));
                }
              } else if (sessionId)
                run({ type: "seek", sessionId, seconds: positionSeconds });
            }}
          />
          <label className="playback-volume">
            <Volume2 size={16} />
            <PlaybackSlider
              max={100}
              value={browser ? browser.volume * 100 : (video?.volume ?? 100)}
              label={t("music.volume")}
              disabled={busy}
              onCommit={(volume) => {
                if (browser) p.updateBrowser({ volume: volume / 100 });
                else if (sessionId)
                  run({ type: "set-volume", sessionId, volume });
              }}
            />
          </label>
          {!browser && sessionId ? (
            <details className="playback-output">
              <summary>{t("music.output")}</summary>
              <label>
                {t("music.output")}
                <OutputDeviceSelect
                  value={output || null}
                  devices={devices}
                  disabled={busy}
                  defaultLabel={t("playback.tvOutput")}
                  onChange={(deviceId) => setOutput(deviceId ?? "")}
                />
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  run({
                    type: "set-output",
                    sessionId,
                    audioDeviceId: output || null,
                  })
                }
              >
                {t("playback.switchOutput")}
              </button>
              <label>
                {t("playback.audioDelay")}
                <PlaybackSlider
                  min={-5000}
                  max={5000}
                  step={50}
                  value={
                    nas?.preferences.audioDelays[nas?.audioDelayKey ?? "tv"] ??
                    0
                  }
                  label={t("playback.audioDelay")}
                  disabled={busy}
                  onCommit={(milliseconds) =>
                    run({ type: "set-audio-delay", sessionId, milliseconds })
                  }
                />
                <span>
                  {nas?.preferences.audioDelays[nas?.audioDelayKey ?? "tv"] ??
                    0}{" "}
                  ms
                </span>
              </label>
              <button
                aria-pressed={nas?.preferences.videoMuted}
                onClick={() =>
                  run({
                    type: "set-muted",
                    sessionId,
                    muted: !nas?.preferences.videoMuted,
                  })
                }
              >
                {t("playback.mute")}
              </button>
              <label>
                {t("video.audio")}
                <select
                  value={video?.selectedAudioTrackId ?? ""}
                  onChange={(e) =>
                    run({
                      type: "set-audio-track",
                      sessionId,
                      trackId: Number(e.target.value),
                    })
                  }
                >
                  {video?.audioTracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.title ?? track.language ?? track.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("video.subtitles")}
                <select
                  value={video?.selectedSubtitleTrackId ?? "off"}
                  onChange={(e) =>
                    run({
                      type: "set-subtitle-track",
                      sessionId,
                      trackId:
                        e.target.value === "off"
                          ? null
                          : Number(e.target.value),
                    })
                  }
                >
                  <option value="off">{t("video.off")}</option>
                  {video?.subtitleTracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.title ?? track.language ?? track.id}
                    </option>
                  ))}
                </select>
              </label>
            </details>
          ) : null}
          <button
            aria-label={t("video.stop")}
            disabled={busy}
            onClick={() => {
              if (browser) p.stopBrowser();
              else if (sessionId) run({ type: "stop-video", sessionId });
            }}
          >
            <Square size={17} />
          </button>
        </section>
      ) : null}
      {(error ?? (!browser && (p.error ?? video?.error))) ? (
        <p role="alert" className="playback-error">
          {error ?? p.error ?? video?.error}
        </p>
      ) : null}
    </div>
  );
}
