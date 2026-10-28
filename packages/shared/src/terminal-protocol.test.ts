import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  decodeTerminalData,
  encodeTerminalData,
  encodeTerminalFrame,
  parseTerminalClientFrame,
  parseTerminalOpenResult,
  parseTerminalServerFrame,
  terminalCommand,
  terminalRequest
} from "./terminal-protocol.js";

const REQUEST_ID = "67e55044-10b1-426f-9247-bb680e5fe0c8";
const STREAM_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("Terminal Protocol v1", () => {
  it("round-trips strict request and command envelopes", () => {
    const open = terminalRequest(REQUEST_ID, "session.open", {
      user: "cyberos",
      cols: 120,
      rows: 32,
      sessionName: "cyberos-demo",
      persistent: true
    });
    expect(parseTerminalClientFrame(encodeTerminalFrame(open).trim())).toEqual(open);
    const input = terminalCommand(STREAM_ID, "terminal.input", {
      data: encodeTerminalData(Buffer.from("pwd\r"))
    });
    expect(parseTerminalClientFrame(encodeTerminalFrame(input).trim())).toEqual(input);
    expect(decodeTerminalData(input.payload.data)?.toString("utf8")).toBe("pwd\r");
  });

  it("rejects unknown fields, versions, invalid dimensions, ids, and base64", () => {
    expect(parseTerminalClientFrame("not json")).toBeNull();
    expect(parseTerminalClientFrame(`{"version":2,"kind":"request","id":"${REQUEST_ID}","operation":"session.open","payload":{"user":"cyberos","cols":120,"rows":32}}`)).toBeNull();
    expect(parseTerminalClientFrame(`{"version":1,"kind":"request","id":"bad","operation":"session.open","payload":{"user":"cyberos","cols":120,"rows":32}}`)).toBeNull();
    expect(parseTerminalClientFrame(`{"version":1,"kind":"request","id":"${REQUEST_ID}","operation":"session.open","payload":{"user":"cyberos","cols":1,"rows":32}}`)).toBeNull();
    expect(parseTerminalClientFrame(`{"version":1,"kind":"command","streamId":"${STREAM_ID}","operation":"terminal.input","payload":{"data":"***"}}`)).toBeNull();
    expect(parseTerminalClientFrame(`{"version":1,"kind":"command","streamId":"${STREAM_ID}","operation":"terminal.input","payload":{"data":"Zh=="}}`)).toBeNull();
    expect(parseTerminalClientFrame(`{"version":1,"kind":"command","streamId":"${STREAM_ID}","operation":"terminal.input","payload":{"data":"Zg"}}`)).toBeNull();
    expect(parseTerminalClientFrame(`{"version":1,"kind":"request","id":"${REQUEST_ID.replaceAll("-", "")}","operation":"session.open","payload":{"user":"cyberos","cols":120,"rows":32}}`)).toBeNull();
    expect(parseTerminalClientFrame(`{"version":1,"kind":"request","id":"67e55044-10b1-026f-9247-bb680e5fe0c8","operation":"session.open","payload":{"user":"cyberos","cols":120,"rows":32}}`)).toBeNull();
    expect(parseTerminalClientFrame(`{"version":1,"kind":"request","id":"67e55044-10b1-426f-7247-bb680e5fe0c8","operation":"session.open","payload":{"user":"cyberos","cols":120,"rows":32}}`)).toBeNull();
    expect(parseTerminalClientFrame(`{"version":1,"kind":"request","id":"${REQUEST_ID}","operation":"session.destroy","payload":{"user":"cyberos","sessionName":"cyberos-demo"},"extra":true}`)).toBeNull();
  });

  it("parses success, error, output, exit, and stream error frames", () => {
    const ready = parseTerminalServerFrame(`{"version":1,"kind":"response","id":"${REQUEST_ID}","ok":true,"result":{"streamId":"${STREAM_ID}","user":"cyberos","cwd":"/cyberos/home/terminal","shell":"/bin/bash"}}`);
    expect(ready?.kind).toBe("response");
    if (ready?.kind !== "response" || !ready.ok) throw new Error("expected ready response");
    expect(parseTerminalOpenResult(ready.result)).toEqual({
      streamId: STREAM_ID,
      user: "cyberos",
      cwd: "/cyberos/home/terminal",
      shell: "/bin/bash"
    });
    expect(parseTerminalServerFrame(`{"version":1,"kind":"response","id":"${REQUEST_ID}","ok":false,"error":{"status":409,"code":"conflict","message":"busy","retryable":true}}`)).not.toBeNull();
    expect(parseTerminalServerFrame(`{"version":1,"kind":"event","streamId":"${STREAM_ID}","event":"terminal.output","payload":{"data":"5Lit5paH"}}`)).not.toBeNull();
    expect(parseTerminalServerFrame(`{"version":1,"kind":"event","streamId":"${STREAM_ID}","event":"terminal.exit","payload":{"exitCode":0,"recoverable":false}}`)).not.toBeNull();
    expect(parseTerminalServerFrame(`{"version":1,"kind":"event","streamId":"${STREAM_ID}","event":"terminal.error","payload":{"code":"unavailable","message":"closed","retryable":true}}`)).not.toBeNull();
  });

  it("keeps the checked-in golden frames valid", async () => {
    const fixtures = JSON.parse(await readFile(new URL("../fixtures/terminal-protocol-v1.json", import.meta.url), "utf8")) as {
      client: string[];
      server: string[];
    };
    expect(fixtures.client.map(parseTerminalClientFrame).every(Boolean)).toBe(true);
    expect(fixtures.server.map(parseTerminalServerFrame).every(Boolean)).toBe(true);
  });
});
