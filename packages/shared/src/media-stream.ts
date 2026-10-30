export interface StreamTrack {
  index: number;
  type: "video" | "audio" | "subtitle";
  codec: string;
  language: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  hdr: boolean;
}
export interface StreamOptions {
  startPositionSeconds?: number;
  quality?: "original" | "1080" | "720" | "480";
  audioTrack?: number;
  subtitleTrack?: number | null;
  codecs?: string[];
}
export interface StreamSession {
  id: string;
  fileId: string;
  state: "queued" | "preparing" | "ready" | "error";
  mode: "direct" | "remux" | "transcode";
  startPositionSeconds: number;
  durationSeconds: number | null;
  tracks: StreamTrack[];
  audioTrack: number | null;
  subtitleTrack: number | null;
  error: string | null;
  reason: string | null;
  url: string;
  container?: string | null;
}
