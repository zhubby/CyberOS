import { useTranslation } from "react-i18next";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import type {
  NasPlaybackStatus,
  StreamSession,
  StreamOptions,
  VodPlayerCommand,
} from "@cyberos/shared";
import {
  getPlayback,
  commandPlayback,
  closeStream,
  createStream,
  getStream,
  saveStreamProgress,
} from "../../lib/video-api.js";
import { acceptPlaybackRevision } from "../../lib/playback-state.js";

export interface BrowserPlayback {
  fileId: string;
  title: string;
  session: StreamSession;
  options: StreamOptions;
  position: number;
  playing: boolean;
  volume: number;
  muted: boolean;
}
interface PlaybackContextValue {
  nas: NasPlaybackStatus | null;
  error: string | null;
  browser: BrowserPlayback | null;
  target: "browser" | "nas";
  setTarget: (target: "browser" | "nas") => void;
  playerOpen: boolean;
  setPlayerOpen: (open: boolean) => void;
  fullscreen: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  refresh: () => Promise<void>;
  control: (command: VodPlayerCommand) => Promise<void>;
  playBrowser: (
    fileId: string,
    title: string,
    options?: StreamOptions,
  ) => Promise<void>;
  stopBrowser: () => void;
  toggleBrowser: () => Promise<void>;
  updateBrowser: (patch: Partial<BrowserPlayback>) => void;
}
const PlaybackContext = createContext<PlaybackContextValue | null>(null);
export const useOptionalPlayback = () => useContext(PlaybackContext);
export function usePlayback() {
  const value = useOptionalPlayback();
  if (!value) throw new Error("PlaybackProvider required");
  return value;
}
export function PlaybackProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const translate = useRef(t);
  translate.current = t;
  const [nas, setNas] = useState<NasPlaybackStatus | null>(null);
  const nasRef = useRef(nas);
  const [error, setError] = useState<string | null>(null);
  const [browser, setBrowser] = useState<BrowserPlayback | null>(null);
  const browserRef = useRef(browser);
  const [target, setTarget] = useState<"browser" | "nas">("nas");
  const [playerOpen, setPlayerOpenState] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const setPlayerOpen = useCallback((open: boolean) => {
    if (
      !open &&
      document.fullscreenElement?.classList.contains("browser-player-backdrop")
    )
      void document.exitFullscreen().catch(() => {});
    setPlayerOpenState(open);
  }, []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const requestId = useRef(0);
  const commit = useCallback((next: NasPlaybackStatus) => {
    const accepted = acceptPlaybackRevision(
      nasRef.current
        ? { ...nasRef.current, updatedAt: nasRef.current.music.updatedAt }
        : null,
      { ...next, updatedAt: next.music.updatedAt },
    );
    nasRef.current = accepted;
    setNas(accepted);
    setError(null);
  }, []);
  const refresh = useCallback(async () => {
    try {
      commit(await getPlayback());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [commit]);
  useEffect(() => {
    void refresh();
    let live = true;
    const events = new EventSource("/api/playback/events");
    events.addEventListener("snapshot", (e) => {
      if (live) {
        try {
          commit(
            JSON.parse((e as MessageEvent<string>).data) as NasPlaybackStatus,
          );
        } catch {
          void refresh();
        }
      }
    });
    events.addEventListener("unavailable", () => {
      if (live) setError(translate.current("playback.unavailable"));
    });
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => {
      live = false;
      events.close();
      window.clearInterval(timer);
    };
  }, [refresh, commit]);
  useEffect(() => {
    const sync = () =>
      setFullscreen(
        document.fullscreenElement?.classList.contains(
          "browser-player-backdrop",
        ) ?? false,
      );
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const updateBrowser = useCallback((patch: Partial<BrowserPlayback>) => {
    const current = browserRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    browserRef.current = next;
    setBrowser(next);
  }, []);
  const stopBrowser = useCallback(() => {
    requestId.current++;
    const current = browserRef.current;
    videoRef.current?.pause();
    if (current)
      void saveStreamProgress(current.session.id, current.position)
        .catch(() => {})
        .then(() => closeStream(current.session.id))
        .catch(() => {});
    browserRef.current = null;
    setBrowser(null);
    setPlayerOpen(false);
    setTarget("nas");
  }, [setPlayerOpen]);
  const playBrowser = useCallback(
    async (fileId: string, title: string, options: StreamOptions = {}) => {
      const sequence = ++requestId.current;
      const old = browserRef.current;
      if (old) {
        videoRef.current?.pause();
        await saveStreamProgress(old.session.id, old.position).catch(() => {});
        await closeStream(old.session.id).catch(() => {});
      }
      const codecs = [
        "h264",
        ...(document
          .createElement("video")
          .canPlayType('video/mp4; codecs="hvc1"')
          ? ["hevc"]
          : []),
      ];
      let session: StreamSession;
      try {
        session = await createStream(fileId, { ...options, codecs });
      } catch (failure) {
        if (sequence === requestId.current && old)
          updateBrowser({
            playing: false,
            session: {
              ...old.session,
              state: "error",
              error:
                failure instanceof Error ? failure.message : String(failure),
            },
          });
        throw failure;
      }
      if (sequence !== requestId.current) {
        void closeStream(session.id).catch(() => {});
        return;
      }
      const next: BrowserPlayback = {
        fileId,
        title,
        session,
        options,
        position: options.startPositionSeconds ?? 0,
        playing: false,
        volume: old?.volume ?? 1,
        muted: old?.muted ?? false,
      };
      browserRef.current = next;
      setBrowser(next);
      setTarget("browser");
      setPlayerOpen(true);
    },
    [updateBrowser, setPlayerOpen],
  );
  const toggleBrowser = useCallback(async () => {
    const current = browserRef.current;
    const video = videoRef.current;
    if (!current || !video || current.session.state !== "ready") return;
    if (!video.paused) {
      video.pause();
    } else if (current.session.mode === "direct") {
      await video.play();
    } else {
      // HLS evicts old segments while paused. Rebuild at the saved source
      // position so resuming cannot jump to the encoder's live edge.
      const wasOpen = playerOpen;
      await playBrowser(current.fileId, current.title, {
        ...current.options,
        startPositionSeconds: current.position,
      });
      if (!wasOpen) setPlayerOpen(false);
    }
  }, [playBrowser, playerOpen, setPlayerOpen]);
  useEffect(() => {
    const session = browser?.session;
    if (!session || session.state === "error") return;
    let live = true;
    let lastSaved = 0;
    let lastPosition = -1;
    let lastStatus = 0;
    const timer = window.setInterval(() => {
      const current = browserRef.current;
      if (!current || current.session.id !== session.id) return;
      if (
        Date.now() - lastSaved >= 10000 &&
        current.session.state === "ready" &&
        current.position !== lastPosition
      ) {
        lastSaved = Date.now();
        lastPosition = current.position;
        void saveStreamProgress(session.id, current.position).catch(() => {});
      }
      if (
        current.session.state !== "ready" ||
        Date.now() - lastStatus >= 15000
      ) {
        lastStatus = Date.now();
        void getStream(session.id)
          .then((next) => {
            if (live && browserRef.current?.session.id === next.id)
              updateBrowser({ session: next });
          })
          .catch((e) => {
            if (live)
              updateBrowser({
                playing: false,
                session: {
                  ...current.session,
                  state: "error",
                  error: e instanceof Error ? e.message : String(e),
                },
              });
          });
      }
    }, 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [browser?.session.id, browser?.session.state, updateBrowser]);
  useEffect(() => {
    const flush = () => {
      const current = browserRef.current;
      if (current)
        navigator.sendBeacon(
          `/api/media/playback-sessions/${encodeURIComponent(current.session.id)}/progress`,
          new Blob([JSON.stringify({ positionSeconds: current.position })], {
            type: "application/json",
          }),
        );
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);
  useEffect(
    () => () => {
      requestId.current++;
      const current = browserRef.current;
      if (current)
        void saveStreamProgress(current.session.id, current.position)
          .catch(() => {})
          .then(() => closeStream(current.session.id))
          .catch(() => {});
    },
    [],
  );
  const control = useCallback(
    async (command: VodPlayerCommand) => {
      const current = nasRef.current;
      if (!current) return;
      try {
        commit(
          await commandPlayback({
            type: "guarded",
            serviceInstanceId: current.serviceInstanceId,
            expectedSessionId: current.sessionId,
            command,
          }),
        );
      } catch (e) {
        await refresh();
        throw e;
      }
    },
    [commit, refresh],
  );
  const value = useMemo(
    () => ({
      nas,
      error,
      browser,
      target,
      setTarget,
      playerOpen,
      setPlayerOpen,
      fullscreen,
      videoRef,
      refresh,
      control,
      playBrowser,
      stopBrowser,
      toggleBrowser,
      updateBrowser,
    }),
    [
      nas,
      error,
      browser,
      target,
      playerOpen,
      fullscreen,
      setPlayerOpen,
      refresh,
      control,
      playBrowser,
      stopBrowser,
      toggleBrowser,
      updateBrowser,
    ],
  );
  return (
    <PlaybackContext.Provider value={value}>
      {children}
    </PlaybackContext.Provider>
  );
}
