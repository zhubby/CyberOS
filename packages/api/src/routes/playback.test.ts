import { get } from "node:http";
import Fastify from "fastify";
import { expect, it } from "vitest";
import fixtures from "../../../shared/fixtures/vod-player-protocol-v3.json" with { type: "json" };
import { parsePlaybackSnapshot, type VodPlayerCommand } from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { registerPlaybackRoutes } from "./playback.js";

it("provides one NAS snapshot and rejects unguarded or file-start commands", async () => {
  const raw = JSON.parse(fixtures.responses[0]!) as { status: unknown };
  const status = parsePlaybackSnapshot(raw.status)!;
  const commands: VodPlayerCommand[] = [];
  const server = Fastify();
  registerPlaybackRoutes(server, {
    playback: {
      getStatus: async () => status,
      command: async (c: VodPlayerCommand) => {
        commands.push(c);
        return status;
      },
    },
  } as unknown as ApiRouteContext);
  expect(
    (await server.inject("/api/playback/status")).json().status,
  ).toMatchObject({ target: "nas", revision: 7 });
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/api/playback/command",
        payload: { type: "pause", sessionId: "session-1" },
      })
    ).statusCode,
  ).toBe(400);
  const guarded = {
    type: "guarded",
    serviceInstanceId: "instance-1",
    expectedSessionId: "session-1",
    command: { type: "pause", sessionId: "session-1" },
  };
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/api/playback/command",
        payload: guarded,
      })
    ).statusCode,
  ).toBe(200);
  expect(commands).toEqual([guarded]);
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/api/playback/command",
        payload: {
          ...guarded,
          command: {
            type: "play",
            storagePoolId: "pool-1",
            relativePath: "x.mp4",
          },
        },
      })
    ).statusCode,
  ).toBe(400);
  await server.close();
});

it("closes active playback event subscribers before HTTP server shutdown", async () => {
  const status = parsePlaybackSnapshot(
    (JSON.parse(fixtures.responses[0]!) as { status: unknown }).status,
  )!;
  const server = Fastify();
  registerPlaybackRoutes(server, {
    playback: { getStatus: async () => status, command: async () => status },
  } as unknown as ApiRouteContext);
  const url = await server.listen({ port: 0, host: "127.0.0.1" });
  let request: ReturnType<typeof get> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      request = get(`${url}/api/playback/events`, (response) => {
        response.once("data", () => resolve());
        response.on("error", () => {});
      });
      request.on("error", reject);
    });
    await Promise.race([
      server.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("SSE prevented server shutdown")),
          3000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    request?.destroy();
    await server.close();
  }
});
