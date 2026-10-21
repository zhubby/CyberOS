import type { MediaHome, MediaTitleDetail, MediaTitlePage, VodPlayerStatus } from "@zos/shared";

export async function getMediaHome(): Promise<MediaHome> {
  return fetchJson<MediaHome>("/api/media/home");
}

export async function getMediaTitle(id: string): Promise<MediaTitleDetail> {
  const result = await fetchJson<{ title: MediaTitleDetail }>(`/api/media/titles/${encodeURIComponent(id)}`);
  return result.title;
}

export async function searchMedia(query: string): Promise<MediaTitlePage> {
  const params = new URLSearchParams({ query, limit: "60" });
  return fetchJson<MediaTitlePage>(`/api/media/titles?${params.toString()}`);
}

export async function playMediaFile(fileId: string, startPositionSeconds?: number): Promise<VodPlayerStatus> {
  const response = await fetch(`/api/media/files/${encodeURIComponent(fileId)}/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startPositionSeconds === undefined ? {} : { startPositionSeconds })
  });
  await ensureOk(response);
  return ((await response.json()) as { status: VodPlayerStatus }).status;
}

export function mediaArtworkUrl(titleId: string, kind: "poster" | "backdrop" | "still"): string {
  return `/api/media/titles/${encodeURIComponent(titleId)}/artwork/${kind}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  await ensureOk(response);
  return (await response.json()) as T;
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || "Request failed";
  try {
    const body = (await response.json()) as { error?: string };
    message = body.error ?? message;
  } catch {
    // Keep the HTTP status text.
  }
  throw new Error(message);
}
