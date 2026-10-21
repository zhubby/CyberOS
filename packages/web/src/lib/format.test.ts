import { describe, expect, it } from "vitest";
import { formatFileModifiedAt, toErrorMessage } from "./format.js";

describe("format helpers", () => {
  it("normalizes unknown errors for display without translating raw API text", () => {
    expect(toErrorMessage(new Error("API failed"))).toBe("API failed");
    expect(toErrorMessage("plain failure")).toBe("plain failure");
  });

  it("formats file modification times with a fixed local shape", () => {
    const value = "2026-08-21T08:30:00.000Z";
    const date = new Date(value);
    const pad = (part: number) => String(part).padStart(2, "0");

    expect(formatFileModifiedAt(value)).toBe(
      `${String(date.getFullYear()).padStart(4, "0")}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  });
});
