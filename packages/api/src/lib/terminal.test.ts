import { describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  terminalDimension,
  terminalMessage
} from "./terminal.js";

describe("terminal helpers", () => {
  it("accepts terminal dimensions only inside the supported bounds", () => {
    expect(terminalDimension(MIN_TERMINAL_COLS, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)).toBe(MIN_TERMINAL_COLS);
    expect(terminalDimension(MAX_TERMINAL_ROWS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)).toBe(MAX_TERMINAL_ROWS);
    expect(terminalDimension(1.5, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)).toBeNull();
    expect(terminalDimension(MAX_TERMINAL_COLS + 1, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)).toBeNull();
  });

  it("parses input and bounded resize messages while rejecting malformed payloads", () => {
    expect(terminalMessage(JSON.stringify({ type: "input", data: "ls\r" }))).toEqual({
      type: "input",
      data: "ls\r"
    });
    expect(terminalMessage(JSON.stringify({ type: "resize", cols: 120, rows: 32 }))).toEqual({
      type: "resize",
      cols: 120,
      rows: 32
    });
    expect(terminalMessage(JSON.stringify({ type: "resize", cols: 1, rows: 32 }))).toBeNull();
    expect(terminalMessage("not json")).toBeNull();
  });

  it("parses an explicit close message", () => {
    expect(terminalMessage(JSON.stringify({ type: "close" }))).toEqual({ type: "close" });
  });
});
