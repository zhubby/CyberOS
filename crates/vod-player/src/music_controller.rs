use std::collections::HashSet;

use super::*;
use crate::music::{MusicCommand, PlayEvent};

impl Controller {
    pub(super) async fn handle_music_command(
        &mut self,
        command: MusicCommand,
    ) -> Result<Status, VodError> {
        command.validate()?;
        if command.expected_version() != self.status.music.queue_version {
            return Err(VodError::new(
                ErrorCode::SessionConflict,
                "Music queue changed; refresh before retrying",
                409,
            ));
        }
        match &command {
            MusicCommand::Replace {
                expected_session_id,
                ..
            }
            | MusicCommand::Jump {
                expected_session_id,
                ..
            }
            | MusicCommand::Resume {
                expected_session_id,
                ..
            } if expected_session_id.is_some()
                || (self.status.owner == Some(PlaybackOwner::Video) && self.desired.is_some()) =>
            {
                self.assert_takeover(expected_session_id.as_deref())?;
            }
            _ => {}
        }
        if matches!(
            &command,
            MusicCommand::Replace { .. }
                | MusicCommand::Jump { .. }
                | MusicCommand::Resume { .. }
                | MusicCommand::Next { .. }
                | MusicCommand::Previous { .. }
        ) {
            self.music_failed_items.clear();
        }
        let insert_next = matches!(&command, MusicCommand::InsertNext { .. });
        match command {
            MusicCommand::Replace { entries, .. } => {
                let first = entries[0].id.clone();
                self.record_music_listening();
                self.stop_mpv().await;
                self.status.music.queue = entries;
                self.status.music.current_item_id = Some(first.clone());
                self.status.music.position_seconds = 0.0;
                self.bump_music_version();
                self.start_music_item(first, 0.0, true).await;
            }
            MusicCommand::Append { entries, .. } | MusicCommand::InsertNext { entries, .. } => {
                let mut combined = self.status.music.queue.clone();
                let index = if insert_next {
                    combined
                        .iter()
                        .position(|entry| {
                            Some(&entry.id) == self.status.music.current_item_id.as_ref()
                        })
                        .map_or(combined.len(), |index| index + 1)
                } else {
                    combined.len()
                };
                combined.splice(index..index, entries);
                music::validate_entries(&combined)?;
                self.status.music.queue = combined;
                if self.status.music.current_item_id.is_none() {
                    self.status.music.current_item_id = self
                        .status
                        .music
                        .queue
                        .first()
                        .map(|entry| entry.id.clone());
                    self.reset_music_event();
                }
                self.bump_music_version();
            }
            MusicCommand::Remove { item_id, .. } => {
                let index = self
                    .status
                    .music
                    .queue
                    .iter()
                    .position(|entry| entry.id == item_id)
                    .ok_or_else(|| invalid_music("Queue item not found"))?;
                let current = self.status.music.current_item_id.as_deref() == Some(&item_id);
                if current {
                    self.record_music_listening();
                }
                self.status.music.queue.remove(index);
                self.bump_music_version();
                if current {
                    let next = self
                        .status
                        .music
                        .queue
                        .get(index)
                        .or_else(|| self.status.music.queue.last())
                        .map(|entry| entry.id.clone());
                    self.status.music.current_item_id = next.clone();
                    self.status.music.position_seconds = 0.0;
                    self.reset_music_event();
                    if self.status.owner == Some(PlaybackOwner::Music) {
                        let playing = self.status.state == PlayerState::Playing;
                        self.stop_mpv().await;
                        self.desired = None;
                        if let Some(id) = next {
                            if playing {
                                self.start_music_item(id, 0.0, true).await;
                            } else {
                                if let Some(entry) = self.status.music.current().cloned() {
                                    self.desired = Some(DesiredSession {
                                        session_id: Uuid::new_v4().to_string(),
                                        storage_pool_id: entry.storage_pool_id,
                                        relative_path: entry.relative_path,
                                        position_seconds: 0.0,
                                        volume: self.status.music.volume,
                                        paused: true,
                                        audio_device_id: self.status.music.audio_device_id.clone(),
                                        media_file_id: None,
                                        identity: None,
                                    });
                                    self.status.duration_seconds = entry.duration_seconds;
                                    self.copy_desired_to_status();
                                }
                                self.status.state = PlayerState::Paused;
                                self.status.position_seconds = 0.0;
                            }
                        } else {
                            self.clear_music_playback();
                        }
                    }
                }
            }
            MusicCommand::Reorder { item_ids, .. } => {
                let current: HashSet<&str> = self
                    .status
                    .music
                    .queue
                    .iter()
                    .map(|entry| entry.id.as_str())
                    .collect();
                if current.len() != item_ids.len()
                    || item_ids.iter().any(|id| !current.contains(id.as_str()))
                {
                    return Err(invalid_music(
                        "Queue order must contain every current item exactly once",
                    ));
                }
                let mut entries = self.status.music.queue.clone();
                entries.sort_by_key(|entry| {
                    item_ids
                        .iter()
                        .position(|id| id == &entry.id)
                        .unwrap_or(usize::MAX)
                });
                self.status.music.queue = entries;
                self.bump_music_version();
            }
            MusicCommand::Clear { .. } => {
                self.record_music_listening();
                self.status.music.queue.clear();
                self.status.music.current_item_id = None;
                self.status.music.position_seconds = 0.0;
                self.reset_music_event();
                self.bump_music_version();
                if self.status.owner == Some(PlaybackOwner::Music) {
                    self.stop_mpv().await;
                    self.clear_music_playback();
                }
            }
            MusicCommand::Jump { item_id, .. } => {
                if !self
                    .status
                    .music
                    .queue
                    .iter()
                    .any(|entry| entry.id == item_id)
                {
                    return Err(invalid_music("Queue item not found"));
                }
                self.start_music_item(item_id, 0.0, true).await;
            }
            MusicCommand::Next { .. } | MusicCommand::Previous { .. } => {
                self.assert_music_owner()?;
                self.advance_music(matches!(command, MusicCommand::Previous { .. }), false)
                    .await;
            }
            MusicCommand::Pause { .. } => {
                self.assert_music_owner()?;
                self.record_music_listening();
                if self.mpv.is_some() {
                    self.execute_mpv_command(json!(["set_property", "pause", true]))
                        .await?;
                }
                if let Some(desired) = self.desired.as_mut() {
                    desired.paused = true;
                }
                self.status.state = PlayerState::Paused;
                self.bump_music_version();
            }
            MusicCommand::Resume { .. } => {
                let id = self
                    .status
                    .music
                    .current_item_id
                    .clone()
                    .or_else(|| {
                        self.status
                            .music
                            .queue
                            .first()
                            .map(|entry| entry.id.clone())
                    })
                    .ok_or_else(|| invalid_music("Music queue is empty"))?;
                if self.status.owner == Some(PlaybackOwner::Music) && self.mpv.is_some() {
                    self.execute_mpv_command(json!(["set_property", "pause", false]))
                        .await?;
                    if let Some(desired) = self.desired.as_mut() {
                        desired.paused = false;
                    }
                    self.status.state = PlayerState::Playing;
                    self.music_last_tick = Instant::now();
                    self.bump_music_version();
                } else {
                    self.start_music_item(id, self.status.music.position_seconds, false)
                        .await;
                }
            }
            MusicCommand::Seek { seconds, .. } => {
                self.assert_music_owner()?;
                let seconds = seconds.min(self.status.duration_seconds.unwrap_or(f64::MAX));
                self.record_music_listening();
                if self.mpv.is_some() {
                    self.execute_mpv_command(json!(["seek", seconds, "absolute", "exact"]))
                        .await?;
                }
                if let Some(desired) = self.desired.as_mut() {
                    desired.position_seconds = seconds;
                }
                self.status.position_seconds = seconds;
                self.bump_music_version();
            }
            MusicCommand::Volume { volume, .. } => {
                self.status.music.volume = volume;
                if self.status.owner == Some(PlaybackOwner::Music) {
                    if self.mpv.is_some() {
                        self.execute_mpv_command(json!(["set_property", "volume", volume]))
                            .await?;
                    }
                    if let Some(desired) = self.desired.as_mut() {
                        desired.volume = volume;
                    }
                    self.status.volume = volume;
                }
                self.bump_music_version();
            }
            MusicCommand::Mode {
                repeat, shuffle, ..
            } => {
                self.status.music.repeat = repeat;
                self.status.music.shuffle = shuffle;
                self.bump_music_version();
            }
            MusicCommand::Output {
                audio_device_id, ..
            } => {
                self.status.music.audio_device_id = audio_device_id.clone();
                if self.status.owner == Some(PlaybackOwner::Music) {
                    self.record_music_listening();
                    let was_playing = self.status.state == PlayerState::Playing;
                    self.stop_mpv().await;
                    if let Some(desired) = self.desired.as_mut() {
                        desired.audio_device_id = audio_device_id;
                        desired.paused = !was_playing;
                    }
                    self.status.audio_device_id = self.status.music.audio_device_id.clone();
                    self.status.effective_audio_device_id = None;
                    self.resolved_audio_device = None;
                    if self.desired.is_some()
                        && let Err(error) = self.attempt_start().await
                    {
                        self.pause_music_with_error(error);
                    }
                }
                self.bump_music_version();
            }
        }
        self.publish();
        self.persist_music_checkpoint()?;
        Ok(self.status.clone())
    }

    pub(super) fn assert_takeover(
        &self,
        expected_session_id: Option<&str>,
    ) -> Result<(), VodError> {
        if expected_session_id.is_some() && expected_session_id == self.status.session_id.as_deref()
        {
            Ok(())
        } else {
            Err(VodError::new(
                ErrorCode::SessionConflict,
                "Another playback is active; confirm switching playback",
                409,
            ))
        }
    }

    fn assert_music_owner(&self) -> Result<(), VodError> {
        if self.status.owner == Some(PlaybackOwner::Music) {
            Ok(())
        } else {
            Err(VodError::new(
                ErrorCode::SessionConflict,
                "Music does not own the current playback",
                409,
            ))
        }
    }

    fn bump_music_version(&mut self) {
        self.status.music.queue_version = self.status.music.queue_version.saturating_add(1);
    }

    fn clear_music_playback(&mut self) {
        self.desired = None;
        self.retry_at = None;
        self.stable_since = None;
        self.status.owner = None;
        self.status.state = PlayerState::Idle;
        self.status.session_id = None;
        self.status.position_seconds = 0.0;
        self.status.duration_seconds = None;
        self.status.error = None;
        self.status.error_code = None;
        self.status.storage_pool_id = None;
        self.status.relative_path = None;
        self.status.file_name = None;
    }

    pub(super) async fn start_music_item(
        &mut self,
        mut item_id: String,
        mut position: f64,
        mut reset_event: bool,
    ) {
        let pinned_output = (self.status.owner == Some(PlaybackOwner::Music))
            .then(|| self.resolved_audio_device.clone())
            .flatten();
        self.record_music_listening();
        if self.status.owner == Some(PlaybackOwner::Video) {
            self.save_progress();
        }
        self.stop_mpv().await;
        self.retry_at = None;
        self.stable_since = None;
        let _ = session::clear(&self.config.state_path);
        for _ in 0..self.status.music.queue.len() {
            let Some(entry) = self
                .status
                .music
                .queue
                .iter()
                .find(|entry| entry.id == item_id)
                .cloned()
            else {
                return;
            };
            self.status.owner = Some(PlaybackOwner::Music);
            self.status.music.current_item_id = Some(item_id.clone());
            self.status.music.position_seconds = position;
            self.desired = Some(DesiredSession {
                session_id: Uuid::new_v4().to_string(),
                storage_pool_id: entry.storage_pool_id,
                relative_path: entry.relative_path,
                position_seconds: position,
                volume: self.status.music.volume,
                paused: false,
                audio_device_id: self.status.music.audio_device_id.clone(),
                media_file_id: None,
                identity: None,
            });
            if reset_event {
                self.reset_music_event();
            }
            self.status.state = PlayerState::Starting;
            self.status.duration_seconds = entry.duration_seconds;
            self.copy_desired_to_status();
            self.resolved_audio_device = pinned_output.clone();
            self.bump_music_version();
            self.publish();
            match self.attempt_start().await {
                Ok(()) => {
                    self.music_last_tick = Instant::now();
                    return;
                }
                Err(error) => {
                    let can_skip = matches!(
                        error.code,
                        ErrorCode::InvalidPath
                            | ErrorCode::UnsupportedMedia
                            | ErrorCode::SourceChanged
                            | ErrorCode::InvalidCommand
                    );
                    if can_skip {
                        if let Some(next) = self.next_after_music_failure() {
                            tracing::warn!(track_id = %entry.track_id, error = %error.message, "skipping unavailable music track");
                            item_id = next;
                            position = 0.0;
                            reset_event = true;
                            continue;
                        }
                        self.stop_failed_music_cycle();
                    } else {
                        self.pause_music_with_error(error);
                    }
                    return;
                }
            }
        }
        self.stop_failed_music_cycle();
    }

    pub(super) fn next_after_music_failure(&mut self) -> Option<String> {
        self.music_failed_items
            .retain(|id| self.status.music.queue.iter().any(|entry| &entry.id == id));
        if let Some(id) = &self.status.music.current_item_id {
            self.music_failed_items.insert(id.clone());
        }
        let mut traversal = self.status.music.clone();
        for _ in 0..traversal.queue.len() {
            let next = traversal.next_id(false, false)?;
            if !self.music_failed_items.contains(&next) {
                return Some(next);
            }
            traversal.current_item_id = Some(next);
        }
        None
    }

    pub(super) fn stop_failed_music_cycle(&mut self) {
        self.set_music_error(
            VodError::new(
                ErrorCode::PlaybackFailed,
                "No playable songs remain in this queue",
                422,
            ),
            PlayerState::Stopped,
        );
    }

    pub(super) async fn advance_music(&mut self, backwards: bool, natural_end: bool) {
        self.record_music_listening();
        if let Some(next) = self.status.music.next_id(backwards, natural_end) {
            self.start_music_item(next, 0.0, true).await;
        } else {
            self.stop_mpv().await;
            if let Some(desired) = self.desired.as_mut() {
                desired.paused = true;
                desired.position_seconds = 0.0;
            }
            self.status.state = PlayerState::Stopped;
            self.status.position_seconds = 0.0;
            self.status.music.position_seconds = 0.0;
            self.bump_music_version();
            self.publish();
            let _ = self.persist_music_checkpoint();
        }
    }

    pub(super) fn pause_music_with_error(&mut self, error: VodError) {
        self.set_music_error(error, PlayerState::Paused);
    }

    fn set_music_error(&mut self, error: VodError, state: PlayerState) {
        if let Some(desired) = self.desired.as_mut() {
            desired.paused = true;
        }
        self.retry_at = None;
        self.stable_since = None;
        self.status.state = state;
        self.status.next_retry_at = None;
        self.status.effective_audio_device_id = None;
        self.status.error = Some(error.message);
        self.status.error_code = Some(error.code);
        self.publish();
        let _ = self.persist_music_checkpoint();
    }

    fn reset_music_event(&mut self) {
        self.music_checkpoint.event_id = Uuid::new_v4().to_string();
        self.music_checkpoint.listened_seconds = 0.0;
        self.music_checkpoint.counted = false;
    }

    pub(super) fn persist_music_checkpoint(&mut self) -> Result<(), VodError> {
        if self.status.owner == Some(PlaybackOwner::Music) {
            self.status.music.position_seconds = self.status.position_seconds;
            self.status.music.volume = self.status.volume;
        }
        self.music_checkpoint.state = self.status.music.clone();
        music::persist_checkpoint(
            &music::checkpoint_path(&self.config.state_path),
            &self.music_checkpoint,
        )
    }

    pub(super) fn record_music_listening(&mut self) {
        let elapsed = self.music_last_tick.elapsed().as_secs_f64();
        self.music_last_tick = Instant::now();
        if self.status.owner != Some(PlaybackOwner::Music)
            || self.status.state != PlayerState::Playing
            || self.mpv.is_none()
        {
            return;
        }
        self.music_checkpoint.listened_seconds += elapsed;
        if self.music_checkpoint.counted {
            return;
        }
        let Some(entry) = self.status.music.current() else {
            return;
        };
        let threshold = self
            .status
            .duration_seconds
            .or(entry.duration_seconds)
            .map(|duration| (duration / 2.0).min(240.0))
            .unwrap_or(240.0);
        if self.music_checkpoint.listened_seconds >= threshold && threshold > 0.0 {
            self.music_checkpoint.pending_events.push(PlayEvent {
                id: self.music_checkpoint.event_id.clone(),
                track_id: entry.track_id.clone(),
                played_at: now(),
                listened_seconds: self.music_checkpoint.listened_seconds,
            });
            self.music_checkpoint.counted = true;
            if let Err(error) = self.persist_music_checkpoint() {
                tracing::error!(%error, "failed to persist music play event");
            }
        }
    }

    pub(super) async fn flush_music_history(&mut self) {
        if self
            .music_history_flush
            .as_ref()
            .is_some_and(|task| task.is_finished())
            && let Some(task) = self.music_history_flush.take()
            && let Ok(saved) = task.await
        {
            self.music_checkpoint
                .pending_events
                .retain(|event| !saved.contains(&event.id));
            let _ = self.persist_music_checkpoint();
        }
        if self.music_history_flush.is_none() && !self.music_checkpoint.pending_events.is_empty() {
            // Persist the event before submitting it to SQLite. A failed state
            // write must not create an untracked cross-storage commit window.
            if self.persist_music_checkpoint().is_err() {
                return;
            }
            let events: Vec<_> = self
                .music_checkpoint
                .pending_events
                .iter()
                .take(16)
                .cloned()
                .collect();
            let database_path = self.config.database_path.clone();
            self.music_history_flush = Some(tokio::task::spawn_blocking(move || {
                events
                    .into_iter()
                    .filter_map(|event| {
                        if music::save_play_event(&database_path, &event).is_ok() {
                            Some(event.id)
                        } else {
                            None
                        }
                    })
                    .collect()
            }));
        }
    }
}

fn invalid_music(message: &str) -> VodError {
    VodError::new(ErrorCode::InvalidCommand, message, 400)
}
