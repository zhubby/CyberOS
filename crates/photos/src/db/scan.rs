use super::*;

pub const SCAN_BATCH_SIZE: usize = 256;
pub(super) const SIDECAR_SQL: &str = "SELECT path FROM photos_scan_entries WHERE job_id=? AND parent_path=? AND entry_type='sidecar' AND name_key=? LIMIT 2";
pub(super) const MEDIA_PENDING_SQL: &str = "SELECT path,entry_type,retry_count FROM photos_scan_entries WHERE job_id=?1 AND parent_path=?2 AND entry_type='media' AND status='pending' ORDER BY path LIMIT ?4";
pub(super) const MEDIA_RETRY_SQL: &str = "SELECT path,entry_type,retry_count FROM photos_scan_entries WHERE job_id=?1 AND parent_path=?2 AND entry_type='media' AND status='failed' AND error_retryable=1 AND next_retry_at<=?3 ORDER BY next_retry_at,path LIMIT ?4";

#[derive(Debug, Clone)]
pub struct DiscoveredEntry {
    pub path: String,
    pub entry_type: String,
}

#[derive(Debug, Clone)]
pub struct CurrentAsset {
    pub id: String,
    pub source: FileIdentity,
    pub sidecar_path: Option<String>,
    pub sidecar: Option<FileIdentity>,
    pub metadata_version: u32,
    pub sidecar_warning: Option<String>,
    pub media: crate::media::ReusableMedia,
}

fn lookup_keys(path: &str) -> (String, String, Option<&'static str>) {
    let path = Path::new(path);
    (
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase(),
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase(),
        crate::media::candidate_kind(&path.to_string_lossy()).map(media_kind),
    )
}

impl Db {
    pub async fn restart_refresh_scope(&self, job: &Job, worker_id: &str) -> DbResult<()> {
        loop {
            let job = job.clone();
            let worker_id = worker_id.to_owned();
            let removed = self.call(move |connection| {
                let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotosError::database)?;
                ensure_job_owned(&transaction, &job.id, &worker_id)?;
                let journal: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM photos_publish_journal WHERE job_id=?)", [&job.id], |row| row.get(0)).map_err(PhotosError::database)?;
                if journal { return Err(PhotosError::new(ErrorCode::Database, "Refresh scope still has publication recovery work", true)); }
                let removed = transaction.execute("DELETE FROM photos_scan_entries WHERE rowid IN (SELECT rowid FROM photos_scan_entries WHERE job_id=? LIMIT 1000)", [&job.id]).map_err(PhotosError::database)?;
                if removed == 0 {
                    transaction.execute("UPDATE photos_jobs SET path=?,scan_generation=?,scanned=0,processed=0,failed=0,updated_at=? WHERE id=?", params![job.path,job.scan_generation,now_iso(),job.id]).map_err(PhotosError::database)?;
                }
                transaction.commit().map_err(PhotosError::database)?;
                Ok(removed)
            }).await?;
            if removed == 0 {
                return Ok(());
            }
            tokio::task::yield_now().await;
        }
    }
    pub async fn complete_metadata_only(
        &self,
        record: &PublishRecord,
        worker_id: &str,
    ) -> DbResult<()> {
        let record = record.clone();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(PhotosError::database)?;
            ensure_job_owned(&transaction, &record.job_id, &worker_id)?;
            write_record(&transaction, &record)?;
            transaction.commit().map_err(PhotosError::database)
        })
        .await
    }
    pub async fn add_scan_entries(
        &self,
        job_id: &str,
        parent: &str,
        entries: Vec<DiscoveredEntry>,
        worker_id: &str,
    ) -> DbResult<()> {
        if entries.len() > SCAN_BATCH_SIZE {
            return Err(PhotosError::internal("Scan batch exceeds 256 entries"));
        }
        let job_id = job_id.to_owned();
        let parent = parent.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotosError::database)?;
            ensure_job_owned(&transaction, &job_id, &worker_id)?;
            let now = now_iso();
            {
                let mut insert = transaction.prepare_cached("INSERT INTO photos_scan_entries(job_id,path,entry_type,status,parent_path,name_key,stem_key,media_kind,updated_at) VALUES(?,?,?,CASE WHEN ? = 'sidecar' THEN 'completed' ELSE 'pending' END,?,?,?,?,?) ON CONFLICT(job_id,path) DO NOTHING").map_err(PhotosError::database)?;
                for entry in entries {
                    let (name, stem, kind) = lookup_keys(&entry.path);
                    insert.execute(params![job_id, entry.path, entry.entry_type, entry.entry_type, parent, name, stem, kind, now]).map_err(PhotosError::database)?;
                }
            }
            transaction.commit().map_err(PhotosError::database)
        }).await
    }

    pub async fn backfill_lookup_keys(&self, job: &Job, worker_id: &str) -> DbResult<()> {
        loop {
            let job_id = job.id.clone();
            let worker_id = worker_id.to_owned();
            let count = self.call(move |connection| {
                let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotosError::database)?;
                ensure_job_owned(&transaction, &job_id, &worker_id)?;
                let paths = {
                    let mut query = transaction.prepare("SELECT path FROM photos_scan_entries WHERE job_id=? AND name_key IS NULL AND entry_type IN ('media','sidecar') ORDER BY path LIMIT 256").map_err(PhotosError::database)?;
                    query.query_map([&job_id], |row| row.get::<_, String>(0)).map_err(PhotosError::database)?.collect::<Result<Vec<_>, _>>().map_err(PhotosError::database)?
                };
                for path in &paths {
                    let (name, stem, kind) = lookup_keys(path);
                    transaction.execute("UPDATE photos_scan_entries SET name_key=?,stem_key=?,media_kind=? WHERE job_id=? AND path=?", params![name, stem, kind, job_id, path]).map_err(PhotosError::database)?;
                }
                transaction.commit().map_err(PhotosError::database)?;
                Ok(paths.len())
            }).await?;
            if count < SCAN_BATCH_SIZE {
                return Ok(());
            }
            tokio::task::yield_now().await;
        }
    }

    pub async fn indexed_sidecar_for(
        &self,
        job_id: &str,
        media_path: &str,
    ) -> DbResult<Result<Option<String>, String>> {
        let job_id = job_id.to_owned();
        let media_path = media_path.to_owned();
        self.call(move |connection| {
            let parent = Path::new(&media_path).parent().unwrap_or_else(|| Path::new("")).to_string_lossy();
            let (name, stem, kind) = lookup_keys(&media_path);
            for key in [format!("{name}.xmp"), format!("{stem}.xmp")] {
                let candidates = {
                    let mut query = connection.prepare_cached(SIDECAR_SQL).map_err(PhotosError::database)?;
                    query.query_map(params![job_id, parent, key], |row| row.get::<_, String>(0)).map_err(PhotosError::database)?.collect::<Result<Vec<_>, _>>().map_err(PhotosError::database)?
                };
                if candidates.len() > 1 { return Ok(Err("Ambiguous XMP sidecar name".into())); }
                if let Some(candidate) = candidates.first() {
                    if key == format!("{name}.xmp") { return Ok(Ok(Some(candidate.clone()))); }
                    let siblings: i64 = connection.query_row("SELECT COUNT(*) FROM (SELECT 1 FROM photos_scan_entries WHERE job_id=? AND parent_path=? AND entry_type='media' AND stem_key=? LIMIT 2)", params![job_id, parent, stem], |row| row.get(0)).map_err(PhotosError::database)?;
                    let raw: i64 = connection.query_row("SELECT COUNT(*) FROM (SELECT 1 FROM photos_scan_entries WHERE job_id=? AND parent_path=? AND entry_type='media' AND stem_key=? AND media_kind='raw' LIMIT 2)", params![job_id, parent, stem], |row| row.get(0)).map_err(PhotosError::database)?;
                    return Ok(if siblings == 1 || (kind == Some("raw") && raw == 1) { Ok(Some(candidate.clone())) } else { Err("Ambiguous XMP sidecar was not attached".into()) });
                }
            }
            Ok(Ok(None))
        }).await
    }

    pub async fn completed_directory(
        &self,
        job: &Job,
        worker_id: &str,
    ) -> DbResult<Option<String>> {
        let job_id = job.id.clone();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            ensure_job_owned(connection, &job_id, &worker_id)?;
            connection.query_row("SELECT path FROM photos_scan_entries WHERE job_id=? AND entry_type='directory' AND status='completed' AND children_processed=0 ORDER BY path LIMIT 1", [job_id], |row| row.get(0)).optional().map_err(PhotosError::database)
        }).await
    }

    pub async fn finish_directory(&self, job: &Job, parent: &str, worker_id: &str) -> DbResult<()> {
        let job_id = job.id.clone();
        let parent = parent.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotosError::database)?;
            ensure_job_owned(&transaction, &job_id, &worker_id)?;
            let pending: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM photos_scan_entries WHERE job_id=? AND parent_path=? AND entry_type='media' AND (status IN ('pending','processing') OR (status='failed' AND error_retryable=1)))", params![job_id,parent], |row| row.get(0)).map_err(PhotosError::database)?;
            if pending { return Err(PhotosError::new(ErrorCode::Database,"Directory still has incomplete media",true)); }
            transaction.execute("UPDATE photos_scan_entries SET children_processed=1 WHERE job_id=? AND path=? AND entry_type='directory' AND status='completed'", params![job_id,parent]).map_err(PhotosError::database)?;
            transaction.commit().map_err(PhotosError::database)
        }).await
    }

    pub async fn claim_media_batch(
        &self,
        job: &Job,
        parent: &str,
        worker_id: &str,
    ) -> DbResult<Vec<ScanEntry>> {
        let job_id = job.id.clone();
        let parent = parent.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotosError::database)?;
            ensure_job_owned(&transaction, &job_id, &worker_id)?;
            let mut entries = Vec::new();
            for sql in [
                MEDIA_PENDING_SQL,
                MEDIA_RETRY_SQL,
            ] {
                let mut query = transaction.prepare_cached(sql).map_err(PhotosError::database)?;
                let rows = query.query_map(params![job_id,parent,now_iso(),(SCAN_BATCH_SIZE-entries.len()) as i64], |row| Ok(ScanEntry { path: row.get(0)?, entry_type: row.get(1)?, retry_count: row.get(2)? })).map_err(PhotosError::database)?;
                entries.extend(rows.collect::<Result<Vec<_>, _>>().map_err(PhotosError::database)?);
                if entries.len() == SCAN_BATCH_SIZE { break; }
            }
            for entry in &entries {
                transaction.execute("UPDATE photos_scan_entries SET status='processing',updated_at=? WHERE job_id=? AND path=?", params![now_iso(),job_id,entry.path]).map_err(PhotosError::database)?;
            }
            transaction.commit().map_err(PhotosError::database)?;
            Ok(entries)
        }).await
    }

    pub async fn complete_unchanged_batch(
        &self,
        job: &Job,
        paths: Vec<String>,
        worker_id: &str,
    ) -> DbResult<()> {
        if paths.len() > SCAN_BATCH_SIZE {
            return Err(PhotosError::internal(
                "Scan completion batch exceeds 256 entries",
            ));
        }
        if paths.is_empty() {
            return Ok(());
        }
        let job = job.clone();
        let worker_id = worker_id.to_owned();
        let current_path = paths.last().cloned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotosError::database)?;
            ensure_job_owned(&transaction, &job.id, &worker_id)?;
            let now = now_iso();
            let mut count = 0;
            for path in paths {
                let changed = transaction.execute("UPDATE photos_scan_entries SET status='completed',error=NULL,error_code=NULL,error_retryable=0,next_retry_at=NULL,updated_at=? WHERE job_id=? AND path=? AND status='processing'", params![now,job.id,path]).map_err(PhotosError::database)?;
                if changed == 1 {
                    transaction.execute("UPDATE photos_assets SET scan_generation=?,indexed_at=? WHERE storage_pool_id=? AND path=? AND library_updated_at=?", params![job.scan_generation,now,job.storage_pool_id,path,job.library_updated_at]).map_err(PhotosError::database)?;
                    count += 1;
                }
            }
            transaction.execute("UPDATE photos_jobs SET scanned=scanned+?,processed=processed+?,current_path=?,phase='processing',updated_at=? WHERE id=?", params![count,count,current_path,now,job.id]).map_err(PhotosError::database)?;
            transaction.commit().map_err(PhotosError::database)
        }).await
    }

    pub async fn current_asset(&self, job: &Job, path: &str) -> DbResult<Option<CurrentAsset>> {
        let pool = job.storage_pool_id.clone();
        let version = job.library_updated_at.clone();
        let path = path.to_owned();
        self.call(move |connection| {
            connection.query_row("SELECT a.id,source_device,source_inode,source_size_bytes,source_mtime_ns,source_ctime_ns,a.sidecar_path,sidecar_device,sidecar_inode,a.sidecar_size_bytes,sidecar_mtime_ns,sidecar_ctime_ns,COALESCE(m.schema_version,0),content_hash,mime_type,width,height,orientation,thumbnail_key,preview_key,m.warnings_json FROM photos_assets a LEFT JOIN photos_asset_metadata m ON m.asset_id=a.id WHERE storage_pool_id=? AND path=? AND library_updated_at=? AND a.status='ready' AND derivative_schema_version=1 AND source_inode IS NOT NULL AND content_hash IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND thumbnail_key IS NOT NULL AND preview_key IS NOT NULL", params![pool,path,version], |row| {
                let sidecar_device: Option<i64> = row.get(7)?;
                Ok(CurrentAsset {
                    id: row.get(0)?,
                    source: FileIdentity { device: row.get::<_,i64>(1)? as u64, inode: row.get::<_,i64>(2)? as u64, size: row.get::<_,i64>(3)? as u64, mtime_ns: row.get(4)?, ctime_ns: row.get(5)? },
                    sidecar_path: row.get(6)?,
                    sidecar: if let Some(device) = sidecar_device { Some(FileIdentity { device: device as u64, inode: row.get::<_,i64>(8)? as u64, size: row.get::<_,i64>(9)? as u64, mtime_ns: row.get(10)?, ctime_ns: row.get(11)? }) } else { None },
                    metadata_version: row.get(12)?,
                    sidecar_warning: serde_json::from_str::<Vec<String>>(&row.get::<_, Option<String>>(20)?.unwrap_or_default()).unwrap_or_default().into_iter().find(|warning| warning.starts_with("Ambiguous XMP sidecar")),
                    media: crate::media::ReusableMedia { content_hash: row.get(13)?, mime_type: row.get(14)?, width: row.get(15)?, height: row.get(16)?, orientation: row.get(17)?, thumbnail_key: row.get(18)?, preview_key: row.get(19)? },
                })
            }).optional().map_err(PhotosError::database)
        }).await
    }

    /// One short cleanup transaction; callers yield between batches so leases and API writes proceed.
    pub async fn prune_history_batch(&self) -> DbResult<usize> {
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotosError::database)?;
            let removed = transaction.execute("DELETE FROM photos_scan_entries WHERE rowid IN (SELECT e.rowid FROM photos_jobs j JOIN photos_scan_entries e ON e.job_id=j.id WHERE (j.status='completed' OR (j.status='failed' AND j.finished_at < ?)) AND NOT EXISTS(SELECT 1 FROM photos_publish_journal p WHERE p.job_id=j.id) LIMIT 1000)", [iso_after(-7*86_400_000)]).map_err(PhotosError::database)?;
            let version = setting_json(&transaction,"photos_library_settings")?.and_then(|value| serde_json::from_str::<LibrarySettings>(&value).ok()).map(|value| value.updated_at);
            let jobs_removed = if removed == 0 {
                transaction.execute("DELETE FROM photos_jobs WHERE id IN (SELECT j.id FROM photos_jobs j WHERE j.status IN ('completed','failed') AND j.finished_at < ? AND NOT EXISTS(SELECT 1 FROM photos_publish_journal p WHERE p.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM photos_scan_entries e WHERE e.job_id=j.id) AND j.id IS NOT (SELECT id FROM photos_jobs WHERE library_updated_at=? ORDER BY created_at DESC,rowid DESC LIMIT 1) AND j.id IS NOT (SELECT id FROM photos_jobs WHERE library_updated_at=? AND kind='full_scan' AND status='completed' ORDER BY finished_at DESC,rowid DESC LIMIT 1) LIMIT 1000)", params![iso_after(-30*86_400_000),version,version]).map_err(PhotosError::database)?
            } else { 0 };
            transaction.commit().map_err(PhotosError::database)?;
            Ok(removed+jobs_removed)
        }).await
    }
}
