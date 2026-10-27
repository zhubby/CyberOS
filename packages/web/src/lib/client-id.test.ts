import { describe, expect, it, vi } from "vitest";
import { createClientId } from "./client-id.js";

describe("createClientId", () => {
  it("uses crypto.randomUUID when available", () => {
    const randomUUID = vi.fn(() => "native-id");

    expect(createClientId({ randomUUID })).toBe("native-id");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("uses getRandomValues when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((values: Uint8Array) => {
      values.fill(0xab);
      return values;
    });

    expect(createClientId({ getRandomValues })).toBe("abababab-abab-4bab-abab-abababababab");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("falls back when crypto UUID generation fails", () => {
    const randomUUID = vi.fn(() => {
      throw new Error("unavailable");
    });
    const getRandomValues = vi.fn((values: Uint8Array) => {
      values.fill(0);
      return values;
    });

    expect(createClientId({ randomUUID, getRandomValues })).toBe("00000000-0000-4000-8000-000000000000");
  });
});
