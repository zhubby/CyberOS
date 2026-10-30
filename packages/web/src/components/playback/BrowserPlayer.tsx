import { PlaybackSlider } from "./PlaybackSlider.js";
import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import {
  Maximize,
  Minimize2,
  Pause,
  Play,
  Square,
  Volume2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { StreamOptions } from "@cyberos/shared";
import { usePlayback } from "./PlaybackProvider.js";
import { useModalDialog } from "../workspace/useModalDialog.js";
import { musicTime } from "../../lib/music-state.js";
import { mediaRequest, saveStreamProgress } from "../../lib/video-api.js";

export function BrowserPlayer() {
  const playback = usePlayback();
  return playback.browser ? <BrowserPlayerSurface /> : null;
}
function BrowserPlayerSurface() {
  const { t } = useTranslation();
  const p = usePlayback();
  const b = p.browser!;
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const dialog = useModalDialog(() => p.setPlayerOpen(false));
  const current = useRef(b);
  current.current = b;
  const translate = useRef(t);
  translate.current = t;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (p.playerOpen) {
      const previous = document.activeElement as HTMLElement | null;
      dialog.current?.focus();
      return () => {
        if (previous?.isConnected) previous.focus();
      };
    }
  }, [p.playerOpen, dialog]);
  useEffect(() => {
    const video = p.videoRef.current;
    if (!video || b.session.state !== "ready") return;
    setError(null);
    let hls: Hls | null = null;
    const ready = () => {
      if (b.session.mode === "direct")
        video.currentTime = b.session.startPositionSeconds;
      void video.play().catch(() => p.updateBrowser({ playing: false }));
    };
    if (b.session.mode === "direct") {
      video.src = b.session.url;
      video.addEventListener("loadedmetadata", ready, { once: true });
    } else if (Hls.isSupported()) {
      // Prefer MSE: native capability hints can succeed even when the browser
      // cannot play our rolling playlist.
      hls = new Hls({
        startPosition: 0,
        maxBufferLength: 24,
        backBufferLength: 8,
      });
      hls.loadSource(b.session.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, ready);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setError(translate.current("video.streamFailed"));
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = b.session.url;
      video.addEventListener("loadedmetadata", ready, { once: true });
    } else setError(translate.current("video.streamUnsupported"));
    return () => {
      video.pause();
      video.removeEventListener("loadedmetadata", ready);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [
    b.session.id,
    b.session.state,
    b.session.url,
    b.session.mode,
    b.session.startPositionSeconds,
    p.videoRef,
    p.updateBrowser,
  ]);
  useEffect(() => {
    const video = p.videoRef.current;
    if (video) {
      video.volume = b.volume;
      video.muted = b.muted;
    }
  }, [b.volume, b.muted, p.videoRef]);
  const replace = (patch: StreamOptions) => {
    void p
      .playBrowser(b.fileId, b.title, {
        ...b.options,
        startPositionSeconds: b.position,
        ...patch,
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  const seek = (seconds: number) => {
    if (b.session.mode === "direct" && p.videoRef.current) {
      p.videoRef.current.currentTime = seconds;
      p.updateBrowser({ position: seconds });
    } else replace({ startPositionSeconds: seconds });
  };
  const toggle = () => {
    void p
      .toggleBrowser()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  const ended = async () => {
    p.updateBrowser({ playing: false });
    const finished = current.current;
    try {
      await saveStreamProgress(
        finished.session.id,
        finished.session.durationSeconds ?? finished.position,
      );
      const result = await mediaRequest<{
        next: { fileId: string; title: string } | null;
      }>(`media/files/${encodeURIComponent(finished.fileId)}/next`);
      if (
        live.current &&
        current.current.session.id === finished.session.id &&
        result.next
      )
        await p.playBrowser(result.next.fileId, result.next.title, {
          quality: finished.options.quality ?? "original",
        });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div
      ref={surface}
      className={`browser-player-backdrop${p.playerOpen ? "" : " is-minimized"}`}
    >
      <section
        ref={dialog}
        tabIndex={-1}
        className="browser-player"
        role={p.playerOpen ? "dialog" : undefined}
        aria-modal={p.playerOpen ? true : undefined}
        aria-label={b.title}
      >
        <header>
          <strong>{b.title}</strong>
          <span>{t("playback.browser")}</span>
          <button
            onClick={() => p.setPlayerOpen(false)}
            aria-label={t("video.minimize")}
          >
            <Minimize2 size={20} />
          </button>
          <button onClick={p.stopBrowser} aria-label={t("video.stop")}>
            <Square size={18} />
          </button>
        </header>
        <video
          ref={p.videoRef}
          playsInline
          onPlay={() => p.updateBrowser({ playing: true })}
          onPause={() => p.updateBrowser({ playing: false })}
          onTimeUpdate={() => {
            const v = p.videoRef.current;
            if (v)
              p.updateBrowser({
                position:
                  (b.session.mode === "direct"
                    ? 0
                    : b.session.startPositionSeconds) + v.currentTime,
              });
          }}
          onEnded={() => void ended()}
          onError={() => {
            if (current.current.session.state === "ready")
              setError(t("video.streamFailed"));
          }}
        />
        {b.session.state !== "ready" ? (
          <p role="status">
            {b.session.state === "queued"
              ? t("video.queued")
              : (b.session.error ?? t("video.preparing"))}
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="browser-controls">
          <button
            disabled={b.session.state !== "ready"}
            onClick={toggle}
            aria-label={b.playing ? t("music.pause") : t("music.play")}
          >
            {b.playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <span>{musicTime(b.position)}</span>
          <PlaybackSlider
            label={t("music.seek")}
            max={b.session.durationSeconds ?? 1}
            value={b.position}
            disabled={!b.session.durationSeconds || b.session.state !== "ready"}
            onCommit={seek}
          />
          <span>{musicTime(b.session.durationSeconds)}</span>
          <button
            onClick={() => p.updateBrowser({ muted: !b.muted })}
            aria-label={t("playback.mute")}
            aria-pressed={b.muted}
          >
            <Volume2 size={18} />
          </button>
          <input
            className="video-volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={b.volume}
            aria-label={t("music.volume")}
            onChange={(e) =>
              p.updateBrowser({ volume: Number(e.target.value) })
            }
          />
          <button
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else
                void surface.current
                  ?.requestFullscreen()
                  .catch(() => setError(t("video.streamUnsupported")));
            }}
            aria-label={t("video.fullscreen")}
          >
            <Maximize size={18} />
          </button>
        </div>
        <div className="browser-options">
          <label>
            {t("video.quality")}
            <select
              value={b.options.quality ?? "original"}
              onChange={(e) =>
                replace({
                  quality: e.target.value as NonNullable<
                    StreamOptions["quality"]
                  >,
                })
              }
            >
              {["original", "1080", "720", "480"].map((q) => (
                <option key={q} value={q}>
                  {q === "original" ? t("video.original") : `${q}p`}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("video.audio")}
            <select
              value={b.session.audioTrack ?? ""}
              onChange={(e) => replace({ audioTrack: Number(e.target.value) })}
            >
              {b.session.tracks
                .filter((track) => track.type === "audio")
                .map((track) => (
                  <option key={track.index} value={track.index}>
                    {track.title ?? track.language ?? track.codec} ·{" "}
                    {track.index}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {t("video.subtitles")}
            <select
              value={b.session.subtitleTrack ?? "off"}
              onChange={(e) =>
                replace({
                  subtitleTrack:
                    e.target.value === "off" ? null : Number(e.target.value),
                })
              }
            >
              <option value="off">{t("video.off")}</option>
              {b.session.tracks
                .filter((track) => track.type === "subtitle")
                .map((track) => (
                  <option key={track.index} value={track.index}>
                    {track.title ?? track.language ?? track.codec} ·{" "}
                    {track.index}
                  </option>
                ))}
            </select>
          </label>
          <span>
            {b.session.mode === "direct"
              ? t("video.direct")
              : b.session.mode === "remux"
                ? t("video.remux")
                : t("video.transcode")}
          </span>
        </div>
      </section>
    </div>
  );
}
