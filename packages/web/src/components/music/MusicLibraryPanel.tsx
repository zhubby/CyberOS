import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Disc3,
  FolderPlus,
  Heart,
  ListMusic,
  LoaderCircle,
  Music2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shuffle,
  SkipForward,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  MusicAlbum,
  MusicArtist,
  MusicHome,
  MusicLibraryStatus,
  MusicPage,
  MusicPlaylist,
  MusicPlaylistTrack,
  MusicQuery,
  MusicSource,
  MusicTrack,
} from "@cyberos/shared";
import type { SupportedLocale } from "../../i18n/locale.js";
import { musicRequest } from "../../lib/music-api.js";
import { musicTime } from "../../lib/music-state.js";
import {
  PanelHeader,
  PanelHeaderAction,
  PanelHeaderActions,
} from "../workspace/PanelHeader.js";
import {
  StorageFilePickerDialog,
  type StorageFilePickerPool,
} from "../workspace/StorageFilePickerDialog.js";
import { Switch } from "../common/Switch.js";
import { MusicCover } from "./MusicPlayer.js";
import { MusicDialog, MusicNameDialog } from "./MusicDialogs.js";
import { useMusicRemote } from "./MusicProvider.js";
import { focusMusicReorderRow } from "./music-focus.js";

type View = "home" | "albums" | "artists" | "tracks" | "playlists" | "search";
type Detail = {
  kind: "album" | "artist" | "playlist";
  id: string;
  title: string;
};
interface Content {
  albums: MusicAlbum[];
  artists: MusicArtist[];
  tracks: MusicTrack[];
  playlists: MusicPlaylist[];
  home: MusicHome | null;
  nextCursor: string | null;
  albumsNextCursor: string | null;
  tracksNextCursor: string | null;
  artistsNextCursor: string | null;
}
const EMPTY: Content = {
  albums: [],
  artists: [],
  tracks: [],
  playlists: [],
  home: null,
  nextCursor: null,
  albumsNextCursor: null,
  tracksNextCursor: null,
  artistsNextCursor: null,
};

export function MusicLibraryPanel({
  pools,
  locale,
}: {
  pools: StorageFilePickerPool[];
  locale: SupportedLocale;
}) {
  const { t } = useTranslation();
  const remote = useMusicRemote();
  const [view, setView] = useState<View>("home");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({
    sourceId: "",
    year: "",
    genre: "",
    favorite: false,
    sort: "added" as NonNullable<MusicQuery["sort"]>,
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState(filters);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{
    kind: "playlist" | "source";
    id: string;
  } | null>(null);
  const [sources, setSources] = useState<MusicSource[]>([]);
  const [library, setLibrary] = useState<MusicLibraryStatus | null>(null);
  const [content, setContent] = useState<Content>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [nameDialog, setNameDialog] = useState<"create" | "rename" | null>(
    null,
  );
  const [addTrack, setAddTrack] = useState<MusicTrack | null>(null);
  const [playlistChoices, setPlaylistChoices] = useState<MusicPlaylist[]>([]);
  const [playlistChoicesCursor, setPlaylistChoicesCursor] = useState<
    string | null
  >(null);
  const [playlistChoicesLoading, setPlaylistChoicesLoading] = useState(false);
  const [playlistChoicesError, setPlaylistChoicesError] = useState<
    string | null
  >(null);
  const [focusPlaylistChoiceSelect, setFocusPlaylistChoiceSelect] =
    useState(false);
  const [targetPlaylistId, setTargetPlaylistId] = useState("");
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [reorderFocus, setReorderFocus] = useState<{
    playlistId: string;
    itemId: string;
    trackId: string;
    index: number;
    direction: -1 | 1;
  } | null>(null);
  const requestId = useRef(0);
  const menuRoot = useRef<HTMLDivElement | null>(null);
  const rowActionButtons = useRef(new Map<string, HTMLButtonElement>());
  const trackListRoot = useRef<HTMLDivElement | null>(null);
  const playlistChoicesRequestId = useRef(0);
  const playlistChoicesController = useRef<AbortController | null>(null);
  const playlistChoicesSession = useRef(0);
  const playlistChoiceSelect = useRef<HTMLSelectElement | null>(null);
  const playlistChoicesMore = useRef<HTMLButtonElement | null>(null);
  const playlistChoicesCreate = useRef<HTMLButtonElement | null>(null);
  const reload = () => setRefreshVersion((current) => current + 1);
  const queryParams = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams({ limit: "50", sort: filters.sort });
      if (search.trim()) params.set("query", search.trim());
      if (filters.sourceId) params.set("sourceId", filters.sourceId);
      if (filters.year) params.set("year", filters.year);
      if (filters.genre.trim()) params.set("genre", filters.genre.trim());
      if (filters.favorite) params.set("favorite", "true");
      if (cursor) params.set("cursor", cursor);
      return params.toString();
    },
    [filters, search],
  );
  const load = useCallback(
    async (cursor?: string) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      if (!cursor) setContent(EMPTY);
      const suffix = `?${queryParams(cursor)}`;
      try {
        let next = EMPTY;
        if (detail?.kind === "album") {
          const result = await musicRequest<{
            album: MusicAlbum;
            tracks: MusicTrack[];
          }>(`/albums/${encodeURIComponent(detail.id)}`);
          next = { ...EMPTY, tracks: result.tracks, albums: [result.album] };
        } else if (detail?.kind === "artist") {
          const result = await musicRequest<{
            artist: MusicArtist;
            albums: MusicAlbum[];
            tracks: MusicTrack[];
            albumsNextCursor: string | null;
            tracksNextCursor: string | null;
          }>(`/artists/${encodeURIComponent(detail.id)}`);
          next = {
            ...EMPTY,
            artists: [result.artist],
            albums: result.albums,
            tracks: result.tracks,
            albumsNextCursor: result.albumsNextCursor,
            tracksNextCursor: result.tracksNextCursor,
          };
        } else if (detail?.kind === "playlist") {
          const result = await musicRequest<{
            playlist: MusicPlaylist;
            tracks: MusicPlaylistTrack[];
          }>(`/playlists/${encodeURIComponent(detail.id)}`);
          next = {
            ...EMPTY,
            tracks: result.tracks,
            playlists: [result.playlist],
          };
        } else if (view === "home") {
          next = { ...EMPTY, home: await musicRequest<MusicHome>("/home") };
        } else if (view === "search") {
          const [albums, artists, tracks] = await Promise.all([
            musicRequest<MusicPage<MusicAlbum>>(`/albums${suffix}`),
            musicRequest<MusicPage<MusicArtist>>(`/artists${suffix}`),
            musicRequest<MusicPage<MusicTrack>>(`/tracks${suffix}`),
          ]);
          next = {
            ...EMPTY,
            albums: albums.items,
            artists: artists.items,
            tracks: tracks.items,
            albumsNextCursor: albums.nextCursor,
            artistsNextCursor: artists.nextCursor,
            tracksNextCursor: tracks.nextCursor,
          };
        } else if (view === "albums") {
          const page = await musicRequest<MusicPage<MusicAlbum>>(
            `/albums${suffix}`,
          );
          next = { ...EMPTY, albums: page.items, nextCursor: page.nextCursor };
        } else if (view === "artists") {
          const page = await musicRequest<MusicPage<MusicArtist>>(
            `/artists${suffix}`,
          );
          next = { ...EMPTY, artists: page.items, nextCursor: page.nextCursor };
        } else if (view === "tracks") {
          const page = await musicRequest<MusicPage<MusicTrack>>(
            `/tracks${suffix}`,
          );
          next = { ...EMPTY, tracks: page.items, nextCursor: page.nextCursor };
        } else {
          const page = await musicRequest<MusicPage<MusicPlaylist>>(
            `/playlists${suffix}`,
          );
          next = {
            ...EMPTY,
            playlists: page.items,
            nextCursor: page.nextCursor,
          };
        }
        if (id === requestId.current)
          setContent((current) =>
            cursor
              ? {
                  ...next,
                  albums: [...current.albums, ...next.albums],
                  artists: [...current.artists, ...next.artists],
                  tracks: [...current.tracks, ...next.tracks],
                  playlists: [...current.playlists, ...next.playlists],
                }
              : next,
          );
      } catch (failure) {
        if (id === requestId.current) {
          if (
            cursor &&
            failure instanceof Error &&
            failure.message.includes("Invalid music cursor")
          ) {
            setRefreshVersion((current) => current + 1);
          } else
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
        }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [detail, queryParams, view],
  );
  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load, refreshVersion, remote.libraryVersion]);
  useEffect(() => {
    if (!reorderFocus || loading || busy) return;
    if (detail?.kind === "playlist" && detail.id === reorderFocus.playlistId) {
      const rows = Array.from(
        trackListRoot.current?.querySelectorAll<HTMLElement>(
          "[data-music-item-id]",
        ) ?? [],
      );
      const original = rows.find(
        (row) => row.dataset.musicItemId === reorderFocus.itemId,
      );
      // Playlist replacement regenerates entry IDs. The target position keeps
      // the selected occurrence identifiable even when a song appears twice.
      const moved = rows[reorderFocus.index];
      focusMusicReorderRow(
        original ??
          (moved?.dataset.musicTrackId === reorderFocus.trackId
            ? moved
            : undefined),
        reorderFocus.direction,
      );
    }
    setReorderFocus(null);
  }, [busy, detail, loading, reorderFocus]);
  useEffect(() => {
    if (playlistChoicesLoading || !focusPlaylistChoiceSelect) return;
    setFocusPlaylistChoiceSelect(false);
    if (playlistChoiceSelect.current && !playlistChoiceSelect.current.disabled)
      playlistChoiceSelect.current.focus();
    else playlistChoicesCreate.current?.focus();
  }, [focusPlaylistChoiceSelect, playlistChoicesLoading]);
  useEffect(
    () => () => {
      playlistChoicesRequestId.current += 1;
      playlistChoicesController.current?.abort();
    },
    [],
  );
  useEffect(() => {
    let active = true;
    void Promise.all([
      musicRequest<{ sources: MusicSource[] }>("/sources"),
      musicRequest<{ status: MusicLibraryStatus }>("/status"),
    ])
      .then(([result, state]) => {
        if (active) {
          setSources(result.sources);
          setLibrary(state.status);
        }
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => {
      active = false;
    };
  }, [refreshVersion, remote.libraryVersion]);
  useEffect(() => {
    if (!rowMenu) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (
        event instanceof MouseEvent &&
        menuRoot.current?.contains(event.target as Node)
      )
        return;
      setRowMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [rowMenu]);
  const loadCollectionMore = async (kind: "albums" | "tracks" | "artists") => {
    if (loading) return;
    const cursor =
      kind === "albums"
        ? content.albumsNextCursor
        : kind === "artists"
          ? content.artistsNextCursor
          : content.tracksNextCursor;
    if (!cursor || (view !== "search" && detail?.kind !== "artist")) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    const params =
      detail?.kind === "artist"
        ? new URLSearchParams({
            artistId: detail.id,
            limit: "100",
            cursor,
          }).toString()
        : queryParams(cursor);
    try {
      if (kind === "albums") {
        const page = await musicRequest<MusicPage<MusicAlbum>>(
          `/albums?${params}`,
        );
        if (id === requestId.current)
          setContent((current) => ({
            ...current,
            albums: [...current.albums, ...page.items],
            albumsNextCursor: page.nextCursor,
          }));
      } else if (kind === "artists") {
        const page = await musicRequest<MusicPage<MusicArtist>>(
          `/artists?${params}`,
        );
        if (id === requestId.current)
          setContent((current) => ({
            ...current,
            artists: [...current.artists, ...page.items],
            artistsNextCursor: page.nextCursor,
          }));
      } else {
        const page = await musicRequest<MusicPage<MusicTrack>>(
          `/tracks?${params}`,
        );
        if (id === requestId.current)
          setContent((current) => ({
            ...current,
            tracks: [...current.tracks, ...page.items],
            tracksNextCursor: page.nextCursor,
          }));
      }
    } catch (failure) {
      if (id !== requestId.current) return;
      if (
        failure instanceof Error &&
        failure.message.includes("Invalid music cursor")
      )
        reload();
      else
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };
  const action = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const favorite = (
    kind: "track" | "album" | "artist",
    item: { id: string; favorite: boolean },
  ) =>
    void action(() =>
      musicRequest("/favorites", "POST", {
        kind,
        id: item.id,
        favorite: !item.favorite,
      }),
    );
  const play = (
    tracks: MusicTrack[],
    type: "replace" | "append" | "insert-next" = "replace",
  ) => {
    if (loading) return;
    const ids = tracks
      .filter((track) => !track.missing)
      .map((track) => track.id);
    if (ids.length) void remote.execute({ type, trackIds: ids });
  };
  const openDetail = (kind: Detail["kind"], id: string, title: string) => {
    setLoading(true);
    setContent(EMPTY);
    setDetail({ kind, id, title });
    setRowMenu(null);
  };
  const loadPlaylistChoices = async (cursor?: string) => {
    playlistChoicesController.current?.abort();
    const controller = new AbortController();
    playlistChoicesController.current = controller;
    const id = ++playlistChoicesRequestId.current;
    setPlaylistChoicesLoading(true);
    setPlaylistChoicesError(null);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const page = await musicRequest<MusicPage<MusicPlaylist>>(
        `/playlists?${params.toString()}`,
        "GET",
        undefined,
        controller.signal,
      );
      if (id !== playlistChoicesRequestId.current || controller.signal.aborted)
        return;
      if (
        !page.nextCursor &&
        document.activeElement === playlistChoicesMore.current
      )
        setFocusPlaylistChoiceSelect(true);
      setPlaylistChoices((current) => {
        const preceding = cursor ? current : [];
        const existing = new Set(preceding.map((playlist) => playlist.id));
        return [
          ...preceding,
          ...page.items.filter((playlist) => !existing.has(playlist.id)),
        ];
      });
      setPlaylistChoicesCursor(page.nextCursor);
      if (!cursor)
        setTargetPlaylistId((current) =>
          page.items.some((playlist) => playlist.id === current)
            ? current
            : (page.items[0]?.id ?? ""),
        );
    } catch (failure) {
      if (id !== playlistChoicesRequestId.current || controller.signal.aborted)
        return;
      if (
        cursor &&
        failure instanceof Error &&
        failure.message.includes("Invalid music cursor")
      ) {
        // A changed catalogue invalidates continuation tokens. Refresh this
        // selector independently of the library view and any newer dialog.
        void loadPlaylistChoices();
      } else
        setPlaylistChoicesError(
          failure instanceof Error ? failure.message : String(failure),
        );
    } finally {
      if (id === playlistChoicesRequestId.current)
        setPlaylistChoicesLoading(false);
    }
  };
  const closeAdd = () => {
    playlistChoicesSession.current += 1;
    playlistChoicesRequestId.current += 1;
    playlistChoicesController.current?.abort();
    setFocusPlaylistChoiceSelect(false);
    setPlaylistChoicesLoading(false);
    setAddTrack(null);
  };
  const openAdd = (track: MusicTrack, rowKey: string) => {
    // The menu item unmounts when the dialog opens. Transfer its focus to the
    // stable row trigger so useModalDialog can restore that opener on close.
    rowActionButtons.current.get(rowKey)?.focus();
    playlistChoicesSession.current += 1;
    setFocusPlaylistChoiceSelect(false);
    setRowMenu(null);
    setPlaylistChoices([]);
    setPlaylistChoicesCursor(null);
    setTargetPlaylistId("");
    setAddTrack(track);
    void loadPlaylistChoices();
  };
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setContent(EMPTY);
    setSearch(query);
    setDetail(null);
    setView(query.trim() ? "search" : "tracks");
    reload();
  };
  const playlistReorder = (index: number, delta: -1 | 1) => {
    if (detail?.kind !== "playlist") return;
    const reordered = [...content.tracks];
    const [item] = reordered.splice(index, 1);
    if (!item) return;
    reordered.splice(index + delta, 0, item);
    let targetIndex = index;
    void action(async () => {
      await musicRequest(
        `/playlists/${encodeURIComponent(detail.id)}`,
        "PATCH",
        { trackIds: reordered.map((track) => track.id) },
      );
      targetIndex = index + delta;
      // Keep focus pending until the refreshed entry IDs are rendered.
      setLoading(true);
      setContent(EMPTY);
    }).finally(() =>
      setReorderFocus({
        playlistId: detail.id,
        itemId: (item as Partial<MusicPlaylistTrack>).playlistItemId ?? item.id,
        trackId: item.id,
        index: targetIndex,
        direction: delta,
      }),
    );
  };
  const albumGrid = (albums: MusicAlbum[]) => (
    <div className="music-album-grid">
      {albums.map((album) => (
        <article className="music-album" key={album.id}>
          <button
            type="button"
            className="music-album-open"
            onClick={() => openDetail("album", album.id, album.title)}
          >
            <MusicCover coverKey={album.coverKey} />
            <strong title={album.title}>{album.title}</strong>
            <small title={album.artists.join(" · ")}>
              {album.artists.join(" · ") || t("music.unknownArtist")}
            </small>
          </button>
          <div className="music-album-meta">
            <span>{album.year ?? "—"}</span>
            <button
              type="button"
              aria-label={t("music.favorite")}
              aria-pressed={album.favorite}
              disabled={busy}
              onClick={() => favorite("album", album)}
            >
              <Heart
                size={14}
                fill={album.favorite ? "currentColor" : "none"}
              />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
  const artistGrid = (artists: MusicArtist[]) => (
    <div className="music-artist-list">
      {artists.map((artist) => (
        <div className="music-artist" key={artist.id}>
          <button
            type="button"
            onClick={() => openDetail("artist", artist.id, artist.name)}
          >
            <MusicCover coverKey={artist.coverKey} />
            <span>
              <strong>{artist.name}</strong>
              <small>
                {t("music.artistCounts", {
                  albums: artist.albumCount,
                  tracks: artist.trackCount,
                })}
              </small>
            </span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => favorite("artist", artist)}
            aria-label={t("music.favorite")}
            aria-pressed={artist.favorite}
          >
            <Heart size={16} fill={artist.favorite ? "currentColor" : "none"} />
          </button>
        </div>
      ))}
    </div>
  );
  const trackList = (tracks: MusicTrack[], scope: string) => (
    <div
      className="music-track-list"
      data-music-list-scope={scope}
      ref={detail?.kind === "playlist" ? trackListRoot : null}
    >
      {tracks.map((track, index) => {
        const itemId =
          (track as Partial<MusicPlaylistTrack>).playlistItemId ?? track.id;
        const rowKey = JSON.stringify([scope, itemId]);
        return (
          <div
            key={rowKey}
            className={`music-track${track.missing ? " is-missing" : ""}`}
            data-music-item-id={itemId}
            data-music-track-id={track.id}
          >
            <button
              type="button"
              className="music-track-play"
              disabled={track.missing || remote.busy || loading}
              aria-label={t("music.playTrack", { title: track.title })}
              onClick={() => play(tracks.slice(index))}
            >
              <Play size={15} />
            </button>
            <div
              className="music-track-copy"
              tabIndex={detail?.kind === "playlist" ? -1 : undefined}
              data-music-reorder-title=""
            >
              <strong title={track.title}>{track.title}</strong>
              <span>
                {track.artists.join(" · ") || t("music.unknownArtist")}
                {track.missing ? ` · ${t("music.missing")}` : ""}
              </span>
            </div>
            <button
              type="button"
              className="music-track-album"
              title={track.album}
              onClick={() => openDetail("album", track.albumId, track.album)}
            >
              {track.album}
            </button>
            <span className="music-track-duration">
              {musicTime(track.durationSeconds)}
            </span>
            <button
              type="button"
              disabled={busy}
              className="music-track-favorite"
              aria-label={t("music.favorite")}
              aria-pressed={track.favorite}
              onClick={() => favorite("track", track)}
            >
              <Heart
                size={15}
                fill={track.favorite ? "currentColor" : "none"}
              />
            </button>
            {detail?.kind === "playlist" ? (
              <>
                <button
                  type="button"
                  disabled={loading || busy || index === 0}
                  onClick={() => playlistReorder(index, -1)}
                  className="music-track-reorder"
                  aria-label={t("music.moveUp")}
                  data-music-reorder="up"
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  disabled={loading || busy || index === tracks.length - 1}
                  onClick={() => playlistReorder(index, 1)}
                  className="music-track-reorder"
                  aria-label={t("music.moveDown")}
                  data-music-reorder="down"
                >
                  <ArrowDown size={14} />
                </button>
              </>
            ) : null}
            <div
              className="music-row-menu"
              ref={rowMenu === rowKey ? menuRoot : null}
            >
              <button
                ref={(button) => {
                  if (button) rowActionButtons.current.set(rowKey, button);
                  else rowActionButtons.current.delete(rowKey);
                }}
                type="button"
                aria-label={t("music.trackActions")}
                aria-expanded={rowMenu === rowKey}
                onClick={() => setRowMenu(rowMenu === rowKey ? null : rowKey)}
              >
                <Plus size={17} />
              </button>
              {rowMenu === rowKey ? (
                <div className="music-track-actions">
                  <button
                    type="button"
                    disabled={track.missing || remote.busy || loading}
                    onClick={() => {
                      play([track], "insert-next");
                      setRowMenu(null);
                    }}
                  >
                    <SkipForward size={14} />
                    {t("music.playNext")}
                  </button>
                  <button
                    type="button"
                    disabled={track.missing || remote.busy || loading}
                    onClick={() => {
                      play([track], "append");
                      setRowMenu(null);
                    }}
                  >
                    <ListMusic size={14} />
                    {t("music.append")}
                  </button>
                  <button type="button" onClick={() => openAdd(track, rowKey)}>
                    <Plus size={14} />
                    {t("music.addToPlaylist")}
                  </button>
                  {detail?.kind === "playlist" ? (
                    <button
                      type="button"
                      onClick={() => {
                        const id = detail.id;
                        setRowMenu(null);
                        void action(() =>
                          musicRequest(
                            `/playlists/${encodeURIComponent(id)}`,
                            "PATCH",
                            {
                              trackIds: tracks
                                .filter((_entry, at) => at !== index)
                                .map((entry) => entry.id),
                            },
                          ),
                        );
                      }}
                    >
                      <Trash2 size={14} />
                      {t("music.remove")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
  const empty =
    !content.home &&
    !content.albums.length &&
    !content.artists.length &&
    !content.tracks.length &&
    !content.playlists.length;
  return (
    <section className="music-panel">
      <PanelHeader
        icon={<Music2 size={21} />}
        title="Music"
        subtitle={t("music.subtitle")}
        actions={
          <PanelHeaderActions label={t("music.libraryActions")}>
            <PanelHeaderAction
              label={t("common.actions.refresh")}
              disabled={loading}
              onClick={() => {
                reload();
                void remote.refresh();
              }}
            >
              <RefreshCw size={17} />
            </PanelHeaderAction>
            <PanelHeaderAction
              label={t("music.sources")}
              onClick={() => setSourcesOpen(true)}
            >
              <Settings2 size={17} />
            </PanelHeaderAction>
          </PanelHeaderActions>
        }
      />
      <form className="music-search" onSubmit={submitSearch}>
        <Search size={17} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("music.searchPlaceholder")}
          aria-label={t("music.searchPlaceholder")}
        />
        <button type="submit" aria-label={t("music.search")}>
          <ArrowUp className="music-search-submit" size={17} />
        </button>
        <button
          type="button"
          aria-label={t("music.filters")}
          aria-pressed={filtersOpen}
          onClick={() => {
            setDraftFilters(filters);
            setFiltersOpen(true);
          }}
        >
          <SlidersHorizontal size={17} />
        </button>
      </form>
      <nav className="music-tabs" aria-label={t("music.navigation")}>
        {(["home", "albums", "artists", "tracks", "playlists"] as const).map(
          (tab) => (
            <button
              key={tab}
              type="button"
              aria-current={view === tab && !detail ? "page" : undefined}
              className={view === tab && !detail ? "is-active" : ""}
              onClick={() => {
                setLoading(true);
                setContent(EMPTY);
                setDetail(null);
                setView(tab);
                setSearch("");
                setQuery("");
                reload();
              }}
            >
              {t(`music.views.${tab}`)}
            </button>
          ),
        )}
      </nav>
      <div className="music-content" aria-busy={loading}>
        {error ? (
          <div className="music-error" role="alert">
            {error}
            <button type="button" onClick={reload}>
              {t("common.actions.refresh")}
            </button>
          </div>
        ) : null}
        {remote.error ? (
          <div className="music-inline-state" role="status">
            <SpeakerIcon />
            {t("music.playerUnavailable")}
          </div>
        ) : null}
        {library?.scans.some((scan) => scan.status === "failed") ? (
          <button
            className="music-scan-warning"
            type="button"
            onClick={() => setSourcesOpen(true)}
          >
            {t("music.scanNeedsAttention")}
          </button>
        ) : null}
        {detail ? (
          <>
            <button
              className="music-back"
              type="button"
              onClick={() => {
                setLoading(true);
                setContent(EMPTY);
                setDetail(null);
              }}
            >
              <ArrowLeft size={16} />
              {t("music.back")}
            </button>
            <header className="music-detail-header">
              <MusicCover
                coverKey={
                  content.albums[0]?.coverKey ??
                  content.artists[0]?.coverKey ??
                  null
                }
              />
              <div>
                <small>{t(`music.kind.${detail.kind}`)}</small>
                <h3>{detail.title}</h3>
                <p>
                  {detail.kind === "album"
                    ? content.albums[0]?.artists.join(" · ")
                    : t("music.trackCount", { count: content.tracks.length })}
                </p>
                <div className="music-detail-actions">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={loading || remote.busy || !content.tracks.length}
                    onClick={() => play(content.tracks)}
                  >
                    <Play size={15} />
                    {t("music.play")}
                  </button>
                  <button
                    type="button"
                    disabled={loading || remote.busy || !content.tracks.length}
                    onClick={() =>
                      void (async () => {
                        await remote.execute({
                          type: "mode",
                          shuffle: true,
                          repeat: remote.status?.repeat ?? "off",
                        });
                        await remote.execute({
                          type: "replace",
                          trackIds: content.tracks
                            .filter((track) => !track.missing)
                            .map((track) => track.id),
                        });
                      })()
                    }
                  >
                    <Shuffle size={15} />
                    {t("music.shuffle")}
                  </button>
                  <button
                    type="button"
                    disabled={loading || remote.busy || !content.tracks.length}
                    onClick={() => play(content.tracks, "append")}
                  >
                    <Plus size={15} />
                    {t("music.append")}
                  </button>
                  {detail.kind === "playlist" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setNameDialog("rename")}
                      >
                        {t("music.rename")}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmDelete({ kind: "playlist", id: detail.id })
                        }
                      >
                        <Trash2 size={15} />
                        {t("common.actions.delete")}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </header>
            {detail.kind === "artist" ? (
              <>
                {albumGrid(content.albums)}
                {content.albumsNextCursor ? (
                  <button
                    type="button"
                    className="music-load-more"
                    disabled={loading}
                    onClick={() => void loadCollectionMore("albums")}
                  >
                    {t("music.loadMoreAlbums")}
                  </button>
                ) : null}
              </>
            ) : null}
            {detail.kind === "album" &&
            new Set(content.tracks.map((track) => track.discNumber ?? 1)).size >
              1
              ? [
                  ...new Set(
                    content.tracks.map((track) => track.discNumber ?? 1),
                  ),
                ]
                  .sort((a, b) => a - b)
                  .map((disc) => (
                    <section key={disc}>
                      <h4 className="music-section-title">
                        {t("music.disc", { number: disc })}
                      </h4>
                      {trackList(
                        content.tracks.filter(
                          (track) => (track.discNumber ?? 1) === disc,
                        ),
                        `album:${detail.id}:disc:${disc}`,
                      )}
                    </section>
                  ))
              : trackList(content.tracks, `${detail.kind}:${detail.id}`)}
            {detail.kind === "artist" && content.tracksNextCursor ? (
              <button
                type="button"
                className="music-load-more"
                disabled={loading}
                onClick={() => void loadCollectionMore("tracks")}
              >
                {t("music.loadMoreTracks")}
              </button>
            ) : null}
          </>
        ) : null}
        {!detail && view === "home" && content.home ? (
          <>
            <MusicSection title={t("music.recentlyAdded")}>
              {albumGrid(content.home.recentlyAdded)}
            </MusicSection>
            <MusicSection title={t("music.recentlyPlayed")}>
              {trackList(content.home.recentlyPlayed, "home:recently-played")}
            </MusicSection>
            <MusicSection title={t("music.mostPlayed")}>
              {trackList(content.home.mostPlayed, "home:most-played")}
            </MusicSection>
            <MusicSection
              title={t("music.favorites")}
              action={
                <button
                  type="button"
                  onClick={() => {
                    setView("tracks");
                    setFilters((current) => ({ ...current, favorite: true }));
                  }}
                >
                  {t("music.showAll")}
                </button>
              }
            >
              {trackList(content.home.favorites, "home:favorites")}
            </MusicSection>
          </>
        ) : null}
        {!detail && (view === "albums" || view === "search") ? (
          <MusicSection
            title={view === "search" ? t("music.views.albums") : ""}
            action={
              view === "search" && content.albumsNextCursor ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void loadCollectionMore("albums")}
                >
                  {t("music.loadMoreAlbums")}
                </button>
              ) : null
            }
          >
            {albumGrid(content.albums)}
          </MusicSection>
        ) : null}
        {!detail && (view === "artists" || view === "search") ? (
          <MusicSection
            title={view === "search" ? t("music.views.artists") : ""}
            action={
              view === "search" && content.artistsNextCursor ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void loadCollectionMore("artists")}
                >
                  {t("music.loadMoreArtists")}
                </button>
              ) : null
            }
          >
            {artistGrid(content.artists)}
          </MusicSection>
        ) : null}
        {!detail && (view === "tracks" || view === "search") ? (
          <MusicSection
            title={view === "search" ? t("music.views.tracks") : ""}
            action={
              view === "search" && content.tracksNextCursor ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void loadCollectionMore("tracks")}
                >
                  {t("music.loadMoreTracks")}
                </button>
              ) : null
            }
          >
            {trackList(content.tracks, `view:${view}`)}
          </MusicSection>
        ) : null}
        {!detail && view === "playlists" ? (
          <>
            <div className="music-section-heading">
              <h3>{t("music.views.playlists")}</h3>
              <button type="button" onClick={() => setNameDialog("create")}>
                <Plus size={16} />
                {t("music.newPlaylist")}
              </button>
            </div>
            <div className="music-playlist-list">
              {content.playlists.map((playlist) => (
                <button
                  type="button"
                  key={playlist.id}
                  onClick={() =>
                    openDetail("playlist", playlist.id, playlist.name)
                  }
                >
                  <ListMusic size={22} />
                  <span>
                    <strong>{playlist.name}</strong>
                    <small>
                      {t("music.trackCount", { count: playlist.trackCount })} ·{" "}
                      {musicTime(playlist.durationSeconds)}
                    </small>
                  </span>
                  <Play size={15} />
                </button>
              ))}
            </div>
          </>
        ) : null}
        {!loading && sources.length === 0 ? (
          <div className="music-empty">
            <Disc3 size={42} aria-hidden="true" />
            <h3>{t("music.emptyTitle")}</h3>
            <p>{t("music.emptyBody")}</p>
            <button
              className="primary-button"
              type="button"
              onClick={() => setPickerOpen(true)}
              disabled={!pools.length}
            >
              <FolderPlus size={16} />
              {t("music.addSource")}
            </button>
          </div>
        ) : !loading &&
          (empty ||
            (content.home !== null &&
              !content.home.recentlyAdded.length &&
              !content.home.recentlyPlayed.length &&
              !content.home.mostPlayed.length &&
              !content.home.favorites.length)) ? (
          <p className="music-empty">{t("music.noResults")}</p>
        ) : null}
        {loading ? (
          <p className="music-loading" role="status">
            <LoaderCircle className="is-spinning" size={18} />
            {t("common.states.loading")}
          </p>
        ) : null}
        {content.nextCursor && !detail ? (
          <button
            className="music-load-more"
            type="button"
            disabled={loading}
            onClick={() => void load(content.nextCursor!)}
          >
            {t("music.loadMore")}
          </button>
        ) : null}
      </div>
      {filtersOpen ? (
        <MusicDialog
          title={t("music.filters")}
          onClose={() => setFiltersOpen(false)}
        >
          <div className="music-filter-fields">
            <label>
              {t("music.source")}
              <select
                value={draftFilters.sourceId}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    sourceId: event.target.value,
                  }))
                }
              >
                <option value="">{t("music.allSources")}</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("music.year")}
              <input
                type="number"
                min="1"
                max="9999"
                value={draftFilters.year}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    year: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              {t("music.genre")}
              <input
                value={draftFilters.genre}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    genre: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              {t("music.sort")}
              <select
                value={draftFilters.sort}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    sort: event.target.value as NonNullable<MusicQuery["sort"]>,
                  }))
                }
              >
                <option value="added">{t("music.sortAdded")}</option>
                <option value="name">{t("music.sortName")}</option>
                <option value="year">{t("music.sortYear")}</option>
              </select>
            </label>
            <label className="music-check">
              <input
                type="checkbox"
                checked={draftFilters.favorite}
                onChange={(event) =>
                  setDraftFilters((current) => ({
                    ...current,
                    favorite: event.target.checked,
                  }))
                }
              />
              {t("music.onlyFavorites")}
            </label>
          </div>
          <footer>
            <button
              type="button"
              onClick={() =>
                setDraftFilters({
                  sourceId: "",
                  year: "",
                  genre: "",
                  favorite: false,
                  sort: "added",
                })
              }
            >
              {t("music.reset")}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setLoading(true);
                setContent(EMPTY);
                setFilters(draftFilters);
                setDetail(null);
                if (view === "home") setView("tracks");
                setFiltersOpen(false);
                reload();
              }}
            >
              {t("music.apply")}
            </button>
          </footer>
        </MusicDialog>
      ) : null}
      {sourcesOpen ? (
        <MusicDialog
          title={t("music.sources")}
          onClose={() => setSourcesOpen(false)}
        >
          <div className="music-source-list">
            {sources.map((source) => (
              <section key={source.id}>
                <header>
                  <strong>{source.name}</strong>
                  <Switch
                    checked={source.enabled}
                    disabled={busy}
                    onCheckedChange={(enabled) =>
                      void action(() =>
                        musicRequest(
                          `/sources/${encodeURIComponent(source.id)}`,
                          "PATCH",
                          { enabled },
                        ),
                      )
                    }
                    label={t("music.sourceEnabled")}
                  />
                </header>
                <p>{source.path}</p>
                <div className="music-detail-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(() =>
                        musicRequest(
                          `/sources/${encodeURIComponent(source.id)}/scan`,
                          "POST",
                        ),
                      )
                    }
                  >
                    <RefreshCw size={14} />
                    {t("music.scan")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setConfirmDelete({ kind: "source", id: source.id })
                    }
                  >
                    <Trash2 size={14} />
                    {t("music.remove")}
                  </button>
                </div>
                {library?.scans
                  .filter((scan) => scan.sourceId === source.id)
                  .slice(0, 1)
                  .map((scan) => (
                    <p
                      className={
                        scan.status === "failed"
                          ? "music-error"
                          : "music-inline-state"
                      }
                      key={scan.id}
                    >
                      {t(`music.scanStates.${scan.status}`)} · {scan.scanned}
                      {scan.error ? ` · ${scan.error}` : ""}
                    </p>
                  ))}
              </section>
            ))}
          </div>
          <footer>
            <button
              className="primary-button"
              type="button"
              disabled={!pools.length}
              onClick={() => setPickerOpen(true)}
            >
              <FolderPlus size={16} />
              {t("music.addSource")}
            </button>
          </footer>
        </MusicDialog>
      ) : null}
      {confirmDelete ? (
        <MusicDialog
          title={t("common.actions.delete")}
          onClose={() => setConfirmDelete(null)}
        >
          <p>
            {t(
              confirmDelete.kind === "playlist"
                ? "music.deletePlaylistConfirm"
                : "music.removeSourceConfirm",
            )}
          </p>
          <footer>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(null)}
            >
              {t("common.actions.cancel")}
            </button>
            <button
              type="button"
              disabled={busy}
              className="danger-button"
              onClick={() =>
                void action(async () => {
                  const pending = confirmDelete;
                  await musicRequest(
                    `/${pending.kind === "playlist" ? "playlists" : "sources"}/${encodeURIComponent(pending.id)}`,
                    "DELETE",
                  );
                  if (pending.kind === "playlist") setDetail(null);
                  setConfirmDelete(null);
                })
              }
            >
              {t("common.actions.delete")}
            </button>
          </footer>
        </MusicDialog>
      ) : null}
      {pickerOpen ? (
        <StorageFilePickerDialog
          pools={pools}
          initialPoolId={pools[0]?.id ?? ""}
          locale={locale}
          mode="directory"
          directoryPurpose="musicLibrary"
          onCancel={() => setPickerOpen(false)}
          onSelect={(selection) => {
            setPickerOpen(false);
            void action(() =>
              musicRequest("/sources", "POST", {
                name: selection.name,
                storagePoolId: selection.storagePoolId,
                path: selection.path,
              }),
            );
          }}
        />
      ) : null}
      {nameDialog ? (
        <MusicNameDialog
          title={t(
            nameDialog === "create" ? "music.newPlaylist" : "music.rename",
          )}
          initial={nameDialog === "rename" ? (detail?.title ?? "") : ""}
          onClose={() => setNameDialog(null)}
          onSubmit={async (name) => {
            if (nameDialog === "rename" && detail) {
              await musicRequest(
                `/playlists/${encodeURIComponent(detail.id)}`,
                "PATCH",
                { name },
              );
              setDetail({ ...detail, title: name });
            } else await musicRequest("/playlists", "POST", { name });
            reload();
          }}
        />
      ) : null}
      {addTrack ? (
        <MusicDialog title={t("music.addToPlaylist")} onClose={closeAdd}>
          <label className="music-field">
            {addTrack.title}
            <select
              ref={playlistChoiceSelect}
              value={targetPlaylistId}
              disabled={!playlistChoices.length || busy}
              aria-busy={playlistChoicesLoading}
              onChange={(event) => setTargetPlaylistId(event.target.value)}
            >
              {playlistChoices.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>
              ))}
            </select>
          </label>
          {playlistChoicesError ? (
            <p role="alert" className="music-error">
              {playlistChoicesError}
            </p>
          ) : null}
          {playlistChoicesLoading ||
          playlistChoicesCursor ||
          playlistChoicesError ? (
            <button
              ref={playlistChoicesMore}
              type="button"
              aria-disabled={playlistChoicesLoading || busy}
              aria-busy={playlistChoicesLoading}
              onClick={() => {
                if (!playlistChoicesLoading && !busy)
                  void loadPlaylistChoices(playlistChoicesCursor ?? undefined);
              }}
            >
              {playlistChoicesLoading
                ? t("common.states.loading")
                : playlistChoicesError
                  ? t("common.actions.refresh")
                  : t("music.loadMore")}
            </button>
          ) : null}
          {!playlistChoicesLoading &&
          !playlistChoicesError &&
          !playlistChoices.length ? (
            <p>{t("music.createPlaylistFirst")}</p>
          ) : null}
          <footer>
            <button
              ref={playlistChoicesCreate}
              type="button"
              disabled={busy}
              onClick={() => {
                closeAdd();
                setNameDialog("create");
              }}
            >
              {t("music.newPlaylist")}
            </button>
            <button
              type="button"
              disabled={!targetPlaylistId || busy}
              className="primary-button"
              onClick={() => {
                const session = playlistChoicesSession.current;
                void action(async () => {
                  const result = await musicRequest<{ tracks: MusicTrack[] }>(
                    `/playlists/${encodeURIComponent(targetPlaylistId)}`,
                  );
                  await musicRequest(
                    `/playlists/${encodeURIComponent(targetPlaylistId)}`,
                    "PATCH",
                    {
                      trackIds: [
                        ...result.tracks.map((track) => track.id),
                        addTrack.id,
                      ],
                    },
                  );
                  if (session === playlistChoicesSession.current) closeAdd();
                });
              }}
            >
              {t("music.add")}
            </button>
          </footer>
        </MusicDialog>
      ) : null}
    </section>
  );
}
function MusicSection({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="music-section">
      {title ? (
        <div className="music-section-heading">
          <h3>{title}</h3>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}
function SpeakerIcon() {
  return <Music2 size={16} aria-hidden="true" />;
}
