import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCatalogDescriptors } from "./catalog.js";

describe("media MCP contracts", () => {
  const tools = ["music.query", "music.get", "music.status", "music.manage-propose", "music.control-propose", "media.query", "media.get", "media.status", "media.manage-propose", "media.play-propose", "playback.status", "playback.outputs", "playback.control-propose"];
  it.each(tools)("registers cyberos.%s with strict schemas and domain scopes", (name) => {
    const descriptor = createCatalogDescriptors().find((entry) => entry.id === `cyberos.${name}`);
    expect(descriptor).toBeDefined();
    expect(descriptor!.inputSchema.additionalProperties).toBe(false);
    expect(descriptor!.requiredScopes).toEqual([`cyberos:${name.split(".")[0]}:${name.endsWith("-propose") ? "propose" : "read"}`]);
    if (name.endsWith("-propose")) expect(descriptor!.approval).not.toBe("none");
  });
  it("requires playback guards and rejects credentials, arbitrary commands and oversized queries", () => {
    const schema = (name: string) => z.fromJSONSchema(createCatalogDescriptors().find((entry) => entry.id === name)!.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    expect(schema("cyberos.music.query").safeParse({ entity: "tracks", limit: 101 }).success).toBe(false);
    expect(schema("cyberos.music.control-propose").safeParse({ request: { operation: "pause" } }).success).toBe(false);
    expect(schema("cyberos.music.control-propose").safeParse({ request: { operation: "pause", serviceInstanceId: "instance", playbackSessionId: null, expectedQueueVersion: 0 } }).success).toBe(true);
    expect(schema("cyberos.media.manage-propose").safeParse({ request: { operation: "settings", tmdbReadAccessToken: "secret" } }).success).toBe(false);
    expect(schema("cyberos.playback.control-propose").safeParse({ request: { operation: "shell", command: "ls" } }).success).toBe(false);
  });
});
