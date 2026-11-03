import { ChevronUp, CirclePlay } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePlayback } from "./PlaybackProvider.js";

export function PlaybackRestoreButton() {
  const p = usePlayback();
  const { t } = useTranslation();
  if (!p.dock.available) return null;
  const label = `${t("playback.nowPlaying")} · ${t(`playback.state.${p.dock.state}`)}`;
  return (
    <button
      type="button"
      className="playback-restore"
      data-playback-restore
      data-playback-state={p.dock.state}
      data-tv-focusable
      aria-label={label}
      data-tooltip={label}
      aria-expanded={p.barVisible}
      aria-controls={p.barVisible ? "playback-dock" : undefined}
      onClick={p.expandBar}
    >
      <CirclePlay size={19} aria-hidden="true" />
      <span className="playback-restore-label">{t("playback.nowPlaying")}</span>
      <span className="playback-restore-state"><span className="playback-restore-dot" aria-hidden="true" />{t(`playback.state.${p.dock.state}`)}</span>
      <ChevronUp className="playback-restore-chevron" size={18} aria-hidden="true" />
    </button>
  );
}
