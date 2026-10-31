import { OutputDeviceSelect } from "../playback/OutputDeviceSelect.js";
import { useOptionalPlayback } from "../playback/PlaybackProvider.js";
import { PlaybackSlider } from "../playback/PlaybackSlider.js";
import { PlaybackTargetSelect } from "../playback/PlaybackTargetSelect.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bluetooth,
  Check,
  Disc3,
  Heart,
  MonitorPlay,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Speaker,
  Trash2,
  Volume2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MusicLyrics, MusicQueueEntry, MusicTrack } from "@cyberos/shared";
import { getBluetoothSettings, type BluetoothAudioDevice } from "../../api.js";
import { musicCoverUrl, musicRequest } from "../../lib/music-api.js";
import {
  activeLyricIndex,
  moveQueueItem,
  musicTime,
  parseMusicLyrics,
} from "../../lib/music-state.js";
import { useMusicRemote } from "./MusicProvider.js";
import { MusicDialog, MusicNameDialog } from "./MusicDialogs.js";
import { focusMusicReorderRow } from "./music-focus.js";

export function MusicCover({
  coverKey,
  className = "",
}: {
  coverKey: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [coverKey]);
  return (
    <span className={`music-cover ${className}`}>
      {coverKey && !failed ? (
        <img
          src={musicCoverUrl(coverKey)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <Disc3 aria-hidden="true" />
      )}
    </span>
  );
}

export function MusicPlayerDetails({
  onOpenBluetoothSettings,
}: {
  onOpenBluetoothSettings: () => void;
}) {
  const { t } = useTranslation();
  const playback = useOptionalPlayback();
  const remote = useMusicRemote();
  const { status, busy, execute, drawerOpen, setDrawerOpen, error } = remote;
  const [tab, setTab] = useState<"queue" | "lyrics">("queue");
  const [devices, setDevices] = useState<BluetoothAudioDevice[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [lyrics, setLyrics] = useState<MusicLyrics | null>(null);
  const [lyricsError, setLyricsError] = useState(false);
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [reorderFocus, setReorderFocus] = useState<{
    itemId: string;
    direction: -1 | 1;
  } | null>(null);
  const queueList = useRef<HTMLDivElement | null>(null);
  const activeLine = useRef<HTMLParagraphElement | null>(null);
  const current =
    status?.queue.find((item) => item.id === status.currentItemId) ?? null;
  const lines = useMemo(() => parseMusicLyrics(lyrics?.text ?? ""), [lyrics]);
  const activeIndex = activeLyricIndex(lines, status?.positionSeconds ?? 0);
  useEffect(() => {
    let active = true;
    void getBluetoothSettings()
      .then((result) => {
        if (active) {
          setDevices(result.audioDevices);
          setDeviceError(null);
        }
      })
      .catch((failure: unknown) => {
        if (active)
          setDeviceError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => {
      active = false;
    };
  }, [drawerOpen, status?.effectiveAudioDeviceId]);
  useEffect(() => {
    if (!drawerOpen || !current) {
      setLyrics(null);
      return;
    }
    const controller = new AbortController();
    setLyrics(null);
    setLyricsError(false);
    setCurrentTrack(null);
    setFavoriteError(null);
    void musicRequest<{ track: MusicTrack }>(
      `/tracks/${encodeURIComponent(current.trackId)}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setCurrentTrack(result.track);
      })
      .catch(() => {
        /* Library actions remain available if a record was removed. */
      });
    void musicRequest<MusicLyrics>(
      `/tracks/${encodeURIComponent(current.trackId)}/lyrics`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setLyrics(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLyricsError(true);
      });
    return () => controller.abort();
  }, [current?.trackId, drawerOpen]);
  useEffect(() => {
    activeLine.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);
  useEffect(() => {
    if (!reorderFocus || busy) return;
    if (drawerOpen && tab === "queue") {
      const row = Array.from(
        queueList.current?.querySelectorAll<HTMLElement>(
          "[data-music-item-id]",
        ) ?? [],
      ).find((item) => item.dataset.musicItemId === reorderFocus.itemId);
      focusMusicReorderRow(row, reorderFocus.direction);
    }
    setReorderFocus(null);
  }, [busy, drawerOpen, reorderFocus, tab]);
  if (!status || (status.queue.length === 0 && status.owner !== "music"))
    return null;
  const owned = status.owner === "music";
  const playing = owned && status.state === "playing";
  const requestedOutputName = status.audioDeviceId
    ? (devices.find((device) => device.id === status.audioDeviceId)?.name ??
      t("music.bluetoothOutput"))
    : t("music.defaultOutput");
  const outputUnavailable = Boolean(
    owned &&
      !status.effectiveAudioDeviceId &&
      (status.audioDeviceId || status.errorCode || status.error),
  );
  const outputName = status.effectiveAudioDeviceId
    ? (devices.find((device) => device.id === status.effectiveAudioDeviceId)
        ?.name ?? t("music.bluetoothOutput"))
    : outputUnavailable
      ? t("music.outputUnavailable")
      : t("music.defaultOutput");
  const toggle = () => void execute({ type: playing ? "pause" : "resume" });
  const reorder = async (item: MusicQueueEntry, direction: -1 | 1) => {
    await execute({
      type: "reorder",
      itemIds: moveQueueItem(
        status.queue.map((entry) => entry.id),
        item.id,
        direction,
      ),
    });
    setReorderFocus({ itemId: item.id, direction });
  };
  return (
    <>
      {drawerOpen ? (
        <MusicDialog
          title={t("music.nowPlaying")}
          onClose={() => setDrawerOpen(false)}
        >
          {playback ? <PlaybackTargetSelect onChange={() => setDrawerOpen(false)} /> : null}
          <div className="music-now-playing">
            <MusicCover coverKey={current?.coverKey ?? null} />
            <div>
              <h3>{current?.title ?? t("music.queue")}</h3>
              <p>{current?.artist}</p>
              <p>{current?.album}</p>
              <div className="music-detail-actions">
                <button
                  type="button"
                  disabled={busy || !currentTrack}
                  aria-pressed={currentTrack?.favorite ?? false}
                  onClick={() => {
                    if (!currentTrack) return;
                    void musicRequest("/favorites", "POST", {
                      kind: "track",
                      id: currentTrack.id,
                      favorite: !currentTrack.favorite,
                    })
                      .then(() =>
                        setCurrentTrack({
                          ...currentTrack,
                          favorite: !currentTrack.favorite,
                        }),
                      )
                      .catch((failure: unknown) =>
                        setFavoriteError(
                          failure instanceof Error
                            ? failure.message
                            : String(failure),
                        ),
                      );
                  }}
                  aria-label={t("music.favorite")}
                >
                  <Heart
                    size={17}
                    fill={currentTrack?.favorite ? "currentColor" : "none"}
                  />
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={status.shuffle}
                  onClick={() =>
                    void execute({
                      type: "mode",
                      repeat: status.repeat,
                      shuffle: !status.shuffle,
                    })
                  }
                  title={t("music.shuffle")}
                  aria-label={t("music.shuffle")}
                >
                  <Shuffle size={17} />
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t(`music.repeat.${status.repeat}`)}
                  onClick={() =>
                    void execute({
                      type: "mode",
                      shuffle: status.shuffle,
                      repeat:
                        status.repeat === "off"
                          ? "all"
                          : status.repeat === "all"
                            ? "one"
                            : "off",
                    })
                  }
                  aria-pressed={status.repeat !== "off"}
                >
                  {status.repeat === "one" ? (
                    <Repeat1 size={17} />
                  ) : (
                    <Repeat size={17} />
                  )}
                </button>
              </div>
            </div>
          </div>
          <div className="music-drawer-transport">
            <div className="music-transport">
              <button
                type="button"
                disabled={busy || !status.queue.length}
                onClick={() => void execute({ type: "previous" })}
                aria-label={t("music.previous")}
              >
                <SkipBack size={20} />
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !status.queue.length}
                onClick={toggle}
              >
                {playing ? <Pause size={20} /> : <Play size={20} />}
                {playing ? t("music.pause") : t("music.play")}
              </button>
              <button
                type="button"
                disabled={busy || !status.queue.length}
                onClick={() => void execute({ type: "next" })}
                aria-label={t("music.next")}
              >
                <SkipForward size={20} />
              </button>
            </div>
            <label className="music-progress">
              <span>{musicTime(status.positionSeconds)}</span>
              <PlaybackSlider
                max={Math.max(1, status.durationSeconds ?? 1)}
                value={Math.min(
                  status.positionSeconds,
                  status.durationSeconds ?? status.positionSeconds,
                )}
                disabled={busy || !owned || !status.durationSeconds}
                label={t("music.seek")}
                onCommit={(seconds) => void execute({ type: "seek", seconds })}
              />
              <span>{musicTime(status.durationSeconds)}</span>
            </label>
          </div>
          <div className="music-output-controls">
            <label>
              <Speaker size={16} aria-hidden="true" />
              <span>{t("music.output")}</span>
              <OutputDeviceSelect value={status.audioDeviceId} devices={devices} disabled={busy} defaultLabel={t("music.defaultOutput")} onChange={audioDeviceId => void execute({ type: "output", audioDeviceId })} />
            </label>
            <button
              type="button"
              onClick={() => {
                setDrawerOpen(false);
                onOpenBluetoothSettings();
              }}
            >
              <Bluetooth size={16} aria-hidden="true" />
              {t("music.bluetoothSettings")}
            </button>
            <label>
              <Volume2 size={16} aria-hidden="true" />
              <PlaybackSlider
                max={100}
                value={status.volume}
                disabled={busy}
                label={t("music.volume")}
                onCommit={(volume) => void execute({ type: "volume", volume })}
              />
              <span>{Math.round(status.volume)}</span>
            </label>
            {playback?.nas?.owner === "music" && playback.nas.sessionId ? <button disabled={busy} aria-pressed={playback.nas.preferences.musicMuted} onClick={() => void playback.control({ type: "set-muted", sessionId: playback.nas!.sessionId!, muted: !playback.nas!.preferences.musicMuted }).catch(error => setDeviceError(error instanceof Error ? error.message : String(error)))}>{t("playback.mute")}</button> : null}
          </div>
          {status.owner === "video" ? (
            <p className="music-inline-state">
              <MonitorPlay size={16} />
              {t("music.videoOwnsOutput")}
            </p>
          ) : (
            <p
              className="music-inline-state"
              role={outputUnavailable ? "status" : undefined}
            >
              {playing && !outputUnavailable ? (
                <Check size={15} />
              ) : (
                <Speaker size={15} />
              )}
              {outputUnavailable
                ? t("music.waitingForOutput", { output: requestedOutputName })
                : playing
                  ? t("music.actualOutput", { output: outputName })
                  : t("music.selectedOutput", { output: requestedOutputName })}
            </p>
          )}
          {error || status.error || deviceError || favoriteError ? (
            <p className="music-error" role="alert">
              {error ?? status.error ?? deviceError ?? favoriteError}
            </p>
          ) : null}
          <div
            className="music-tabs"
            role="group"
            aria-label={t("music.nowPlaying")}
          >
            <button
              type="button"
              aria-pressed={tab === "queue"}
              onClick={() => setTab("queue")}
            >
              {t("music.queue")} <span>{status.queue.length}</span>
            </button>
            <button
              type="button"
              aria-pressed={tab === "lyrics"}
              onClick={() => setTab("lyrics")}
            >
              {t("music.lyrics")}
            </button>
          </div>
          {tab === "queue" ? (
            <>
              <div className="music-queue-list" ref={queueList}>
                {status.queue.map((item, index) => (
                  <div
                    className={`music-queue-row${item.id === status.currentItemId ? " is-current" : ""}`}
                    key={item.id}
                    data-music-item-id={item.id}
                    draggable={!busy}
                    onDragStart={(event) =>
                      event.dataTransfer.setData(
                        "text/x-cyberos-music-queue",
                        item.id,
                      )
                    }
                    onDragOver={(event) => {
                      if (
                        event.dataTransfer.types.includes(
                          "text/x-cyberos-music-queue",
                        )
                      )
                        event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const id = event.dataTransfer.getData(
                        "text/x-cyberos-music-queue",
                      );
                      if (
                        !status.queue.some((entry) => entry.id === id) ||
                        id === item.id
                      )
                        return;
                      const ids = status.queue
                        .map((entry) => entry.id)
                        .filter((entry) => entry !== id);
                      ids.splice(index, 0, id);
                      void execute({ type: "reorder", itemIds: ids });
                    }}
                  >
                    <span className="music-row-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <button
                      type="button"
                      className="music-queue-title"
                      data-music-reorder-title=""
                      disabled={busy}
                      aria-current={
                        item.id === status.currentItemId ? "true" : undefined
                      }
                      onClick={() =>
                        void execute({ type: "jump", itemId: item.id })
                      }
                    >
                      <strong>{item.title}</strong>
                      <small>{item.artist}</small>
                    </button>
                    <button
                      type="button"
                      aria-label={t("music.moveUp")}
                      data-music-reorder="up"
                      disabled={busy || index === 0}
                      onClick={() => void reorder(item, -1)}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("music.moveDown")}
                      data-music-reorder="down"
                      disabled={busy || index === status.queue.length - 1}
                      onClick={() => void reorder(item, 1)}
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("music.remove")}
                      disabled={busy}
                      onClick={() =>
                        void execute({ type: "remove", itemId: item.id })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <footer>
                <button
                  type="button"
                  disabled={busy || !status.queue.length}
                  onClick={() => void execute({ type: "clear" })}
                >
                  {t("music.clearQueue")}
                </button>
                <button
                  type="button"
                  disabled={!status.queue.length}
                  onClick={() => setSaveOpen(true)}
                >
                  {t("music.saveQueue")}
                </button>
              </footer>
            </>
          ) : (
            <div className="music-lyrics" aria-label={t("music.lyrics")}>
              {lyricsError ? (
                <p role="alert">{t("music.lyricsFailed")}</p>
              ) : lines.length ? (
                lines.map((line, index) => (
                  <p
                    key={index}
                    ref={index === activeIndex ? activeLine : null}
                    className={index === activeIndex ? "is-current" : ""}
                    aria-current={index === activeIndex ? "true" : undefined}
                  >
                    {line.text || "\u00a0"}
                  </p>
                ))
              ) : (
                <p>{t("music.noLyrics")}</p>
              )}
            </div>
          )}
        </MusicDialog>
      ) : null}
      {saveOpen ? (
        <MusicNameDialog
          title={t("music.saveQueue")}
          onClose={() => setSaveOpen(false)}
          onSubmit={async (name) => {
            await musicRequest("/playlists", "POST", {
              name,
              trackIds: status.queue.map((entry) => entry.trackId),
            });
          }}
        />
      ) : null}
    </>
  );
}
