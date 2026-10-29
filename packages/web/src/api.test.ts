import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api.js";
import { createTerminalTab, initializeTerminalTabs, type TerminalTabState } from "./api.js";

const terminalState: TerminalTabState = {
  initialized: true,
  tabs: [],
  activeTabId: null,
  maxSessions: 4
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terminal tab requests", () => {
  it("initializes tabs without declaring an empty JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(terminalState));
    vi.stubGlobal("fetch", fetchMock);

    await expect(initializeTerminalTabs()).resolves.toEqual(terminalState);

    expect(fetchMock).toHaveBeenCalledWith("/api/terminal/tabs/initialize", { method: "POST" });
  });

  it("creates a tab without declaring an empty JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(terminalState));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createTerminalTab()).resolves.toEqual(terminalState);

    expect(fetchMock).toHaveBeenCalledWith("/api/terminal/tabs", { method: "POST" });
  });
});

describe("torrent download requests", () => {
  it("creates Magnet and uploaded torrent previews with the correct wire shapes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ preview: torrentPreview }))
      .mockResolvedValueOnce(jsonResponse({ preview: { ...torrentPreview, sourceKind: "torrent" } }));
    vi.stubGlobal("fetch", fetchMock);
    const createMagnetPreview = Reflect.get(api, "createMagnetPreview") as unknown;
    const uploadTorrentPreview = Reflect.get(api, "uploadTorrentPreview") as unknown;

    expect(createMagnetPreview).toBeTypeOf("function");
    expect(uploadTorrentPreview).toBeTypeOf("function");
    if (typeof createMagnetPreview !== "function" || typeof uploadTorrentPreview !== "function") return;

    await createMagnetPreview("magnet:?xt=urn:btih:0123456789012345678901234567890123456789");
    const file = new File(["torrent"], "release.torrent", { type: "application/x-bittorrent" });
    await uploadTorrentPreview(file);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/downloads/torrent-previews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magnet: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789" })
    });
    const uploadRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/downloads/torrent-previews");
    expect(uploadRequest.method).toBe("POST");
    expect(uploadRequest.headers).toBeUndefined();
    expect(uploadRequest.body).toBeInstanceOf(FormData);
    expect((uploadRequest.body as FormData).get("torrent")).toBe(file);
  });

  it("creates a selected-file torrent task with bounded seeding defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ task: { id: "task-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const createTorrentDownload = Reflect.get(api, "createTorrentDownload") as unknown;

    expect(createTorrentDownload).toBeTypeOf("function");
    if (typeof createTorrentDownload !== "function") return;

    await createTorrentDownload({
      torrentPreviewId: "preview-1",
      selectedFileIndices: [0, 2],
      storagePoolId: "pool-1",
      targetDirectory: "Downloads",
      fileName: "release",
      seedRatioLimit: 1,
      seedTimeLimitSeconds: 7_200
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        torrentPreviewId: "preview-1",
        selectedFileIndices: [0, 2],
        storagePoolId: "pool-1",
        targetDirectory: "Downloads",
        fileName: "release",
        seedRatioLimit: 1,
        seedTimeLimitSeconds: 7_200
      })
    });
  });
});

const torrentPreview = {
  id: "preview-1",
  sourceKind: "magnet",
  sourceUri: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
  status: "queued",
  infoHash: null,
  name: null,
  totalBytes: null,
  fileCount: 0,
  isPrivate: false,
  error: null,
  workerId: null,
  leaseExpiresAt: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
  expiresAt: "2026-10-29T00:30:00.000Z",
  files: []
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" }
  });
}
