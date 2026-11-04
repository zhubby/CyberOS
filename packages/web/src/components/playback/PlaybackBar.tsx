import { ChevronDown } from "lucide-react";
import { usePlaybackControls, PlaybackControls, PlaybackDetails } from "./PlaybackControls.js";
import { PlaybackRestoreButton } from "./PlaybackRestoreButton.js";

export function PlaybackBar({ onOpenBluetoothSettings }: { onOpenBluetoothSettings: () => void }) {
  const c = usePlaybackControls();
  return <>
    <PlaybackDetails c={c} onOpenBluetoothSettings={onOpenBluetoothSettings} />
    {c.p.dockVisible ? <div id="playback-dock" data-tv-region="playback" className={`playback-shell${c.p.barVisible ? "" : " is-collapsed"}`}>
      {c.p.barVisible ? <PlaybackControls c={c} variant="bar" trailingControl={
        <button className="plain-button playback-collapse" aria-label={c.t("playback.collapse")} data-tooltip={c.t("playback.collapse")} onClick={c.p.collapseBar}><ChevronDown size={18} aria-hidden="true" /></button>
      } /> : <PlaybackRestoreButton />}
    </div> : null}
  </>;
}
