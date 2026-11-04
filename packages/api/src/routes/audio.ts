import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../context.js";

export function registerAudioRoutes(server: FastifyInstance, { audio }: Pick<ApiRouteContext, "audio">): void {
  server.get("/api/audio/status", async (_request, reply) => {
    if (!audio) return reply.status(503).send({ error: "Audio coordinator unavailable" });
    return audio.refreshStatus();
  });
  server.get("/api/audio/devices", async (_request, reply) => {
    if (!audio) return reply.status(503).send({ error: "Audio coordinator unavailable" });
    try { return await audio.runtime.devices(); }
    catch { return reply.status(503).send({ error: "Audio daemon unavailable" }); }
  });
  server.post("/api/audio/test/service", async (_request, reply) => {
    if (!audio) return reply.status(503).send({ error: "Audio coordinator unavailable" });
    return audio.serviceTest();
  });
  server.post("/api/audio/test/recording", async (_request, reply) => {
    if (!audio) return reply.status(503).send({ error: "Audio coordinator unavailable" });
    try { await audio.armRecordingTest(); return { armed: true }; }
    catch { return reply.status(409).send({ error: "Configure input, service and token; wait for active recording to finish" }); }
  });
  server.post<{ Body?: { text?: string } }>("/api/audio/test/speech", async (request, reply) => {
    if (!audio) return reply.status(503).send({ error: "Audio coordinator unavailable" });
    const text = request.body?.text ?? "你好，CyberOS 语音输出测试。 Hello from CyberOS.";
    if (typeof text !== "string" || !text.trim() || Array.from(text).length > 500) return reply.status(400).send({ error: "Speech test requires 1–500 characters" });
    try { await audio.testSpeech(text); return { played: true }; }
    catch { return reply.status(409).send({ error: "Speech test failed; check service, selected output and media focus" }); }
  });
  server.post("/api/audio/stop", async (_request, reply) => {
    if (!audio) return reply.status(503).send({ error: "Audio coordinator unavailable" });
    await audio.stopSpeech(); return { stopped: true };
  });
  server.post("/api/audio/session/reset", async (_request, reply) => {
    if (!audio) return reply.status(503).send({ error: "Audio coordinator unavailable" });
    try { return { session: audio.resetContext() }; }
    catch { return reply.status(409).send({ error: "Voice context cannot reset while work is active" }); }
  });
}
