import type { SupportedLocale } from "./locale.js";

export function formatBytes(value: number, locale: SupportedLocale): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = value;
  let unitIndex = 0;

  while (Math.abs(size) >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${formatNumber(size, locale, unitIndex === 0 ? 0 : 1)} ${units[unitIndex] ?? "PB"}`;
}

export function formatDate(value: string, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatTime(value: string, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatRelativeTime(value: string, locale: SupportedLocale, now = Date.now()): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  const ranges: Array<{ limit: number; divisor: number; unit: Intl.RelativeTimeFormatUnit }> = [
    { limit: 60, divisor: 1, unit: "second" },
    { limit: 60 * 60, divisor: 60, unit: "minute" },
    { limit: 24 * 60 * 60, divisor: 60 * 60, unit: "hour" },
    { limit: 7 * 24 * 60 * 60, divisor: 24 * 60 * 60, unit: "day" },
    { limit: 30 * 24 * 60 * 60, divisor: 7 * 24 * 60 * 60, unit: "week" },
    { limit: 365 * 24 * 60 * 60, divisor: 30 * 24 * 60 * 60, unit: "month" },
    { limit: Number.POSITIVE_INFINITY, divisor: 365 * 24 * 60 * 60, unit: "year" }
  ];
  const range = ranges.find((candidate) => elapsedSeconds < candidate.limit) ?? ranges[ranges.length - 1];
  if (!range) {
    return value;
  }

  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    -Math.floor(elapsedSeconds / range.divisor),
    range.unit
  );
}

function formatNumber(value: number, locale: SupportedLocale, fractionDigits: number): string {
  return formatLocaleNumber(value, locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  });
}

export function formatLocaleNumber(
  value: number,
  locale: SupportedLocale,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale, {
    ...options
  }).format(value);
}
