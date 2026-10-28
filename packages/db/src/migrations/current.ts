import type { Migration } from "./types.js";

export const currentMigrations: Migration[] = [
  {
    id: "001_cyberos_2_0",
    sql: `
CREATE TABLE users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , kind TEXT NOT NULL DEFAULT 'agent'
        CHECK (kind IN ('agent', 'file_batch')), attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0), lease_owner TEXT, lease_until TEXT, heartbeat_at TEXT, error_code TEXT, working_path TEXT NOT NULL DEFAULT '.');
CREATE TABLE agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      , source TEXT NOT NULL DEFAULT 'cyberos', source_id TEXT, run_id TEXT NOT NULL, sequence INTEGER NOT NULL);
CREATE TABLE file_operations (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        source_path TEXT,
        target_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'applied', 'rolled_back', 'failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE file_tags (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(file_id, tag)
      );
CREATE TABLE system_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE agent_provider_sessions (
        session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
        provider_session_id TEXT NOT NULL,
        session_file TEXT,
        provider_name TEXT NOT NULL,
        model TEXT NOT NULL,
        settings_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , runtime_generation INTEGER NOT NULL DEFAULT 1, runtime_provider TEXT, runtime_model TEXT, projection_cursor TEXT);
CREATE TABLE share_operations (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('apply_settings')),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'applied', 'failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE vm_operations (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('create', 'start', 'shutdown', 'stop', 'restart', 'pause', 'resume', 'reset', 'snapshot', 'delete', 'console')),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'applied', 'failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE backup_runs (
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
CREATE TABLE execution_locks (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
CREATE TABLE storage_operations (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('create_pool', 'delete_pool')),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'applied', 'failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE docker_operations (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('create', 'start', 'stop', 'restart', 'remove', 'compose_up', 'compose_down', 'compose_pull', 'compose_restart', 'console')),
        target_type TEXT NOT NULL CHECK (target_type IN ('container', 'compose_project', 'console', 'volume', 'network')),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'applied', 'failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE docker_apps (
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
      , host_access_json TEXT NOT NULL DEFAULT '[]', deployed_host_access_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE docker_app_environment (
        app_id TEXT NOT NULL REFERENCES docker_apps(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, key)
      );
CREATE TABLE vm_console_authorizations (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES vm_operations(id) ON DELETE CASCADE,
        domain_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'used', 'expired', 'failed')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
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
CREATE TABLE photos_upload_reservations (
        id TEXT PRIMARY KEY,
        library_updated_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(library_updated_at, content_hash),
        UNIQUE(library_updated_at, path)
      );
CREATE TABLE photos_asset_metadata (
        asset_id TEXT PRIMARY KEY REFERENCES photos_assets(id) ON DELETE CASCADE,
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
CREATE TABLE photos_keywords (
        asset_id TEXT NOT NULL REFERENCES photos_assets(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        normalized_keyword TEXT NOT NULL,
        PRIMARY KEY(asset_id, normalized_keyword)
      );
CREATE TABLE photos_metadata_values (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL REFERENCES photos_assets(id) ON DELETE CASCADE,
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
CREATE VIRTUAL TABLE photos_metadata_fts USING fts5(
        asset_id UNINDEXED, name, path, title, description, creator, copyright,
        keywords, camera, lens, tokenize = 'unicode61 remove_diacritics 2'
      );
CREATE VIRTUAL TABLE photos_geo_index USING rtree(
        metadata_rowid, min_latitude, max_latitude, min_longitude, max_longitude
      );
CREATE TABLE photos_scan_entries (
        job_id TEXT NOT NULL REFERENCES photos_jobs(id) ON DELETE CASCADE,
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
CREATE TABLE photos_publish_journal (
        operation_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES photos_jobs(id) ON DELETE CASCADE,
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
CREATE TABLE photos_space_reservations (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES photos_jobs(id) ON DELETE CASCADE,
        storage_pool_id TEXT NOT NULL,
        path TEXT NOT NULL,
        reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
        updated_at TEXT NOT NULL
      );
CREATE TABLE photos_workers (
        worker_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
CREATE TABLE indexer_workers (
        worker_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
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
CREATE TABLE agent_transcript_items (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        message_id TEXT UNIQUE REFERENCES agent_messages(id) ON DELETE CASCADE,
        event_id INTEGER UNIQUE REFERENCES agent_events(id) ON DELETE CASCADE,
        CHECK ((message_id IS NOT NULL) <> (event_id IS NOT NULL))
      );
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
      , evaluation_error TEXT, last_evaluated_at TEXT);
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
CREATE TABLE monitoring_alert_silences (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES monitoring_alert_rules(id) ON DELETE CASCADE,
        series_key TEXT,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 240),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, cancelled_at TEXT,
        CHECK (ends_at > starts_at)
      );
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
CREATE TABLE "monitoring_alert_incident_events" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id TEXT NOT NULL REFERENCES monitoring_alert_incidents(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('fired', 'acknowledged', 'read', 'recovered', 'rule_changed', 'disabled', 'deleted', 'silenced', 'unsilenced', 'delivery_succeeded', 'delivery_failed')),
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
CREATE TABLE docker_compose_host_access_drafts (
        id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES docker_apps(id) ON DELETE CASCADE,
        compose_revision TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        image_digests_json TEXT NOT NULL DEFAULT '[]',
        fingerprints_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
CREATE TABLE mcp_clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        kind TEXT NOT NULL CHECK (kind IN ('pi', 'local', 'lan')),
        token_digest TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE capability_runs (
        id TEXT PRIMARY KEY,
        client_id TEXT REFERENCES mcp_clients(id) ON DELETE SET NULL,
        subject_id TEXT NOT NULL,
        subject_kind TEXT NOT NULL CHECK (subject_kind IN ('pi', 'local', 'lan', 'system')),
        capability_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'expired')),
        risk TEXT NOT NULL CHECK (risk IN ('read', 'low', 'medium', 'high', 'critical')),
        input_json TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        idempotency_key TEXT,
        progress_json TEXT NOT NULL DEFAULT '{}',
        domain_operation_type TEXT,
        domain_operation_id TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        cancellable INTEGER NOT NULL DEFAULT 1 CHECK (cancellable IN (0, 1)),
        lease_owner TEXT,
        lease_expires_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK ((domain_operation_type IS NULL) = (domain_operation_id IS NULL))
      );
CREATE TABLE capability_run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES capability_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
CREATE TABLE capability_approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES capability_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
        proposal_json TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        requires_confirmation INTEGER NOT NULL DEFAULT 0 CHECK (requires_confirmation IN (0, 1)),
        decided_by TEXT,
        decided_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE agent_capability_runs (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE REFERENCES capability_runs(id) ON DELETE CASCADE,
        provider_session_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_id, run_id)
      );
CREATE TABLE bluetooth_transfer_service_state (
        id TEXT PRIMARY KEY CHECK (id = 'primary'),
        heartbeat_at TEXT NOT NULL,
        error TEXT
      );
CREATE TABLE capability_run_payloads (
        run_id TEXT PRIMARY KEY REFERENCES capability_runs(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE file_batch_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES file_batches(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        source_path TEXT NOT NULL,
        target_path TEXT,
        trash_entry_id TEXT,
        operation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(batch_id, source_path),
        UNIQUE(batch_id, ordinal)
      );
CREATE TABLE docker_console_authorizations (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES docker_operations(id) ON DELETE CASCADE,
        container_id TEXT NOT NULL,
        shell TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'used', 'expired', 'failed')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
CREATE TABLE media_titles (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
        source_path TEXT NOT NULL,
        tmdb_id INTEGER CHECK (tmdb_id IS NULL OR tmdb_id > 0),
        title TEXT NOT NULL,
        original_title TEXT,
        sort_title TEXT NOT NULL,
        overview TEXT,
        year INTEGER CHECK (year IS NULL OR year BETWEEN 1870 AND 3000),
        release_date TEXT,
        runtime_minutes INTEGER CHECK (runtime_minutes IS NULL OR runtime_minutes >= 0),
        original_language TEXT,
        genres_json TEXT NOT NULL DEFAULT '[]',
        metadata_source TEXT NOT NULL CHECK (metadata_source IN ('nfo', 'tmdb', 'filename')),
        match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'pending', 'unmatched', 'excluded')),
        match_confidence REAL CHECK (match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)),
        poster_key TEXT,
        backdrop_key TEXT,
        scan_generation TEXT NOT NULL,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_id, source_path)
      );
CREATE TABLE media_seasons (
        id TEXT PRIMARY KEY,
        title_id TEXT NOT NULL REFERENCES media_titles(id) ON DELETE CASCADE,
        season_number INTEGER NOT NULL CHECK (season_number >= 0),
        name TEXT,
        overview TEXT,
        poster_key TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(title_id, season_number)
      );
CREATE TABLE media_episodes (
        id TEXT PRIMARY KEY,
        title_id TEXT NOT NULL REFERENCES media_titles(id) ON DELETE CASCADE,
        season_id TEXT NOT NULL REFERENCES media_seasons(id) ON DELETE CASCADE,
        episode_number INTEGER NOT NULL CHECK (episode_number >= 0),
        name TEXT,
        overview TEXT,
        air_date TEXT,
        runtime_minutes INTEGER CHECK (runtime_minutes IS NULL OR runtime_minutes >= 0),
        still_key TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(season_id, episode_number)
      );
CREATE TABLE media_artwork (
        id TEXT PRIMARY KEY,
        title_id TEXT NOT NULL REFERENCES media_titles(id) ON DELETE CASCADE,
        season_id TEXT REFERENCES media_seasons(id) ON DELETE CASCADE,
        episode_id TEXT REFERENCES media_episodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('poster', 'backdrop', 'still')),
        source TEXT NOT NULL CHECK (source IN ('local', 'tmdb')),
        source_url TEXT,
        cache_key TEXT NOT NULL,
        width INTEGER CHECK (width IS NULL OR width > 0),
        height INTEGER CHECK (height IS NULL OR height > 0),
        language TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        updated_at TEXT NOT NULL,
        UNIQUE(title_id, season_id, episode_id, kind, cache_key)
      );
CREATE TABLE media_progress (
        file_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL DEFAULT 'local-admin',
        position_seconds REAL NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
        duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(file_id, profile_id)
      );
CREATE TABLE media_match_overrides (
        title_id TEXT PRIMARY KEY REFERENCES media_titles(id) ON DELETE CASCADE,
        tmdb_id INTEGER CHECK (tmdb_id IS NULL OR tmdb_id > 0),
        excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
        updated_at TEXT NOT NULL,
        CHECK (excluded = 1 OR tmdb_id IS NOT NULL)
      );
CREATE TABLE media_scan_runs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        generation TEXT NOT NULL,
        scanned INTEGER NOT NULL DEFAULT 0 CHECK (scanned >= 0),
        added INTEGER NOT NULL DEFAULT 0 CHECK (added >= 0),
        updated INTEGER NOT NULL DEFAULT 0 CHECK (updated >= 0),
        removed INTEGER NOT NULL DEFAULT 0 CHECK (removed >= 0),
        unmatched INTEGER NOT NULL DEFAULT 0 CHECK (unmatched >= 0),
        current_path TEXT,
        error TEXT,
        worker_id TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
CREATE TABLE operation_notifications (
        id TEXT PRIMARY KEY,
        job_id TEXT UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
        operation_id TEXT UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'docker', 'vm', 'storage', 'share', 'media')),
        status TEXT NOT NULL CHECK (status IN ('pending_approval', 'running', 'succeeded', 'failed', 'rejected', 'cancelled')),
        summary TEXT NOT NULL,
        error TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (job_id IS NOT NULL OR operation_id IS NOT NULL)
      );
CREATE TABLE mcp_resource_tokens (
        token_digest TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'file_export', 'photo_media', 'photo_export')),
        descriptor_json TEXT NOT NULL CHECK (length(descriptor_json) <= 65536),
        revision TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
CREATE TABLE agent_session_commands (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        type TEXT NOT NULL CHECK (type IN (
          'prompt', 'steer', 'follow_up', 'abort', 'compact',
          'set_model', 'set_thinking_level', 'stats'
        )),
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
          'queued', 'running', 'completed', 'failed', 'cancelled'
        )),
        result_json TEXT,
        error TEXT,
        lease_owner TEXT,
        lease_until TEXT,
        heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, idempotency_key)
      );
CREATE TABLE backup_failures (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
        storage_pool_id TEXT,
        path TEXT,
        code TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE bluetooth_transfers (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('send', 'receive')),
        adapter_id TEXT,
        device_address TEXT NOT NULL,
        storage_pool_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        finalization_relative_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'finalizing', 'completed', 'failed', 'cancelled')),
        transferred_bytes INTEGER NOT NULL DEFAULT 0 CHECK (transferred_bytes >= 0),
        total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
        error TEXT,
        obex_transfer_path TEXT,
        control_requested TEXT CHECK (control_requested IS NULL OR control_requested = 'cancel'),
        read_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        last_progress_at TEXT
      );
CREATE TABLE download_tasks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
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
        phase TEXT CHECK (phase IS NULL OR phase IN ('probing', 'downloading', 'verifying', 'publishing', 'retry_wait')),
        download_mode TEXT CHECK (download_mode IS NULL OR download_mode IN ('single', 'segmented')),
        expected_sha256 TEXT CHECK (expected_sha256 IS NULL OR (length(expected_sha256) = 64 AND expected_sha256 = lower(expected_sha256))),
        actual_sha256 TEXT CHECK (actual_sha256 IS NULL OR (length(actual_sha256) = 64 AND actual_sha256 = lower(actual_sha256))),
        error_code TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0, 1)),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        next_retry_at TEXT,
        control_requested TEXT CHECK (control_requested IS NULL OR control_requested IN ('pause', 'cancel')),
        segment_count INTEGER NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
        UNIQUE(storage_pool_id, target_path)
      );
CREATE TABLE file_batches (
        id TEXT PRIMARY KEY,
        storage_pool_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('move', 'trash')),
        target_directory TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        total_count INTEGER NOT NULL CHECK (total_count > 0),
        completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
        success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
        failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
        cancelled_count INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_count >= 0),
        current_source_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
CREATE TABLE health_alerts (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        scope TEXT NOT NULL,
        storage_pool_id TEXT,
        severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
        status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT,
        details TEXT,
        UNIQUE(code, scope)
      );
CREATE TABLE indexed_files (
        id TEXT PRIMARY KEY,
        storage_pool_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        hash TEXT,
        indexed_at TEXT NOT NULL,
        source_device INTEGER,
        source_inode INTEGER,
        source_size_bytes INTEGER CHECK (source_size_bytes IS NULL OR source_size_bytes >= 0),
        source_mtime_ns INTEGER,
        source_ctime_ns INTEGER,
        scan_generation TEXT,
        extraction_source TEXT CHECK (extraction_source IS NULL OR extraction_source IN ('plain_text', 'pdftotext', 'docx', 'xlsx', 'pptx', 'ocr')),
        extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'ready', 'stale', 'error', 'skipped')),
        extraction_error TEXT,
        UNIQUE(storage_pool_id, path)
      );
CREATE VIRTUAL TABLE indexed_content_fts USING fts5(
        file_id UNINDEXED,
        storage_pool_id UNINDEXED,
        path,
        name,
        body,
        terms,
        tokenize = 'unicode61 remove_diacritics 2',
        prefix = '2 3'
      );
CREATE TABLE index_storage_pool_state (
        storage_pool_id TEXT PRIMARY KEY,
        watcher_status TEXT NOT NULL DEFAULT 'starting' CHECK (watcher_status IN ('starting', 'ready', 'degraded', 'unsupported')),
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
CREATE TABLE index_content_state (
        storage_pool_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('rebuilding', 'ready', 'failed')),
        error TEXT,
        updated_at TEXT NOT NULL
      );
CREATE TABLE index_queue (
        id TEXT PRIMARY KEY,
        storage_pool_id TEXT NOT NULL,
        path TEXT NOT NULL,
        recursive INTEGER NOT NULL DEFAULT 0 CHECK (recursive IN (0, 1)),
        kind TEXT NOT NULL CHECK (kind IN ('full', 'incremental', 'manual')),
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'retrying', 'failed')),
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
        UNIQUE(storage_pool_id, path)
      );
CREATE TABLE index_runs (
        id TEXT PRIMARY KEY,
        storage_pool_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
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
        kind TEXT NOT NULL DEFAULT 'full' CHECK (kind IN ('full', 'incremental', 'manual'))
      );
CREATE TABLE index_run_history (
        id TEXT PRIMARY KEY,
        storage_pool_id TEXT NOT NULL,
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
        failures_json TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL DEFAULT 'full' CHECK (kind IN ('full', 'incremental', 'manual'))
      );
CREATE TABLE index_failures (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES index_runs(id) ON DELETE CASCADE,
        storage_pool_id TEXT NOT NULL,
        path TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE mcp_transfer_tokens (
        token_digest TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
        storage_pool_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        modified_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
CREATE TABLE media_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
        storage_pool_id TEXT NOT NULL,
        path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(storage_pool_id, path, kind)
      );
CREATE TABLE media_files (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
        title_id TEXT NOT NULL REFERENCES media_titles(id) ON DELETE CASCADE,
        episode_id TEXT REFERENCES media_episodes(id) ON DELETE CASCADE,
        storage_pool_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        mtime_ms INTEGER NOT NULL CHECK (mtime_ms >= 0),
        duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
        container TEXT,
        video_codec TEXT,
        audio_codec TEXT,
        scan_generation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_id, relative_path)
      );
CREATE TABLE photos_assets (
        id TEXT PRIMARY KEY,
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
        UNIQUE(storage_pool_id, path)
      );
CREATE TABLE photos_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('full_scan', 'path_refresh')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retrying', 'completed', 'failed')),
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
CREATE TABLE terminal_tabs (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal > 0),
        custom_title TEXT CHECK (custom_title IS NULL OR (length(custom_title) BETWEEN 1 AND 64 AND custom_title = trim(custom_title))),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE terminal_tab_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_tab_id TEXT REFERENCES terminal_tabs(id) ON DELETE SET NULL,
        next_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (next_ordinal > 0),
        initialized_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE trash_entries (
        id TEXT PRIMARY KEY,
        storage_pool_id TEXT NOT NULL,
        original_path TEXT NOT NULL,
        trash_path TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        restored_at TEXT
      );
CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        current_path TEXT NOT NULL DEFAULT '.',
        pi_resources_trusted INTEGER NOT NULL DEFAULT 0 CHECK (pi_resources_trusted IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE INDEX idx_agent_events_session_id_id ON agent_events(session_id, id);
CREATE INDEX idx_share_operations_created_at
        ON share_operations(created_at);
CREATE INDEX idx_vm_operations_created_at ON vm_operations(created_at);
CREATE INDEX idx_backup_runs_started_at ON backup_runs(started_at DESC);
CREATE INDEX idx_storage_operations_created_at
        ON storage_operations(created_at);
CREATE INDEX idx_docker_operations_created_at
        ON docker_operations(created_at);
CREATE INDEX idx_docker_apps_updated_at
        ON docker_apps(updated_at DESC);
CREATE INDEX idx_vm_console_authorizations_status_expires_at
        ON vm_console_authorizations(status, expires_at);
CREATE INDEX idx_download_workers_heartbeat
        ON download_workers(heartbeat_at DESC);
CREATE INDEX idx_photos_upload_reservations_created_at
        ON photos_upload_reservations(library_updated_at, created_at);
CREATE INDEX idx_photos_asset_metadata_version
        ON photos_asset_metadata(schema_version, status);
CREATE INDEX idx_photos_asset_metadata_camera
        ON photos_asset_metadata(camera_model, asset_id);
CREATE INDEX idx_photos_asset_metadata_lens
        ON photos_asset_metadata(lens_model, asset_id);
CREATE INDEX idx_photos_asset_metadata_capture
        ON photos_asset_metadata(captured_at, asset_id);
CREATE INDEX idx_photos_asset_metadata_rating
        ON photos_asset_metadata(rating, asset_id);
CREATE INDEX idx_photos_keywords_value
        ON photos_keywords(normalized_keyword, asset_id);
CREATE INDEX idx_photos_metadata_values_key_type
        ON photos_metadata_values(key, value_type, asset_id);
CREATE INDEX idx_photos_metadata_values_text
        ON photos_metadata_values(key, normalized_text_value, asset_id)
        WHERE normalized_text_value IS NOT NULL;
CREATE INDEX idx_photos_metadata_values_number
        ON photos_metadata_values(key, number_value, asset_id)
        WHERE number_value IS NOT NULL;
CREATE INDEX idx_photos_metadata_values_date
        ON photos_metadata_values(key, date_value, asset_id)
        WHERE date_value IS NOT NULL;
CREATE INDEX idx_photos_scan_entries_claim
        ON photos_scan_entries(job_id, status, next_retry_at, path);
CREATE INDEX idx_photos_space_reservations_pool
        ON photos_space_reservations(storage_pool_id);
CREATE INDEX idx_photos_workers_heartbeat
        ON photos_workers(heartbeat_at DESC);
CREATE INDEX idx_indexer_workers_heartbeat
        ON indexer_workers(heartbeat_at DESC);
CREATE INDEX idx_ops_runs_task_started_at
        ON ops_runs(task, started_at DESC, id DESC);
CREATE INDEX idx_ops_runs_status_heartbeat
        ON ops_runs(status, heartbeat_at);
CREATE INDEX idx_jobs_kind_status_created_at ON jobs(kind, status, created_at);
CREATE INDEX idx_agent_transcript_items_session_sequence
        ON agent_transcript_items(session_id, sequence);
CREATE INDEX idx_monitoring_oncall_overrides_window
        ON monitoring_oncall_overrides(schedule_id, starts_at, ends_at);
CREATE INDEX idx_monitoring_alert_rules_enabled
        ON monitoring_alert_rules(enabled, deleted_at, metric);
CREATE UNIQUE INDEX idx_monitoring_alert_incidents_active
        ON monitoring_alert_incidents(source, COALESCE(rule_id, health_alert_id, ''), series_key)
        WHERE status = 'firing';
CREATE INDEX idx_monitoring_alert_incidents_feed
        ON monitoring_alert_incidents(status, firing_at DESC);
CREATE INDEX idx_monitoring_alert_incidents_unread
        ON monitoring_alert_incidents(read_at, firing_at DESC);
CREATE INDEX idx_monitoring_alert_silences_active
        ON monitoring_alert_silences(rule_id, series_key, starts_at, ends_at);
CREATE INDEX idx_monitoring_alert_deliveries_claim
        ON monitoring_alert_deliveries(status, due_at, created_at);
CREATE INDEX idx_monitoring_alert_deliveries_incident
        ON monitoring_alert_deliveries(incident_id, status, created_at);
CREATE INDEX idx_monitoring_alert_delivery_attempts_finished
        ON monitoring_alert_delivery_attempts(finished_at);
CREATE INDEX idx_monitoring_alert_silences_effective
        ON monitoring_alert_silences(cancelled_at, rule_id, series_key, starts_at, ends_at);
CREATE INDEX idx_monitoring_alert_incident_events_incident
        ON monitoring_alert_incident_events(incident_id, created_at, id);
CREATE INDEX idx_docker_compose_host_access_drafts_expires_at
        ON docker_compose_host_access_drafts(expires_at);
CREATE INDEX idx_mcp_clients_active
        ON mcp_clients(revoked_at, expires_at, created_at);
CREATE UNIQUE INDEX idx_capability_runs_idempotency
        ON capability_runs(client_id, capability_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_capability_runs_owner_created
        ON capability_runs(client_id, created_at DESC, id DESC);
CREATE INDEX idx_capability_runs_claim
        ON capability_runs(state, lease_expires_at, created_at);
CREATE UNIQUE INDEX idx_capability_runs_domain_operation
        ON capability_runs(domain_operation_type, domain_operation_id)
        WHERE domain_operation_type IS NOT NULL AND domain_operation_id IS NOT NULL;
CREATE INDEX idx_capability_run_events_run
        ON capability_run_events(run_id, id);
CREATE INDEX idx_capability_approvals_pending
        ON capability_approvals(status, created_at);
CREATE INDEX idx_file_batch_items_claim ON file_batch_items(status, batch_id, ordinal);
CREATE INDEX idx_file_batch_items_source ON file_batch_items(source_path, status);
CREATE INDEX idx_docker_console_authorizations_status_expires_at
        ON docker_console_authorizations(status, expires_at);
CREATE INDEX idx_media_titles_kind_sort ON media_titles(kind, sort_title, id);
CREATE INDEX idx_media_titles_match ON media_titles(match_status, updated_at DESC);
CREATE INDEX idx_media_titles_recent ON media_titles(added_at DESC, id DESC);
CREATE INDEX idx_media_artwork_owner ON media_artwork(title_id, season_id, episode_id, kind, is_primary DESC);
CREATE INDEX idx_media_progress_continue ON media_progress(profile_id, completed, updated_at DESC);
CREATE INDEX idx_media_scan_runs_claim ON media_scan_runs(status, created_at);
CREATE INDEX idx_media_scan_runs_source ON media_scan_runs(source_id, created_at DESC);
CREATE INDEX idx_operation_notifications_updated_at ON operation_notifications(updated_at DESC);
CREATE INDEX idx_operation_notifications_unread_updated_at ON operation_notifications(read_at, updated_at DESC);
CREATE INDEX idx_mcp_resource_tokens_expiry
        ON mcp_resource_tokens(expires_at, used_at);
CREATE INDEX idx_jobs_agent_session_status
        ON jobs(session_id, status, created_at)
        WHERE kind = 'agent';
CREATE UNIQUE INDEX one_active_agent_job_per_session
        ON jobs(session_id)
        WHERE kind = 'agent' AND status = 'running' AND lease_owner IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_events_source
        ON agent_events(session_id, source, source_id)
        WHERE source_id IS NOT NULL;
CREATE INDEX idx_agent_events_run_sequence
        ON agent_events(session_id, run_id, sequence)
        WHERE run_id IS NOT NULL;
CREATE INDEX idx_agent_session_commands_status_created_at
        ON agent_session_commands(status, created_at);
CREATE INDEX idx_agent_session_commands_session_created_at
        ON agent_session_commands(session_id, created_at);
CREATE UNIQUE INDEX one_running_agent_command_per_session
        ON agent_session_commands(session_id)
        WHERE status = 'running';
CREATE INDEX idx_backup_failures_run_id ON backup_failures(run_id);
CREATE INDEX idx_bluetooth_transfers_status_created_at ON bluetooth_transfers(status, created_at);
CREATE INDEX idx_bluetooth_transfers_updated_at ON bluetooth_transfers(updated_at DESC);
CREATE INDEX idx_download_tasks_claim ON download_tasks(status, next_retry_at, created_at);
CREATE INDEX idx_download_tasks_status_created_at ON download_tasks(status, created_at);
CREATE INDEX idx_download_tasks_updated_at ON download_tasks(updated_at DESC);
CREATE INDEX idx_file_batches_scope_created_at ON file_batches(storage_pool_id, created_at DESC);
CREATE INDEX idx_file_batches_status_created_at ON file_batches(status, created_at);
CREATE INDEX idx_health_alerts_status_last_seen ON health_alerts(status, last_seen_at DESC);
CREATE INDEX idx_index_queue_claim ON index_queue(status, next_retry_at, priority DESC, created_at);
CREATE INDEX idx_index_queue_storage_pool ON index_queue(storage_pool_id, status, updated_at);
CREATE INDEX idx_index_runs_storage_pool_started_at ON index_runs(storage_pool_id, started_at DESC);
CREATE INDEX idx_index_run_history_storage_pool_started_at ON index_run_history(storage_pool_id, started_at DESC);
CREATE INDEX idx_index_failures_run_id ON index_failures(run_id);
CREATE INDEX idx_mcp_transfer_tokens_expiry ON mcp_transfer_tokens(expires_at, used_at);
CREATE INDEX idx_media_files_episode ON media_files(episode_id, relative_path);
CREATE INDEX idx_media_files_title ON media_files(title_id, relative_path);
CREATE INDEX idx_photos_assets_content_hash ON photos_assets(library_updated_at, content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX idx_photos_assets_timeline ON photos_assets(library_updated_at, status, taken_at DESC, id DESC);
CREATE INDEX idx_photos_jobs_claim ON photos_jobs(status, next_retry_at, created_at);
CREATE INDEX idx_photos_jobs_library_created_at ON photos_jobs(library_updated_at, created_at DESC);
CREATE INDEX idx_terminal_tabs_ordinal ON terminal_tabs(ordinal);
CREATE TRIGGER trg_photos_asset_metadata_delete_indexes
      BEFORE DELETE ON photos_asset_metadata
      BEGIN
        DELETE FROM photos_geo_index WHERE metadata_rowid = OLD.rowid;
        DELETE FROM photos_metadata_fts WHERE asset_id = OLD.asset_id;
      END;
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
CREATE TRIGGER trg_index_failures_storage_pool_matches_run
      BEFORE INSERT ON index_failures
      WHEN NOT EXISTS (
        SELECT 1 FROM index_runs
        WHERE id = NEW.run_id AND storage_pool_id = NEW.storage_pool_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'index failure storage pool does not match index run');
      END;
CREATE TRIGGER trg_index_failures_storage_pool_matches_run_update
      BEFORE UPDATE OF run_id, storage_pool_id ON index_failures
      WHEN NOT EXISTS (
        SELECT 1 FROM index_runs
        WHERE id = NEW.run_id AND storage_pool_id = NEW.storage_pool_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'index failure storage pool does not match index run');
      END;

INSERT INTO monitoring_alerter_state(id, status, pending_deliveries, updated_at)
VALUES (1, 'starting', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT INTO system_settings(key, value_json, updated_at)
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
    'ocrStoragePoolIds', json('[]'),
    'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
INSERT INTO system_settings(key, value_json, updated_at)
VALUES (
  'photos_processing_settings',
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
INSERT INTO system_settings(key, value_json, updated_at)
VALUES (
  'monitoring_smtp',
  '{"host":"","port":587,"security":"starttls","username":"","password":"","from":"","enabled":false}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
INSERT INTO system_settings(key, value_json, updated_at)
VALUES (
  'monitoring_health_routing',
  '{"warningPolicyId":null,"criticalPolicyId":null}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
    `
  }
];
