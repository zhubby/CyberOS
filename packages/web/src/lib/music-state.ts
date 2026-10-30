export interface VersionedMusicSnapshot {
  serviceInstanceId: string;
  revision: number;
  updatedAt: string;
}

export function acceptMusicSnapshot<T extends VersionedMusicSnapshot>(
  current: T | null,
  next: T,
): T {
  if (!current) return next;
  if (current.serviceInstanceId === next.serviceInstanceId)
    return next.revision >= current.revision ? next : current;
  const currentTime = Date.parse(current.updatedAt);
  const nextTime = Date.parse(next.updatedAt);
  return Number.isFinite(currentTime) &&
    (!Number.isFinite(nextTime) || nextTime < currentTime)
    ? current
    : next;
}

export function moveQueueItem(
  ids: string[],
  id: string,
  direction: -1 | 1,
): string[] {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  const result = [...ids];
  result.splice(index, 1);
  result.splice(target, 0, id);
  return result;
}

export interface MusicLyricLine {
  seconds: number | null;
  text: string;
}

export function parseMusicLyrics(text: string): MusicLyricLine[] {
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/iu)?.[1] ?? 0) / 1000;
  const timed: MusicLyricLine[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const timestamps = [
      ...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/gu),
    ];
    const content = line.replace(/\[[^\]]*\]/gu, "").trim();
    for (const stamp of timestamps) {
      const seconds =
        Number(stamp[1]) * 60 +
        Number(stamp[2]) +
        Number(`0.${stamp[3] ?? "0"}`) +
        offset;
      if (Number(stamp[2]) < 60)
        timed.push({ seconds: Math.max(0, seconds), text: content });
    }
  }
  if (timed.length)
    return timed.sort((left, right) => left.seconds! - right.seconds!);
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !/^\[[a-z]+:/iu.test(line))
    .map((line) => ({ seconds: null, text: line }));
}

export function activeLyricIndex(
  lines: MusicLyricLine[],
  seconds: number,
): number {
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.seconds === null) continue;
    if (lines[i]!.seconds! > seconds) break;
    index = i;
  }
  return index;
}

export function musicTime(seconds: number | null | undefined): string {
  const value = Math.max(0, Math.floor(seconds ?? 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
