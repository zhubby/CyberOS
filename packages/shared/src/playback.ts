import type { MusicPlayerStatus } from "./music-player.js";
import type {
  VodPlayerStatus,
  VodPlayerCommand,
} from "./vod-player-protocol.js";
import type { PlaybackPreferences } from "./generated/vod-player.js";
import type { PlaybackOutput } from "./video.js";
export interface NasPlaybackStatus {
  target: "nas";
  owner: "music" | "video" | null;
  sessionId: string | null;
  serviceInstanceId: string;
  revision: number;
  music: MusicPlayerStatus;
  video: VodPlayerStatus;
  preferences: PlaybackPreferences;
  output: PlaybackOutput;
  audioDelayKey: string;
}
export interface PlaybackRuntime {
  getStatus(): Promise<NasPlaybackStatus>;
  command(command: VodPlayerCommand): Promise<NasPlaybackStatus>;
}
