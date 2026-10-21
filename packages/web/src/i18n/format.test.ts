import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatLocaleNumber, formatRelativeTime, formatTime } from "./format.js";

describe("locale-aware formatting", () => {
  it("formats bytes with locale-aware numbers and stable units", () => {
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
    expect(formatBytes(1536, "zh-CN")).toBe("1.5 KB");
  });

  it("formats dates and times with the resolved app locale", () => {
    const value = "2026-08-21T08:30:00.000Z";

    expect(formatDate(value, "en")).toBe(
      new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(value))
    );
    expect(formatDate(value, "zh-CN")).toBe(
      new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(value))
    );
    expect(formatTime(value, "en")).toBe(
      new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(value))
    );
    expect(formatTime(value, "zh-CN")).toBe(
      new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(value))
    );
  });

  it("formats standalone UI numbers with the resolved app locale", () => {
    expect(formatLocaleNumber(1234567, "en")).toBe(new Intl.NumberFormat("en").format(1234567));
    expect(formatLocaleNumber(1234567, "zh-CN")).toBe(new Intl.NumberFormat("zh-CN").format(1234567));
  });

  it("formats recent interaction times in readable relative units", () => {
    const now = Date.parse("2026-09-01T10:00:00.000Z");

    expect(formatRelativeTime("2026-09-01T09:59:30.000Z", "zh-CN", now)).toBe("30秒钟前");
    expect(formatRelativeTime("2026-09-01T09:58:00.000Z", "zh-CN", now)).toBe("2分钟前");
    expect(formatRelativeTime("2026-09-01T07:00:00.000Z", "zh-CN", now)).toBe("3小时前");
    expect(formatRelativeTime("2026-08-31T10:00:00.000Z", "zh-CN", now)).toBe("昨天");
    expect(formatRelativeTime("2026-09-01T09:58:00.000Z", "en", now)).toBe("2 minutes ago");
  });
});
