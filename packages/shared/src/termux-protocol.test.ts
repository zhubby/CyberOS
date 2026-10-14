import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  decodeTermuxData,
  encodeTermuxData,
  encodeTermuxFrame,
  parseTermuxClientFrame,
  parseTermuxOpenResult,
  parseTermuxServerFrame,
  termuxCommand,
  termuxRequest
} from "./termux-protocol.js";

const REQUEST_ID = "67e55044-10b1-426f-9247-bb680e5fe0c8";
const STREAM_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("Termux Protocol v1", () => {
  it("round-trips strict request and command envelopes", () => {
    const open = termuxRequest(REQUEST_ID, "session.open", {
      user: "zos",
      cols: 120,
      rows: 32,
      sessionName: "zos-demo",
      persistent: true
    });
    expect(parseTermuxClientFrame(encodeTermuxFrame(open).trim())).toEqual(open);
    const input = termuxCommand(STREAM_ID, "terminal.input", {
      data: encodeTermuxData(Buffer.from("pwd\r"))
    });
    expect(parseTermuxClientFrame(encodeTermuxFrame(input).trim())).toEqual(input);
    expect(decodeTermuxData(input.payload.data)?.toString("utf8")).toBe("pwd\r");
  });

  it("rejects unknown fields, versions, invalid dimensions, ids, and base64", () => {
    expect(parseTermuxClientFrame("not json")).toBeNull();
    expect(parseTermuxClientFrame(`{"version":2,"kind":"request","id":"${REQUEST_ID}","operation":"session.open","payload":{"user":"zos","cols":120,"rows":32}}`)).toBeNull();
    expect(parseTermuxClientFrame(`{"version":1,"kind":"request","id":"bad","operation":"session.open","payload":{"user":"zos","cols":120,"rows":32}}`)).toBeNull();
    expect(parseTermuxClientFrame(`{"version":1,"kind":"request","id":"${REQUEST_ID}","operation":"session.open","payload":{"user":"zos","cols":1,"rows":32}}`)).toBeNull();
    expect(parseTermuxClientFrame(`{"version":1,"kind":"command","streamId":"${STREAM_ID}","operation":"terminal.input","payload":{"data":"***"}}`)).toBeNull();
    expect(parseTermuxClientFrame(`{"version":1,"kind":"command","streamId":"${STREAM_ID}","operation":"terminal.input","payload":{"data":"Zh=="}}`)).toBeNull();
    expect(parseTermuxClientFrame(`{"version":1,"kind":"command","streamId":"${STREAM_ID}","operation":"terminal.input","payload":{"data":"Zg"}}`)).toBeNull();
    expect(parseTermuxClientFrame(`{"version":1,"kind":"request","id":"${REQUEST_ID.replaceAll("-", "")}","operation":"session.open","payload":{"user":"zos","cols":120,"rows":32}}`)).toBeNull();
    expect(parseTermuxClientFrame(`{"version":1,"kind":"request","id":"67e55044-10b1-026f-9247-bb680e5fe0c8","operation":"session.open","payload":{"user":"zos","cols":120,"rows":32}}`)).toBeNull();
    expect(parseTermuxClientFrame(`{"version":1,"kind":"request","id":"67e55044-10b1-426f-7247-bb680e5fe0c8","operation":"session.open","payload":{"user":"zos","cols":120,"rows":32}}`)).toBeNull();
    expect(parseTermuxClientFrame(`{"version":1,"kind":"request","id":"${REQUEST_ID}","operation":"session.destroy","payload":{"user":"zos","sessionName":"zos-demo"},"extra":true}`)).toBeNull();
  });

  it("parses success, error, output, exit, and stream error frames", () => {
    const ready = parseTermuxServerFrame(`{"version":1,"kind":"response","id":"${REQUEST_ID}","ok":true,"result":{"streamId":"${STREAM_ID}","user":"zos","cwd":"/zos/home/termux","shell":"/bin/bash"}}`);
    expect(ready?.kind).toBe("response");
    if (ready?.kind !== "response" || !ready.ok) throw new Error("expected ready response");
    expect(parseTermuxOpenResult(ready.result)).toEqual({
      streamId: STREAM_ID,
      user: "zos",
      cwd: "/zos/home/termux",
      shell: "/bin/bash"
    });
    expect(parseTermuxServerFrame(`{"version":1,"kind":"response","id":"${REQUEST_ID}","ok":false,"error":{"status":409,"code":"conflict","message":"busy","retryable":true}}`)).not.toBeNull();
    expect(parseTermuxServerFrame(`{"version":1,"kind":"event","streamId":"${STREAM_ID}","event":"terminal.output","payload":{"data":"5Lit5paH"}}`)).not.toBeNull();
    expect(parseTermuxServerFrame(`{"version":1,"kind":"event","streamId":"${STREAM_ID}","event":"terminal.exit","payload":{"exitCode":0,"recoverable":false}}`)).not.toBeNull();
    expect(parseTermuxServerFrame(`{"version":1,"kind":"event","streamId":"${STREAM_ID}","event":"terminal.error","payload":{"code":"unavailable","message":"closed","retryable":true}}`)).not.toBeNull();
  });

  it("keeps the checked-in golden frames valid", async () => {
    const fixtures = JSON.parse(await readFile(new URL("../fixtures/termux-protocol-v1.json", import.meta.url), "utf8")) as {
      client: string[];
      server: string[];
    };
    expect(fixtures.client.map(parseTermuxClientFrame).every(Boolean)).toBe(true);
    expect(fixtures.server.map(parseTermuxServerFrame).every(Boolean)).toBe(true);
  });
});
