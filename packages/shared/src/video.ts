import type {
  MediaHome,
  MediaProgressRecord,
  MediaTitleDetail,
  MediaTitleSummary,
} from "./types.js";

export interface MediaPersonalState {
  favorite: boolean;
  watchlist: boolean;
  watched: boolean | null;
}
export interface VideoTitle extends MediaTitleSummary {
  personal: MediaPersonalState;
  watched: boolean;
  rating: number | null;
  credits: Array<{ name: string; role: string }>;
}
export interface VideoTitleDetail extends MediaTitleDetail, VideoTitle {
  fileProgress: Record<string, MediaProgressRecord>;
  episodeWatched: Record<string, boolean>;
  technical: Record<string, import("./media-stream.js").StreamTrack[]>;
  nextFileId: string | null;
}
export interface MediaCollection {
  id: string;
  name: string;
  kind: "manual" | "tmdb";
  titleIds: string[];
}
export interface VideoHome extends MediaHome {
  watchlist: VideoTitle[];
  upNext: Array<{
    title: VideoTitle;
    fileId: string;
    episodeId: string;
    seasonNumber: number;
    episodeNumber: number;
  }>;
  collections: MediaCollection[];
}
export interface VideoQuery {
  kind?: "movie" | "series";
  query?: string;
  sourceId?: string;
  genre?: string;
  year?: number;
  favorite?: boolean;
  watchlist?: boolean;
  watched?: boolean;
  collectionId?: string;
  sort?: "title" | "year" | "added" | "rating" | "recent";
  limit?: number;
  cursor?: string;
}
export interface VideoPage {
  titles: VideoTitle[];
  nextCursor: string | null;
}
export interface PlaybackOutput {
  requested: { kind: "default" | "bluetooth"; deviceId: string | null };
  effective: {
    kind: "default" | "bluetooth" | "unavailable" | "unknown";
    deviceId: string | null;
  };
}
