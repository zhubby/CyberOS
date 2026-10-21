import { describe, expect, it, vi } from "vitest";
import { searchTmdbCandidates, TmdbSearchError } from "./tmdb-client.js";

describe("searchTmdbCandidates", () => {
  it("normalizes and bounds TMDB results without exposing credentials", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/3/search/movie?query=Arrival");
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer secret-token" }));
      return new Response(JSON.stringify({
        results: Array.from({ length: 12 }, (_, index) => ({
          id: index + 1,
          title: `Arrival ${index + 1}`,
          original_title: "Arrival",
          overview: "First contact",
          release_date: "2016-11-11",
          original_language: "en",
          poster_path: "/arrival.jpg",
          backdrop_path: "/arrival-backdrop.jpg",
          popularity: 42
        }))
      }), { headers: { "content-type": "application/json" } });
    });

    const candidates = await searchTmdbCandidates({
      token: "secret-token",
      kind: "movie",
      query: "Arrival",
      language: "zh-CN",
      region: "CN"
    }, fetchImpl);

    expect(candidates).toHaveLength(10);
    expect(candidates[0]).toEqual(expect.objectContaining({
      tmdbId: 1,
      kind: "movie",
      title: "Arrival 1",
      year: 2016,
      posterUrl: "https://image.tmdb.org/t/p/w500/arrival.jpg"
    }));
  });

  it("returns a stable error for invalid and oversized responses", async () => {
    const oversized = new Response("x", { headers: { "content-length": String(1024 * 1024 + 1) } });
    await expect(searchTmdbCandidates({
      token: "secret-token",
      kind: "series",
      query: "Dark",
      language: "en-US",
      region: null
    }, async () => oversized)).rejects.toBeInstanceOf(TmdbSearchError);

    await expect(searchTmdbCandidates({
      token: "secret-token",
      kind: "series",
      query: "Dark",
      language: "en-US",
      region: null
    }, async () => new Response("upstream stack trace", { status: 500 }))).rejects.toThrow("TMDB search is unavailable");
  });
});
