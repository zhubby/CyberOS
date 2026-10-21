import { describe, expect, it } from "vitest";
import {
  clearVideoProgress,
  readVideoProgress,
  videoProgressStorageKey,
  writeVideoProgress,
  type VideoProgressIdentity
} from "./video-progress.js";

const identity: VideoProgressIdentity = {
  rootId: "local",
  path: "movies/clip one.mkv",
  sizeBytes: 2048,
  modifiedAt: "2026-08-28T00:00:00.000Z"
};

function storage(values = new Map<string, string>()) {
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

describe("video progress", () => {
  it("writes and reads progress for a file identity", () => {
    const nextStorage = storage();

    writeVideoProgress(identity, 42.5, nextStorage);

    expect(readVideoProgress(identity, nextStorage)).toEqual({
      positionSeconds: 42.5,
      sizeBytes: identity.sizeBytes,
      modifiedAt: identity.modifiedAt
    });
    expect(videoProgressStorageKey(identity)).toContain("movies%2Fclip%20one.mkv");
  });

  it("ignores progress from a changed file", () => {
    const nextStorage = storage();
    writeVideoProgress(identity, 42.5, nextStorage);

    expect(
      readVideoProgress(
        {
          ...identity,
          sizeBytes: identity.sizeBytes + 1
        },
        nextStorage
      )
    ).toBeNull();
    expect(
      readVideoProgress(
        {
          ...identity,
          modifiedAt: "2026-08-29T00:00:00.000Z"
        },
        nextStorage
      )
    ).toBeNull();
  });

  it("clears progress when playback finishes", () => {
    const nextStorage = storage();
    writeVideoProgress(identity, 42.5, nextStorage);

    clearVideoProgress(identity, nextStorage);

    expect(readVideoProgress(identity, nextStorage)).toBeNull();
  });

  it("ignores malformed progress and tolerates unavailable storage", () => {
    const nextStorage = storage();
    nextStorage.values.set(videoProgressStorageKey(identity), JSON.stringify({ positionSeconds: -1 }));
    expect(readVideoProgress(identity, nextStorage)).toBeNull();

    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
      removeItem: () => {
        throw new Error("storage unavailable");
      }
    };
    expect(readVideoProgress(identity, unavailableStorage)).toBeNull();
    expect(() => writeVideoProgress(identity, 10, unavailableStorage)).not.toThrow();
    expect(() => clearVideoProgress(identity, unavailableStorage)).not.toThrow();
  });

  it("tolerates a browser that throws while exposing localStorage", () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage() {
          throw new Error("storage unavailable");
        }
      }
    });

    expect(() => readVideoProgress(identity)).not.toThrow();
    expect(() => writeVideoProgress(identity, 10)).not.toThrow();
    expect(() => clearVideoProgress(identity)).not.toThrow();

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow
    });
  });
});
