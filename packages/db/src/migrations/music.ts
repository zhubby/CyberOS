import type { Migration } from "./types.js";
export const musicMigrations: Migration[] = [
  {
    id: "004_music_library",
    sql: `
CREATE TABLE music_sources (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, storage_pool_id TEXT NOT NULL,
  path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(storage_pool_id,path)
);
CREATE TABLE music_scan_runs (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES music_sources(id),
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  generation TEXT NOT NULL, full_scan INTEGER NOT NULL DEFAULT 1 CHECK(full_scan IN (0,1)), rescan_requested INTEGER NOT NULL DEFAULT 0 CHECK(rescan_requested IN (0,1)), scanned INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0,
  current_path TEXT, error TEXT, worker_id TEXT, lease_expires_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE UNIQUE INDEX music_scan_active ON music_scan_runs(source_id) WHERE status IN ('queued','running');
CREATE TABLE music_scan_entries (
  scan_id TEXT NOT NULL REFERENCES music_scan_runs(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL, entry_json TEXT NOT NULL, PRIMARY KEY(scan_id,relative_path)
);
CREATE TABLE music_tracks (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES music_sources(id),
  storage_pool_id TEXT NOT NULL, relative_path TEXT NOT NULL,
  title TEXT NOT NULL, album_id TEXT NOT NULL, album TEXT NOT NULL,
  artists_json TEXT NOT NULL DEFAULT '[]', album_artists_json TEXT NOT NULL DEFAULT '[]',
  genres_json TEXT NOT NULL DEFAULT '[]', year INTEGER, track_number INTEGER, disc_number INTEGER,
  duration_seconds REAL, bitrate INTEGER, sample_rate INTEGER, bit_depth INTEGER,
  musicbrainz_recording_id TEXT, musicbrainz_release_id TEXT,
  artwork_key TEXT, lyrics_text TEXT, lyrics_format TEXT CHECK(lyrics_format IN ('lrc','text')),
  metadata_signature TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, mtime_ms INTEGER NOT NULL DEFAULT 0,
  scan_generation TEXT NOT NULL, missing INTEGER NOT NULL DEFAULT 0 CHECK(missing IN (0,1)),
  added_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(storage_pool_id,relative_path)
);
CREATE INDEX music_tracks_album ON music_tracks(album_id,disc_number,track_number);
CREATE INDEX music_tracks_source ON music_tracks(source_id,scan_generation);
CREATE INDEX music_tracks_title ON music_tracks(title COLLATE NOCASE,id);
CREATE TABLE music_favorites (
  kind TEXT NOT NULL CHECK(kind IN ('track','album','artist')), entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(kind,entity_id)
);
CREATE TABLE music_playlists (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE music_playlist_items (
  id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES music_tracks(id), position INTEGER NOT NULL CHECK(position>=0),
  UNIQUE(playlist_id,position)
);
CREATE TABLE music_play_events (
  id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES music_tracks(id),
  played_at TEXT NOT NULL, listened_seconds REAL NOT NULL DEFAULT 0
);
CREATE INDEX music_play_events_track ON music_play_events(track_id,played_at);
`
  }
];
