use std::fs::File;
use std::os::unix::fs::FileExt;
use std::os::unix::fs::MetadataExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::{StreamExt, TryStreamExt, stream};
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, ETAG, LAST_MODIFIED};
use reqwest::{Response, StatusCode};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::io::AsyncReadExt;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::config::Config;
use crate::db::{Db, DownloadSettings, Progress, PublishJournal, Segment, SegmentCheckpoint, Task};
use crate::error::{DownloadError, ErrorCode};
use crate::network::{RangeRequest, RequestOptions, get};
use crate::retry::retry_delay;
use crate::storage::{FileIdentity, StorageTarget};

const LEASE: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(750);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
#[cfg(not(test))]
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(1);
#[cfg(test)]
const CHECKPOINT_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(not(test))]
const MIN_SEGMENT_BYTES: u64 = 16 * 1024 * 1024;
#[cfg(test)]
const MIN_SEGMENT_BYTES: u64 = 1024 * 1024;
const MAX_SEGMENTS: u64 = 4096;

#[derive(Clone)]
pub struct Downloader {
    db: Db,
    worker_id: String,
    shutdown: CancellationToken,
}

#[derive(Debug)]
struct Probe {
    total: Option<u64>,
    etag: Option<String>,
    last_modified: Option<String>,
    segmented: bool,
}

struct SegmentProgress {
    initial_bytes: u64,
    written_bytes: AtomicU64,
    started: Instant,
}

impl SegmentProgress {
    fn new(initial_bytes: u64) -> Self {
        Self {
            initial_bytes,
            written_bytes: AtomicU64::new(initial_bytes),
            started: Instant::now(),
        }
    }

    fn record(&self, bytes: u64) {
        self.written_bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    fn speed(&self) -> u64 {
        let transferred = self
            .written_bytes
            .load(Ordering::Relaxed)
            .saturating_sub(self.initial_bytes);
        (transferred as f64 / self.started.elapsed().as_secs_f64().max(0.001)) as u64
    }
}

#[derive(Debug)]
enum TaskOutcome {
    Complete,
    Interrupted { cancelled: bool },
    Shutdown,
}

struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl Downloader {
    pub fn new(config: &Config) -> Result<Self, DownloadError> {
        Ok(Self {
            db: Db::open(&config.database_path)?,
            worker_id: Uuid::new_v4().to_string(),
            shutdown: CancellationToken::new(),
        })
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    pub async fn run(&self) -> Result<(), DownloadError> {
        self.db.wait_for_schema(Duration::from_secs(60)).await?;
        self.db
            .register_worker(&self.worker_id, env!("CARGO_PKG_VERSION"))
            .await?;
        self.db.recover_expired().await?;
        self.recover_publish_journals().await?;

        let mut tasks = JoinSet::new();
        let mut poll = tokio::time::interval(POLL_INTERVAL);
        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);

        let run_result = async {
            loop {
                tokio::select! {
                    _ = self.shutdown.cancelled() => break,
                    _ = heartbeat.tick() => {
                        self.db.heartbeat_worker(&self.worker_id).await?;
                        self.recover_publish_journals().await?;
                    }
                    Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                        if let Err(error) = result {
                            error!(%error, "download task panicked");
                        }
                    }
                    _ = poll.tick() => {
                        self.db.recover_expired().await?;
                        self.recover_publish_journals().await?;
                        let settings = self.db.settings().await?;
                        let running = self.db.running_count().await?;
                        let slots = settings.concurrency.saturating_sub(running);
                        for _ in 0..slots {
                            let Some(task) = self.db.claim(&self.worker_id, LEASE).await? else { break };
                            let downloader = self.clone();
                            tasks.spawn(async move {
                                downloader.handle_task(task).await;
                            });
                        }
                    }
                }
            }
            Ok::<(), DownloadError>(())
        }
        .await;

        self.shutdown.cancel();
        let shutdown_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while !tasks.is_empty()
            && tokio::time::timeout_at(shutdown_deadline, tasks.join_next())
                .await
                .is_ok_and(|result| result.is_some())
        {}
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        let requeue_result = self.db.requeue_owned(&self.worker_id).await;
        let remove_worker_result = self.db.remove_worker(&self.worker_id).await;
        run_result?;
        requeue_result?;
        remove_worker_result
    }

    async fn handle_task(&self, task: Task) {
        let settings = match self.db.settings().await {
            Ok(settings) => settings,
            Err(error) => {
                error!(task_id = %task.id, %error, "could not load download settings");
                return;
            }
        };
        let lease_stop = CancellationToken::new();
        let _lease_stop_guard = CancelOnDrop(lease_stop.clone());
        let lease_lost = CancellationToken::new();
        let lease_heartbeat = {
            let db = self.db.clone();
            let task_id = task.id.clone();
            let worker_id = self.worker_id.clone();
            let lease_stop = lease_stop.clone();
            let lease_lost = lease_lost.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval_at(
                    tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
                    HEARTBEAT_INTERVAL,
                );
                loop {
                    tokio::select! {
                        _ = lease_stop.cancelled() => break,
                        _ = interval.tick() => match db.extend_lease(&task_id, &worker_id, LEASE).await {
                            Ok(true) => {}
                            Ok(false) => {
                                lease_lost.cancel();
                                break;
                            }
                            Err(error) => {
                                warn!(task_id = %task_id, %error, "could not renew task lease");
                                lease_lost.cancel();
                                break;
                            }
                        }
                    }
                }
            })
        };
        let result = tokio::select! {
            biased;
            result = self.run_task(&task, &settings) => result,
            _ = lease_lost.cancelled() => Err(DownloadError::new(
                ErrorCode::Database,
                "download task lease could not be renewed",
                true,
            )),
        };
        lease_stop.cancel();
        let _ = lease_heartbeat.await;
        match result {
            Ok(TaskOutcome::Complete) => info!(task_id = %task.id, "download completed"),
            Ok(TaskOutcome::Interrupted { cancelled }) => {
                if cancelled && let Ok(target) = StorageTarget::resolve(&task) {
                    let _ = target.remove_partial();
                }
                let _ = self.db.finish_control(&task, cancelled).await;
            }
            Ok(TaskOutcome::Shutdown) => {}
            Err(error) => {
                if let Ok(Some(TaskOutcome::Interrupted { cancelled })) =
                    self.control_outcome(&task).await
                {
                    if cancelled && let Ok(target) = StorageTarget::resolve(&task) {
                        let _ = target.remove_partial();
                    }
                    let _ = self.db.finish_control(&task, cancelled).await;
                    return;
                }
                let next_retry = task.retry_count.saturating_add(1);
                let delay =
                    (error.retryable && task.retry_count < settings.max_auto_retries).then(|| {
                        retry_delay(
                            next_retry,
                            settings.retry_base_delay_ms,
                            settings.retry_max_delay_ms,
                            error.retry_after_ms,
                            settings.retry_after_max_delay_ms,
                        )
                    });
                match self.db.fail_or_retry(&task, &error, &settings, delay).await {
                    Ok(true) => {
                        warn!(task_id = %task.id, code = error.code.as_str(), ?delay, "download scheduled for retry")
                    }
                    Ok(false) => {
                        error!(task_id = %task.id, code = error.code.as_str(), message = %error.message, "download failed")
                    }
                    Err(db_error) => {
                        error!(task_id = %task.id, %db_error, "could not persist download failure")
                    }
                }
            }
        }
    }

    async fn run_task(
        &self,
        task: &Task,
        settings: &DownloadSettings,
    ) -> Result<TaskOutcome, DownloadError> {
        if self.shutdown.is_cancelled() {
            return Ok(TaskOutcome::Shutdown);
        }
        let target = Arc::new(StorageTarget::resolve(task)?);
        if target.target_identity()?.is_some() {
            return Err(DownloadError::new(
                ErrorCode::TargetConflict,
                "download target already exists",
                false,
            ));
        }
        let options = request_options(settings);
        let mut probe = probe_source(task, settings, &options).await?;
        let _partial_lock = target.lock_partial()?;
        let mut restarted_for_source_change = false;
        let (size, mode) = loop {
            enforce_size(probe.total, settings)?;
            let result = if probe.segmented {
                self.download_segmented(task, settings, &options, &probe, &target)
                    .await
                    .map(|size| (size, "segmented"))
            } else {
                self.download_single(task, settings, &options, &probe, &target)
                    .await
                    .map(|size| (size, "single"))
            };
            match result {
                Err(error)
                    if error.code == ErrorCode::SourceChanged && !restarted_for_source_change =>
                {
                    restarted_for_source_change = true;
                    self.db.reset_transfer(&task.id, &self.worker_id).await?;
                    let partial = target.open_partial(true)?;
                    partial.sync_data().map_err(DownloadError::storage)?;
                    probe = probe_source(task, settings, &options).await?;
                }
                result => break result?,
            }
        };
        if let Some(outcome) = self.control_outcome(task).await? {
            return Ok(outcome);
        }
        if self.shutdown.is_cancelled() {
            return Ok(TaskOutcome::Shutdown);
        }

        let actual_sha256 = if let Some(expected) = &task.expected_sha256 {
            let Some(checksum) = self
                .hash_file(task, target.open_partial_readonly()?)
                .await?
            else {
                return Ok(TaskOutcome::Shutdown);
            };
            if !self
                .db
                .set_actual_checksum(&task.id, &self.worker_id, &checksum)
                .await?
            {
                return self.interrupted_error(task).await;
            }
            if &checksum != expected {
                return Err(DownloadError::new(
                    ErrorCode::ChecksumMismatch,
                    format!("SHA-256 mismatch: expected {expected}, received {checksum}"),
                    false,
                ));
            }
            Some(checksum)
        } else {
            None
        };
        if let Some(outcome) = self.control_outcome(task).await? {
            return Ok(outcome);
        }
        if self.shutdown.is_cancelled() {
            return Ok(TaskOutcome::Shutdown);
        }

        let file = target.open_partial(false)?;
        let metadata = file.metadata().map_err(DownloadError::storage)?;
        let identity = FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.len(),
        };
        if identity.size != size {
            return Err(DownloadError::new(
                ErrorCode::Storage,
                "download size changed before publication",
                false,
            ));
        }
        target.prepare_publish(&file, identity).await?;
        if let Some(outcome) = self.control_outcome(task).await? {
            return Ok(outcome);
        }
        if self.shutdown.is_cancelled() {
            return Ok(TaskOutcome::Shutdown);
        }
        let journal = PublishJournal {
            task_id: task.id.clone(),
            operation_id: format!("download:{}", task.id),
            worker_id: self.worker_id.clone(),
            device: identity.device,
            inode: identity.inode,
            size_bytes: size,
            sha256: actual_sha256,
        };
        self.db.begin_publish(journal.clone()).await?;
        target.publish()?;
        self.db.finalize_publish(&journal, task, mode).await?;
        Ok(TaskOutcome::Complete)
    }

    async fn download_single(
        &self,
        task: &Task,
        settings: &DownloadSettings,
        options: &RequestOptions,
        probe: &Probe,
        target: &StorageTarget,
    ) -> Result<u64, DownloadError> {
        let existing = target
            .partial_identity()?
            .map_or(0, |identity| identity.size);
        let validator = validator(probe);
        let can_resume = task.received_bytes > 0
            && existing >= task.received_bytes
            && validator.is_some()
            && validators_match(task, probe)
            && probe.total.is_none_or(|total| task.received_bytes <= total);
        let mut start = if can_resume { task.received_bytes } else { 0 };
        if !can_resume && existing > 0 {
            self.db.reset_transfer(&task.id, &self.worker_id).await?;
        }
        let mut file = target.open_partial(start == 0)?;
        if can_resume && existing != start {
            file.set_len(start).map_err(DownloadError::storage)?;
            file.sync_data().map_err(DownloadError::storage)?;
        }
        if can_resume && probe.total == Some(start) {
            return Ok(start);
        }
        let mut response = get(
            &task.url,
            options,
            &RangeRequest {
                start: (start > 0).then_some(start),
                end_inclusive: None,
                if_range: (start > 0).then(|| validator.clone()).flatten(),
            },
        )
        .await?
        .0;
        if start > 0 && !valid_range_response(&response, start, None, probe.total) {
            response = get(&task.url, options, &RangeRequest::default()).await?.0;
            if response.status() != StatusCode::OK {
                return Err(http_status_error(response.status()));
            }
            self.db.reset_transfer(&task.id, &self.worker_id).await?;
            file = target.open_partial(true)?;
            start = 0;
        }
        if start > 0 && response_validator_conflicts(&response, probe) {
            return Err(DownloadError::new(
                ErrorCode::SourceChanged,
                "download source validator changed during resumed transfer",
                false,
            ));
        }
        if start == 0 && response.status() != StatusCode::OK {
            return Err(http_status_error(response.status()));
        }
        let response_length = header_u64(&response, CONTENT_LENGTH);
        let total = if start > 0 {
            parse_content_range(
                response
                    .headers()
                    .get(CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok()),
            )
            .and_then(|range| range.2)
        } else {
            response_length
        };
        if start == 0
            && (probe
                .total
                .zip(total)
                .is_some_and(|(expected, actual)| expected != actual)
                || response_validator_conflicts(&response, probe))
        {
            return Err(DownloadError::new(
                ErrorCode::SourceChanged,
                "download source changed after capability probing",
                false,
            ));
        }
        enforce_size(total, settings)?;
        if let Some(total) = total {
            self.db
                .reserve_space(
                    task,
                    total.saturating_sub(start),
                    target.available_bytes()?,
                    settings.min_free_space_bytes,
                )
                .await?;
        }
        let mut offset = start;
        let started = Instant::now();
        let mut checkpoint = tokio::time::interval_at(
            tokio::time::Instant::now() + CHECKPOINT_INTERVAL,
            CHECKPOINT_INTERVAL,
        );
        let mut body = response.bytes_stream();
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => {
                    file.sync_data().map_err(DownloadError::storage)?;
                    return Ok(offset);
                }
                _ = checkpoint.tick() => {
                    file.sync_data().map_err(DownloadError::storage)?;
                    let speed =
                        ((offset - start) as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
                    let owned = self
                        .db
                        .progress(
                            &task.id,
                            &self.worker_id,
                            LEASE,
                            Progress {
                                received_bytes: offset,
                                total_bytes: total,
                                speed_bytes_per_second: speed,
                                etag: probe.etag.as_deref(),
                                last_modified: probe.last_modified.as_deref(),
                                phase: "downloading",
                                mode: "single",
                                segment_count: 0,
                            },
                        )
                        .await?;
                    if !owned {
                        return self.interrupted_error(task).await;
                    }
                }
                chunk = body.next() => {
                    let Some(chunk) = chunk else { break };
                    let chunk = chunk.map_err(body_error)?;
                    let next = offset.saturating_add(chunk.len() as u64);
                    if settings
                        .max_file_size_bytes
                        .is_some_and(|limit| next > limit)
                    {
                        return Err(DownloadError::new(
                            ErrorCode::SizeLimit,
                            "download exceeded the configured file size limit",
                            false,
                        ));
                    }
                    if target.available_bytes()? < settings.min_free_space_bytes.saturating_add(chunk.len() as u64) {
                        return Err(DownloadError::new(
                            ErrorCode::DiskSpace,
                            "download reached the configured free-space reserve",
                            false,
                        ));
                    }
                    file.write_all_at(&chunk, offset)
                        .map_err(DownloadError::storage)?;
                    offset = next;
                }
            }
        }
        file.set_len(offset).map_err(DownloadError::storage)?;
        file.sync_data().map_err(DownloadError::storage)?;
        if let Some(expected) = response_length
            && offset.saturating_sub(start) != expected
        {
            return Err(DownloadError::new(
                ErrorCode::Connect,
                "download ended before the expected response length",
                true,
            ));
        }
        if total.is_some_and(|total| total != offset) {
            return Err(DownloadError::new(
                ErrorCode::RangeProtocol,
                "download size did not match the advertised total",
                true,
            ));
        }
        if !self
            .db
            .progress(
                &task.id,
                &self.worker_id,
                LEASE,
                Progress {
                    received_bytes: offset,
                    total_bytes: Some(offset),
                    speed_bytes_per_second: 0,
                    etag: probe.etag.as_deref(),
                    last_modified: probe.last_modified.as_deref(),
                    phase: "downloading",
                    mode: "single",
                    segment_count: 0,
                },
            )
            .await?
        {
            return self.interrupted_error(task).await;
        }
        Ok(offset)
    }

    async fn download_segmented(
        &self,
        task: &Task,
        settings: &DownloadSettings,
        options: &RequestOptions,
        probe: &Probe,
        target: &StorageTarget,
    ) -> Result<u64, DownloadError> {
        let total = probe.total.expect("segmented downloads have a total");
        let validator = validator(probe).expect("segmented downloads have a validator");
        let mut segments = self.db.segments(&task.id).await?;
        let partial = target.partial_identity()?;
        let existing = partial.map_or(0, |identity| identity.size);
        let mut truncate = false;
        if !segments.is_empty()
            && (partial.is_none() || existing != total || !segments_cover_total(&segments, total))
        {
            self.db.reset_transfer(&task.id, &self.worker_id).await?;
            segments.clear();
            truncate = true;
        }
        if segments.is_empty() {
            let prefix = if existing == 0 || truncate {
                0
            } else if validators_match(task, probe)
                && task.received_bytes == existing
                && existing <= total
            {
                existing
            } else {
                self.db.reset_transfer(&task.id, &self.worker_id).await?;
                truncate = true;
                0
            };
            segments = plan_segments(total, prefix);
            self.db
                .replace_segments(&task.id, &self.worker_id, &segments)
                .await?;
            truncate |= prefix == 0;
        }
        let file = target.open_partial(truncate)?;
        file.set_len(total).map_err(DownloadError::storage)?;
        let received = segments
            .iter()
            .map(|segment| segment.next.saturating_sub(segment.start))
            .sum();
        self.db
            .reserve_space(
                task,
                total.saturating_sub(received),
                target.available_bytes()?,
                settings.min_free_space_bytes,
            )
            .await?;
        let segment_count = u32::try_from(segments.len()).unwrap_or(u32::MAX);
        if !self
            .db
            .progress(
                &task.id,
                &self.worker_id,
                LEASE,
                Progress {
                    received_bytes: received,
                    total_bytes: Some(total),
                    speed_bytes_per_second: 0,
                    etag: probe.etag.as_deref(),
                    last_modified: probe.last_modified.as_deref(),
                    phase: "downloading",
                    mode: "segmented",
                    segment_count,
                },
            )
            .await?
        {
            return self.interrupted_error(task).await;
        }
        let pending: Vec<_> = segments
            .into_iter()
            .filter(|segment| segment.next < segment.end)
            .collect();
        let transfer_progress = Arc::new(SegmentProgress::new(received));
        stream::iter(pending.into_iter().map(|segment| {
            let downloader = self.clone();
            let db = self.db.clone();
            let task = task.clone();
            let options = options.clone();
            let probe = probe.clone();
            let file = file.try_clone().map_err(DownloadError::storage);
            let validator = validator.clone();
            let transfer_progress = transfer_progress.clone();
            async move {
                let file = file?;
                downloader
                    .download_segment(
                        &db,
                        &task,
                        &options,
                        &probe,
                        settings,
                        target,
                        file,
                        segment,
                        total,
                        &validator,
                        &transfer_progress,
                    )
                    .await
            }
        }))
        .buffer_unordered(settings.parallel_requests_per_task)
        .try_collect::<Vec<_>>()
        .await?;
        file.sync_all().map_err(DownloadError::storage)?;
        Ok(total)
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_segment(
        &self,
        db: &Db,
        task: &Task,
        options: &RequestOptions,
        probe: &Probe,
        settings: &DownloadSettings,
        target: &StorageTarget,
        file: File,
        segment: Segment,
        total: u64,
        validator: &str,
        transfer_progress: &SegmentProgress,
    ) -> Result<(), DownloadError> {
        let response = get(
            &task.url,
            options,
            &RangeRequest {
                start: Some(segment.next),
                end_inclusive: Some(segment.end - 1),
                if_range: Some(validator.to_owned()),
            },
        )
        .await?
        .0;
        if !valid_range_response(&response, segment.next, Some(segment.end - 1), Some(total)) {
            let source_changed = response_validator_conflicts(&response, probe);
            return Err(DownloadError::new(
                if source_changed {
                    ErrorCode::SourceChanged
                } else {
                    ErrorCode::RangeProtocol
                },
                if source_changed {
                    "download source changed during segmented transfer"
                } else {
                    "download server did not honor the requested segment"
                },
                false,
            ));
        }
        if !response_validators_match(&response, probe) {
            return Err(DownloadError::new(
                ErrorCode::SourceChanged,
                "download source changed during segmented transfer",
                false,
            ));
        }
        let mut offset = segment.next;
        let mut checkpoint = tokio::time::interval_at(
            tokio::time::Instant::now() + CHECKPOINT_INTERVAL,
            CHECKPOINT_INTERVAL,
        );
        let mut body = response.bytes_stream();
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => return Ok(()),
                _ = checkpoint.tick() => {
                    file.sync_data().map_err(DownloadError::storage)?;
                    if !db
                        .checkpoint_segment(
                            &task.id,
                            &self.worker_id,
                            SegmentCheckpoint {
                                start: segment.start,
                                next: offset,
                                total,
                                speed_bytes_per_second: transfer_progress.speed(),
                            },
                            LEASE,
                        )
                        .await?
                    {
                        return self.interrupted_error(task).await;
                    }
                }
                chunk = body.next() => {
                    let Some(chunk) = chunk else { break };
                    let chunk = chunk.map_err(body_error)?;
                    let next = offset.saturating_add(chunk.len() as u64);
                    if next > segment.end {
                        return Err(DownloadError::new(
                            ErrorCode::RangeProtocol,
                            "range response exceeded its requested segment",
                            false,
                        ));
                    }
                    if target.available_bytes()? < settings.min_free_space_bytes.saturating_add(chunk.len() as u64) {
                        return Err(DownloadError::new(
                            ErrorCode::DiskSpace,
                            "download reached the configured free-space reserve",
                            false,
                        ));
                    }
                    file.write_all_at(&chunk, offset)
                        .map_err(DownloadError::storage)?;
                    offset = next;
                    transfer_progress.record(chunk.len() as u64);
                }
            }
        }
        if offset != segment.end {
            return Err(DownloadError::new(
                ErrorCode::Connect,
                "range response ended before its requested segment",
                true,
            ));
        }
        file.sync_data().map_err(DownloadError::storage)?;
        if !db
            .checkpoint_segment(
                &task.id,
                &self.worker_id,
                SegmentCheckpoint {
                    start: segment.start,
                    next: offset,
                    total,
                    speed_bytes_per_second: transfer_progress.speed(),
                },
                LEASE,
            )
            .await?
        {
            return self.interrupted_error(task).await;
        }
        Ok(())
    }

    async fn hash_file(&self, task: &Task, file: File) -> Result<Option<String>, DownloadError> {
        let mut file = tokio::fs::File::from_std(file);
        let mut hash = Sha256::new();
        let mut buffer = vec![0_u8; 1024 * 1024];
        let mut checkpoint = Instant::now();
        loop {
            if self.shutdown.is_cancelled() {
                return Ok(None);
            }
            let read = file
                .read(&mut buffer)
                .await
                .map_err(DownloadError::storage)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
            if checkpoint.elapsed() >= CHECKPOINT_INTERVAL {
                if !self
                    .db
                    .renew_phase(&task.id, &self.worker_id, "verifying", LEASE)
                    .await?
                {
                    return self.interrupted_error(task).await;
                }
                checkpoint = Instant::now();
            }
        }
        Ok(Some(format!("{:x}", hash.finalize())))
    }

    async fn interrupted_error<T>(&self, task: &Task) -> Result<T, DownloadError> {
        let live = self.db.get_task(&task.id).await?;
        let action = live.and_then(|task| task.control_requested);
        Err(DownloadError::new(
            ErrorCode::Internal,
            match action.as_deref() {
                Some("cancel") => "download cancelled",
                _ => "download paused",
            },
            false,
        ))
    }

    async fn control_outcome(&self, task: &Task) -> Result<Option<TaskOutcome>, DownloadError> {
        let live = self.db.get_task(&task.id).await?;
        Ok(match live.and_then(|task| task.control_requested) {
            Some(action) if action == "cancel" => {
                Some(TaskOutcome::Interrupted { cancelled: true })
            }
            Some(_) => Some(TaskOutcome::Interrupted { cancelled: false }),
            None => None,
        })
    }

    async fn recover_publish_journals(&self) -> Result<(), DownloadError> {
        for journal in self.db.journals().await? {
            let Some(task) = self.db.get_task(&journal.task_id).await? else {
                self.db
                    .fail_recovery(
                        &journal.task_id,
                        "internal",
                        "download task disappeared during publication",
                    )
                    .await?;
                continue;
            };
            let target = match StorageTarget::resolve(&task) {
                Ok(target) => target,
                Err(error) => {
                    warn!(task_id = %task.id, %error, "publication recovery is waiting for storage");
                    continue;
                }
            };
            let expected = FileIdentity {
                device: journal.device,
                inode: journal.inode,
                size: journal.size_bytes,
            };
            let target_identity = target.target_identity()?;
            if target_identity == Some(expected) {
                target.sync_directory()?;
                self.db
                    .finalize_publish(
                        &journal,
                        &task,
                        task.download_mode.as_deref().unwrap_or("single"),
                    )
                    .await?;
            } else if task_lease_is_live(&task) {
                continue;
            } else if target_identity.is_none() && target.partial_identity()? == Some(expected) {
                let Some(_partial_lock) = target.try_lock_existing_partial()? else {
                    continue;
                };
                if target.partial_identity()? != Some(expected) {
                    continue;
                }
                let control = task.control_requested.clone();
                if self.db.recover_unpublished(&task.id).await?
                    && control.as_deref() == Some("cancel")
                {
                    target.remove_partial()?;
                }
            } else {
                self.db
                    .fail_recovery(
                        &task.id,
                        "target_conflict",
                        "download publication state conflicts with an existing file",
                    )
                    .await?;
            }
        }
        Ok(())
    }
}

fn task_lease_is_live(task: &Task) -> bool {
    task.status == "running"
        && task
            .lease_expires_at
            .as_deref()
            .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
            .is_some_and(|expires_at| expires_at > OffsetDateTime::now_utc())
}

impl Clone for Probe {
    fn clone(&self) -> Self {
        Self {
            total: self.total,
            etag: self.etag.clone(),
            last_modified: self.last_modified.clone(),
            segmented: self.segmented,
        }
    }
}

async fn probe_source(
    task: &Task,
    settings: &DownloadSettings,
    options: &RequestOptions,
) -> Result<Probe, DownloadError> {
    let (response, _) = get(
        &task.url,
        options,
        &RangeRequest {
            start: Some(0),
            end_inclusive: Some(0),
            if_range: None,
        },
    )
    .await?;
    let status = response.status();
    let etag = header_text(&response, ETAG);
    let last_modified = header_text(&response, LAST_MODIFIED);
    let range = parse_content_range(
        response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok()),
    );
    let total = if status == StatusCode::PARTIAL_CONTENT {
        range.and_then(|range| range.2)
    } else if status == StatusCode::OK {
        header_u64(&response, CONTENT_LENGTH)
    } else if status == StatusCode::RANGE_NOT_SATISFIABLE {
        parse_unsatisfied_total(
            response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok()),
        )
    } else {
        return Err(http_status_error(status));
    };
    let validator_available = strong_etag(etag.as_deref()).is_some()
        || usable_last_modified(last_modified.as_deref()).is_some();
    let segmented = status == StatusCode::PARTIAL_CONTENT
        && range.is_some_and(|range| range.0 == 0 && range.1 == 0)
        && header_u64(&response, CONTENT_LENGTH) == Some(1)
        && total.is_some_and(|total| total >= settings.segmented_download_min_bytes)
        && settings.parallel_requests_per_task > 1
        && validator_available;
    Ok(Probe {
        total,
        etag,
        last_modified,
        segmented,
    })
}

fn plan_segments(total: u64, prefix: u64) -> Vec<Segment> {
    let prefix = prefix.min(total);
    let prefix_segments = u64::from(prefix > 0);
    let slots = MAX_SEGMENTS.saturating_sub(prefix_segments).max(1);
    let dynamic = total.saturating_sub(prefix).div_ceil(slots);
    let chunk = dynamic.max(MIN_SEGMENT_BYTES).div_ceil(1024 * 1024) * 1024 * 1024;
    let mut segments = Vec::new();
    if prefix > 0 {
        segments.push(Segment {
            start: 0,
            end: prefix,
            next: prefix,
        });
    }
    let mut start = prefix;
    while start < total {
        let end = start.saturating_add(chunk).min(total);
        segments.push(Segment {
            start,
            end,
            next: start,
        });
        start = end;
    }
    segments
}

fn segments_cover_total(segments: &[Segment], total: u64) -> bool {
    let mut expected_start = 0;
    for segment in segments {
        if segment.start != expected_start
            || segment.next < segment.start
            || segment.next > segment.end
        {
            return false;
        }
        expected_start = segment.end;
    }
    expected_start == total
}

fn request_options(settings: &DownloadSettings) -> RequestOptions {
    RequestOptions {
        connect_timeout: Duration::from_millis(settings.connect_timeout_ms),
        header_timeout: Duration::from_millis(settings.response_header_timeout_ms),
        read_idle_timeout: Duration::from_millis(settings.read_idle_timeout_ms),
        #[cfg(test)]
        allow_private_ips: true,
        #[cfg(test)]
        resolved_addresses: None,
    }
}

fn validator(probe: &Probe) -> Option<String> {
    selected_validator(probe).map(ToOwned::to_owned)
}

fn validators_match(task: &Task, probe: &Probe) -> bool {
    if let Some(expected) = strong_etag(probe.etag.as_deref()) {
        return task.etag.as_deref() == Some(expected);
    }
    if let Some(expected) = usable_last_modified(probe.last_modified.as_deref()) {
        return task.last_modified.as_deref() == Some(expected);
    }
    false
}

fn response_validators_match(response: &Response, probe: &Probe) -> bool {
    if let Some(expected) = strong_etag(probe.etag.as_deref()) {
        return header_text(response, ETAG).as_deref() == Some(expected);
    }
    if let Some(expected) = usable_last_modified(probe.last_modified.as_deref()) {
        return header_text(response, LAST_MODIFIED).as_deref() == Some(expected);
    }
    false
}

fn response_validator_conflicts(response: &Response, probe: &Probe) -> bool {
    if let (Some(expected), Some(actual)) = (
        strong_etag(probe.etag.as_deref()),
        header_text(response, ETAG),
    ) {
        return actual != expected;
    }
    if strong_etag(probe.etag.as_deref()).is_none()
        && let (Some(expected), Some(actual)) = (
            usable_last_modified(probe.last_modified.as_deref()),
            header_text(response, LAST_MODIFIED),
        )
    {
        return actual != expected;
    }
    false
}

fn selected_validator(probe: &Probe) -> Option<&str> {
    strong_etag(probe.etag.as_deref())
        .or_else(|| usable_last_modified(probe.last_modified.as_deref()))
}

fn strong_etag(value: Option<&str>) -> Option<&str> {
    let value = value?;
    (value.len() >= 2 && value.starts_with('"') && value.ends_with('"') && !value.starts_with("W/"))
        .then_some(value)
}

fn usable_last_modified(value: Option<&str>) -> Option<&str> {
    let value = value?;
    httpdate::parse_http_date(value).is_ok().then_some(value)
}

fn valid_range_response(
    response: &Response,
    start: u64,
    end: Option<u64>,
    total: Option<u64>,
) -> bool {
    if response.status() != StatusCode::PARTIAL_CONTENT {
        return false;
    }
    parse_content_range(
        response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok()),
    )
    .is_some_and(|range| {
        range.0 == start
            && end.is_none_or(|end| range.1 == end)
            && total.is_none_or(|total| range.2 == Some(total))
    })
}

fn parse_content_range(value: Option<&str>) -> Option<(u64, u64, Option<u64>)> {
    let value = value?.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse().ok()?;
    let end = end.parse().ok()?;
    let total = if total == "*" {
        None
    } else {
        Some(total.parse().ok()?)
    };
    if end < start || total.is_some_and(|total| total <= end) {
        return None;
    }
    Some((start, end, total))
}

fn parse_unsatisfied_total(value: Option<&str>) -> Option<u64> {
    value?.strip_prefix("bytes */")?.parse().ok()
}

fn header_u64(response: &Response, name: reqwest::header::HeaderName) -> Option<u64> {
    response.headers().get(name)?.to_str().ok()?.parse().ok()
}

fn header_text(response: &Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)?
        .to_str()
        .ok()
        .map(ToOwned::to_owned)
}

fn enforce_size(total: Option<u64>, settings: &DownloadSettings) -> Result<(), DownloadError> {
    if let (Some(total), Some(limit)) = (total, settings.max_file_size_bytes)
        && total > limit
    {
        return Err(DownloadError::new(
            ErrorCode::SizeLimit,
            "download exceeds the configured file size limit",
            false,
        ));
    }
    Ok(())
}

fn http_status_error(status: StatusCode) -> DownloadError {
    DownloadError::new(
        ErrorCode::HttpStatus,
        format!("download server returned HTTP {}", status.as_u16()),
        false,
    )
}

fn body_error(error: reqwest::Error) -> DownloadError {
    if error.is_timeout() {
        DownloadError::new(ErrorCode::Timeout, error.to_string(), true)
    } else {
        DownloadError::new(ErrorCode::Connect, error.to_string(), true)
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use rusqlite::params;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use crate::db::TEST_SCHEMA;

    #[test]
    fn plans_bounded_segments_and_preserves_a_legacy_prefix() {
        let segments = plan_segments(80 * 1024 * 1024, 8 * 1024 * 1024);
        assert_eq!(segments[0].next, 8 * 1024 * 1024);
        assert!(segments.len() <= 4096);
        assert_eq!(segments.last().unwrap().end, 80 * 1024 * 1024);
        assert!(segments_cover_total(&segments, 80 * 1024 * 1024));
    }

    #[test]
    fn parses_content_ranges_strictly() {
        assert_eq!(
            parse_content_range(Some("bytes 10-19/100")),
            Some((10, 19, Some(100)))
        );
        assert_eq!(parse_content_range(Some("bytes 10-100/100")), None);
        assert_eq!(parse_unsatisfied_total(Some("bytes */0")), Some(0));
    }

    #[test]
    fn selects_only_strong_or_usable_range_validators() {
        let modified = "Wed, 21 Oct 2015 07:28:00 GMT";
        assert_eq!(
            validator(&Probe {
                total: Some(1),
                etag: Some("\"strong\"".to_owned()),
                last_modified: Some(modified.to_owned()),
                segmented: true,
            }),
            Some("\"strong\"".to_owned())
        );
        assert_eq!(
            validator(&Probe {
                total: Some(1),
                etag: Some("W/\"weak\"".to_owned()),
                last_modified: Some(modified.to_owned()),
                segmented: true,
            }),
            Some(modified.to_owned())
        );
        assert_eq!(
            validator(&Probe {
                total: Some(1),
                etag: None,
                last_modified: Some("not-a-date".to_owned()),
                segmented: false,
            }),
            None
        );
    }

    #[tokio::test]
    async fn downloads_ranges_out_of_order_into_one_file() {
        let data = Arc::new(
            (0..2 * 1024 * 1024)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>(),
        );
        let url = serve_range_fixture(data.clone(), RangeFixtureMode::Success).await;
        let (_directory, downloader, task, target, settings) =
            segmented_download_context(&url).await;
        let options = test_request_options();
        let probe = probe_source(&task, &settings, &options).await.unwrap();
        assert!(probe.segmented);
        let _lock = target.lock_partial().unwrap();

        assert_eq!(
            downloader
                .download_segmented(&task, &settings, &options, &probe, &target)
                .await
                .unwrap(),
            data.len() as u64
        );
        assert_eq!(
            std::fs::read(_directory.path().join("nas/.download.part")).unwrap(),
            *data
        );
        let persisted = downloader.db.get_task(&task.id).await.unwrap().unwrap();
        assert_eq!(persisted.received_bytes, data.len() as u64);
        assert!(persisted.speed_bytes_per_second > 0);
    }

    #[tokio::test]
    async fn classifies_ignored_ranges_and_changed_validators() {
        let data = Arc::new(vec![b'x'; 2 * 1024 * 1024]);
        for (mode, expected) in [
            (RangeFixtureMode::IgnoreRanges, ErrorCode::RangeProtocol),
            (RangeFixtureMode::ChangedValidator, ErrorCode::SourceChanged),
        ] {
            let url = serve_range_fixture(data.clone(), mode).await;
            let (_directory, downloader, task, target, settings) =
                segmented_download_context(&url).await;
            let options = test_request_options();
            let probe = probe_source(&task, &settings, &options).await.unwrap();
            let _lock = target.lock_partial().unwrap();
            let error = downloader
                .download_segmented(&task, &settings, &options, &probe, &target)
                .await
                .unwrap_err();
            assert_eq!(error.code, expected);
        }
    }

    #[tokio::test]
    async fn rejects_unknown_length_before_exceeding_the_size_limit() {
        let url = serve_single_fixture(Arc::new(b"oversized".to_vec()), false).await;
        let (_directory, downloader, task, _target, mut settings) =
            segmented_download_context(&url).await;
        settings.max_file_size_bytes = Some(4);

        let error = downloader.run_task(&task, &settings).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::SizeLimit);
        assert_eq!(
            std::fs::metadata(_directory.path().join("nas/.download.part"))
                .unwrap()
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn classifies_truncated_response_bodies_as_retryable_connections() {
        let url = serve_truncated_fixture(32, Arc::new(b"short".to_vec())).await;
        let (_directory, downloader, task, _target, settings) =
            segmented_download_context(&url).await;

        let error = downloader.run_task(&task, &settings).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Connect);
        assert!(error.retryable);
    }

    #[tokio::test]
    async fn records_checksum_mismatches_and_keeps_the_partial_file() {
        let payload = Arc::new(b"checksum payload".to_vec());
        let url = serve_single_fixture(payload.clone(), true).await;
        let (directory, downloader, mut task, _target, settings) =
            segmented_download_context(&url).await;
        let expected = "0".repeat(64);
        task.expected_sha256 = Some(expected.clone());
        downloader
            .db
            .test_call({
                let expected = expected.clone();
                move |connection| {
                    connection
                        .execute(
                            "UPDATE download_tasks SET expected_sha256 = ? WHERE id = 'task'",
                            [expected],
                        )
                        .map_err(DownloadError::database)?;
                    Ok(())
                }
            })
            .await
            .unwrap();

        let error = downloader.run_task(&task, &settings).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::ChecksumMismatch);
        let actual = format!("{:x}", Sha256::digest(payload.as_slice()));
        assert_eq!(
            downloader
                .db
                .get_task("task")
                .await
                .unwrap()
                .unwrap()
                .actual_sha256,
            Some(actual)
        );
        assert_eq!(
            std::fs::read(directory.path().join("nas/.download.part")).unwrap(),
            *payload
        );
        assert!(!directory.path().join("nas/download.bin").exists());
    }

    #[tokio::test]
    async fn cooperatively_pauses_and_cancels_running_downloads() {
        for (control, expected_status, partial_remains) in
            [("pause", "paused", true), ("cancel", "cancelled", false)]
        {
            let url = serve_slow_single_fixture(256 * 1024).await;
            let (directory, downloader, task, _target, _settings) =
                segmented_download_context(&url).await;
            let db = downloader.db.clone();
            let worker = downloader.clone();
            let handle = tokio::spawn(async move { worker.handle_task(task).await });
            tokio::time::sleep(Duration::from_millis(60)).await;
            db.test_call(move |connection| {
                connection
                    .execute(
                        "UPDATE download_tasks SET control_requested = ? WHERE id = 'task'",
                        [control],
                    )
                    .map_err(DownloadError::database)?;
                Ok(())
            })
            .await
            .unwrap();
            tokio::time::timeout(Duration::from_secs(2), handle)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                db.get_task("task").await.unwrap().unwrap().status,
                expected_status
            );
            assert_eq!(
                directory.path().join("nas/.download.part").exists(),
                partial_remains
            );
        }
    }

    #[derive(Clone, Copy)]
    enum RangeFixtureMode {
        Success,
        IgnoreRanges,
        ChangedValidator,
    }

    async fn segmented_download_context(
        url: &str,
    ) -> (
        tempfile::TempDir,
        Downloader,
        Task,
        StorageTarget,
        DownloadSettings,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("nas");
        std::fs::create_dir(&root).unwrap();
        let root_text = root.to_string_lossy().into_owned();
        let db = Db::open(&directory.path().join("test.sqlite")).unwrap();
        let url = url.to_owned();
        db.test_call({
            let root_text = root_text.clone();
            move |connection| {
                connection
                    .execute_batch(TEST_SCHEMA)
                    .map_err(DownloadError::database)?;
                connection
                    .execute(
                        "INSERT INTO nas_roots (id, path) VALUES ('root', ?)",
                        [&root_text],
                    )
                    .map_err(DownloadError::database)?;
                connection.execute(
                    "INSERT INTO download_tasks (id, url, root_id, storage_pool_id, target_directory, \
                       target_file_name, target_path, partial_path, status, worker_id, lease_expires_at, \
                       created_at, updated_at) VALUES \
                       ('task', ?, 'root', ?, '.', 'download.bin', 'download.bin', '.download.part', \
                        'running', 'worker', '2099-01-01T00:00:00Z', \
                        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                    params![url, root_text],
                ).map_err(DownloadError::database)?;
                Ok(())
            }
        }).await.unwrap();
        let task = db.get_task("task").await.unwrap().unwrap();
        let target = StorageTarget::resolve(&task).unwrap();
        let downloader = Downloader {
            db,
            worker_id: "worker".to_owned(),
            shutdown: CancellationToken::new(),
        };
        let settings = DownloadSettings {
            segmented_download_min_bytes: 1024 * 1024,
            parallel_requests_per_task: 2,
            ..DownloadSettings::default()
        };
        (directory, downloader, task, target, settings)
    }

    fn test_request_options() -> RequestOptions {
        RequestOptions {
            connect_timeout: Duration::from_secs(2),
            header_timeout: Duration::from_secs(2),
            read_idle_timeout: Duration::from_secs(2),
            allow_private_ips: true,
            resolved_addresses: None,
        }
    }

    async fn serve_range_fixture(data: Arc<Vec<u8>>, mode: RangeFixtureMode) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let data = data.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0_u8; 1024];
                    loop {
                        let Ok(read) = socket.read(&mut buffer).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..read]);
                        if request.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let request = String::from_utf8_lossy(&request);
                    let range = request.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("range").then(|| value.trim())
                    });
                    let Some((start, end)) = range.and_then(parse_request_range) else {
                        return;
                    };
                    if start == 0 && end == 0 {
                        write_fixture_response(
                            &mut socket,
                            "206 Partial Content",
                            &[0],
                            Some((0, 0, data.len())),
                            "\"v1\"",
                        )
                        .await;
                        return;
                    }
                    if start == 0 {
                        tokio::time::sleep(Duration::from_millis(40)).await;
                    }
                    match mode {
                        RangeFixtureMode::IgnoreRanges => {
                            write_fixture_response(&mut socket, "200 OK", &data, None, "\"v1\"")
                                .await;
                        }
                        RangeFixtureMode::Success | RangeFixtureMode::ChangedValidator => {
                            write_fixture_response(
                                &mut socket,
                                "206 Partial Content",
                                &data[start..=end],
                                Some((start, end, data.len())),
                                if matches!(mode, RangeFixtureMode::ChangedValidator) {
                                    "\"v2\""
                                } else {
                                    "\"v1\""
                                },
                            )
                            .await;
                        }
                    }
                });
            }
        });
        format!("http://{address}/download.bin")
    }

    async fn serve_single_fixture(data: Arc<Vec<u8>>, content_length: bool) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let data = data.clone();
                tokio::spawn(async move {
                    if !read_request(&mut socket).await {
                        return;
                    }
                    let mut headers = "HTTP/1.1 200 OK\r\nConnection: close\r\n".to_owned();
                    if content_length {
                        headers.push_str(&format!("Content-Length: {}\r\n", data.len()));
                    }
                    headers.push_str("\r\n");
                    if socket.write_all(headers.as_bytes()).await.is_ok() {
                        let _ = socket.write_all(&data).await;
                    }
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{address}/download.bin")
    }

    async fn serve_slow_single_fixture(total: usize) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Some(request) = read_request_text(&mut socket).await else {
                        return;
                    };
                    let is_probe = request
                        .lines()
                        .any(|line| line.eq_ignore_ascii_case("range: bytes=0-0"));
                    let headers = format!(
                        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {total}\r\n\r\n"
                    );
                    if socket.write_all(headers.as_bytes()).await.is_err() {
                        return;
                    }
                    if is_probe {
                        return;
                    }
                    let chunk = vec![b'x'; 4 * 1024];
                    for _ in 0..total.div_ceil(chunk.len()) {
                        if socket.write_all(&chunk).await.is_err() {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{address}/download.bin")
    }

    async fn serve_truncated_fixture(advertised: usize, body: Arc<Vec<u8>>) -> String {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let body = body.clone();
                tokio::spawn(async move {
                    if !read_request(&mut socket).await {
                        return;
                    }
                    let headers = format!(
                        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {advertised}\r\n\r\n"
                    );
                    if socket.write_all(headers.as_bytes()).await.is_ok() {
                        let _ = socket.write_all(&body).await;
                    }
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{address}/download.bin")
    }

    async fn read_request(socket: &mut tokio::net::TcpStream) -> bool {
        read_request_text(socket).await.is_some()
    }

    async fn read_request_text(socket: &mut tokio::net::TcpStream) -> Option<String> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let read = socket.read(&mut buffer).await.ok()?;
            if read == 0 {
                return None;
            }
            request.extend_from_slice(&buffer[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                return String::from_utf8(request).ok();
            }
        }
    }

    fn parse_request_range(value: &str) -> Option<(usize, usize)> {
        let value = value.strip_prefix("bytes=")?;
        let (start, end) = value.split_once('-')?;
        Some((start.parse().ok()?, end.parse().ok()?))
    }

    async fn write_fixture_response(
        socket: &mut tokio::net::TcpStream,
        status: &str,
        body: &[u8],
        content_range: Option<(usize, usize, usize)>,
        etag: &str,
    ) {
        let mut headers = format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\nETag: {etag}\r\n",
            body.len()
        );
        if let Some((start, end, total)) = content_range {
            headers.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
        }
        headers.push_str("\r\n");
        if socket.write_all(headers.as_bytes()).await.is_ok() {
            let _ = socket.write_all(body).await;
        }
        let _ = socket.shutdown().await;
    }

    #[tokio::test]
    async fn recovers_publication_on_both_sides_of_atomic_rename() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("nas");
        std::fs::create_dir(&root).unwrap();
        let db = Db::open(&directory.path().join("test.sqlite")).unwrap();
        let root_text = root.to_string_lossy().into_owned();
        db.test_call({
            let root_text = root_text.clone();
            move |connection| {
                connection
                    .execute_batch(TEST_SCHEMA)
                    .map_err(DownloadError::database)?;
                connection
                    .execute(
                        "INSERT INTO nas_roots (id, path) VALUES ('root', ?)",
                        [&root_text],
                    )
                    .map_err(DownloadError::database)?;
                Ok(())
            }
        })
        .await
        .unwrap();
        let downloader = Downloader {
            db: db.clone(),
            worker_id: "recovery-worker".to_owned(),
            shutdown: CancellationToken::new(),
        };

        let partial = root.join(".before.part");
        std::fs::write(&partial, b"before").unwrap();
        insert_recovery_fixture(
            &db,
            &root_text,
            "before",
            "before.bin",
            ".before.part",
            &partial,
        )
        .await;
        let before_task = db.get_task("before").await.unwrap().unwrap();
        let before_target = StorageTarget::resolve(&before_task).unwrap();
        let before_metadata = std::fs::metadata(&partial).unwrap();
        assert_eq!(before_target.target_identity().unwrap(), None);
        assert_eq!(
            before_target.partial_identity().unwrap(),
            Some(FileIdentity {
                device: before_metadata.dev(),
                inode: before_metadata.ino(),
                size: before_metadata.len(),
            })
        );
        let active_lock = before_target.lock_partial().unwrap();
        downloader.recover_publish_journals().await.unwrap();
        assert_eq!(
            db.get_task("before").await.unwrap().unwrap().status,
            "running"
        );
        assert_eq!(db.journals().await.unwrap().len(), 1);
        drop(active_lock);
        downloader.recover_publish_journals().await.unwrap();
        assert_eq!(
            db.get_task("before").await.unwrap().unwrap().status,
            "queued"
        );
        assert!(partial.exists());
        assert!(db.journals().await.unwrap().is_empty());

        let target = root.join("after.bin");
        std::fs::write(&target, b"after").unwrap();
        insert_recovery_fixture(
            &db,
            &root_text,
            "after",
            "after.bin",
            ".after.part",
            &target,
        )
        .await;
        downloader.recover_publish_journals().await.unwrap();
        let completed = db.get_task("after").await.unwrap().unwrap();
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.received_bytes, 5);
        let operation_count = db
            .test_call(|connection| {
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM file_operations WHERE id = 'download:after'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(DownloadError::database)
            })
            .await
            .unwrap();
        assert_eq!(operation_count, 1);
        assert!(target.exists());
    }

    async fn insert_recovery_fixture(
        db: &Db,
        storage_pool_id: &str,
        task_id: &str,
        target_name: &str,
        partial_name: &str,
        identity_path: &std::path::Path,
    ) {
        let metadata = std::fs::metadata(identity_path).unwrap();
        let task_id = task_id.to_owned();
        let operation_id = format!("download:{task_id}");
        let storage_pool_id = storage_pool_id.to_owned();
        let target_name = target_name.to_owned();
        let partial_name = partial_name.to_owned();
        db.test_call(move |connection| {
            connection.execute(
                "INSERT INTO download_tasks (id, url, root_id, storage_pool_id, target_directory, \
                   target_file_name, target_path, partial_path, status, worker_id, lease_expires_at, \
                   created_at, updated_at, download_mode) VALUES \
                   (?, 'https://example.com/file', 'root', ?, '.', ?, ?, ?, 'running', 'dead-worker', \
                    '1970-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'single')",
                params![task_id, storage_pool_id, target_name, target_name, partial_name],
            ).map_err(DownloadError::database)?;
            connection.execute(
                "INSERT INTO download_publish_journal \
                   (task_id, operation_id, worker_id, device, inode, size_bytes, created_at) \
                   VALUES (?, ?, 'dead-worker', ?, ?, ?, '2026-01-01T00:00:00Z')",
                params![
                    task_id,
                    operation_id,
                    i64::try_from(metadata.dev()).unwrap(),
                    i64::try_from(metadata.ino()).unwrap(),
                    i64::try_from(metadata.len()).unwrap()
                ],
            ).map_err(DownloadError::database)?;
            Ok(())
        }).await.unwrap();
    }
}
