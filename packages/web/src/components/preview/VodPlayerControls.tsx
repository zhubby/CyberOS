import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Captions,
  ListMusic,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Square,
  Volume2,
  VolumeX
} from "lucide-react";
import type { VodPlayerCommand, VodPlayerStatus } from "../../api.js";

export function VodPlayerControls({ status, busy, onCommand, onRetry }: {
  status: VodPlayerStatus;
  busy: boolean;
  onCommand: (command: Exclude<VodPlayerCommand, { type: "play" }>) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (!status.fileName && status.state === "idle") return null;

  const duration = status.durationSeconds ?? 0;
  const position = Math.min(status.positionSeconds, duration || status.positionSeconds);
  const isPlaying = status.state === "playing";
  const isPaused = status.state === "paused";
  const isRecovering = status.state === "recovering";
  const isError = status.state === "error";
  const sessionId = status.sessionId;
  const controlsDisabled = busy || !sessionId || (!isPlaying && !isPaused);
  const errorMessage = status.errorCode
    ? t(`preview.vodPlayer.errors.${status.errorCode}`, { defaultValue: status.error ?? t("preview.vodPlayer.playbackError") })
    : status.error ?? t("preview.vodPlayer.playbackError");
  const recoveryMessage = t("preview.vodPlayer.recoveringIn", {
    seconds: retrySeconds(status.nextRetryAt),
    count: status.retryCount
  });
  type ControlIntent =
    | { type: "pause" | "resume" | "stop" | "retry" }
    | { type: "seek"; seconds: number }
    | { type: "set-volume"; volume: number }
    | { type: "set-audio-track"; trackId: number }
    | { type: "set-subtitle-track"; trackId: number | null };
  const command = (next: ControlIntent) => {
    if (sessionId) onCommand({ ...next, sessionId } as Exclude<VodPlayerCommand, { type: "play" }>);
  };

  return (
    <section className="vod-player-controls" aria-label={t("preview.vodPlayer.label")} aria-busy={busy || undefined}>
      <div className="vod-player-heading">
        <div className="vod-player-title">
          <span className="eyebrow">{t("preview.vodPlayer.label")}</span>
          <strong title={status.relativePath ?? status.fileName ?? undefined}>{status.fileName ?? t("preview.vodPlayer.unknownFile")}</strong>
        </div>
        <span className={`vod-player-state${isError ? " is-error" : isRecovering ? " is-recovering" : ""}`} role="status">
          {t(`preview.vodPlayer.states.${status.state}`)}
        </span>
      </div>

      {isError || isRecovering ? (
        <div className={`vod-player-message${isError ? " is-error" : " is-recovering"}`} role={isError ? "alert" : "status"}>
          {isError ? <AlertTriangle aria-hidden="true" size={15} /> : <RefreshCw className="is-spinning" aria-hidden="true" size={14} />}
          <span>{isRecovering ? recoveryMessage : errorMessage}</span>
          <button type="button" className="preview-tool-button" onClick={onRetry} disabled={busy || !sessionId} title={t("preview.retry")} aria-label={t("preview.retry")}>
            {busy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={14} /> : <RefreshCw aria-hidden="true" size={14} />}
          </button>
        </div>
      ) : null}

      {status.audioFallbackReason ? (
        <div className="vod-player-message is-warning" role="status">
          <AlertTriangle aria-hidden="true" size={15} />
          <span>{t("preview.vodPlayer.audioFallback", { reason: status.audioFallbackReason })}</span>
        </div>
      ) : null}

      <label className="vod-player-progress">
        <span className="visually-hidden">{t("preview.vodPlayer.seek")}</span>
        <input
          type="range"
          min="0"
          max={Math.max(duration, 1)}
          step="0.1"
          value={position}
          disabled={controlsDisabled || !status.durationSeconds}
          onChange={(event) => command({ type: "seek", seconds: Number(event.target.value) })}
        />
        <span>{formatTime(position)} / {formatTime(status.durationSeconds)}</span>
      </label>

      <div className="vod-player-actions">
        <button type="button" className="preview-tool-button" onClick={() => command({ type: "seek", seconds: Math.max(0, status.positionSeconds - 10) })} disabled={controlsDisabled} title={t("preview.vodPlayer.rewind")} aria-label={t("preview.vodPlayer.rewind")}>
          <RotateCcw aria-hidden="true" size={15} />
        </button>
        <button type="button" className="preview-tool-button is-primary" onClick={() => command({ type: isPlaying ? "pause" : "resume" })} disabled={controlsDisabled} title={isPlaying ? t("preview.vodPlayer.pause") : t("preview.vodPlayer.resume")} aria-label={isPlaying ? t("preview.vodPlayer.pause") : t("preview.vodPlayer.resume")}>
          {busy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={15} /> : isPlaying ? <Pause aria-hidden="true" size={15} /> : <Play aria-hidden="true" size={15} />}
        </button>
        <button type="button" className="preview-tool-button" onClick={() => command({ type: "seek", seconds: status.positionSeconds + 10 })} disabled={controlsDisabled} title={t("preview.vodPlayer.forward")} aria-label={t("preview.vodPlayer.forward")}>
          <RotateCw aria-hidden="true" size={15} />
        </button>
        <button type="button" className="preview-tool-button" onClick={() => command({ type: "stop" })} disabled={busy || !sessionId || status.state === "stopped" || status.state === "idle"} title={t("preview.vodPlayer.stop")} aria-label={t("preview.vodPlayer.stop")}>
          <Square aria-hidden="true" size={14} />
        </button>
        <label className="vod-player-volume">
          <span className="visually-hidden">{t("preview.vodPlayer.volume")}</span>
          {status.volume === 0 ? <VolumeX aria-hidden="true" size={15} /> : <Volume2 aria-hidden="true" size={15} />}
          <input type="range" min="0" max="100" step="1" value={status.volume} onChange={(event) => command({ type: "set-volume", volume: Number(event.target.value) })} disabled={busy || !sessionId} />
        </label>
      </div>

      {status.audioTracks.length > 0 || status.subtitleTracks.length > 0 ? (
        <div className="vod-player-tracks">
          {status.audioTracks.length > 0 ? (
            <label>
              <ListMusic aria-hidden="true" size={15} />
              <span className="visually-hidden">{t("preview.vodPlayer.audioTrack")}</span>
              <select
                value={status.selectedAudioTrackId ?? ""}
                disabled={controlsDisabled}
                aria-label={t("preview.vodPlayer.audioTrack")}
                onChange={(event) => command({ type: "set-audio-track", trackId: Number(event.target.value) })}
              >
                {status.audioTracks.map((track, index) => (
                  <option key={track.id} value={track.id}>{trackLabel(track, index, t("preview.vodPlayer.audioTrack"))}</option>
                ))}
              </select>
            </label>
          ) : null}
          {status.subtitleTracks.length > 0 ? (
            <label>
              <Captions aria-hidden="true" size={15} />
              <span className="visually-hidden">{t("preview.vodPlayer.subtitleTrack")}</span>
              <select
                value={status.selectedSubtitleTrackId ?? "off"}
                disabled={controlsDisabled}
                aria-label={t("preview.vodPlayer.subtitleTrack")}
                onChange={(event) => command({
                  type: "set-subtitle-track",
                  trackId: event.target.value === "off" ? null : Number(event.target.value)
                })}
              >
                <option value="off">{t("preview.vodPlayer.subtitleOff")}</option>
                {status.subtitleTracks.map((track, index) => (
                  <option key={track.id} value={track.id}>{trackLabel(track, index, t("preview.vodPlayer.subtitleTrack"))}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function trackLabel(
  track: VodPlayerStatus["audioTracks"][number],
  index: number,
  fallback: string
): string {
  return [track.title, track.language?.toUpperCase(), !track.title && !track.language ? `${fallback} ${index + 1}` : null]
    .filter(Boolean)
    .join(" · ");
}

function retrySeconds(nextRetryAt: string | null): number {
  if (!nextRetryAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(nextRetryAt) - Date.now()) / 1_000));
}

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  const hours = Math.floor(minutes / 60);
  const minutePart = hours > 0 ? minutes % 60 : minutes;
  return hours > 0
    ? `${hours}:${String(minutePart).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutePart}:${String(remaining).padStart(2, "0")}`;
}
