use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use time::format_description::well_known::Rfc3339;
use time::{Duration as TimeDuration, OffsetDateTime};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::interval;
use uuid::Uuid;

use crate::config::VodPlayerConfig;
use crate::error::{ErrorCode, VodError};
use crate::mpv::{MpvEvent, MpvHandle, classify_end_file_failure, probe, probe_active_outputs};
use crate::progress::ProgressStore;
use crate::protocol::{Capabilities, Command, HardwareDecode, PlayerState, Status, Track};
use crate::session::{self, LoadOutcome, PersistedSession};
use crate::storage::{FileIdentity, open_media};

#[derive(Clone)]
pub struct ControllerHandle {
    sender: mpsc::Sender<Message>,
    status: watch::Receiver<Status>,
    shutdown: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}

enum Message {
    Execute(Command, oneshot::Sender<Result<Status, VodError>>),
}

#[derive(Debug, Clone)]
struct DesiredSession {
    session_id: String,
    root_id: String,
    storage_pool_id: String,
    relative_path: String,
    position_seconds: f64,
    volume: f64,
    paused: bool,
    audio_device_id: Option<String>,
    media_file_id: Option<String>,
    identity: Option<FileIdentity>,
}

struct Controller {
    config: Arc<VodPlayerConfig>,
    receiver: mpsc::Receiver<Message>,
    status_sender: watch::Sender<Status>,
    shutdown: watch::Receiver<bool>,
    done: watch::Sender<bool>,
    status: Status,
    desired: Option<DesiredSession>,
    mpv: Option<MpvHandle>,
    retry_at: Option<Instant>,
    stable_since: Option<Instant>,
    last_checkpoint: Instant,
    last_capability_probe: Instant,
    progress: ProgressStore,
}

impl ControllerHandle {
    pub async fn start(config: Arc<VodPlayerConfig>) -> Result<Self, VodError> {
        let service_instance_id = Uuid::new_v4().to_string();
        let capabilities = probe(&config).await.capabilities;
        let mut status = empty_status(
            service_instance_id,
            capabilities,
            config.video_output.clone(),
        );
        let desired = match session::load(&config.state_path)? {
            LoadOutcome::Empty => None,
            LoadOutcome::Corrupt(path) => {
                tracing::warn!(path = %path.display(), "ignored corrupt VOD player session");
                None
            }
            LoadOutcome::Session(saved) => {
                let saved = *saved;
                status.state = PlayerState::Recovering;
                status.session_id = Some(saved.session_id.clone());
                status.root_id = Some(saved.root_id.clone());
                status.storage_pool_id = Some(saved.storage_pool_id.clone());
                status.relative_path = Some(saved.relative_path.clone());
                status.file_name = file_name(&saved.relative_path);
                status.position_seconds = saved.position_seconds;
                status.volume = saved.volume;
                Some(DesiredSession {
                    session_id: saved.session_id,
                    root_id: saved.root_id,
                    storage_pool_id: saved.storage_pool_id,
                    relative_path: saved.relative_path,
                    position_seconds: saved.position_seconds,
                    volume: saved.volume,
                    paused: saved.desired_paused,
                    audio_device_id: saved.audio_device_id,
                    media_file_id: saved.media_file_id,
                    identity: Some(saved.identity),
                })
            }
        };
        let (status_sender, status_receiver) = watch::channel(status.clone());
        let (sender, receiver) = mpsc::channel(32);
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let (done_sender, done_receiver) = watch::channel(false);
        let progress = ProgressStore::new(config.database_path.clone());
        let mut controller = Controller {
            config,
            receiver,
            status_sender,
            shutdown: shutdown_receiver,
            done: done_sender,
            status,
            desired,
            mpv: None,
            retry_at: None,
            stable_since: None,
            last_checkpoint: Instant::now(),
            last_capability_probe: Instant::now(),
            progress,
        };
        tokio::spawn(async move { controller.run().await });
        Ok(Self {
            sender,
            status: status_receiver,
            shutdown: shutdown_sender,
            done: done_receiver,
        })
    }

    pub fn status(&self) -> Result<Status, VodError> {
        if self.sender.is_closed() {
            return Err(VodError::unavailable(
                ErrorCode::VodPlayerUnavailable,
                "VOD player controller stopped",
            ));
        }
        Ok(self.status.borrow().clone())
    }

    pub async fn execute(&self, command: Command) -> Result<Status, VodError> {
        if matches!(command, Command::Status) {
            return self.status();
        }
        let (response_tx, response_rx) = oneshot::channel();
        self.sender
            .try_send(Message::Execute(command, response_tx))
            .map_err(|_| {
                VodError::unavailable(
                    ErrorCode::VodPlayerUnavailable,
                    "VOD player command queue is full",
                )
            })?;
        response_rx.await.map_err(|_| {
            VodError::unavailable(
                ErrorCode::VodPlayerUnavailable,
                "VOD player controller stopped",
            )
        })?
    }

    pub async fn shutdown(&self) {
        let _ = self.shutdown.send(true);
        let mut done = self.done.clone();
        if !*done.borrow() {
            let _ = done.changed().await;
        }
    }
}

impl Controller {
    async fn run(&mut self) {
        if self.desired.is_some() {
            self.try_start_or_schedule().await;
        }
        let mut tick = interval(Duration::from_secs(1));
        tick.tick().await;
        loop {
            tokio::select! {
                biased;
                changed = self.shutdown.changed() => {
                    if changed.is_err() || *self.shutdown.borrow() {
                        self.shutdown().await;
                        self.done.send_replace(true);
                        return;
                    }
                }
                message = self.receiver.recv() => match message {
                    Some(Message::Execute(command, response)) => {
                        let result = self.handle_command(command).await;
                        let _ = response.send(result);
                    }
                    None => {
                        self.shutdown().await;
                        self.done.send_replace(true);
                        return;
                    }
                },
                _ = tick.tick() => self.tick().await,
            }
        }
    }

    async fn handle_command(&mut self, command: Command) -> Result<Status, VodError> {
        match command {
            Command::Status => {}
            Command::Play {
                root_id,
                storage_pool_id,
                relative_path,
                start_position_seconds,
                audio_device_id,
                media_file_id,
            } => {
                if let Some(file_id) = media_file_id.as_deref() {
                    self.progress.verify_media_file(
                        file_id,
                        &root_id,
                        &storage_pool_id,
                        &relative_path,
                    )?;
                }
                self.stop_mpv().await;
                self.retry_at = None;
                self.stable_since = None;
                self.status.retry_count = 0;
                self.desired = Some(DesiredSession {
                    session_id: Uuid::new_v4().to_string(),
                    root_id,
                    storage_pool_id,
                    relative_path,
                    position_seconds: start_position_seconds.unwrap_or(0.0),
                    volume: self.status.volume,
                    paused: false,
                    audio_device_id,
                    media_file_id,
                    identity: None,
                });
                self.status.state = PlayerState::Starting;
                self.status.error = None;
                self.status.error_code = None;
                self.copy_desired_to_status();
                self.publish();
                self.try_start_or_schedule().await;
            }
            Command::Pause { session_id } => {
                self.assert_session(&session_id)?;
                self.execute_mpv_command(json!(["set_property", "pause", true]))
                    .await?;
                if let Some(desired) = self.desired.as_mut() {
                    desired.paused = true;
                }
                self.status.state = PlayerState::Paused;
                self.stable_since = None;
                self.transition_checkpoint()?;
            }
            Command::Resume { session_id } => {
                self.assert_session(&session_id)?;
                self.execute_mpv_command(json!(["set_property", "pause", false]))
                    .await?;
                if let Some(desired) = self.desired.as_mut() {
                    desired.paused = false;
                }
                self.status.state = PlayerState::Playing;
                self.stable_since = Some(Instant::now());
                self.transition_checkpoint()?;
            }
            Command::TogglePause { session_id } => {
                self.assert_session(&session_id)?;
                let paused = !self.desired.as_ref().is_some_and(|desired| desired.paused);
                self.execute_mpv_command(json!(["set_property", "pause", paused]))
                    .await?;
                if let Some(desired) = self.desired.as_mut() {
                    desired.paused = paused;
                }
                self.status.state = if paused {
                    PlayerState::Paused
                } else {
                    PlayerState::Playing
                };
                self.stable_since = (!paused).then(Instant::now);
                self.transition_checkpoint()?;
            }
            Command::Stop { session_id } => {
                self.assert_session(&session_id)?;
                self.save_progress();
                self.stop_mpv().await;
                self.desired = None;
                self.retry_at = None;
                self.status.state = PlayerState::Stopped;
                self.status.position_seconds = 0.0;
                self.status.duration_seconds = None;
                self.status.next_retry_at = None;
                self.status.error = None;
                self.status.error_code = None;
                session::clear(&self.config.state_path)?;
                self.publish();
            }
            Command::Retry { session_id } => {
                self.assert_session(&session_id)?;
                self.stop_mpv().await;
                self.status.retry_count = 0;
                self.retry_at = None;
                self.try_start_or_schedule().await;
            }
            Command::Seek {
                session_id,
                seconds,
            } => {
                self.assert_session(&session_id)?;
                self.execute_mpv_command(json!(["seek", seconds, "absolute", "exact"]))
                    .await?;
                if let Some(desired) = self.desired.as_mut() {
                    desired.position_seconds = seconds;
                }
                self.status.position_seconds = seconds;
                self.transition_checkpoint()?;
            }
            Command::SeekRelative {
                session_id,
                seconds,
            } => {
                self.assert_session(&session_id)?;
                self.execute_mpv_command(json!(["seek", seconds, "relative", "exact"]))
                    .await?;
                let position = (self.status.position_seconds + seconds)
                    .max(0.0)
                    .min(self.status.duration_seconds.unwrap_or(f64::MAX));
                if let Some(desired) = self.desired.as_mut() {
                    desired.position_seconds = position;
                }
                self.status.position_seconds = position;
                self.transition_checkpoint()?;
            }
            Command::SetVolume { session_id, volume } => {
                self.assert_session(&session_id)?;
                if self.mpv.is_some() {
                    self.execute_mpv_command(json!(["set_property", "volume", volume]))
                        .await?;
                }
                if let Some(desired) = self.desired.as_mut() {
                    desired.volume = volume;
                }
                self.status.volume = volume;
                self.transition_checkpoint()?;
            }
            Command::SetAudioTrack {
                session_id,
                track_id,
            } => {
                self.assert_session(&session_id)?;
                if !self
                    .status
                    .audio_tracks
                    .iter()
                    .any(|track| track.id == track_id)
                {
                    return Err(VodError::new(
                        ErrorCode::InvalidCommand,
                        "Audio track is unavailable",
                        400,
                    ));
                }
                self.execute_mpv_command(json!(["set_property", "aid", track_id]))
                    .await?;
                self.status.selected_audio_track_id = Some(track_id);
                self.publish();
            }
            Command::SetSubtitleTrack {
                session_id,
                track_id,
            } => {
                self.assert_session(&session_id)?;
                if track_id.is_some_and(|id| {
                    !self
                        .status
                        .subtitle_tracks
                        .iter()
                        .any(|track| track.id == id)
                }) {
                    return Err(VodError::new(
                        ErrorCode::InvalidCommand,
                        "Subtitle track is unavailable",
                        400,
                    ));
                }
                let value = track_id.map_or_else(|| json!("no"), |id| json!(id));
                self.execute_mpv_command(json!(["set_property", "sid", value]))
                    .await?;
                self.status.selected_subtitle_track_id = track_id;
                self.publish();
            }
            Command::CycleAudioTrack { session_id } => {
                self.assert_session(&session_id)?;
                self.execute_mpv_command(json!(["cycle", "aid"])).await?;
            }
            Command::CycleSubtitleTrack { session_id } => {
                self.assert_session(&session_id)?;
                self.execute_mpv_command(json!(["cycle", "sid"])).await?;
            }
        }
        Ok(self.status.clone())
    }

    async fn try_start_or_schedule(&mut self) {
        match self.attempt_start().await {
            Ok(()) => {}
            Err(error) if error.retryable() => self.schedule_recovery(error),
            Err(error) => self.set_terminal_error(error),
        }
    }

    async fn execute_mpv_command(&mut self, command: serde_json::Value) -> Result<(), VodError> {
        let result = match self.mpv.as_mut() {
            Some(mpv) => mpv.command(command).await.map(|_| ()),
            None => Err(VodError::unavailable(
                ErrorCode::VodPlayerUnavailable,
                "Playback is not active",
            )),
        };
        if let Err(error) = &result
            && error.retryable()
        {
            let recovery_error = error.clone();
            self.stop_mpv().await;
            self.schedule_recovery(recovery_error);
        }
        result
    }

    async fn attempt_start(&mut self) -> Result<(), VodError> {
        let desired = self
            .desired
            .clone()
            .ok_or_else(|| VodError::internal("No playback session to start"))?;
        let probe = probe(&self.config).await;
        self.status.capabilities = probe.capabilities;
        if let Some(error) = probe.error {
            return Err(error);
        }
        let media = open_media(
            &self.config,
            &desired.root_id,
            &desired.storage_pool_id,
            &desired.relative_path,
        )?;
        if desired
            .identity
            .is_some_and(|expected| expected != media.identity)
        {
            return Err(VodError::new(
                ErrorCode::SourceChanged,
                "Media file changed since the session was saved",
                409,
            ));
        }
        if let Some(current) = self.desired.as_mut() {
            current.identity = Some(media.identity);
        }
        self.status.state = PlayerState::Starting;
        self.status.error = None;
        self.status.error_code = None;
        self.status.next_retry_at = None;
        self.publish();
        self.persist_current()?;
        let requested_audio_device = desired
            .audio_device_id
            .as_deref()
            .map(bluetooth_alsa_device);
        let mpv = if let Some(audio_device) = requested_audio_device.as_deref() {
            match MpvHandle::start(
                &self.config,
                media.try_clone()?,
                desired.position_seconds,
                desired.volume,
                desired.paused,
                Some(audio_device),
            )
            .await
            {
                Ok(mpv) => {
                    self.status.effective_audio_device_id = desired.audio_device_id.clone();
                    self.status.audio_fallback_reason = None;
                    mpv
                }
                Err(error) => {
                    self.status.effective_audio_device_id = None;
                    self.status.audio_fallback_reason = Some(error.message.clone());
                    tracing::warn!(device_id = ?desired.audio_device_id, message = %error.message, "Bluetooth audio failed; falling back to configured output");
                    MpvHandle::start(
                        &self.config,
                        media,
                        desired.position_seconds,
                        desired.volume,
                        desired.paused,
                        None,
                    )
                    .await?
                }
            }
        } else {
            self.status.effective_audio_device_id = None;
            self.status.audio_fallback_reason = None;
            MpvHandle::start(
                &self.config,
                media,
                desired.position_seconds,
                desired.volume,
                desired.paused,
                None,
            )
            .await?
        };
        self.mpv = Some(mpv);
        self.retry_at = None;
        self.status.state = if desired.paused {
            PlayerState::Paused
        } else {
            PlayerState::Playing
        };
        self.status.error = None;
        self.status.error_code = None;
        self.status.next_retry_at = None;
        self.stable_since = (!desired.paused).then(Instant::now);
        self.publish();
        self.persist_current()?;
        Ok(())
    }

    async fn tick(&mut self) {
        let events = self
            .mpv
            .as_mut()
            .map(MpvHandle::drain_events)
            .unwrap_or_default();
        for event in events {
            self.handle_mpv_event(event).await;
        }
        if self.last_capability_probe.elapsed() >= Duration::from_secs(5) {
            self.refresh_capabilities().await;
        }
        if self
            .retry_at
            .is_some_and(|retry_at| Instant::now() >= retry_at)
        {
            self.retry_at = None;
            self.try_start_or_schedule().await;
        }
        if self
            .stable_since
            .is_some_and(|started| started.elapsed() >= Duration::from_secs(60))
            && self.status.retry_count != 0
        {
            self.status.retry_count = 0;
            self.stable_since = None;
            self.publish();
        }
        if self.desired.is_some()
            && self.last_checkpoint.elapsed()
                >= Duration::from_millis(self.config.checkpoint_interval_ms)
            && let Err(error) = self.persist_current()
        {
            tracing::error!(code = ?error.code, "failed to persist VOD player checkpoint");
        }
    }

    async fn refresh_capabilities(&mut self) {
        self.last_capability_probe = Instant::now();
        let mut probe = if self.mpv.is_some() {
            probe_active_outputs(&self.config).await
        } else {
            probe(&self.config).await
        };
        if self.mpv.is_some() && self.config.hwdec != "no" {
            probe.capabilities.hardware_decode = self.status.capabilities.hardware_decode;
        }
        let changed = probe.capabilities != self.status.capabilities;
        self.status.capabilities = probe.capabilities;
        if let Some(error) = probe.error
            && self.mpv.is_some()
        {
            self.stop_mpv().await;
            if error.retryable() {
                self.schedule_recovery(error);
            } else {
                self.set_terminal_error(error);
            }
        } else if changed {
            self.publish();
        }
    }

    async fn handle_mpv_event(&mut self, event: MpvEvent) {
        match event {
            MpvEvent::Property { name, value } => {
                let mut changed = false;
                match name.as_str() {
                    "time-pos" => {
                        if let Some(position) = value.as_f64() {
                            self.status.position_seconds = position.max(0.0);
                            if let Some(desired) = self.desired.as_mut() {
                                desired.position_seconds = self.status.position_seconds;
                            }
                            changed = true;
                        }
                    }
                    "duration" => {
                        if let Some(duration) = value.as_f64() {
                            self.status.duration_seconds = Some(duration.max(0.0));
                            changed = true;
                        }
                    }
                    "pause" => {
                        if let Some(paused) = value.as_bool() {
                            self.status.state = if paused {
                                PlayerState::Paused
                            } else {
                                PlayerState::Playing
                            };
                            if let Some(desired) = self.desired.as_mut() {
                                desired.paused = paused;
                            }
                            self.stable_since = if paused { None } else { Some(Instant::now()) };
                            changed = true;
                        }
                    }
                    "volume" => {
                        if let Some(volume) = value.as_f64() {
                            self.status.volume = volume.clamp(0.0, 100.0);
                            if let Some(desired) = self.desired.as_mut() {
                                desired.volume = self.status.volume;
                            }
                            changed = true;
                        }
                    }
                    "hwdec-current" => {
                        if let Some(hwdec) = value.as_str() {
                            self.status.capabilities.hardware_decode = if hwdec == "no" {
                                HardwareDecode::Software
                            } else {
                                HardwareDecode::Enabled
                            };
                            changed = true;
                        }
                    }
                    "track-list" => {
                        let (audio, subtitles, selected_audio, selected_subtitle) =
                            parse_tracks(&value);
                        self.status.audio_tracks = audio;
                        self.status.subtitle_tracks = subtitles;
                        self.status.selected_audio_track_id = selected_audio;
                        self.status.selected_subtitle_track_id = selected_subtitle;
                        changed = true;
                    }
                    _ => {}
                }
                if changed {
                    self.publish();
                }
            }
            MpvEvent::EndFile { reason, error: _ } if reason == "eof" => {
                if self.mpv.is_none() {
                    return;
                }
                self.stop_mpv().await;
                self.retry_at = None;
                self.status.state = PlayerState::Stopped;
                self.status.position_seconds = self
                    .status
                    .duration_seconds
                    .unwrap_or(self.status.position_seconds);
                if let Some(desired) = self.desired.as_mut() {
                    desired.position_seconds = self.status.position_seconds;
                }
                self.save_progress();
                self.desired = None;
                self.status.error = None;
                self.status.error_code = None;
                let _ = session::clear(&self.config.state_path);
                self.publish();
            }
            MpvEvent::EndFile { reason, error } => {
                if self.mpv.is_none() {
                    return;
                }
                self.stop_mpv().await;
                if matches!(reason.as_str(), "quit" | "stop") {
                    self.save_progress();
                    self.desired = None;
                    self.retry_at = None;
                    self.status.state = PlayerState::Stopped;
                    self.status.error = None;
                    self.status.error_code = None;
                    let _ = session::clear(&self.config.state_path);
                    self.publish();
                    return;
                }
                self.save_progress();
                let failure = classify_end_file_failure(&reason, error.as_deref());
                if failure.retryable() {
                    self.schedule_recovery(failure);
                } else {
                    self.set_terminal_error(failure);
                }
            }
            MpvEvent::Exit { code, signal } => {
                if self.mpv.take().is_some() && self.desired.is_some() {
                    if is_clean_mpv_exit(code, signal) {
                        self.finish_external_stop();
                    } else {
                        self.schedule_recovery(VodError::unavailable(
                            ErrorCode::PlaybackFailed,
                            format!("mpv exited unexpectedly (code {code:?}, signal {signal:?})"),
                        ));
                    }
                }
            }
            MpvEvent::ProtocolFailure(message) => {
                if self.mpv.is_none() {
                    return;
                }
                self.stop_mpv().await;
                self.schedule_recovery(VodError::unavailable(ErrorCode::PlaybackFailed, message));
            }
            MpvEvent::FileLoaded => {}
        }
    }

    fn schedule_recovery(&mut self, error: VodError) {
        if self.desired.is_none() {
            return;
        }
        self.status.retry_count = self.status.retry_count.saturating_add(1);
        let exponent = self.status.retry_count.saturating_sub(1).min(20);
        let multiplier = 1_u64 << exponent;
        let delay_ms = self
            .config
            .retry_base_delay_ms
            .saturating_mul(multiplier)
            .min(self.config.retry_max_delay_ms);
        self.retry_at = Some(Instant::now() + Duration::from_millis(delay_ms));
        self.status.state = PlayerState::Recovering;
        self.status.error = Some(error.message);
        self.status.error_code = Some(error.code);
        self.status.next_retry_at = Some(format_time(
            OffsetDateTime::now_utc() + TimeDuration::milliseconds(delay_ms as i64),
        ));
        self.publish();
        let _ = self.persist_current();
    }

    fn finish_external_stop(&mut self) {
        self.save_progress();
        self.desired = None;
        self.retry_at = None;
        self.stable_since = None;
        self.status.state = PlayerState::Stopped;
        self.status.next_retry_at = None;
        self.status.error = None;
        self.status.error_code = None;
        let _ = session::clear(&self.config.state_path);
        self.publish();
    }

    fn set_terminal_error(&mut self, error: VodError) {
        self.save_progress();
        self.status.state = PlayerState::Error;
        self.status.error = Some(error.message);
        self.status.error_code = Some(error.code);
        self.status.next_retry_at = None;
        self.retry_at = None;
        self.stable_since = None;
        if let Err(clear_error) = session::clear(&self.config.state_path) {
            tracing::error!(code = ?clear_error.code, "failed to clear terminal VOD player session");
        }
        self.publish();
    }

    fn assert_session(&self, session_id: &str) -> Result<(), VodError> {
        if self.status.session_id.as_deref() != Some(session_id) {
            return Err(VodError::new(
                ErrorCode::SessionConflict,
                "Playback session changed",
                409,
            ));
        }
        Ok(())
    }

    fn copy_desired_to_status(&mut self) {
        if let Some(desired) = &self.desired {
            self.status.session_id = Some(desired.session_id.clone());
            self.status.root_id = Some(desired.root_id.clone());
            self.status.storage_pool_id = Some(desired.storage_pool_id.clone());
            self.status.relative_path = Some(desired.relative_path.clone());
            self.status.file_name = file_name(&desired.relative_path);
            self.status.media_file_id = desired.media_file_id.clone();
            self.status.position_seconds = desired.position_seconds;
            self.status.volume = desired.volume;
            self.status.audio_device_id = desired.audio_device_id.clone();
            self.status.effective_audio_device_id = None;
            self.status.audio_fallback_reason = None;
            self.status.audio_tracks.clear();
            self.status.subtitle_tracks.clear();
            self.status.selected_audio_track_id = None;
            self.status.selected_subtitle_track_id = None;
        }
    }

    fn transition_checkpoint(&mut self) -> Result<(), VodError> {
        self.publish();
        self.persist_current()
    }

    fn persist_current(&mut self) -> Result<(), VodError> {
        let Some(desired) = &self.desired else {
            return Ok(());
        };
        let Some(identity) = desired.identity else {
            return Ok(());
        };
        session::persist(
            &self.config.state_path,
            &PersistedSession {
                version: 2,
                session_id: desired.session_id.clone(),
                root_id: desired.root_id.clone(),
                storage_pool_id: desired.storage_pool_id.clone(),
                relative_path: desired.relative_path.clone(),
                position_seconds: desired.position_seconds,
                volume: desired.volume,
                desired_paused: desired.paused,
                audio_device_id: desired.audio_device_id.clone(),
                media_file_id: desired.media_file_id.clone(),
                identity,
                updated_at: now(),
            },
        )?;
        self.save_progress();
        self.last_checkpoint = Instant::now();
        Ok(())
    }

    fn save_progress(&self) {
        let Some(desired) = &self.desired else {
            return;
        };
        let Some(file_id) = desired.media_file_id.as_deref() else {
            return;
        };
        if let Err(error) = self.progress.save(
            file_id,
            desired.position_seconds,
            self.status.duration_seconds,
        ) {
            tracing::warn!(code = ?error.code, media_file_id = %file_id, "failed to persist media progress");
        }
    }

    fn publish(&mut self) {
        self.status.revision = self.status.revision.saturating_add(1);
        self.status.updated_at = now();
        self.status_sender.send_replace(self.status.clone());
    }

    async fn stop_mpv(&mut self) {
        if let Some(mpv) = self.mpv.take() {
            let diagnostic = mpv.stderr_summary();
            mpv.shutdown().await;
            if !diagnostic.is_empty() {
                tracing::debug!(stderr = %diagnostic, "mpv stopped");
            }
        }
    }

    async fn shutdown(&mut self) {
        self.stop_mpv().await;
        let _ = self.persist_current();
    }
}

fn is_clean_mpv_exit(code: Option<i32>, signal: Option<i32>) -> bool {
    code == Some(0) && signal.is_none()
}

fn empty_status(
    service_instance_id: String,
    capabilities: Capabilities,
    video_output: String,
) -> Status {
    Status {
        state: PlayerState::Idle,
        session_id: None,
        service_instance_id,
        revision: 0,
        root_id: None,
        storage_pool_id: None,
        relative_path: None,
        file_name: None,
        media_file_id: None,
        video_output,
        position_seconds: 0.0,
        duration_seconds: None,
        volume: 100.0,
        retry_count: 0,
        next_retry_at: None,
        audio_device_id: None,
        effective_audio_device_id: None,
        audio_fallback_reason: None,
        audio_tracks: Vec::new(),
        subtitle_tracks: Vec::new(),
        selected_audio_track_id: None,
        selected_subtitle_track_id: None,
        capabilities,
        error: None,
        error_code: None,
        updated_at: now(),
    }
}

fn parse_tracks(value: &serde_json::Value) -> (Vec<Track>, Vec<Track>, Option<i64>, Option<i64>) {
    let mut audio = Vec::new();
    let mut subtitles = Vec::new();
    let mut selected_audio = None;
    let mut selected_subtitle = None;
    for item in value.as_array().into_iter().flatten() {
        let Some(id) = item
            .get("id")
            .and_then(serde_json::Value::as_i64)
            .filter(|id| *id > 0)
        else {
            continue;
        };
        let track = Track {
            id,
            language: item
                .get("lang")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            title: item
                .get("title")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            default: item
                .get("default")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            forced: item
                .get("forced")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            external: item
                .get("external")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        };
        let selected = item
            .get("selected")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        match item.get("type").and_then(serde_json::Value::as_str) {
            Some("audio") => {
                if selected {
                    selected_audio = Some(id);
                }
                audio.push(track);
            }
            Some("sub") => {
                if selected {
                    selected_subtitle = Some(id);
                }
                subtitles.push(track);
            }
            _ => {}
        }
    }
    (audio, subtitles, selected_audio, selected_subtitle)
}

fn now() -> String {
    format_time(OffsetDateTime::now_utc())
}

fn format_time(value: OffsetDateTime) -> String {
    value
        .format(&Rfc3339)
        .unwrap_or_else(|_| value.unix_timestamp().to_string())
}

fn file_name(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}

fn bluetooth_alsa_device(device_id: &str) -> String {
    let target = device_id.strip_prefix("bluetooth:").unwrap_or_default();
    let address = target
        .rsplit_once('/')
        .map_or(target, |(_, address)| address);
    format!("alsa/bluealsa:DEV={address},PROFILE=a2dp")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NasRoot;

    fn test_config(directory: &Path) -> Arc<VodPlayerConfig> {
        Arc::new(VodPlayerConfig {
            enabled: true,
            socket_path: directory.join("vod-player.sock"),
            state_path: directory.join("session.json"),
            database_path: directory.join("zos.sqlite"),
            command_timeout_ms: 100,
            startup_timeout_ms: 100,
            checkpoint_interval_ms: 5_000,
            retry_base_delay_ms: 10,
            retry_max_delay_ms: 60,
            video_output: "drm".to_owned(),
            drm_connector: None,
            audio_output: "alsa".to_owned(),
            audio_device: None,
            hwdec: "no".to_owned(),
            user: "test".to_owned(),
            peer_uid: nix::unistd::Uid::current().as_raw(),
            nas_roots: vec![NasRoot {
                id: "root".to_owned(),
                path: directory.to_owned(),
            }],
        })
    }

    fn test_controller(
        directory: &Path,
    ) -> (Controller, mpsc::Sender<Message>, watch::Receiver<bool>) {
        let (sender, receiver) = mpsc::channel(1);
        let (status_sender, _) = watch::channel(empty_status(
            "instance".to_owned(),
            Capabilities {
                mpv_available: true,
                drm_available: true,
                audio_available: true,
                hardware_decode: HardwareDecode::Software,
                error: None,
            },
            "drm".to_owned(),
        ));
        let status = status_sender.borrow().clone();
        let (_, shutdown) = watch::channel(false);
        let (done, done_receiver) = watch::channel(false);
        (
            Controller {
                config: test_config(directory),
                receiver,
                status_sender,
                shutdown,
                done,
                status,
                desired: None,
                mpv: None,
                retry_at: None,
                stable_since: None,
                last_checkpoint: Instant::now(),
                last_capability_probe: Instant::now(),
                progress: ProgressStore::new(directory.join("zos.sqlite")),
            },
            sender,
            done_receiver,
        )
    }

    #[test]
    fn recovery_backoff_caps_at_the_configured_maximum() {
        let base = 2_000_u64;
        let maximum = 60_000_u64;
        let delay = base.saturating_mul(1_u64 << 10).min(maximum);
        assert_eq!(delay, maximum);
    }

    #[test]
    fn file_names_do_not_expose_parent_paths() {
        assert_eq!(file_name("private/movies/a.mp4").as_deref(), Some("a.mp4"));
    }

    #[test]
    fn bluetooth_ids_map_to_bluealsa_without_accepting_an_alsa_device() {
        assert_eq!(
            bluetooth_alsa_device("bluetooth:AA:BB:CC:DD:EE:FF"),
            "alsa/bluealsa:DEV=AA:BB:CC:DD:EE:FF,PROFILE=a2dp"
        );
        assert_eq!(
            bluetooth_alsa_device("bluetooth:adapter-hci1/AA:BB:CC:DD:EE:FF"),
            "alsa/bluealsa:DEV=AA:BB:CC:DD:EE:FF,PROFILE=a2dp"
        );
    }

    #[test]
    fn new_session_clears_previous_audio_output_state() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        controller.status.effective_audio_device_id =
            Some("bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF".to_owned());
        controller.status.audio_fallback_reason = Some("BlueALSA unavailable".to_owned());
        controller.desired = Some(DesiredSession {
            session_id: "next-session".to_owned(),
            root_id: "root".to_owned(),
            storage_pool_id: "pool".to_owned(),
            relative_path: "movie.mp4".to_owned(),
            position_seconds: 0.0,
            volume: 100.0,
            paused: false,
            audio_device_id: Some("bluetooth:adapter-hci1/11:22:33:44:55:66".to_owned()),
            media_file_id: Some("media-1".to_owned()),
            identity: None,
        });

        controller.copy_desired_to_status();

        assert_eq!(
            controller.status.audio_device_id.as_deref(),
            Some("bluetooth:adapter-hci1/11:22:33:44:55:66")
        );
        assert!(controller.status.effective_audio_device_id.is_none());
        assert!(controller.status.audio_fallback_reason.is_none());
    }

    #[test]
    fn deterministic_decode_failures_do_not_retry() {
        assert_eq!(
            classify_end_file_failure("error", Some("decoder not found for codec")).code,
            ErrorCode::UnsupportedMedia
        );
        assert!(classify_end_file_failure("error", Some("Input/output error")).retryable());
    }

    #[tokio::test]
    async fn shutdown_preempts_queued_commands() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, sender, done) = test_controller(directory.path());
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        controller.shutdown = shutdown_receiver;
        let (response_sender, response_receiver) = oneshot::channel();
        sender
            .try_send(Message::Execute(
                Command::SetVolume {
                    session_id: "stale".to_owned(),
                    volume: 10.0,
                },
                response_sender,
            ))
            .unwrap();
        shutdown_sender.send(true).unwrap();

        controller.run().await;

        assert!(*done.borrow());
        drop(controller);
        assert!(response_receiver.await.is_err());
    }

    #[tokio::test]
    async fn stale_terminal_events_do_not_schedule_recovery_twice() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        controller.desired = Some(DesiredSession {
            session_id: "session".to_owned(),
            root_id: "root".to_owned(),
            storage_pool_id: "pool".to_owned(),
            relative_path: "movie.mp4".to_owned(),
            position_seconds: 0.0,
            volume: 100.0,
            paused: false,
            audio_device_id: None,
            media_file_id: None,
            identity: None,
        });
        controller.status.retry_count = 1;
        controller
            .handle_mpv_event(MpvEvent::ProtocolFailure("closed".to_owned()))
            .await;
        controller
            .handle_mpv_event(MpvEvent::Exit {
                code: Some(1),
                signal: None,
            })
            .await;
        controller
            .handle_mpv_event(MpvEvent::EndFile {
                reason: "error".to_owned(),
                error: None,
            })
            .await;

        assert_eq!(controller.status.retry_count, 1);
        assert!(controller.retry_at.is_none());
    }

    #[test]
    fn clean_mpv_exit_is_treated_as_an_external_stop() {
        assert!(is_clean_mpv_exit(Some(0), None));
        assert!(!is_clean_mpv_exit(Some(1), None));
        assert!(!is_clean_mpv_exit(None, Some(15)));
    }
}
