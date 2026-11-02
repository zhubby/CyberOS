import { describe, expect, it } from "vitest";
import { getInitialEventId } from "./events.js";

describe("session event cursors", () => {
  it("resumes reconnects after the last delivered event instead of the original snapshot", () => {
    expect(getInitialEventId("250", "100")).toBe(250);
    expect(getInitialEventId(["250"], "100")).toBe(250);
  });

  it("uses the snapshot cursor on the first connection and rejects invalid cursors", () => {
    expect(getInitialEventId(undefined, "100")).toBe(100);
    expect(getInitialEventId(undefined, undefined)).toBe(0);
    for (const invalid of ["invalid", "-1", "1.5", "Infinity", "9007199254740992"]) {
      expect(getInitialEventId(invalid, "100")).toBe(100);
      expect(getInitialEventId(undefined, invalid)).toBe(0);
    }
  });
});
