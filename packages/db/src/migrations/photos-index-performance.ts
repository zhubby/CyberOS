import type { Migration } from "./types.js";

export const photosIndexPerformanceMigrations: Migration[] = [{
  id: "008_photos_index_performance",
  sql: `
ALTER TABLE photos_scan_entries ADD COLUMN name_key TEXT;
ALTER TABLE photos_scan_entries ADD COLUMN stem_key TEXT;
ALTER TABLE photos_scan_entries ADD COLUMN media_kind TEXT;
ALTER TABLE photos_scan_entries ADD COLUMN children_processed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photos_asset_metadata ADD COLUMN fts_rowid INTEGER;

UPDATE photos_asset_metadata SET fts_rowid = f.rowid
FROM photos_metadata_fts f WHERE f.asset_id = photos_asset_metadata.asset_id;

CREATE UNIQUE INDEX idx_photos_metadata_document ON photos_asset_metadata(fts_rowid);
CREATE INDEX idx_photos_metadata_values_asset ON photos_metadata_values(asset_id);
CREATE INDEX idx_photos_scan_pending ON photos_scan_entries(job_id, entry_type, path) WHERE status = 'pending';
CREATE INDEX idx_photos_scan_retry ON photos_scan_entries(job_id, entry_type, next_retry_at, path)
  WHERE status = 'failed' AND error_retryable = 1;
CREATE INDEX idx_photos_scan_parent ON photos_scan_entries(job_id, parent_path, entry_type, status, path);
CREATE INDEX idx_photos_scan_parent_retry ON photos_scan_entries(job_id, parent_path, next_retry_at, path)
  WHERE entry_type = 'media' AND status = 'failed' AND error_retryable = 1;
CREATE INDEX idx_photos_scan_name ON photos_scan_entries(job_id, parent_path, entry_type, name_key);
CREATE INDEX idx_photos_scan_stem ON photos_scan_entries(job_id, parent_path, entry_type, stem_key, media_kind);
CREATE INDEX idx_photos_scan_directory_work ON photos_scan_entries(job_id, children_processed, path)
  WHERE entry_type = 'directory' AND status = 'completed';
CREATE INDEX idx_photos_scan_missing_keys ON photos_scan_entries(job_id, path)
  WHERE name_key IS NULL AND entry_type IN ('media', 'sidecar');
CREATE INDEX idx_photos_jobs_library_active ON photos_jobs(library_updated_at, status, lease_expires_at);
CREATE INDEX idx_photos_publish_job ON photos_publish_journal(job_id);

DROP TRIGGER trg_photos_asset_metadata_delete_indexes;
CREATE TRIGGER trg_photos_asset_metadata_delete_indexes BEFORE DELETE ON photos_asset_metadata
BEGIN
  DELETE FROM photos_geo_index WHERE metadata_rowid = OLD.rowid;
  DELETE FROM photos_metadata_fts WHERE rowid = OLD.fts_rowid;
END;
`
}];
