export type MusicScanState =
  "queued" | "running" | "completed" | "failed" | "cancelled";
export interface MusicSource {
  id: string;
  name: string;
  storagePoolId: string;
  path: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface MusicScan {
  id: string;
  sourceId: string;
  status: MusicScanState;
  generation: string;
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  currentPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface MusicTrack {
  id: string;
  sourceId: string;
  storagePoolId: string;
  relativePath: string;
  title: string;
  albumId: string;
  album: string;
  artists: string[];
  albumArtists: string[];
  genres: string[];
  year: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  durationSeconds: number | null;
  bitrate: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  musicbrainzRecordingId: string | null;
  musicbrainzReleaseId: string | null;
  coverKey: string | null;
  missing: boolean;
  favorite: boolean;
  playCount: number;
  lastPlayedAt: string | null;
  addedAt: string;
  updatedAt: string;
}
export interface MusicAlbum {
  id: string;
  title: string;
  artists: string[];
  genres: string[];
  year: number | null;
  coverKey: string | null;
  trackCount: number;
  durationSeconds: number;
  favorite: boolean;
  addedAt: string;
}
export interface MusicArtist {
  id: string;
  name: string;
  albumCount: number;
  trackCount: number;
  coverKey: string | null;
  favorite: boolean;
}
export interface MusicPlaylist {
  id: string;
  name: string;
  trackCount: number;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
}
export interface MusicPlaylistTrack extends MusicTrack {
  playlistItemId: string;
}
export interface MusicPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface MusicLibraryStatus {
  sourceCount: number;
  trackCount: number;
  albumCount: number;
  artistCount: number;
  missingCount: number;
  scans: MusicScan[];
  revision: string;
}
export interface MusicHome {
  recentlyAdded: MusicAlbum[];
  recentlyPlayed: MusicTrack[];
  mostPlayed: MusicTrack[];
  favorites: MusicTrack[];
}
export interface MusicQuery {
  query?: string;
  sourceId?: string;
  albumId?: string;
  artistId?: string;
  year?: number;
  genre?: string;
  favorite?: boolean;
  sort?: "name" | "year" | "added";
  cursor?: string;
  limit?: number;
}
export type MusicFavoriteKind = "track" | "album" | "artist";
export interface MusicLyrics {
  text: string | null;
  format: "lrc" | "text" | null;
}
