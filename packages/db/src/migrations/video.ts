import type { Migration } from "./types.js";
export const videoMigrations: Migration[] = [{ id: "005_video_library", sql: `
CREATE TABLE media_personal_state (
 title_id TEXT PRIMARY KEY REFERENCES media_titles(id) ON DELETE CASCADE,
 favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN(0,1)),
 watchlist INTEGER NOT NULL DEFAULT 0 CHECK(watchlist IN(0,1)),
 watched INTEGER CHECK(watched IN(0,1)), updated_at TEXT NOT NULL
);
CREATE TABLE media_episode_state (
 episode_id TEXT PRIMARY KEY REFERENCES media_episodes(id) ON DELETE CASCADE,
 watched INTEGER NOT NULL CHECK(watched IN(0,1)), updated_at TEXT NOT NULL
);
CREATE TABLE media_collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'manual' CHECK(kind IN('manual','tmdb')), external_id INTEGER UNIQUE);
CREATE TABLE media_collection_members (
 collection_id TEXT NOT NULL REFERENCES media_collections(id) ON DELETE CASCADE,
 title_id TEXT NOT NULL REFERENCES media_titles(id) ON DELETE CASCADE, position INTEGER NOT NULL,
 PRIMARY KEY(collection_id,title_id)
);
CREATE TABLE media_title_metadata (title_id TEXT PRIMARY KEY REFERENCES media_titles(id) ON DELETE CASCADE, rating REAL, credits_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE media_file_technical (file_id TEXT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE, identity TEXT NOT NULL, probe_json TEXT NOT NULL);
CREATE INDEX idx_media_personal_watchlist ON media_personal_state(watchlist,updated_at DESC);
` }];
