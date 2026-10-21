import type { VodPlayerStatus } from "../api.js";

export function acceptVodPlayerStatus(
  current: VodPlayerStatus | null,
  next: VodPlayerStatus
): VodPlayerStatus {
  if (!current) return next;
  if (current.serviceInstanceId === "client-error" && next.serviceInstanceId !== "client-error") {
    return next;
  }
  if (current.serviceInstanceId === next.serviceInstanceId) {
    return next.revision >= current.revision ? next : current;
  }
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const nextUpdatedAt = Date.parse(next.updatedAt);
  if (Number.isFinite(currentUpdatedAt) && (!Number.isFinite(nextUpdatedAt) || nextUpdatedAt < currentUpdatedAt)) {
    return current;
  }
  return next;
}
