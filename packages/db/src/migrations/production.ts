import type { Migration } from "./types.js";

export const productionMigrations: Migration[] = [
  {
    id: "009_p0_operations",
    sql: `
      ALTER TABLE nas_roots ADD COLUMN mount_policy TEXT NOT NULL DEFAULT 'optional'
        CHECK (mount_policy IN ('required', 'optional'));
      ALTER TABLE nas_roots ADD COLUMN expected_source TEXT;
      ALTER TABLE nas_roots ADD COLUMN expected_uuid TEXT;
      ALTER TABLE nas_roots ADD COLUMN expected_fstype TEXT;

      ALTER TABLE index_runs ADD COLUMN duration_ms INTEGER;
      ALTER TABLE index_runs ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE index_runs ADD COLUMN file_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE index_runs ADD COLUMN text_file_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE index_runs ADD COLUMN phase TEXT;
      ALTER TABLE index_runs ADD COLUMN current_path TEXT;
      ALTER TABLE index_runs ADD COLUMN last_progress_at TEXT;

      CREATE TABLE IF NOT EXISTS nas_root_readiness (
        root_id TEXT PRIMARY KEY REFERENCES nas_roots(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('ready', 'not_ready', 'unknown', 'config_invalid')),
        checked_at TEXT NOT NULL,
        reason TEXT,
        source TEXT,
        uuid TEXT,
        fstype TEXT
      );

      CREATE TABLE IF NOT EXISTS backup_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly', 'check', 'restore')),
        status TEXT NOT NULL CHECK (status IN ('validating', 'running', 'completed', 'failed', 'interrupted')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        snapshot_ids_json TEXT NOT NULL DEFAULT '[]',
        files INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS backup_failures (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
        root_id TEXT REFERENCES nas_roots(id) ON DELETE CASCADE,
        path TEXT,
        code TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at ON backup_runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_backup_failures_run_id ON backup_failures(run_id);
      CREATE TRIGGER IF NOT EXISTS trg_backup_failures_root_matches_run
      BEFORE INSERT ON backup_failures
      WHEN NEW.root_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM nas_root_readiness WHERE root_id = NEW.root_id
      ) AND NOT EXISTS (
        SELECT 1 FROM nas_roots WHERE id = NEW.root_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'backup failure root does not exist');
      END;

      CREATE TABLE IF NOT EXISTS health_alerts (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        scope TEXT NOT NULL,
        root_id TEXT REFERENCES nas_roots(id) ON DELETE CASCADE,
        severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
        status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT,
        details TEXT,
        UNIQUE(code, scope)
      );
      CREATE INDEX IF NOT EXISTS idx_health_alerts_status_last_seen ON health_alerts(status, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS execution_locks (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
    `
  },
  {
    id: "010_index_run_history_archive",
    sql: `
      CREATE TABLE IF NOT EXISTS index_run_history (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        scanned INTEGER NOT NULL DEFAULT 0,
        indexed INTEGER NOT NULL DEFAULT 0,
        unchanged INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        duration_ms INTEGER,
        bytes INTEGER NOT NULL DEFAULT 0,
        file_count INTEGER NOT NULL DEFAULT 0,
        text_file_count INTEGER NOT NULL DEFAULT 0,
        phase TEXT,
        current_path TEXT,
        last_progress_at TEXT,
        failures_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_index_run_history_root_started_at ON index_run_history(root_id, started_at DESC);
    `
  },
  {
    id: "011_storage_pool_delete",
    disableForeignKeys: true,
    sql: `
      PRAGMA legacy_alter_table = ON;

      ALTER TABLE storage_operations RENAME TO storage_operations_old;

      CREATE TABLE storage_operations (
        id TEXT PRIMARY KEY,
        approval_id TEXT REFERENCES pending_approvals(id) ON DELETE SET NULL,
        action TEXT NOT NULL CHECK (action IN ('create_pool', 'delete_pool')),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'applied', 'failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO storage_operations (id, approval_id, action, target_id, status, metadata_json, created_at, updated_at)
      SELECT id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
      FROM storage_operations_old;

      DROP TABLE storage_operations_old;

      PRAGMA legacy_alter_table = OFF;

      CREATE INDEX IF NOT EXISTS idx_storage_operations_created_at
        ON storage_operations(created_at);
    `
  },
  {
    id: "012_docker_resource_create",
    disableForeignKeys: true,
    sql: `
      PRAGMA legacy_alter_table = ON;

      ALTER TABLE docker_operations RENAME TO docker_operations_old;

      CREATE TABLE docker_operations (
        id TEXT PRIMARY KEY,
        approval_id TEXT REFERENCES pending_approvals(id) ON DELETE SET NULL,
        action TEXT NOT NULL CHECK (action IN ('create', 'start', 'stop', 'restart', 'remove', 'compose_up', 'compose_down', 'compose_pull', 'compose_restart', 'console')),
        target_type TEXT NOT NULL CHECK (target_type IN ('container', 'compose_project', 'console', 'volume', 'network')),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'applied', 'failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO docker_operations (
        id, approval_id, action, target_type, target_id, status, metadata_json, created_at, updated_at
      )
      SELECT id, approval_id, action, target_type, target_id, status, metadata_json, created_at, updated_at
      FROM docker_operations_old;

      DROP TABLE docker_operations_old;

      PRAGMA legacy_alter_table = OFF;

      CREATE INDEX IF NOT EXISTS idx_docker_operations_created_at
        ON docker_operations(created_at);
    `
  },
  {
    id: "013_download_tasks",
    sql: `
      CREATE TABLE IF NOT EXISTS download_tasks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE RESTRICT,
        storage_pool_id TEXT NOT NULL,
        target_directory TEXT NOT NULL,
        target_file_name TEXT NOT NULL,
        target_path TEXT NOT NULL,
        partial_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
        received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
        total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
        speed_bytes_per_second INTEGER NOT NULL DEFAULT 0 CHECK (speed_bytes_per_second >= 0),
        etag TEXT,
        last_modified TEXT,
        error TEXT,
        worker_id TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        last_progress_at TEXT,
        file_operation_id TEXT REFERENCES file_operations(id) ON DELETE SET NULL,
        UNIQUE(root_id, storage_pool_id, target_path)
      );

      CREATE INDEX IF NOT EXISTS idx_download_tasks_status_created_at
        ON download_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_download_tasks_updated_at
        ON download_tasks(updated_at DESC);
    `
  },
  {
    id: "014_operation_notifications",
    sql: `
      CREATE TABLE IF NOT EXISTS operation_notifications (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'docker', 'vm', 'storage', 'share')),
        status TEXT NOT NULL CHECK (status IN ('pending_approval', 'running', 'succeeded', 'failed', 'rejected', 'cancelled')),
        summary TEXT NOT NULL,
        error TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_operation_notifications_updated_at
        ON operation_notifications(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_operation_notifications_unread_updated_at
        ON operation_notifications(read_at, updated_at DESC);
    `
  },
  {
    id: "015_terminal_tabs",
    sql: `
      CREATE TABLE IF NOT EXISTS terminal_tabs (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        custom_title TEXT CHECK (
          custom_title IS NULL OR (length(custom_title) BETWEEN 1 AND 64 AND custom_title = trim(custom_title))
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(root_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_terminal_tabs_root_ordinal
        ON terminal_tabs(root_id, ordinal);

      CREATE TABLE IF NOT EXISTS terminal_tab_sets (
        root_id TEXT PRIMARY KEY REFERENCES nas_roots(id) ON DELETE CASCADE,
        active_tab_id TEXT,
        next_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (next_ordinal > 0),
        initialized_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS trg_terminal_tab_sets_active_insert
      BEFORE INSERT ON terminal_tab_sets
      WHEN NEW.active_tab_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM terminal_tabs
        WHERE id = NEW.active_tab_id AND root_id = NEW.root_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'active terminal tab must belong to root');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_terminal_tab_sets_active_update
      BEFORE UPDATE OF active_tab_id, root_id ON terminal_tab_sets
      WHEN NEW.active_tab_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM terminal_tabs
        WHERE id = NEW.active_tab_id AND root_id = NEW.root_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'active terminal tab must belong to root');
      END;
    `
  },
  {
    id: "016_hostd_config",
    sql: `
      UPDATE system_settings
      SET value_json = json_remove(value_json, '$.helperSocketPath')
      WHERE key = 'share_settings'
        AND json_valid(value_json)
        AND json_type(value_json, '$.helperSocketPath') IS NOT NULL;
    `
  },
  {
    id: "017_photo_library",
    sql: `
      CREATE TABLE IF NOT EXISTS photo_assets (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE CASCADE,
        storage_pool_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
        content_hash TEXT,
        width INTEGER CHECK (width IS NULL OR width > 0),
        height INTEGER CHECK (height IS NULL OR height > 0),
        orientation INTEGER,
        taken_at TEXT NOT NULL,
        taken_at_source TEXT NOT NULL CHECK (taken_at_source IN ('exif', 'file_mtime')),
        thumbnail_key TEXT,
        preview_key TEXT,
        status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
        error TEXT,
        library_updated_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(root_id, storage_pool_id, path)
      );

      CREATE INDEX IF NOT EXISTS idx_photo_assets_timeline
        ON photo_assets(library_updated_at, status, taken_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_photo_assets_content_hash
        ON photo_assets(library_updated_at, content_hash)
        WHERE content_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS photo_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('full_scan', 'path_refresh')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE CASCADE,
        storage_pool_id TEXT NOT NULL,
        path TEXT NOT NULL,
        library_updated_at TEXT NOT NULL,
        scanned INTEGER NOT NULL DEFAULT 0 CHECK (scanned >= 0),
        processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),
        failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
        current_path TEXT,
        error TEXT,
        worker_id TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_photo_jobs_status_created_at
        ON photo_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_photo_jobs_library_created_at
        ON photo_jobs(library_updated_at, created_at DESC);
    `
  },
  {
    id: "018_photo_upload_reservations",
    sql: `
      CREATE TABLE IF NOT EXISTS photo_upload_reservations (
        id TEXT PRIMARY KEY,
        library_updated_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(library_updated_at, content_hash),
        UNIQUE(library_updated_at, path)
      );

      CREATE INDEX IF NOT EXISTS idx_photo_upload_reservations_created_at
        ON photo_upload_reservations(library_updated_at, created_at);
    `
  },
  {
    id: "019_photo_metadata_index",
    sql: `
      CREATE TABLE IF NOT EXISTS photo_asset_metadata (
        asset_id TEXT PRIMARY KEY REFERENCES photo_assets(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        status TEXT NOT NULL CHECK (status IN ('ready', 'partial')),
        media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video', 'raw')),
        captured_at TEXT,
        captured_at_local TEXT,
        capture_offset_minutes INTEGER,
        capture_source TEXT NOT NULL CHECK (
          capture_source IN ('sidecar_xmp', 'embedded_xmp', 'iptc', 'exif', 'video', 'file_mtime')
        ),
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        container TEXT,
        video_codec TEXT,
        audio_codec TEXT,
        camera_make TEXT,
        camera_model TEXT,
        software TEXT,
        body_serial TEXT,
        lens_make TEXT,
        lens_model TEXT,
        lens_serial TEXT,
        iso REAL CHECK (iso IS NULL OR iso >= 0),
        exposure_time_seconds REAL CHECK (exposure_time_seconds IS NULL OR exposure_time_seconds >= 0),
        aperture REAL CHECK (aperture IS NULL OR aperture >= 0),
        focal_length_mm REAL CHECK (focal_length_mm IS NULL OR focal_length_mm >= 0),
        focal_length_35_mm REAL CHECK (focal_length_35_mm IS NULL OR focal_length_35_mm >= 0),
        exposure_bias_ev REAL,
        exposure_program TEXT,
        metering_mode TEXT,
        flash TEXT,
        white_balance TEXT,
        title TEXT,
        description TEXT,
        creator TEXT,
        copyright TEXT,
        rating REAL,
        gps_latitude REAL CHECK (gps_latitude IS NULL OR (gps_latitude >= -90 AND gps_latitude <= 90)),
        gps_longitude REAL CHECK (gps_longitude IS NULL OR (gps_longitude >= -180 AND gps_longitude <= 180)),
        gps_altitude_m REAL,
        gps_direction_deg REAL,
        raw_metadata_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        sidecar_path TEXT,
        sidecar_size_bytes INTEGER CHECK (sidecar_size_bytes IS NULL OR sidecar_size_bytes >= 0),
        sidecar_mtime_ms INTEGER CHECK (sidecar_mtime_ms IS NULL OR sidecar_mtime_ms >= 0),
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_photo_asset_metadata_version
        ON photo_asset_metadata(schema_version, status);
      CREATE INDEX IF NOT EXISTS idx_photo_asset_metadata_camera
        ON photo_asset_metadata(camera_model, asset_id);
      CREATE INDEX IF NOT EXISTS idx_photo_asset_metadata_lens
        ON photo_asset_metadata(lens_model, asset_id);
      CREATE INDEX IF NOT EXISTS idx_photo_asset_metadata_capture
        ON photo_asset_metadata(captured_at, asset_id);
      CREATE INDEX IF NOT EXISTS idx_photo_asset_metadata_rating
        ON photo_asset_metadata(rating, asset_id);

      CREATE TABLE IF NOT EXISTS photo_keywords (
        asset_id TEXT NOT NULL REFERENCES photo_assets(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        normalized_keyword TEXT NOT NULL,
        PRIMARY KEY(asset_id, normalized_keyword)
      );

      CREATE INDEX IF NOT EXISTS idx_photo_keywords_value
        ON photo_keywords(normalized_keyword, asset_id);

      CREATE TABLE IF NOT EXISTS photo_metadata_values (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL REFERENCES photo_assets(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'boolean')),
        text_value TEXT,
        normalized_text_value TEXT,
        number_value REAL,
        date_value TEXT,
        boolean_value INTEGER CHECK (boolean_value IS NULL OR boolean_value IN (0, 1)),
        sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0)
      );

      CREATE INDEX IF NOT EXISTS idx_photo_metadata_values_key_type
        ON photo_metadata_values(key, value_type, asset_id);
      CREATE INDEX IF NOT EXISTS idx_photo_metadata_values_text
        ON photo_metadata_values(key, normalized_text_value, asset_id)
        WHERE normalized_text_value IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_photo_metadata_values_number
        ON photo_metadata_values(key, number_value, asset_id)
        WHERE number_value IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_photo_metadata_values_date
        ON photo_metadata_values(key, date_value, asset_id)
        WHERE date_value IS NOT NULL;

      CREATE VIRTUAL TABLE IF NOT EXISTS photo_metadata_fts USING fts5(
        asset_id UNINDEXED,
        name,
        path,
        title,
        description,
        creator,
        copyright,
        keywords,
        camera,
        lens,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS photo_geo_index USING rtree(
        metadata_rowid,
        min_latitude,
        max_latitude,
        min_longitude,
        max_longitude
      );

      CREATE TRIGGER IF NOT EXISTS trg_photo_asset_metadata_delete_indexes
      BEFORE DELETE ON photo_asset_metadata
      BEGIN
        DELETE FROM photo_geo_index WHERE metadata_rowid = OLD.rowid;
        DELETE FROM photo_metadata_fts WHERE asset_id = OLD.asset_id;
      END;
    `
  },
  {
    id: "020_docker_compose_apps",
    sql: `
      CREATE TABLE IF NOT EXISTS docker_apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_key TEXT NOT NULL UNIQUE COLLATE NOCASE,
        compose_content TEXT NOT NULL,
        services_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        risk TEXT NOT NULL CHECK (risk IN ('medium', 'high')),
        revision TEXT NOT NULL,
        deployed_revision TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS docker_app_environment (
        app_id TEXT NOT NULL REFERENCES docker_apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_docker_apps_updated_at
        ON docker_apps(updated_at DESC);
    `
  },
  {
    id: "021_vm_direct_actions",
    disableForeignKeys: true,
    sql: `
      UPDATE vm_operations
      SET status = 'failed',
          metadata_json = json_set(
            metadata_json,
            '$.error',
            'VM approval retired because VM actions now execute directly',
            '$.failedAt',
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status IN ('proposed', 'approved')
        AND approval_id IN (
          SELECT id FROM pending_approvals
          WHERE kind = 'vm_operation' AND status IN ('pending', 'approved')
        );

      UPDATE jobs
      SET status = 'cancelled',
          error = 'VM approval retired because VM actions now execute directly',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'waiting_approval'
        AND id IN (
          SELECT job_id FROM pending_approvals
          WHERE kind = 'vm_operation' AND status IN ('pending', 'approved')
        );

      UPDATE operation_notifications
      SET status = 'cancelled',
          error = 'VM approval retired because VM actions now execute directly',
          read_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE job_id IN (
        SELECT job_id FROM pending_approvals
        WHERE kind = 'vm_operation' AND status IN ('pending', 'approved')
      );

      UPDATE pending_approvals
      SET status = 'expired',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE kind = 'vm_operation' AND status IN ('pending', 'approved');

      PRAGMA legacy_alter_table = ON;

      ALTER TABLE vm_console_authorizations RENAME TO vm_console_authorizations_old;

      CREATE TABLE vm_console_authorizations (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES vm_operations(id) ON DELETE CASCADE,
        approval_id TEXT REFERENCES pending_approvals(id) ON DELETE CASCADE,
        domain_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'used', 'expired', 'failed')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );

      INSERT INTO vm_console_authorizations
        (id, operation_id, approval_id, domain_name, status, created_at, expires_at, used_at)
      SELECT id, operation_id, approval_id, domain_name, status, created_at, expires_at, used_at
      FROM vm_console_authorizations_old;

      DROP TABLE vm_console_authorizations_old;

      PRAGMA legacy_alter_table = OFF;

      CREATE INDEX idx_vm_console_authorizations_status_expires_at
        ON vm_console_authorizations(status, expires_at);
    `
  },
  {
    id: "022_downloader_reliability",
    sql: `
      ALTER TABLE download_tasks ADD COLUMN phase TEXT
        CHECK (phase IS NULL OR phase IN ('probing', 'downloading', 'verifying', 'publishing', 'retry_wait'));
      ALTER TABLE download_tasks ADD COLUMN download_mode TEXT
        CHECK (download_mode IS NULL OR download_mode IN ('single', 'segmented'));
      ALTER TABLE download_tasks ADD COLUMN expected_sha256 TEXT
        CHECK (expected_sha256 IS NULL OR (length(expected_sha256) = 64 AND expected_sha256 = lower(expected_sha256)));
      ALTER TABLE download_tasks ADD COLUMN actual_sha256 TEXT
        CHECK (actual_sha256 IS NULL OR (length(actual_sha256) = 64 AND actual_sha256 = lower(actual_sha256)));
      ALTER TABLE download_tasks ADD COLUMN error_code TEXT;
      ALTER TABLE download_tasks ADD COLUMN error_retryable INTEGER NOT NULL DEFAULT 0
        CHECK (error_retryable IN (0, 1));
      ALTER TABLE download_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0
        CHECK (retry_count >= 0);
      ALTER TABLE download_tasks ADD COLUMN next_retry_at TEXT;
      ALTER TABLE download_tasks ADD COLUMN control_requested TEXT
        CHECK (control_requested IS NULL OR control_requested IN ('pause', 'cancel'));
      ALTER TABLE download_tasks ADD COLUMN segment_count INTEGER NOT NULL DEFAULT 0
        CHECK (segment_count >= 0);

      CREATE TABLE download_segments (
        task_id TEXT NOT NULL REFERENCES download_tasks(id) ON DELETE CASCADE,
        start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
        end_byte INTEGER NOT NULL CHECK (end_byte > start_byte),
        next_byte INTEGER NOT NULL CHECK (next_byte >= start_byte AND next_byte <= end_byte),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, start_byte)
      );

      CREATE TABLE download_publish_journal (
        task_id TEXT PRIMARY KEY REFERENCES download_tasks(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL UNIQUE,
        worker_id TEXT NOT NULL,
        device INTEGER NOT NULL,
        inode INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE download_space_reservations (
        task_id TEXT PRIMARY KEY REFERENCES download_tasks(id) ON DELETE CASCADE,
        storage_pool_id TEXT NOT NULL,
        reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE download_workers (
        worker_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );

      CREATE INDEX idx_download_tasks_claim
        ON download_tasks(status, next_retry_at, created_at);
      CREATE INDEX idx_download_workers_heartbeat
        ON download_workers(heartbeat_at DESC);
    `
  },
  {
    id: "023_photostaff_reliability",
    disableForeignKeys: true,
    sql: `
      CREATE TABLE photostaff_assets (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE CASCADE,
        storage_pool_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
        content_hash TEXT,
        width INTEGER CHECK (width IS NULL OR width > 0),
        height INTEGER CHECK (height IS NULL OR height > 0),
        orientation INTEGER,
        taken_at TEXT NOT NULL,
        taken_at_source TEXT NOT NULL CHECK (taken_at_source IN ('exif', 'file_mtime')),
        thumbnail_key TEXT,
        preview_key TEXT,
        status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
        error TEXT,
        error_code TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0, 1)),
        source_device INTEGER,
        source_inode INTEGER,
        source_size_bytes INTEGER CHECK (source_size_bytes IS NULL OR source_size_bytes >= 0),
        source_mtime_ns INTEGER,
        source_ctime_ns INTEGER,
        sidecar_path TEXT,
        sidecar_device INTEGER,
        sidecar_inode INTEGER,
        sidecar_size_bytes INTEGER CHECK (sidecar_size_bytes IS NULL OR sidecar_size_bytes >= 0),
        sidecar_mtime_ns INTEGER,
        sidecar_ctime_ns INTEGER,
        derivative_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (derivative_schema_version > 0),
        scan_generation TEXT,
        library_updated_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(root_id, storage_pool_id, path)
      );

      INSERT INTO photostaff_assets (
        id, root_id, storage_pool_id, path, name, mime_type, size_bytes, mtime_ms,
        content_hash, width, height, orientation, taken_at, taken_at_source,
        thumbnail_key, preview_key, status, error, source_size_bytes, source_mtime_ns,
        derivative_schema_version, scan_generation, library_updated_at, indexed_at
      )
      SELECT id, root_id, storage_pool_id, path, name, mime_type, size_bytes, mtime_ms,
        content_hash, width, height, orientation, taken_at, taken_at_source,
        thumbnail_key, preview_key, status, error, size_bytes, mtime_ms * 1000000,
        1, NULL, library_updated_at, indexed_at
      FROM photo_assets;

      CREATE INDEX idx_photostaff_assets_timeline
        ON photostaff_assets(library_updated_at, status, taken_at DESC, id DESC);
      CREATE INDEX idx_photostaff_assets_content_hash
        ON photostaff_assets(library_updated_at, content_hash)
        WHERE content_hash IS NOT NULL;

      CREATE TABLE photostaff_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('full_scan', 'path_refresh')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retrying', 'completed', 'failed')),
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE CASCADE,
        storage_pool_id TEXT NOT NULL,
        path TEXT NOT NULL,
        library_updated_at TEXT NOT NULL,
        scanned INTEGER NOT NULL DEFAULT 0 CHECK (scanned >= 0),
        processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),
        failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
        current_path TEXT,
        phase TEXT CHECK (phase IS NULL OR phase IN ('discovering', 'processing', 'publishing', 'cleanup', 'retry_wait')),
        error TEXT,
        error_code TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0, 1)),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        next_retry_at TEXT,
        scan_generation TEXT NOT NULL,
        worker_id TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      INSERT INTO photostaff_jobs (
        id, kind, status, root_id, storage_pool_id, path, library_updated_at,
        scanned, processed, failed, current_path, error, scan_generation,
        worker_id, lease_expires_at, created_at, updated_at, started_at, finished_at
      )
      SELECT id, kind, CASE WHEN status = 'running' THEN 'queued' ELSE status END,
        root_id, storage_pool_id, path, library_updated_at, scanned, processed,
        failed, current_path, error, id, NULL, NULL, created_at, updated_at,
        CASE WHEN status = 'running' THEN NULL ELSE started_at END,
        CASE WHEN status = 'running' THEN NULL ELSE finished_at END
      FROM photo_jobs;

      CREATE INDEX idx_photostaff_jobs_claim
        ON photostaff_jobs(status, next_retry_at, created_at);
      CREATE INDEX idx_photostaff_jobs_library_created_at
        ON photostaff_jobs(library_updated_at, created_at DESC);

      CREATE TABLE photostaff_upload_reservations (
        id TEXT PRIMARY KEY,
        library_updated_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(library_updated_at, content_hash),
        UNIQUE(library_updated_at, path)
      );
      INSERT INTO photostaff_upload_reservations
        SELECT * FROM photo_upload_reservations;
      CREATE INDEX idx_photostaff_upload_reservations_created_at
        ON photostaff_upload_reservations(library_updated_at, created_at);

      CREATE TABLE photostaff_asset_metadata (
        asset_id TEXT PRIMARY KEY REFERENCES photostaff_assets(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        status TEXT NOT NULL CHECK (status IN ('ready', 'partial')),
        media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video', 'raw')),
        captured_at TEXT,
        captured_at_local TEXT,
        capture_offset_minutes INTEGER,
        capture_source TEXT NOT NULL CHECK (
          capture_source IN ('sidecar_xmp', 'embedded_xmp', 'iptc', 'exif', 'video', 'file_mtime')
        ),
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        container TEXT,
        video_codec TEXT,
        audio_codec TEXT,
        camera_make TEXT,
        camera_model TEXT,
        software TEXT,
        body_serial TEXT,
        lens_make TEXT,
        lens_model TEXT,
        lens_serial TEXT,
        iso REAL CHECK (iso IS NULL OR iso >= 0),
        exposure_time_seconds REAL CHECK (exposure_time_seconds IS NULL OR exposure_time_seconds >= 0),
        aperture REAL CHECK (aperture IS NULL OR aperture >= 0),
        focal_length_mm REAL CHECK (focal_length_mm IS NULL OR focal_length_mm >= 0),
        focal_length_35_mm REAL CHECK (focal_length_35_mm IS NULL OR focal_length_35_mm >= 0),
        exposure_bias_ev REAL,
        exposure_program TEXT,
        metering_mode TEXT,
        flash TEXT,
        white_balance TEXT,
        title TEXT,
        description TEXT,
        creator TEXT,
        copyright TEXT,
        rating REAL,
        gps_latitude REAL CHECK (gps_latitude IS NULL OR (gps_latitude >= -90 AND gps_latitude <= 90)),
        gps_longitude REAL CHECK (gps_longitude IS NULL OR (gps_longitude >= -180 AND gps_longitude <= 180)),
        gps_altitude_m REAL,
        gps_direction_deg REAL,
        raw_metadata_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        sidecar_path TEXT,
        sidecar_size_bytes INTEGER CHECK (sidecar_size_bytes IS NULL OR sidecar_size_bytes >= 0),
        sidecar_mtime_ms INTEGER CHECK (sidecar_mtime_ms IS NULL OR sidecar_mtime_ms >= 0),
        updated_at TEXT NOT NULL
      );

      INSERT INTO photostaff_asset_metadata (
        rowid, asset_id, schema_version, status, media_kind, captured_at,
        captured_at_local, capture_offset_minutes, capture_source, duration_ms,
        container, video_codec, audio_codec, camera_make, camera_model, software,
        body_serial, lens_make, lens_model, lens_serial, iso, exposure_time_seconds,
        aperture, focal_length_mm, focal_length_35_mm, exposure_bias_ev,
        exposure_program, metering_mode, flash, white_balance, title, description,
        creator, copyright, rating, gps_latitude, gps_longitude, gps_altitude_m,
        gps_direction_deg, raw_metadata_json, warnings_json, sidecar_path,
        sidecar_size_bytes, sidecar_mtime_ms, updated_at
      )
      SELECT rowid, asset_id, schema_version, status, media_kind, captured_at,
        captured_at_local, capture_offset_minutes, capture_source, duration_ms,
        container, video_codec, audio_codec, camera_make, camera_model, software,
        body_serial, lens_make, lens_model, lens_serial, iso, exposure_time_seconds,
        aperture, focal_length_mm, focal_length_35_mm, exposure_bias_ev,
        exposure_program, metering_mode, flash, white_balance, title, description,
        creator, copyright, rating, gps_latitude, gps_longitude, gps_altitude_m,
        gps_direction_deg, raw_metadata_json, warnings_json, sidecar_path,
        sidecar_size_bytes, sidecar_mtime_ms, updated_at
      FROM photo_asset_metadata;

      CREATE INDEX idx_photostaff_asset_metadata_version
        ON photostaff_asset_metadata(schema_version, status);
      CREATE INDEX idx_photostaff_asset_metadata_camera
        ON photostaff_asset_metadata(camera_model, asset_id);
      CREATE INDEX idx_photostaff_asset_metadata_lens
        ON photostaff_asset_metadata(lens_model, asset_id);
      CREATE INDEX idx_photostaff_asset_metadata_capture
        ON photostaff_asset_metadata(captured_at, asset_id);
      CREATE INDEX idx_photostaff_asset_metadata_rating
        ON photostaff_asset_metadata(rating, asset_id);

      CREATE TABLE photostaff_keywords (
        asset_id TEXT NOT NULL REFERENCES photostaff_assets(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        normalized_keyword TEXT NOT NULL,
        PRIMARY KEY(asset_id, normalized_keyword)
      );
      INSERT INTO photostaff_keywords SELECT * FROM photo_keywords;
      CREATE INDEX idx_photostaff_keywords_value
        ON photostaff_keywords(normalized_keyword, asset_id);

      CREATE TABLE photostaff_metadata_values (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL REFERENCES photostaff_assets(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'date', 'boolean')),
        text_value TEXT,
        normalized_text_value TEXT,
        number_value REAL,
        date_value TEXT,
        boolean_value INTEGER CHECK (boolean_value IS NULL OR boolean_value IN (0, 1)),
        sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0)
      );
      INSERT INTO photostaff_metadata_values SELECT * FROM photo_metadata_values;
      CREATE INDEX idx_photostaff_metadata_values_key_type
        ON photostaff_metadata_values(key, value_type, asset_id);
      CREATE INDEX idx_photostaff_metadata_values_text
        ON photostaff_metadata_values(key, normalized_text_value, asset_id)
        WHERE normalized_text_value IS NOT NULL;
      CREATE INDEX idx_photostaff_metadata_values_number
        ON photostaff_metadata_values(key, number_value, asset_id)
        WHERE number_value IS NOT NULL;
      CREATE INDEX idx_photostaff_metadata_values_date
        ON photostaff_metadata_values(key, date_value, asset_id)
        WHERE date_value IS NOT NULL;

      CREATE VIRTUAL TABLE photostaff_metadata_fts USING fts5(
        asset_id UNINDEXED, name, path, title, description, creator, copyright,
        keywords, camera, lens, tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO photostaff_metadata_fts (
        rowid, asset_id, name, path, title, description, creator, copyright,
        keywords, camera, lens
      )
      SELECT rowid, asset_id, name, path, title, description, creator, copyright,
        keywords, camera, lens FROM photo_metadata_fts;

      CREATE VIRTUAL TABLE photostaff_geo_index USING rtree(
        metadata_rowid, min_latitude, max_latitude, min_longitude, max_longitude
      );
      INSERT INTO photostaff_geo_index SELECT * FROM photo_geo_index;

      CREATE TRIGGER trg_photostaff_asset_metadata_delete_indexes
      BEFORE DELETE ON photostaff_asset_metadata
      BEGIN
        DELETE FROM photostaff_geo_index WHERE metadata_rowid = OLD.rowid;
        DELETE FROM photostaff_metadata_fts WHERE asset_id = OLD.asset_id;
      END;

      CREATE TABLE photostaff_scan_entries (
        job_id TEXT NOT NULL REFERENCES photostaff_jobs(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        entry_type TEXT NOT NULL CHECK (entry_type IN ('directory', 'media', 'sidecar')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
        parent_path TEXT,
        error TEXT,
        error_code TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0, 1)),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        next_retry_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(job_id, path)
      );
      CREATE INDEX idx_photostaff_scan_entries_claim
        ON photostaff_scan_entries(job_id, status, next_retry_at, path);

      CREATE TABLE photostaff_publish_journal (
        operation_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES photostaff_jobs(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        thumbnail_temp_path TEXT,
        thumbnail_path TEXT,
        preview_temp_path TEXT,
        preview_path TEXT,
        source_device INTEGER NOT NULL,
        source_inode INTEGER NOT NULL,
        source_size_bytes INTEGER NOT NULL CHECK (source_size_bytes >= 0),
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE photostaff_space_reservations (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES photostaff_jobs(id) ON DELETE CASCADE,
        storage_pool_id TEXT NOT NULL,
        path TEXT NOT NULL,
        reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_photostaff_space_reservations_pool
        ON photostaff_space_reservations(storage_pool_id);

      CREATE TABLE photostaff_workers (
        worker_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
      CREATE INDEX idx_photostaff_workers_heartbeat
        ON photostaff_workers(heartbeat_at DESC);

      INSERT OR IGNORE INTO system_settings (key, value_json, updated_at)
      SELECT 'photostaff_library_settings', value_json, updated_at
      FROM system_settings WHERE key = 'photo_library';
      INSERT OR IGNORE INTO system_settings (key, value_json, updated_at)
      SELECT 'photostaff_map_settings', value_json, updated_at
      FROM system_settings WHERE key = 'photo_map_settings';
      INSERT OR IGNORE INTO system_settings (key, value_json, updated_at)
      VALUES (
        'photostaff_processing_settings',
        json_object(
          'processingConcurrency', 1,
          'scanIntervalMs', 1800000,
          'maxAutoRetries', 5,
          'retryBaseDelayMs', 2000,
          'retryMaxDelayMs', 300000,
          'commandTimeoutMs', 120000,
          'maxFileSizeBytes', 536870912,
          'maxXmpSizeBytes', 16777216,
          'maxIntermediateBytes', 2147483648,
          'minFreeSpaceBytes', 0,
          'maxDecodedPixels', 268402689,
          'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
      DELETE FROM system_settings WHERE key IN ('photo_library', 'photo_map_settings');

      DROP TRIGGER IF EXISTS trg_photo_asset_metadata_delete_indexes;
      DROP TABLE photo_geo_index;
      DROP TABLE photo_metadata_fts;
      DROP TABLE photo_metadata_values;
      DROP TABLE photo_keywords;
      DROP TABLE photo_asset_metadata;
      DROP TABLE photo_upload_reservations;
      DROP TABLE photo_jobs;
      DROP TABLE photo_assets;
    `
  },
  {
    id: "024_rust_indexer",
    sql: `
      CREATE TABLE IF NOT EXISTS indexed_files (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        hash TEXT,
        indexed_at TEXT NOT NULL,
        UNIQUE(root_id, path)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS indexed_text USING fts5(
        file_id UNINDEXED, root_id UNINDEXED, path, name, body
      );

      ALTER TABLE indexed_files ADD COLUMN storage_pool_id TEXT;
      ALTER TABLE indexed_files ADD COLUMN source_device INTEGER;
      ALTER TABLE indexed_files ADD COLUMN source_inode INTEGER;
      ALTER TABLE indexed_files ADD COLUMN source_size_bytes INTEGER
        CHECK (source_size_bytes IS NULL OR source_size_bytes >= 0);
      ALTER TABLE indexed_files ADD COLUMN source_mtime_ns INTEGER;
      ALTER TABLE indexed_files ADD COLUMN source_ctime_ns INTEGER;
      ALTER TABLE indexed_files ADD COLUMN scan_generation TEXT;
      ALTER TABLE indexed_files ADD COLUMN extraction_source TEXT
        CHECK (extraction_source IS NULL OR extraction_source IN ('plain_text', 'pdftotext', 'docx', 'xlsx', 'pptx', 'ocr'));
      ALTER TABLE indexed_files ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (extraction_status IN ('pending', 'ready', 'stale', 'error', 'skipped'));
      ALTER TABLE indexed_files ADD COLUMN extraction_error TEXT;

      ALTER TABLE index_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'full'
        CHECK (kind IN ('full', 'incremental', 'manual'));
      ALTER TABLE index_run_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'full'
        CHECK (kind IN ('full', 'incremental', 'manual'));

      CREATE TABLE index_queue (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE CASCADE,
        storage_pool_id TEXT,
        path TEXT NOT NULL,
        recursive INTEGER NOT NULL DEFAULT 0 CHECK (recursive IN (0, 1)),
        kind TEXT NOT NULL CHECK (kind IN ('full', 'incremental', 'manual')),
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'retrying', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        next_retry_at TEXT,
        worker_id TEXT,
        lease_expires_at TEXT,
        error TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(root_id, path)
      );
      CREATE INDEX idx_index_queue_claim
        ON index_queue(status, next_retry_at, priority DESC, created_at);
      CREATE INDEX idx_index_queue_root
        ON index_queue(root_id, status, updated_at);

      CREATE TABLE index_content_state (
        root_id TEXT PRIMARY KEY REFERENCES nas_roots(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'legacy'
          CHECK (status IN ('legacy', 'copying', 'rebuilding', 'ready', 'failed')),
        legacy_cursor INTEGER NOT NULL DEFAULT 0 CHECK (legacy_cursor >= 0),
        copied_count INTEGER NOT NULL DEFAULT 0 CHECK (copied_count >= 0),
        legacy_total INTEGER NOT NULL DEFAULT 0 CHECK (legacy_total >= 0),
        error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE indexed_content_fts USING fts5(
        file_id UNINDEXED,
        root_id UNINDEXED,
        path,
        name,
        body,
        terms,
        tokenize = 'unicode61 remove_diacritics 2',
        prefix = '2 3'
      );

      CREATE TABLE indexer_workers (
        worker_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
      CREATE INDEX idx_indexer_workers_heartbeat
        ON indexer_workers(heartbeat_at DESC);

      CREATE TABLE index_root_state (
        root_id TEXT PRIMARY KEY REFERENCES nas_roots(id) ON DELETE CASCADE,
        watcher_status TEXT NOT NULL DEFAULT 'starting'
          CHECK (watcher_status IN ('starting', 'ready', 'degraded', 'unsupported')),
        watcher_error TEXT,
        reconcile_requested INTEGER NOT NULL DEFAULT 1 CHECK (reconcile_requested IN (0, 1)),
        active_scan_generation TEXT,
        completed_scan_generation TEXT,
        mount_source TEXT,
        mount_uuid TEXT,
        mount_fstype TEXT,
        last_event_at TEXT,
        last_reconcile_at TEXT,
        updated_at TEXT NOT NULL
      );

      INSERT INTO index_content_state (
        root_id, status, legacy_cursor, copied_count, legacy_total, updated_at
      )
      SELECT r.id, 'legacy', 0, 0,
        (SELECT COUNT(*) FROM indexed_text t
          JOIN indexed_files f ON f.id = t.file_id AND f.root_id = t.root_id
          WHERE t.root_id = r.id),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM nas_roots r;

      INSERT INTO index_root_state (root_id, updated_at)
      SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM nas_roots;

      INSERT OR IGNORE INTO system_settings (key, value_json, updated_at)
      VALUES (
        'indexer_settings',
        json_object(
          'scanConcurrency', 4,
          'extractionConcurrency', 2,
          'reconciliationIntervalMs', 1800000,
          'maxExtractedTextBytes', 2097152,
          'maxSourceDocumentBytes', 536870912,
          'commandTimeoutMs', 120000,
          'maxPdfTextPages', 500,
          'maxOcrPages', 20,
          'ocrRootIds', json('[]'),
          'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    `
  },
  {
    id: "025_ops_runs",
    sql: `
      CREATE TABLE ops_runs (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL CHECK (task IN ('health', 'maintenance')),
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        finished_at TEXT,
        summary_json TEXT,
        error TEXT
      );

      CREATE INDEX idx_ops_runs_task_started_at
        ON ops_runs(task, started_at DESC, id DESC);
      CREATE INDEX idx_ops_runs_status_heartbeat
        ON ops_runs(status, heartbeat_at);
    `
  },
  {
    id: "026_file_batches",
    sql: `
      ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'
        CHECK (kind IN ('agent', 'file_batch'));

      DROP INDEX IF EXISTS idx_jobs_status_created_at;
      CREATE INDEX idx_jobs_kind_status_created_at ON jobs(kind, status, created_at);

      CREATE TABLE file_batches (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        root_id TEXT NOT NULL REFERENCES nas_roots(id) ON DELETE RESTRICT,
        storage_pool_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('move', 'trash')),
        target_directory TEXT,
        total_count INTEGER NOT NULL CHECK (total_count > 0),
        completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
        success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
        failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
        cancelled_count INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_count >= 0),
        current_source_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX idx_file_batches_scope_created_at
        ON file_batches(root_id, storage_pool_id, created_at DESC);
      CREATE INDEX idx_file_batches_session_created_at
        ON file_batches(session_id, created_at DESC);

      CREATE TABLE file_batch_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES file_batches(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        source_path TEXT NOT NULL,
        target_path TEXT,
        trash_entry_id TEXT,
        operation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(batch_id, source_path),
        UNIQUE(batch_id, ordinal)
      );

      CREATE INDEX idx_file_batch_items_claim
        ON file_batch_items(status, batch_id, ordinal);
      CREATE INDEX idx_file_batch_items_source
        ON file_batch_items(source_path, status);
    `
  },
  {
    id: "027_agent_transcript_sequence",
    sql: `
      CREATE TABLE agent_transcript_items (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        message_id TEXT UNIQUE REFERENCES agent_messages(id) ON DELETE CASCADE,
        event_id INTEGER UNIQUE REFERENCES agent_events(id) ON DELETE CASCADE,
        CHECK ((message_id IS NOT NULL) <> (event_id IS NOT NULL))
      );

      CREATE INDEX idx_agent_transcript_items_session_sequence
        ON agent_transcript_items(session_id, sequence);

      CREATE TRIGGER trg_agent_transcript_items_validate_insert
      BEFORE INSERT ON agent_transcript_items
      WHEN (
        NEW.message_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_messages
          WHERE agent_messages.id = NEW.message_id
            AND agent_messages.session_id = NEW.session_id
        )
      ) OR (
        NEW.event_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_events
          WHERE agent_events.id = NEW.event_id
            AND agent_events.session_id = NEW.session_id
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'transcript source/session mismatch');
      END;

      CREATE TRIGGER trg_agent_transcript_items_validate_update
      BEFORE UPDATE OF session_id, message_id, event_id ON agent_transcript_items
      WHEN (
        NEW.message_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_messages
          WHERE agent_messages.id = NEW.message_id
            AND agent_messages.session_id = NEW.session_id
        )
      ) OR (
        NEW.event_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_events
          WHERE agent_events.id = NEW.event_id
            AND agent_events.session_id = NEW.session_id
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'transcript source/session mismatch');
      END;

      INSERT INTO agent_transcript_items (session_id, message_id, event_id)
      SELECT session_id, message_id, event_id
      FROM (
        SELECT
          agent_messages.session_id,
          agent_messages.id AS message_id,
          NULL AS event_id,
          agent_messages.created_at,
          0 AS source_rank,
          agent_messages.id AS source_id
        FROM agent_messages
        WHERE agent_messages.role = 'user'

        UNION ALL

        SELECT
          agent_events.session_id,
          NULL AS message_id,
          agent_events.id AS event_id,
          agent_events.created_at,
          1 AS source_rank,
          printf('%020d', agent_events.id) AS source_id
        FROM agent_events
        LEFT JOIN jobs ON jobs.id = agent_events.job_id
        LEFT JOIN agent_messages ON agent_messages.id = jobs.message_id
        WHERE agent_events.type IN ('agent.message', 'job.failed')
          AND (agent_events.job_id IS NULL OR agent_messages.role IS NULL OR agent_messages.role <> 'system')
      ) AS legacy_transcript
      ORDER BY
        julianday(created_at) IS NULL,
        julianday(created_at),
        CASE WHEN julianday(created_at) IS NULL THEN created_at END,
        source_rank,
        source_id;
    `
  },
  {
    id: "028_monitoring_alerts",
    sql: `
      CREATE TABLE monitoring_alert_contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
        email TEXT NOT NULL CHECK (length(trim(email)) BETWEEN 3 AND 254),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE monitoring_alert_contact_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE monitoring_alert_group_members (
        group_id TEXT NOT NULL REFERENCES monitoring_alert_contact_groups(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES monitoring_alert_contacts(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (group_id, contact_id),
        UNIQUE (group_id, ordinal)
      ) WITHOUT ROWID;

      CREATE TABLE monitoring_oncall_schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
        timezone TEXT NOT NULL CHECK (length(trim(timezone)) BETWEEN 1 AND 80),
        handoff_weekday INTEGER NOT NULL CHECK (handoff_weekday BETWEEN 1 AND 7),
        handoff_time TEXT NOT NULL CHECK (handoff_time GLOB '[0-2][0-9]:[0-5][0-9]'),
        anchor_date TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE monitoring_oncall_members (
        schedule_id TEXT NOT NULL REFERENCES monitoring_oncall_schedules(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES monitoring_alert_contacts(id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (schedule_id, contact_id),
        UNIQUE (schedule_id, ordinal)
      ) WITHOUT ROWID;

      CREATE TABLE monitoring_oncall_overrides (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES monitoring_oncall_schedules(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES monitoring_alert_contacts(id) ON DELETE RESTRICT,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 240),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (ends_at > starts_at)
      );

      CREATE INDEX idx_monitoring_oncall_overrides_window
        ON monitoring_oncall_overrides(schedule_id, starts_at, ends_at);

      CREATE TABLE monitoring_escalation_policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE monitoring_escalation_stages (
        id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL REFERENCES monitoring_escalation_policies(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
        delay_seconds INTEGER NOT NULL CHECK (delay_seconds BETWEEN 0 AND 604800),
        repeat_interval_seconds INTEGER CHECK (
          repeat_interval_seconds IS NULL OR repeat_interval_seconds BETWEEN 300 AND 604800
        ),
        repeat_count INTEGER NOT NULL DEFAULT 0 CHECK (repeat_count BETWEEN 0 AND 10),
        UNIQUE (policy_id, ordinal)
      );

      CREATE TABLE monitoring_escalation_targets (
        stage_id TEXT NOT NULL REFERENCES monitoring_escalation_stages(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK (target_type IN ('contact', 'group', 'oncall')),
        target_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (stage_id, target_type, target_id),
        UNIQUE (stage_id, ordinal)
      ) WITHOUT ROWID;

      CREATE TABLE monitoring_alert_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
        metric TEXT NOT NULL CHECK (length(metric) BETWEEN 1 AND 120),
        selector_json TEXT NOT NULL DEFAULT '{}',
        transform TEXT NOT NULL CHECK (transform IN ('value', 'rate')),
        aggregation TEXT NOT NULL CHECK (aggregation IN ('last', 'avg', 'min', 'max')),
        window_seconds INTEGER NOT NULL CHECK (window_seconds IN (60, 300, 900, 1800, 3600)),
        comparator TEXT NOT NULL CHECK (comparator IN ('>', '>=', '<', '<=')),
        trigger_threshold REAL NOT NULL,
        recovery_threshold REAL NOT NULL,
        trigger_duration_seconds INTEGER NOT NULL CHECK (trigger_duration_seconds BETWEEN 0 AND 86400),
        recovery_duration_seconds INTEGER NOT NULL CHECK (recovery_duration_seconds BETWEEN 0 AND 86400),
        severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
        no_data_policy TEXT NOT NULL DEFAULT 'ignore' CHECK (no_data_policy IN ('ignore', 'firing')),
        escalation_policy_id TEXT REFERENCES monitoring_escalation_policies(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_monitoring_alert_rules_enabled
        ON monitoring_alert_rules(enabled, deleted_at, metric);

      INSERT INTO monitoring_alert_rules(
        id, name, enabled, builtin, metric, selector_json, transform, aggregation,
        window_seconds, comparator, trigger_threshold, recovery_threshold,
        trigger_duration_seconds, recovery_duration_seconds, severity, no_data_policy,
        revision, created_at, updated_at
      ) VALUES
        ('builtin-high-cpu', 'High CPU usage', 0, 1, 'zos_host_cpu_usage_ratio', '{}',
          'value', 'avg', 300, '>', 0.90, 0.80, 300, 300, 'warning', 'ignore', 1,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('builtin-filesystem-capacity', 'Filesystem capacity high', 0, 1, 'zos_host_filesystem_used_ratio', '{}',
          'value', 'max', 300, '>', 0.90, 0.85, 300, 300, 'warning', 'ignore', 1,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('builtin-api-service', 'ZOS API service unavailable', 0, 1, 'zos_systemd_unit_active', '{"unit":"zos-api.service"}',
          'value', 'last', 60, '<', 0.50, 1.00, 60, 60, 'critical', 'firing', 1,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('builtin-monitor-stale', 'Monitoring samples are stale', 1, 1, 'zos_monitor_last_sample_timestamp_seconds', '{}',
          'value', 'last', 60, '>', 30.00, 15.00, 30, 30, 'critical', 'firing', 1,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

      CREATE TABLE monitoring_alert_incidents (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('metric', 'health', 'system')),
        rule_id TEXT REFERENCES monitoring_alert_rules(id) ON DELETE SET NULL,
        health_alert_id TEXT REFERENCES health_alerts(id) ON DELETE SET NULL,
        series_key TEXT NOT NULL,
        labels_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('firing', 'resolved')),
        severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
        title TEXT NOT NULL,
        current_value REAL,
        firing_at TEXT NOT NULL,
        resolved_at TEXT,
        close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('recovered', 'rule_changed', 'disabled', 'deleted', 'health_resolved')),
        acknowledged_at TEXT,
        read_at TEXT,
        rule_snapshot_json TEXT NOT NULL,
        policy_snapshot_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((status = 'firing' AND resolved_at IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL))
      );

      CREATE UNIQUE INDEX idx_monitoring_alert_incidents_active
        ON monitoring_alert_incidents(source, COALESCE(rule_id, health_alert_id, ''), series_key)
        WHERE status = 'firing';
      CREATE INDEX idx_monitoring_alert_incidents_feed
        ON monitoring_alert_incidents(status, firing_at DESC);
      CREATE INDEX idx_monitoring_alert_incidents_unread
        ON monitoring_alert_incidents(read_at, firing_at DESC);

      CREATE TABLE monitoring_alert_instances (
        rule_id TEXT NOT NULL REFERENCES monitoring_alert_rules(id) ON DELETE CASCADE,
        series_key TEXT NOT NULL,
        labels_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL CHECK (state IN ('normal', 'pending', 'firing', 'recovering', 'resolved')),
        state_since TEXT NOT NULL,
        last_evaluated_at TEXT NOT NULL,
        last_value REAL,
        incident_id TEXT REFERENCES monitoring_alert_incidents(id) ON DELETE SET NULL,
        error TEXT,
        PRIMARY KEY (rule_id, series_key)
      ) WITHOUT ROWID;

      CREATE TABLE monitoring_alert_incident_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id TEXT NOT NULL REFERENCES monitoring_alert_incidents(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('fired', 'acknowledged', 'read', 'recovered', 'rule_changed', 'disabled', 'deleted', 'silenced', 'delivery_succeeded', 'delivery_failed')),
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_monitoring_alert_incident_events_incident
        ON monitoring_alert_incident_events(incident_id, created_at, id);

      CREATE TABLE monitoring_alert_silences (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES monitoring_alert_rules(id) ON DELETE CASCADE,
        series_key TEXT,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 240),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (ends_at > starts_at)
      );

      CREATE INDEX idx_monitoring_alert_silences_active
        ON monitoring_alert_silences(rule_id, series_key, starts_at, ends_at);

      CREATE TABLE monitoring_alert_deliveries (
        id TEXT PRIMARY KEY,
        incident_id TEXT REFERENCES monitoring_alert_incidents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('firing', 'reminder', 'resolved', 'test')),
        stage_ordinal INTEGER,
        repeat_ordinal INTEGER,
        idempotency_key TEXT NOT NULL UNIQUE,
        message_id TEXT NOT NULL UNIQUE,
        recipients_json TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'retrying', 'succeeded', 'failed', 'cancelled')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 12),
        due_at TEXT NOT NULL,
        sent_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_monitoring_alert_deliveries_claim
        ON monitoring_alert_deliveries(status, due_at, created_at);
      CREATE INDEX idx_monitoring_alert_deliveries_incident
        ON monitoring_alert_deliveries(incident_id, status, created_at);

      CREATE TABLE monitoring_alert_delivery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL REFERENCES monitoring_alert_deliveries(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 12),
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        UNIQUE (delivery_id, attempt)
      );

      CREATE INDEX idx_monitoring_alert_delivery_attempts_finished
        ON monitoring_alert_delivery_attempts(finished_at);

      CREATE TABLE monitoring_alerter_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL CHECK (status IN ('starting', 'ready', 'degraded')),
        last_evaluation_at TEXT,
        last_delivery_at TEXT,
        pending_deliveries INTEGER NOT NULL DEFAULT 0 CHECK (pending_deliveries >= 0),
        health_initialized INTEGER NOT NULL DEFAULT 0 CHECK (health_initialized IN (0, 1)),
        error TEXT,
        updated_at TEXT NOT NULL
      );

      INSERT INTO monitoring_alerter_state(id, status, pending_deliveries, updated_at)
      VALUES (1, 'starting', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

      INSERT OR IGNORE INTO system_settings(key, value_json, updated_at)
      VALUES (
        'monitoring_smtp',
        '{"host":"","port":587,"security":"starttls","username":"","password":"","from":"","enabled":false}',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
      INSERT OR IGNORE INTO system_settings(key, value_json, updated_at)
      VALUES (
        'monitoring_health_routing',
        '{"warningPolicyId":null,"criticalPolicyId":null}',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    `
  },
  {
    id: "029_monitoring_silence_cancellation",
    sql: `
      ALTER TABLE monitoring_alert_silences ADD COLUMN cancelled_at TEXT;
      CREATE INDEX idx_monitoring_alert_silences_effective
        ON monitoring_alert_silences(cancelled_at, rule_id, series_key, starts_at, ends_at);
    `
  },
  {
    id: "030_monitoring_rule_evaluation_status",
    sql: `
      ALTER TABLE monitoring_alert_rules ADD COLUMN evaluation_error TEXT;
      ALTER TABLE monitoring_alert_rules ADD COLUMN last_evaluated_at TEXT;
    `
  },
  {
    id: "031_monitoring_unsilenced_event",
    sql: `
      CREATE TABLE monitoring_alert_incident_events_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id TEXT NOT NULL REFERENCES monitoring_alert_incidents(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('fired', 'acknowledged', 'read', 'recovered', 'rule_changed', 'disabled', 'deleted', 'silenced', 'unsilenced', 'delivery_succeeded', 'delivery_failed')),
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      INSERT INTO monitoring_alert_incident_events_v2(id, incident_id, type, details_json, created_at)
      SELECT id, incident_id, type, details_json, created_at
      FROM monitoring_alert_incident_events;

      DROP TABLE monitoring_alert_incident_events;
      ALTER TABLE monitoring_alert_incident_events_v2 RENAME TO monitoring_alert_incident_events;

      CREATE INDEX idx_monitoring_alert_incident_events_incident
        ON monitoring_alert_incident_events(incident_id, created_at, id);
    `
  }
];
