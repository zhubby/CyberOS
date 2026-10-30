import type { Migration } from "./types.js";

export const photosScanContentionMigrations: Migration[] = [{
  id: "006_photos_scan_contention",
  sql: `
CREATE INDEX idx_photos_scan_entries_pending
  ON photos_scan_entries(job_id, entry_type, path) WHERE status = 'pending';
CREATE INDEX idx_photos_scan_entries_retry
  ON photos_scan_entries(job_id, entry_type, path, next_retry_at)
  WHERE status = 'failed' AND error_retryable = 1;
`
}];
