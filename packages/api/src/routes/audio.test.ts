import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAudioRoutes } from "./audio.js";

describe("audio diagnostics routes", () => {
  it("reports unavailable coordination consistently without pretending to stop or reset", async () => {
    const server = Fastify();
    registerAudioRoutes(server, {});
    try {
      for (const url of ["/api/audio/status", "/api/audio/devices", "/api/audio/test/service", "/api/audio/test/recording", "/api/audio/test/speech", "/api/audio/stop", "/api/audio/session/reset"]) {
        const response = await server.inject({ method: url.endsWith("status") || url.endsWith("devices") ? "GET" : "POST", url });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: "Audio coordinator unavailable" });
      }
    } finally { await server.close(); }
  });
});
