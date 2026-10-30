export function playbackControlTarget(selected: "browser" | "nas", browserExists: boolean): "browser" | "nas" { return browserExists ? selected : "nas"; }
export function acceptPlaybackRevision<T extends { serviceInstanceId: string; revision: number; updatedAt: string }>(current: T | null, next: T): T {
  if (!current) return next;
  if (current.serviceInstanceId === next.serviceInstanceId) return next.revision >= current.revision ? next : current;
  return Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ? current : next;
}
