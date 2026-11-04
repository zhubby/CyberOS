import { describe, expect, it } from "vitest";
import { defaultAudioSettings } from "@cyberos/db";
import { CyberAudioClient, speechChunks } from "./audio-client.js";

describe("CyberAudio client", () => {
  it("removes code and Markdown, preserves Unicode and bounds each TTS chunk", () => {
    const chunks = speechChunks("# 标题\n```sh\nsecret command\n```\n[链接](https://example.com) **你好**。" + "😀".repeat(1100));
    expect(chunks.every((chunk) => Array.from(chunk).length <= 500)).toBe(true);
    expect(chunks.join("")).not.toContain("secret command");
    expect(chunks.join("")).not.toContain("https:");
    expect(chunks.join("")).toContain("😀".repeat(20));
  });
  it("prefers sentence boundaries and never reads unfinished thinking blocks", () => {
    const first = `${"甲".repeat(300)}。`;
    const second = `${"乙".repeat(300)}。`;
    expect(speechChunks(first + second)).toEqual([first, second]);
    expect(speechChunks("最终答复。<think>private reasoning")).toEqual(["最终答复。"]);
  });

  it("keeps readiness and authentication independent without sending token to ready", async () => {
    const requests: { path: string; authorization: string | null }[] = [];
    const client = new CyberAudioClient(async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push({ path, authorization: new Headers(init?.headers).get("authorization") });
      return path === "/ready" ? Response.json({ models: { stt: "ready", tts: "ready" } }) : new Response("private-token", { status: 401 });
    });
    const status = await client.test({ ...defaultAudioSettings(), cyberAudioBaseUrl: "https://audio.example.com", cyberAudioToken: "private-token" });
    expect(status).toMatchObject({ reachable: true, authenticated: false, sttReady: true, ttsReady: true });
    expect(requests[0]!.authorization).toBeNull();
    expect(JSON.stringify(status)).not.toContain("private-token");
  });

  it("bounds retries for busy services and does not leak response bodies", async () => {
    let count = 0;
    const client = new CyberAudioClient(async () => { count++; return new Response("token-and-audio", { status: 429, headers: { "retry-after": "0" } }); }, async () => {});
    await expect(client.transcribe({ ...defaultAudioSettings(), cyberAudioBaseUrl: "https://audio.example.com", cyberAudioToken: "token" }, Buffer.from("wave"))).rejects.toThrow(/busy/i);
    expect(count).toBe(3);
  });

  it("empty transcription remains empty and redirects never forward credentials", async () => {
    const client = new CyberAudioClient(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      return Response.json({ text: "  " });
    });
    expect(await client.transcribe({ ...defaultAudioSettings(), cyberAudioBaseUrl: "https://audio.example.com", cyberAudioToken: "token" }, Buffer.from("wave"))).toBe("");
  });
});
