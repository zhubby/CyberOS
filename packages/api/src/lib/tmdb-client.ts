import type { MediaMatchCandidate, MediaTitleKind } from "@zos/shared";

const TMDB_API_ORIGIN = "https://api.themoviedb.org";
const TMDB_IMAGE_ORIGIN = "https://image.tmdb.org/t/p/w500";
const TMDB_SEARCH_TIMEOUT_MS = 8_000;
const TMDB_SEARCH_MAX_BYTES = 1024 * 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface TmdbSearchResult {
  id?: unknown;
  title?: unknown;
  name?: unknown;
  original_title?: unknown;
  original_name?: unknown;
  overview?: unknown;
  release_date?: unknown;
  first_air_date?: unknown;
  original_language?: unknown;
  poster_path?: unknown;
  backdrop_path?: unknown;
  popularity?: unknown;
}

export interface TmdbCandidateSearchInput {
  token: string;
  kind: MediaTitleKind;
  query: string;
  language: string;
  region: string | null;
  limit?: number;
}

export class TmdbSearchError extends Error {
  readonly statusCode = 502;

  constructor() {
    super("TMDB search is unavailable");
    this.name = "TmdbSearchError";
  }
}

export async function searchTmdbCandidates(
  input: TmdbCandidateSearchInput,
  fetchImpl: FetchLike = fetch
): Promise<MediaMatchCandidate[]> {
  const query = input.query.trim();
  if (!query || !input.token.trim()) return [];
  const mediaPath = input.kind === "movie" ? "movie" : "tv";
  const url = new URL(`/3/search/${mediaPath}`, TMDB_API_ORIGIN);
  url.searchParams.set("query", query);
  url.searchParams.set("language", input.language);
  url.searchParams.set("include_adult", "false");
  if (input.region) url.searchParams.set("region", input.region);

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`
      },
      signal: AbortSignal.timeout(TMDB_SEARCH_TIMEOUT_MS)
    });
    if (!response.ok || !response.body) throw new TmdbSearchError();
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > TMDB_SEARCH_MAX_BYTES) throw new TmdbSearchError();
    const payload = JSON.parse(await readBoundedText(response, TMDB_SEARCH_MAX_BYTES)) as { results?: unknown };
    if (!Array.isArray(payload.results)) throw new TmdbSearchError();
    const limit = Math.max(1, Math.min(10, Math.floor(input.limit ?? 10)));
    return payload.results
      .map((result) => normalizeCandidate(input.kind, result as TmdbSearchResult))
      .filter((candidate): candidate is MediaMatchCandidate => candidate !== null)
      .slice(0, limit);
  } catch (error) {
    if (error instanceof TmdbSearchError) throw error;
    throw new TmdbSearchError();
  }
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new TmdbSearchError();
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function normalizeCandidate(kind: MediaTitleKind, result: TmdbSearchResult): MediaMatchCandidate | null {
  if (typeof result.id !== "number" || !Number.isInteger(result.id) || result.id <= 0) return null;
  const title = kind === "movie" ? result.title : result.name;
  if (typeof title !== "string" || !title.trim()) return null;
  const originalTitle = kind === "movie" ? result.original_title : result.original_name;
  const releaseDate = kind === "movie" ? result.release_date : result.first_air_date;
  return {
    tmdbId: result.id,
    kind,
    title: title.trim(),
    originalTitle: nullableString(originalTitle),
    overview: nullableString(result.overview),
    year: typeof releaseDate === "string" && /^\d{4}/u.test(releaseDate)
      ? Number(releaseDate.slice(0, 4))
      : null,
    releaseDate: nullableString(releaseDate),
    originalLanguage: nullableString(result.original_language),
    posterUrl: imageUrl(result.poster_path),
    backdropUrl: imageUrl(result.backdrop_path),
    popularity: typeof result.popularity === "number" && Number.isFinite(result.popularity) ? result.popularity : null
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function imageUrl(value: unknown): string | null {
  if (typeof value !== "string" || !/^\/[A-Za-z0-9._/-]+$/u.test(value)) return null;
  return `${TMDB_IMAGE_ORIGIN}${value}`;
}
