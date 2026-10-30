use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::db::{Db, StoragePool};
use crate::error::IndexerError;
use crate::music::{MusicScanEntry, MusicScanTask};
use crate::music_metadata::album_key;

fn now() -> String {
    stamp(OffsetDateTime::now_utc())
}
fn stamp(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).unwrap_or_default()
}
fn future() -> String {
    stamp(OffsetDateTime::now_utc() + Duration::from_secs(30))
}
fn ready(connection: &Connection) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='music_scan_entries'",
            [],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
}
fn assert_lease(
    connection: &Connection,
    task: &MusicScanTask,
    worker: &str,
) -> Result<(), IndexerError> {
    let valid: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM music_scan_runs r JOIN music_sources s ON s.id=r.source_id WHERE r.id=? AND r.generation=? AND r.worker_id=? AND r.status='running' AND r.lease_expires_at>? AND s.enabled=1 AND s.removed=0)", params![task.id, task.generation, worker, now()], |row| row.get(0)).map_err(IndexerError::database)?;
    if valid {
        Ok(())
    } else {
        Err(IndexerError::database("Music scan lease was lost"))
    }
}

impl Db {
    pub async fn cached_music_metadata(
        &self,
        pool: &str,
        path: &str,
        signature: &str,
    ) -> Result<Option<crate::music_metadata::MusicMetadata>, IndexerError> {
        let pool = pool.to_owned();
        let path = path.to_owned();
        let signature = signature.to_owned();
        self.call(move |connection| {
            let value: Option<String> = connection.query_row(
                "SELECT json_object('title',title,'album',album,'artists',json(artists_json),'album_artists',json(album_artists_json),'genres',json(genres_json),'year',year,'track_number',track_number,'disc_number',disc_number,'duration_seconds',duration_seconds,'bitrate',bitrate,'sample_rate',sample_rate,'bit_depth',bit_depth,'musicbrainz_recording_id',musicbrainz_recording_id,'musicbrainz_release_id',musicbrainz_release_id,'artwork_key',artwork_key,'lyrics_text',lyrics_text,'lyrics_format',lyrics_format) FROM music_tracks WHERE storage_pool_id=? AND relative_path=? AND metadata_signature=?",
                params![pool,path,signature], |row| row.get(0),
            ).optional().map_err(IndexerError::database)?;
            value.map(|json|serde_json::from_str(&json).map_err(IndexerError::database)).transpose()
        }).await
    }

    pub async fn enqueue_music_changes(&self, pool: &str, path: &str) -> Result<(), IndexerError> {
        let pool = pool.to_owned();
        let path = path.to_owned();
        self.call(move |connection| {
            if !ready(connection) { return Ok(()); }
            let ids = {
                let mut statement = connection.prepare("SELECT id FROM music_sources WHERE enabled=1 AND removed=0 AND storage_pool_id=? AND (path='.' OR ?='.' OR path=? OR substr(?,1,length(path)+1)=path||'/' OR substr(path,1,length(?)+1)=?||'/')").map_err(IndexerError::database)?;
                statement.query_map(params![pool,path,path,path,path,path], |row| row.get::<_,String>(0)).map_err(IndexerError::database)?.collect::<Result<Vec<_>,_>>().map_err(IndexerError::database)?
            };
            for id in ids { enqueue(connection, &id)?; }
            Ok(())
        }).await
    }

    pub async fn reconcile_music(&self, interval: Duration) -> Result<(), IndexerError> {
        self.call(move |connection| {
            if !ready(connection) { return Ok(()); }
            let cutoff = stamp(OffsetDateTime::now_utc() - interval);
            let ids = {
                let mut statement = connection.prepare("SELECT s.id FROM music_sources s WHERE s.enabled=1 AND s.removed=0 AND NOT EXISTS(SELECT 1 FROM music_scan_runs r WHERE r.source_id=s.id AND r.updated_at>?)").map_err(IndexerError::database)?;
                statement.query_map([cutoff], |row| row.get::<_,String>(0)).map_err(IndexerError::database)?.collect::<Result<Vec<_>,_>>().map_err(IndexerError::database)?
            };
            for id in ids { enqueue(connection, &id)?; }
            Ok(())
        }).await
    }

    pub async fn claim_music_scan(
        &self,
        worker: &str,
        pools: &[StoragePool],
    ) -> Result<Option<MusicScanTask>, IndexerError> {
        let worker = worker.to_owned();
        let pools = pools.to_vec();
        self.call(move |connection| {
            if !ready(connection) { return Ok(None); }
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(IndexerError::database)?;
            transaction.execute("DELETE FROM music_scan_entries WHERE scan_id IN (SELECT id FROM music_scan_runs WHERE status IN ('completed','failed','cancelled'))", []).map_err(IndexerError::database)?;
            transaction.execute("UPDATE music_scan_runs SET status='queued',worker_id=NULL,lease_expires_at=NULL WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)", [now()]).map_err(IndexerError::database)?;
            let row = transaction.query_row("SELECT r.id,r.generation,s.id,s.storage_pool_id,s.path,r.full_scan FROM music_scan_runs r JOIN music_sources s ON s.id=r.source_id WHERE r.status='queued' AND s.enabled=1 AND s.removed=0 ORDER BY r.created_at,r.id LIMIT 1", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,bool>(5)?))).optional().map_err(IndexerError::database)?;
            let Some((id,_previous_generation,source_id,pool_id,source_path,full_scan)) = row else { transaction.commit().map_err(IndexerError::database)?; return Ok(None); };
            let Some(pool) = pools.iter().find(|pool| pool.id==pool_id) else {
                transaction.execute("UPDATE music_scan_runs SET status='failed',error='Storage pool is unavailable',finished_at=?,updated_at=? WHERE id=?", params![now(),now(),id]).map_err(IndexerError::database)?;
                transaction.execute("DELETE FROM music_scan_entries WHERE scan_id=?", [&id]).map_err(IndexerError::database)?;
                transaction.commit().map_err(IndexerError::database)?;
                return Ok(None);
            };
            let generation=Uuid::new_v4().to_string();
            transaction.execute("DELETE FROM music_scan_entries WHERE scan_id=?", [&id]).map_err(IndexerError::database)?;
            transaction.execute("UPDATE music_scan_runs SET status='running',generation=?,worker_id=?,lease_expires_at=?,started_at=?,updated_at=?,scanned=0,added=0,updated=0,removed=0,current_path=NULL,error=NULL,finished_at=NULL WHERE id=?", params![generation,worker,future(),now(),now(),id]).map_err(IndexerError::database)?;
            let task = MusicScanTask { id,generation,source_id,source_path,pool:pool.clone(),full_scan };
            transaction.commit().map_err(IndexerError::database)?;
            Ok(Some(task))
        }).await
    }

    pub async fn renew_music_scan(
        &self,
        task: &MusicScanTask,
        worker: &str,
    ) -> Result<(), IndexerError> {
        let task = task.clone();
        let worker = worker.to_owned();
        self.call(move |connection| {
            assert_lease(connection,&task,&worker)?;
            connection.execute("UPDATE music_scan_runs SET lease_expires_at=?,updated_at=? WHERE id=? AND worker_id=? AND status='running'", params![future(),now(),task.id,worker]).map_err(IndexerError::database)?;
            Ok(())
        }).await
    }

    pub async fn stage_music_entries(
        &self,
        task: &MusicScanTask,
        worker: &str,
        entries: Vec<MusicScanEntry>,
        scanned: u64,
    ) -> Result<(), IndexerError> {
        let task = task.clone();
        let worker = worker.to_owned();
        self.call(move |connection| {
            let transaction=connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(IndexerError::database)?;
            assert_lease(&transaction,&task,&worker)?;
            for entry in &entries {
                transaction.execute("INSERT OR REPLACE INTO music_scan_entries(scan_id,relative_path,entry_json) VALUES (?,?,?)", params![task.id,entry.relative_path,serde_json::to_string(entry).map_err(IndexerError::database)?]).map_err(IndexerError::database)?;
            }
            transaction.execute("UPDATE music_scan_runs SET scanned=?,current_path=?,lease_expires_at=?,updated_at=? WHERE id=?", params![i64::try_from(scanned).map_err(IndexerError::database)?,entries.last().map(|entry|entry.relative_path.as_str()),future(),now(),task.id]).map_err(IndexerError::database)?;
            transaction.commit().map_err(IndexerError::database)
        }).await
    }

    pub async fn publish_music_batch(
        &self,
        task: &MusicScanTask,
        worker: &str,
        after: &str,
    ) -> Result<Option<String>, IndexerError> {
        let task = task.clone();
        let worker = worker.to_owned();
        let after = after.to_owned();
        self.call(move |connection| {
            let transaction=connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(IndexerError::database)?;
            assert_lease(&transaction,&task,&worker)?;
            let entries = {
                let mut statement=transaction.prepare("SELECT entry_json FROM music_scan_entries WHERE scan_id=? AND relative_path>? ORDER BY relative_path LIMIT 100").map_err(IndexerError::database)?;
                statement.query_map(params![task.id,after],|row|row.get::<_,String>(0)).map_err(IndexerError::database)?.collect::<Result<Vec<_>,_>>().map_err(IndexerError::database)?
            };
            let mut last=None; let mut added=0; let mut updated=0;
            for json in entries {
                let entry: MusicScanEntry=serde_json::from_str(&json).map_err(IndexerError::database)?;
                let metadata=&entry.metadata;
                let old_album: Option<String> = transaction.query_row("SELECT album_id FROM music_tracks WHERE storage_pool_id=? AND relative_path=?", params![task.pool.id,entry.relative_path], |row| row.get(0)).optional().map_err(IndexerError::database)?;
                let album_id=album_key(&task.pool.id,std::path::Path::new(&entry.relative_path),&metadata.album,&metadata.album_artists,metadata.musicbrainz_release_id.as_deref());
                transaction.execute("INSERT INTO music_tracks(id,source_id,storage_pool_id,relative_path,title,album_id,album,artists_json,album_artists_json,genres_json,year,track_number,disc_number,duration_seconds,bitrate,sample_rate,bit_depth,musicbrainz_recording_id,musicbrainz_release_id,artwork_key,lyrics_text,lyrics_format,size_bytes,mtime_ms,metadata_signature,scan_generation,missing,added_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(storage_pool_id,relative_path) DO UPDATE SET source_id=excluded.source_id,title=excluded.title,album_id=excluded.album_id,album=excluded.album,artists_json=excluded.artists_json,album_artists_json=excluded.album_artists_json,genres_json=excluded.genres_json,year=excluded.year,track_number=excluded.track_number,disc_number=excluded.disc_number,duration_seconds=excluded.duration_seconds,bitrate=excluded.bitrate,sample_rate=excluded.sample_rate,bit_depth=excluded.bit_depth,musicbrainz_recording_id=excluded.musicbrainz_recording_id,musicbrainz_release_id=excluded.musicbrainz_release_id,artwork_key=excluded.artwork_key,lyrics_text=excluded.lyrics_text,lyrics_format=excluded.lyrics_format,size_bytes=excluded.size_bytes,mtime_ms=excluded.mtime_ms,metadata_signature=excluded.metadata_signature,scan_generation=excluded.scan_generation,missing=0,updated_at=excluded.updated_at",params![Uuid::new_v4().to_string(),task.source_id,task.pool.id,entry.relative_path,metadata.title,album_id,metadata.album,serde_json::to_string(&metadata.artists).map_err(IndexerError::database)?,serde_json::to_string(&metadata.album_artists).map_err(IndexerError::database)?,serde_json::to_string(&metadata.genres).map_err(IndexerError::database)?,metadata.year,metadata.track_number,metadata.disc_number,metadata.duration_seconds,metadata.bitrate,metadata.sample_rate,metadata.bit_depth,metadata.musicbrainz_recording_id,metadata.musicbrainz_release_id,metadata.artwork_key,metadata.lyrics_text,metadata.lyrics_format,i64::try_from(entry.size_bytes).map_err(IndexerError::database)?,entry.mtime_ms,entry.metadata_signature,task.generation,now(),now()]).map_err(IndexerError::database)?;
                if let Some(old_album) = old_album {
                    updated += 1;
                    if old_album != album_id {
                        transaction.execute("INSERT OR IGNORE INTO music_favorites(kind,entity_id,created_at) SELECT 'album',?,created_at FROM music_favorites WHERE kind='album' AND entity_id=?",params![album_id,old_album]).map_err(IndexerError::database)?;
                    }
                } else { added += 1; }
                last=Some(entry.relative_path);
            }
            transaction.execute("UPDATE music_scan_runs SET added=added+?,updated=updated+?,lease_expires_at=?,updated_at=? WHERE id=?",params![added,updated,future(),now(),task.id]).map_err(IndexerError::database)?;
            transaction.commit().map_err(IndexerError::database)?;
            Ok(last)
        }).await
    }

    pub async fn complete_music_scan(
        &self,
        task: &MusicScanTask,
        worker: &str,
    ) -> Result<(), IndexerError> {
        let task = task.clone();
        let worker = worker.to_owned();
        self.call(move |connection| {
            let transaction=connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(IndexerError::database)?;
            assert_lease(&transaction,&task,&worker)?;
            let rescan: (bool,bool) = transaction.query_row("SELECT rescan_requested,full_scan FROM music_scan_runs WHERE id=?",[&task.id],|row|Ok((row.get(0)?,row.get(1)?))).map_err(IndexerError::database)?;
            let removed=transaction.execute("UPDATE music_tracks SET missing=1,updated_at=? WHERE source_id=? AND scan_generation<>? AND missing=0",params![now(),task.source_id,task.generation]).map_err(IndexerError::database)?;
            transaction.execute("UPDATE music_scan_runs SET status='completed',removed=?,worker_id=NULL,lease_expires_at=NULL,current_path=NULL,finished_at=?,updated_at=? WHERE id=?",params![i64::try_from(removed).map_err(IndexerError::database)?,now(),now(),task.id]).map_err(IndexerError::database)?;
            transaction.execute("DELETE FROM music_scan_entries WHERE scan_id=?",[task.id]).map_err(IndexerError::database)?;
            if rescan.0 {
                enqueue(&transaction,&task.source_id)?;
                if rescan.1 { transaction.execute("UPDATE music_scan_runs SET full_scan=1 WHERE source_id=? AND status='queued'",[task.source_id]).map_err(IndexerError::database)?; }
            }
            transaction.commit().map_err(IndexerError::database)
        }).await
    }

    pub async fn fail_music_scan(
        &self,
        task: &MusicScanTask,
        worker: &str,
        error: &IndexerError,
    ) -> Result<(), IndexerError> {
        let id = task.id.clone();
        let generation = task.generation.clone();
        let worker = worker.to_owned();
        let message = error.message.clone();
        self.call(move |connection| {
            let transaction=connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(IndexerError::database)?;
            let changed=transaction.execute("UPDATE music_scan_runs SET status='failed',error=?,worker_id=NULL,lease_expires_at=NULL,finished_at=?,updated_at=? WHERE id=? AND generation=? AND status='running' AND worker_id=?",params![message,now(),now(),id,generation,worker]).map_err(IndexerError::database)?;
            if changed>0 { transaction.execute("DELETE FROM music_scan_entries WHERE scan_id=?",[id]).map_err(IndexerError::database)?; }
            transaction.commit().map_err(IndexerError::database)
        }).await
    }
}

fn enqueue(connection: &Connection, source: &str) -> Result<(), IndexerError> {
    connection.execute("INSERT OR IGNORE INTO music_scan_runs(id,source_id,status,generation,created_at,updated_at,full_scan) VALUES (?,?,'queued',?,?,?,0)",params![Uuid::new_v4().to_string(),source,Uuid::new_v4().to_string(),now(),now()]).map_err(IndexerError::database)?;
    connection
        .execute(
            "UPDATE music_scan_runs SET rescan_requested=1 WHERE source_id=? AND status='running'",
            [source],
        )
        .map_err(IndexerError::database)?;
    Ok(())
}
