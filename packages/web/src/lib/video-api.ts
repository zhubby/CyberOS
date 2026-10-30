import type { MediaCollection, MediaPersonalState, StreamOptions, StreamSession, VideoHome, VideoPage, VideoQuery, VideoTitleDetail, NasPlaybackStatus, VodPlayerCommand } from "@cyberos/shared";
export async function mediaRequest<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  if (!response.ok) { const result = await response.json().catch(() => ({})) as { error?: string }; throw new Error(result.error ?? response.statusText); }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
export const getVideoHome = () => mediaRequest<VideoHome>("media/home");
export const getVideoDetail = (id: string, signal?: AbortSignal) => mediaRequest<{ title: VideoTitleDetail }>(`media/titles/${encodeURIComponent(id)}`, "GET", undefined, signal).then(r => r.title);
export function getVideoPage(input: VideoQuery, signal?: AbortSignal) { const q = new URLSearchParams(); for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== "") q.set(key, String(value)); return mediaRequest<VideoPage>(`media/titles?${q}`, "GET", undefined, signal); }
export const setVideoState = (id: string, state: Partial<MediaPersonalState>) => mediaRequest(`media/titles/${encodeURIComponent(id)}/state`, "PATCH", state);
export const setEpisodeState = (id: string, watched: boolean) => mediaRequest(`media/episodes/${encodeURIComponent(id)}/state`, "PATCH", { watched });
export const getCollections = () => mediaRequest<{ collections: MediaCollection[] }>("media/collections").then(r => r.collections);
export const saveCollection = (id: string, data: { name?: string; titleIds?: string[] }) => mediaRequest(`media/collections/${encodeURIComponent(id)}`, "PATCH", data);
export const createCollection = (name: string) => mediaRequest<{ collection: MediaCollection }>("media/collections", "POST", { name }).then(r => r.collection);
export const deleteCollection = (id: string) => mediaRequest(`media/collections/${encodeURIComponent(id)}`, "DELETE");
export const getPlayback = () => mediaRequest<{ status: NasPlaybackStatus }>("playback/status").then(r => r.status);
export const commandPlayback = (command: VodPlayerCommand) => mediaRequest<{ status: NasPlaybackStatus }>("playback/command", "POST", command).then(r => r.status);
export const createStream = (fileId: string, options: StreamOptions) => mediaRequest<{ session: StreamSession }>("media/playback-sessions", "POST", { fileId, ...options }).then(r => r.session);
export const getStream = (id: string) => mediaRequest<{ session: StreamSession }>(`media/playback-sessions/${encodeURIComponent(id)}`).then(r => r.session);
export const closeStream = (id: string) => mediaRequest(`media/playback-sessions/${encodeURIComponent(id)}`, "DELETE");
export const saveStreamProgress = (id: string, positionSeconds: number) => mediaRequest(`media/playback-sessions/${encodeURIComponent(id)}/progress`, "POST", { positionSeconds });
