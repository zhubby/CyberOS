import type { MusicPlayerRequest, MusicPlayerStatus } from "@cyberos/shared";

export class MusicApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function musicRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/music${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const result = (await response.json().catch((): null => null)) as {
      error?: string;
      code?: string;
    } | null;
    throw new MusicApiError(
      result?.error ?? response.statusText,
      response.status,
      result?.code,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}

export function getMusicPlayer(): Promise<MusicPlayerStatus> {
  return musicRequest<{ status: MusicPlayerStatus }>("/player").then(
    (result) => result.status,
  );
}
export function sendMusicCommand(
  command: MusicPlayerRequest,
): Promise<MusicPlayerStatus> {
  return musicRequest<{ status: MusicPlayerStatus }>(
    "/player/command",
    "POST",
    command,
  ).then((result) => result.status);
}
export function musicCoverUrl(key: string | null): string | undefined {
  return key ? `/api/music/artwork/${encodeURIComponent(key)}` : undefined;
}
