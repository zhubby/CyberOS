import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { MusicPlayerRequest, MusicPlayerStatus } from "@cyberos/shared";
import {
  getMusicPlayer,
  MusicApiError,
  sendMusicCommand,
} from "../../lib/music-api.js";
import { acceptMusicSnapshot } from "../../lib/music-state.js";
import { useModalDialog } from "../workspace/useModalDialog.js";

type WithoutVersion<T> = T extends { expectedQueueVersion: number }
  ? Omit<T, "expectedQueueVersion">
  : never;
export type MusicRemoteCommand = WithoutVersion<MusicPlayerRequest>;
interface MusicRemote {
  status: MusicPlayerStatus | null;
  busy: boolean;
  error: string | null;
  libraryVersion: number;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  execute: (command: MusicRemoteCommand) => Promise<void>;
  refresh: () => Promise<void>;
}
const MusicContext = createContext<MusicRemote | null>(null);

export function useMusicRemote(): MusicRemote {
  const value = useContext(MusicContext);
  if (!value) throw new Error("MusicProvider is required");
  return value;
}

export function MusicProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MusicPlayerStatus | null>(null);
  const statusRef = useRef(status);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [pending, setPending] = useState<{
    command: MusicRemoteCommand;
    status: MusicPlayerStatus;
  } | null>(null);
  const commit = useCallback((next: MusicPlayerStatus) => {
    const accepted = acceptMusicSnapshot(statusRef.current, next);
    statusRef.current = accepted;
    setStatus(accepted);
  }, []);
  const refresh = useCallback(async () => {
    try {
      commit(await getMusicPlayer());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [commit]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getMusicPlayer();
        if (active) {
          commit(next);
          setError(null);
        }
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      }
      if (active)
        timer = setTimeout(
          () => void poll(),
          statusRef.current?.state === "playing" ? 1_000 : 5_000,
        );
    };
    void poll();
    let libraryStamp = "";
    const events =
      typeof EventSource !== "undefined"
        ? new EventSource("/api/music/events")
        : null;
    events?.addEventListener("snapshot", (event) => {
      if (!active) return;
      try {
        const next = JSON.parse((event as MessageEvent<string>).data) as {
          player?: MusicPlayerStatus | null;
          status?: unknown;
        };
        if (next.player) {
          commit(next.player);
          setError(null);
        }
        const stamp = JSON.stringify(next.status ?? null);
        if (stamp !== libraryStamp) {
          libraryStamp = stamp;
          setLibraryVersion((current) => current + 1);
        }
      } catch {
        /* Polling recovers an interrupted event stream. */
      }
    });
    return () => {
      active = false;
      clearTimeout(timer);
      events?.close();
    };
  }, [commit]);

  const execute = useCallback(
    async (command: MusicRemoteCommand) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const current = statusRef.current ?? (await getMusicPlayer());
        commit(
          await sendMusicCommand({
            ...command,
            expectedQueueVersion: current.queueVersion,
          } as MusicPlayerRequest),
        );
      } catch (failure) {
        if (failure instanceof MusicApiError && failure.statusCode === 409) {
          try {
            const current = await getMusicPlayer();
            commit(current);
            if (
              current.owner === "video" &&
              ["replace", "resume", "jump"].includes(command.type)
            ) {
              setPending({ command, status: current });
              return;
            }
          } catch {
            /* Preserve the command error. */
          }
        }
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [commit],
  );
  const confirm = async () => {
    if (!pending || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      commit(
        await sendMusicCommand({
          ...pending.command,
          expectedQueueVersion: pending.status.queueVersion,
          ...(pending.status.sessionId
            ? { expectedSessionId: pending.status.sessionId }
            : {}),
        } as MusicPlayerRequest),
      );
      setPending(null);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPending(null);
      await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const value = useMemo(
    () => ({
      status,
      busy,
      error,
      libraryVersion,
      drawerOpen,
      setDrawerOpen,
      execute,
      refresh,
    }),
    [status, busy, error, libraryVersion, drawerOpen, execute, refresh],
  );
  return (
    <MusicContext.Provider value={value}>
      {children}
      {pending ? (
        <MusicTakeoverDialog
          title={t("music.takeoverTitle")}
          body={t("music.takeoverVideo")}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirm()}
        />
      ) : null}
    </MusicContext.Provider>
  );
}

export function MusicTakeoverDialog({
  title,
  body,
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const ref = useModalDialog(onCancel, busy);
  return (
    <div
      className="management-dialog-backdrop music-dialog-backdrop"
      role="presentation"
    >
      <section
        className="music-dialog"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="music-takeover-title"
      >
        <h2 id="music-takeover-title">{title}</h2>
        <p>{body}</p>
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>
            {t("common.actions.cancel")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {t("music.switchPlayback")}
          </button>
        </footer>
      </section>
    </div>
  );
}
