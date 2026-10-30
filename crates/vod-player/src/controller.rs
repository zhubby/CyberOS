use std::collections::HashSet;
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
use crate::mpv::{
    MpvEvent, MpvHandle, bluetooth_connected, classify_end_file_failure, probe,
    probe_active_outputs,
};
use crate::music::{self, Checkpoint as MusicCheckpoint};
use crate::progress::ProgressStore;
use crate::protocol::{
    Capabilities, Command, HardwareDecode, PlaybackOwner, PlayerState, Status, Track,
};
use crate::session::{self, LoadOutcome, PersistedSession};
use crate::storage::{FileIdentity, open_audio, open_media};

#[path = "music_controller.rs"]
mod music_controller;

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
    resolved_audio_device: Option<Option<String>>,
    resolved_tv_config: Option<VodPlayerConfig>,
    mpv: Option<MpvHandle>,
    retry_at: Option<Instant>,
    stable_since: Option<Instant>,
    last_checkpoint: Instant,
    last_capability_probe: Instant,
    progress: ProgressStore,
    music_checkpoint: MusicCheckpoint,
    music_history_flush: Option<tokio::task::JoinHandle<Vec<String>>>,
    music_last_tick: Instant,
    music_failed_items: HashSet<String>,
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
        status.preferences = crate::preferences::PlaybackPreferences::load(&config.state_path)?;
        let music_checkpoint = music::load_checkpoint(&music::checkpoint_path(&config.state_path))?;
        status.music = music_checkpoint.state.clone();
        let mut desired = match session::load(&config.state_path)? {
            LoadOutcome::Empty => None,
            LoadOutcome::Corrupt(path) => {
                tracing::warn!(path = %path.display(), "ignored corrupt VOD player session");
                None
            }
            LoadOutcome::Session(_) if !config.for_video_session()?.enabled => {
                session::clear(&config.state_path)?;
                None
            }
            LoadOutcome::Session(saved) => {
                let saved = *saved;
                status.state = PlayerState::Paused;
                status.owner = Some(PlaybackOwner::Video);
                status.session_id = Some(saved.session_id.clone());
                status.storage_pool_id = Some(saved.storage_pool_id.clone());
                status.relative_path = Some(saved.relative_path.clone());
                status.file_name = file_name(&saved.relative_path);
                status.position_seconds = saved.position_seconds;
                status.volume = saved.volume;
                status.audio_device_id = saved.audio_device_id.clone();
                status.media_file_id = saved.media_file_id.clone();
                status.selected_audio_track_id = saved.selected_audio_track_id;
                status.selected_subtitle_track_id = saved.selected_subtitle_track_id;
                Some(DesiredSession {
                    session_id: saved.session_id,
                    storage_pool_id: saved.storage_pool_id,
                    relative_path: saved.relative_path,
                    position_seconds: saved.position_seconds,
                    volume: saved.volume,
                    paused: true,
                    audio_device_id: saved.audio_device_id,
                    media_file_id: saved.media_file_id,
                    identity: Some(saved.identity),
                })
            }
        };
        if desired.is_none()
            && let Some(entry) = status.music.current().cloned()
        {
            status.owner = Some(PlaybackOwner::Music);
            status.state = PlayerState::Paused;
            let session_id = Uuid::new_v4().to_string();
            status.session_id = Some(session_id.clone());
            status.storage_pool_id = Some(entry.storage_pool_id.clone());
            status.relative_path = Some(entry.relative_path.clone());
            status.file_name = Some(entry.title);
            status.position_seconds = status.music.position_seconds;
            status.duration_seconds = entry.duration_seconds;
            status.volume = status.music.volume;
            status.audio_device_id = status.music.audio_device_id.clone();
            desired = Some(DesiredSession {
                session_id,
                storage_pool_id: entry.storage_pool_id,
                relative_path: entry.relative_path,
                position_seconds: status.music.position_seconds,
                volume: status.music.volume,
                paused: true,
                audio_device_id: status.music.audio_device_id.clone(),
                media_file_id: None,
                identity: None,
            });
        }
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
            resolved_audio_device: None,
            resolved_tv_config: None,
            mpv: None,
            retry_at: None,
            stable_since: None,
            last_checkpoint: Instant::now(),
            last_capability_probe: Instant::now(),
            progress,
            music_checkpoint,
            music_history_flush: None,
            music_last_tick: Instant::now(),
            music_failed_items: HashSet::new(),
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
        if self.desired.as_ref().is_some_and(|desired| !desired.paused)
            && self.status.owner != Some(PlaybackOwner::Music)
        {
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
            Command::Guarded {
                service_instance_id,
                expected_session_id,
                command,
            } => {
                if service_instance_id != self.status.service_instance_id
                    || expected_session_id != self.status.session_id
                {
                    return Err(VodError::new(
                        ErrorCode::SessionConflict,
                        "Playback session changed",
                        409,
                    ));
                }
                return Box::pin(self.handle_command(*command)).await;
            }
            Command::SetOutput {
                session_id,
                audio_device_id,
            } => {
                self.assert_session(&session_id)?;
                if self.status.owner != Some(PlaybackOwner::Video) {
                    return Err(VodError::new(
                        ErrorCode::SessionConflict,
                        "Video no longer owns playback",
                        409,
                    ));
                }
                self.save_progress();
                if let Some(desired) = self.desired.as_mut() {
                    desired.audio_device_id = audio_device_id.clone();
                }
                self.status.preferences.video_audio_device_id = audio_device_id;
                self.status.preferences.save(&self.config.state_path)?;
                self.stop_mpv().await;
                self.copy_desired_to_status();
                self.try_start_or_schedule().await;
            }
            Command::SetMuted { session_id, muted } => {
                self.assert_session(&session_id)?;
                if self.mpv.is_some() {
                    self.execute_mpv_command(json!(["set_property", "mute", muted]))
                        .await?;
                }
                if self.status.owner == Some(PlaybackOwner::Music) {
                    self.status.preferences.music_muted = muted;
                } else {
                    self.status.preferences.video_muted = muted;
                }
                self.status.preferences.save(&self.config.state_path)?;
                self.publish();
            }
            Command::SetAudioDelay {
                session_id,
                milliseconds,
            } => {
                self.assert_session(&session_id)?;
                if self.status.owner != Some(PlaybackOwner::Video) {
                    return Err(VodError::new(
                        ErrorCode::SessionConflict,
                        "Video no longer owns playback",
                        409,
                    ));
                }
                if self.mpv.is_some() {
                    self.execute_mpv_command(json!([
                        "set_property",
                        "audio-delay",
                        milliseconds / 1000.0
                    ]))
                    .await?;
                }
                let key = self
                    .status
                    .audio_delay_key
                    .clone()
                    .unwrap_or_else(|| "tv".into());
                self.status
                    .preferences
                    .audio_delays
                    .insert(key, milliseconds);
                self.status.preferences.save(&self.config.state_path)?;
                self.publish();
            }
            Command::Music { command } => return self.handle_music_command(command).await,
            Command::StopVideo { session_id } => {
                if self.status.owner != Some(PlaybackOwner::Video) {
                    return Err(VodError::new(
                        ErrorCode::SessionConflict,
                        "Video no longer owns playback",
                        409,
                    ));
                }
                return Box::pin(self.handle_command(Command::Stop { session_id })).await;
            }
            Command::Play {
                storage_pool_id,
                relative_path,
                start_position_seconds,
                audio_device_id,
                media_file_id,
                expected_session_id,
            } => {
                if expected_session_id.is_some()
                    || (self.status.owner == Some(PlaybackOwner::Music) && self.desired.is_some())
                {
                    self.assert_takeover(expected_session_id.as_deref())?;
                }
                if self.status.owner == Some(PlaybackOwner::Music) && self.desired.is_some() {
                    self.record_music_listening();
                    self.persist_music_checkpoint()?;
                }
                if let Some(file_id) = media_file_id.as_deref() {
                    self.progress
                        .verify_media_file(file_id, &storage_pool_id, &relative_path)?;
                }
                self.save_progress();
                self.stop_mpv().await;
                self.status.owner = Some(PlaybackOwner::Video);
                self.retry_at = None;
                self.stable_since = None;
                self.status.retry_count = 0;
                self.desired = Some(DesiredSession {
                    session_id: Uuid::new_v4().to_string(),
                    storage_pool_id,
                    relative_path,
                    position_seconds: start_position_seconds.unwrap_or(0.0),
                    volume: self.status.preferences.video_volume,
                    paused: false,
                    audio_device_id: audio_device_id
                        .or_else(|| self.status.preferences.video_audio_device_id.clone()),
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
                if self.mpv.is_none() {
                    if let Some(desired) = self.desired.as_mut() {
                        desired.paused = false;
                    }
                    self.try_start_or_schedule().await;
                    return Ok(self.status.clone());
                }
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
                self.status.owner = None;
                self.status.session_id = None;
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
                if self.status.owner == Some(PlaybackOwner::Video) {
                    self.status.preferences.video_volume = volume;
                    self.status.preferences.save(&self.config.state_path)?;
                }
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
                self.transition_checkpoint()?;
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
                self.transition_checkpoint()?;
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
        let is_music = self.status.owner == Some(PlaybackOwner::Music);
        let audio_device_id = if let Some(pinned) = &self.resolved_audio_device {
            pinned.clone()
        } else if is_music {
            self.config
                .music_audio_device_id(desired.audio_device_id.as_deref())?
        } else {
            desired.audio_device_id.clone()
        };
        self.resolved_audio_device = Some(audio_device_id.clone());
        let mut playback_config = if is_music {
            self.config.for_music_session(audio_device_id.is_some())
        } else if let Some(pinned) = &self.resolved_tv_config {
            pinned.clone()
        } else {
            let config = self.config.for_video_session()?;
            self.resolved_tv_config = Some(config.clone());
            config
        };
        if !is_music && !playback_config.enabled {
            return Err(VodError::new(
                ErrorCode::VodPlayerDisabled,
                "TV playback is disabled",
                503,
            ));
        }
        if let Some(device) = audio_device_id.as_deref() {
            playback_config.audio_device = Some(bluetooth_alsa_device(device));
            if bluetooth_connected(device).await == Some(false) {
                return Err(VodError::unavailable(
                    ErrorCode::AudioUnavailable,
                    "Bluetooth speaker is disconnected",
                ));
            }
        }
        if !is_music {
            self.status.video_output = playback_config.video_output.clone();
        }
        let probe = probe(&playback_config).await;
        self.status.capabilities = probe.capabilities;
        if let Some(error) = probe.error {
            return Err(error);
        }
        let media = if is_music {
            let entry = self
                .status
                .music
                .current()
                .ok_or_else(|| VodError::internal("Music queue has no current song"))?;
            music::verify_track(&self.config.database_path, entry)?;
            open_audio(
                &playback_config,
                &desired.storage_pool_id,
                &desired.relative_path,
            )?
        } else {
            open_media(
                &playback_config,
                &desired.storage_pool_id,
                &desired.relative_path,
            )?
        };
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
        let requested_audio_device = audio_device_id.as_deref().map(bluetooth_alsa_device);
        let mpv = if let Some(audio_device) = requested_audio_device.as_deref() {
            match MpvHandle::start(
                &playback_config,
                media.try_clone()?,
                desired.position_seconds,
                desired.volume,
                true,
                Some(audio_device),
            )
            .await
            {
                Ok(mpv) => {
                    self.status.effective_audio_device_id = audio_device_id.clone();
                    self.status.audio_fallback_reason = None;
                    mpv
                }
                Err(error) => return Err(error),
            }
        } else {
            self.status.effective_audio_device_id = None;
            self.status.audio_fallback_reason = None;
            MpvHandle::start(
                &playback_config,
                media,
                desired.position_seconds,
                desired.volume,
                true,
                None,
            )
            .await?
        };
        self.mpv = Some(mpv);
        let muted = if is_music {
            self.status.preferences.music_muted
        } else {
            self.status.preferences.video_muted
        };
        self.execute_mpv_command(json!(["set_property", "mute", muted]))
            .await?;
        if !is_music {
            let delay_key = audio_device_id.clone().unwrap_or_else(|| {
                playback_config
                    .audio_device
                    .as_ref()
                    .map(|device| format!("tv:{device}"))
                    .unwrap_or_else(|| "tv".into())
            });
            self.status.audio_delay_key = Some(delay_key.clone());
            let key = delay_key.as_str();
            let delay = self
                .status
                .preferences
                .audio_delays
                .get(key)
                .copied()
                .unwrap_or(0.0);
            self.execute_mpv_command(json!(["set_property", "audio-delay", delay / 1000.0]))
                .await?;
        }
        if !is_music {
            if let Some(id) = self.status.selected_audio_track_id {
                self.execute_mpv_command(json!(["set_property", "aid", id]))
                    .await?;
            }
            let sid = self
                .status
                .selected_subtitle_track_id
                .map_or_else(|| json!("no"), |id| json!(id));
            self.execute_mpv_command(json!(["set_property", "sid", sid]))
                .await?;
        }
        if !desired.paused {
            self.execute_mpv_command(json!(["set_property", "pause", false]))
                .await?;
        }
        self.retry_at = None;
        self.finish_start(desired.paused);
        self.status.error = None;
        self.status.error_code = None;
        self.status.next_retry_at = None;
        self.stable_since = (!desired.paused).then(Instant::now);
        self.publish();
        self.persist_current()?;
        Ok(())
    }

    fn finish_start(&mut self, paused: bool) {
        self.status.state = if paused {
            PlayerState::Paused
        } else {
            PlayerState::Playing
        };
        if self.status.owner == Some(PlaybackOwner::Music) {
            self.music_last_tick = Instant::now();
        }
    }

    async fn tick(&mut self) {
        self.record_music_listening();
        self.flush_music_history().await;
        let event_session = self.status.session_id.clone();
        let events = self
            .mpv
            .as_mut()
            .map(MpvHandle::drain_events)
            .unwrap_or_default();
        for event in events {
            self.handle_mpv_event(event).await;
            if self.status.session_id != event_session {
                break;
            }
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
        if (self.desired.is_some()
            || !self.status.music.queue.is_empty()
            || !self.music_checkpoint.pending_events.is_empty())
            && self.last_checkpoint.elapsed()
                >= Duration::from_millis(self.config.checkpoint_interval_ms)
            && let Err(error) = self.persist_current()
        {
            tracing::error!(code = ?error.code, "failed to persist VOD player checkpoint");
        }
    }

    async fn refresh_capabilities(&mut self) {
        self.last_capability_probe = Instant::now();
        let mut playback_config = if self.status.owner == Some(PlaybackOwner::Music) {
            self.config
                .for_music_session(self.status.effective_audio_device_id.is_some())
        } else {
            self.resolved_tv_config
                .clone()
                .unwrap_or_else(|| self.config.as_ref().clone())
        };
        if let Some(device) = self.status.effective_audio_device_id.as_deref() {
            playback_config.audio_device = Some(bluetooth_alsa_device(device));
        }
        let mut probe = if self.mpv.is_some() {
            probe_active_outputs(&playback_config).await
        } else {
            probe(&playback_config).await
        };
        if self.status.effective_audio_device_id.is_some()
            && let Some(mpv) = self.mpv.as_mut()
            && let Err(error) = mpv.verify_requested_audio_output().await
        {
            probe.error = Some(error);
        }
        if self.mpv.is_some()
            && let Some(device) = self.status.effective_audio_device_id.as_deref()
            && bluetooth_connected(device).await == Some(false)
        {
            probe.capabilities.audio_available = false;
            probe.error = Some(VodError::unavailable(
                ErrorCode::AudioUnavailable,
                "Bluetooth speaker disconnected; reconnect and resume manually",
            ));
        }
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
                if self.status.owner == Some(PlaybackOwner::Music) {
                    self.music_failed_items.clear();
                    self.stop_mpv().await;
                    self.advance_music(false, true).await;
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
                if self.status.owner == Some(PlaybackOwner::Video)
                    && let Some(previous) = self.desired.clone()
                    && let Some(file_id) = previous.media_file_id.as_deref()
                    && let Ok(Some((next_id, pool, relative))) = self.progress.next_episode(file_id)
                {
                    // Runs in this serialized controller while video still owns playback.
                    // No delayed callback can reclaim playback after music takes ownership.
                    self.desired = Some(DesiredSession {
                        session_id: Uuid::new_v4().to_string(),
                        storage_pool_id: pool,
                        relative_path: relative,
                        position_seconds: 0.0,
                        media_file_id: Some(next_id),
                        identity: None,
                        paused: false,
                        ..previous
                    });
                    self.status.duration_seconds = None;
                    self.copy_desired_to_status();
                    self.try_start_or_schedule().await;
                    return;
                }
                self.desired = None;
                self.status.owner = None;
                self.status.session_id = None;
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
                    self.status.owner = None;
                    self.status.session_id = None;
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
                if self.status.owner == Some(PlaybackOwner::Music) {
                    let failure = if failure.code == ErrorCode::UnsupportedMedia {
                        self.desired
                            .as_ref()
                            .and_then(|desired| {
                                open_audio(
                                    &self.config,
                                    &desired.storage_pool_id,
                                    &desired.relative_path,
                                )
                                .err()
                            })
                            .unwrap_or(failure)
                    } else {
                        failure
                    };
                    if failure.code == ErrorCode::UnsupportedMedia {
                        if let Some(next) = self.next_after_music_failure() {
                            self.start_music_item(next, 0.0, true).await;
                        } else {
                            self.stop_failed_music_cycle();
                        }
                    } else {
                        self.pause_music_with_error(failure);
                    }
                    return;
                }
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
        if self.status.owner == Some(PlaybackOwner::Music) {
            self.pause_music_with_error(error);
            return;
        }
        if self.desired.is_none() {
            return;
        }
        if error.code == ErrorCode::AudioUnavailable {
            if let Some(desired) = self.desired.as_mut() {
                desired.paused = true;
            }
            self.status.state = PlayerState::Paused;
            self.status.error = Some(error.message);
            self.status.error_code = Some(error.code);
            self.status.effective_audio_device_id = None;
            self.retry_at = None;
            self.status.next_retry_at = None;
            self.publish();
            let _ = self.persist_current();
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
        self.status.owner = None;
        self.status.session_id = None;
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
        if self.status.owner == Some(PlaybackOwner::Music) {
            self.pause_music_with_error(error);
            return;
        }
        self.save_progress();
        self.status.state = PlayerState::Error;
        self.status.error = Some(error.message);
        self.status.error_code = Some(error.code);
        self.status.next_retry_at = None;
        self.retry_at = None;
        self.stable_since = None;
        if let Some(desired) = self.desired.as_mut() {
            desired.paused = true;
        }
        if let Err(error) = self.persist_current() {
            tracing::error!(code = ?error.code, "failed to retain terminal VOD player session");
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
        self.resolved_audio_device = None;
        self.resolved_tv_config = None;
        if let Some(desired) = &self.desired {
            let same_session = self.status.session_id.as_deref() == Some(&desired.session_id);
            self.status.session_id = Some(desired.session_id.clone());
            self.status.storage_pool_id = Some(desired.storage_pool_id.clone());
            self.status.relative_path = Some(desired.relative_path.clone());
            self.status.file_name = file_name(&desired.relative_path);
            self.status.media_file_id = desired.media_file_id.clone();
            self.status.position_seconds = desired.position_seconds;
            self.status.volume = desired.volume;
            self.status.audio_device_id = desired.audio_device_id.clone();
            self.status.audio_delay_key = desired.audio_device_id.clone();
            self.status.effective_audio_device_id = None;
            self.status.audio_fallback_reason = None;
            if !same_session {
                self.status.audio_tracks.clear();
                self.status.subtitle_tracks.clear();
                self.status.selected_audio_track_id = None;
                self.status.selected_subtitle_track_id = None;
            }
        }
    }

    fn transition_checkpoint(&mut self) -> Result<(), VodError> {
        self.publish();
        self.persist_current()
    }

    fn persist_current(&mut self) -> Result<(), VodError> {
        self.persist_music_checkpoint()?;
        if self.status.owner == Some(PlaybackOwner::Music) {
            self.last_checkpoint = Instant::now();
            return Ok(());
        }
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
                storage_pool_id: desired.storage_pool_id.clone(),
                relative_path: desired.relative_path.clone(),
                position_seconds: desired.position_seconds,
                volume: desired.volume,
                desired_paused: desired.paused,
                audio_device_id: desired.audio_device_id.clone(),
                media_file_id: desired.media_file_id.clone(),
                selected_audio_track_id: self.status.selected_audio_track_id,
                selected_subtitle_track_id: self.status.selected_subtitle_track_id,
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
        if self.status.owner == Some(PlaybackOwner::Music) {
            self.status.music.position_seconds = self.status.position_seconds;
            self.status.music.volume = self.status.volume;
        }
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
        self.record_music_listening();
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
        audio_delay_key: None,
        preferences: crate::preferences::PlaybackPreferences::default(),
        owner: None,
        music: music::QueueState::default(),
        state: PlayerState::Idle,
        session_id: None,
        service_instance_id,
        revision: 0,
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
    fn test_config(directory: &Path) -> Arc<VodPlayerConfig> {
        Arc::new(VodPlayerConfig {
            enabled: true,
            mpv_executable: "mpv".into(),
            socket_path: directory.join("vod-player.sock"),
            state_path: directory.join("session.json"),
            database_path: directory.join("cyberos.sqlite"),
            data_root: directory.join("data"),
            production: false,
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
                resolved_audio_device: None,
                resolved_tv_config: None,
                mpv: None,
                retry_at: None,
                stable_since: None,
                last_checkpoint: Instant::now(),
                last_capability_probe: Instant::now(),
                progress: ProgressStore::new(directory.join("cyberos.sqlite")),
                music_checkpoint: MusicCheckpoint::default(),
                music_history_flush: None,
                music_last_tick: Instant::now(),
                music_failed_items: HashSet::new(),
            },
            sender,
            done_receiver,
        )
    }

    #[tokio::test]
    async fn guarded_commands_reject_old_service_or_session_without_changing_owner() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        controller.status.owner = Some(PlaybackOwner::Music);
        controller.status.session_id = Some("current".into());
        for (instance, session) in [
            ("old-service".to_owned(), Some("current".to_owned())),
            (
                controller.status.service_instance_id.clone(),
                Some("old-session".to_owned()),
            ),
        ] {
            let error = controller
                .handle_command(Command::Guarded {
                    service_instance_id: instance,
                    expected_session_id: session,
                    command: Box::new(Command::Stop {
                        session_id: "current".into(),
                    }),
                })
                .await
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::SessionConflict);
            assert_eq!(controller.status.owner, Some(PlaybackOwner::Music));
            assert_eq!(controller.status.session_id.as_deref(), Some("current"));
        }
    }

    #[test]
    fn video_audio_failure_pauses_without_retry_or_discarding_the_session() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _, _) = test_controller(directory.path());
        controller.status.owner = Some(PlaybackOwner::Video);
        controller.status.session_id = Some("video".into());
        controller.desired = Some(DesiredSession {
            session_id: "video".into(),
            storage_pool_id: "pool-1".into(),
            relative_path: "a.mp4".into(),
            position_seconds: 12.0,
            volume: 45.0,
            paused: false,
            audio_device_id: Some("bluetooth:AA:BB:CC:DD:EE:FF".into()),
            media_file_id: None,
            identity: None,
        });
        controller.schedule_recovery(VodError::unavailable(
            ErrorCode::AudioUnavailable,
            "speaker disconnected",
        ));
        assert_eq!(controller.status.state, PlayerState::Paused);
        assert!(controller.desired.as_ref().unwrap().paused);
        assert_eq!(controller.desired.as_ref().unwrap().position_seconds, 12.0);
        assert!(controller.retry_at.is_none());
    }

    fn prepare_music_process(controller: &mut Controller, directory: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let executable = directory.join("fake-music-mpv");
        std::fs::write(&executable, r#"#!/bin/sh
[ "$1" = --version ] && exit 0
for argument do
  case "$argument" in
    --input-ipc-client=fd://*) ipc_fd=${argument#--input-ipc-client=fd://} ;;
    fdclose://*) media_fd=${argument#fdclose://} ;;
  esac
done
eval "exec 5<&$ipc_fd"
eval "exec 6>&$ipc_fd"
eval "content=\$(dd bs=5 count=1 <&$media_fd 2>/dev/null)"
[ "$content" = crash ] && exit 9
if [ "$content" = bad ]; then
  printf '%s\n' '{"event":"end-file","reason":"error","file_error":"unrecognized file format"}' >&6
else
  printf '%s\n' '{"event":"file-loaded"}' >&6
fi
while IFS= read -r line <&5; do
  case "$line" in
    *'"quit"'*) exit 0 ;;
    *'"emit-eof"'*) printf '%s\n' '{"event":"end-file","reason":"eof"}' >&6 ;;
    *'"emit-error"'*) printf '%s\n' '{"event":"end-file","reason":"error","file_error":"error decoding audio"}' >&6 ;;
    *'"emit-storage-error"'*) printf '%s\n' '{"event":"end-file","reason":"error","file_error":"Input/output error"}' >&6 ;;
    *'"emit-audio-error"'*) printf '%s\n' '{"event":"end-file","reason":"error","file_error":"audio output device unavailable"}' >&6 ;;
  esac
  request_id=$(printf '%s' "$line" | sed -n 's/.*"request_id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$request_id" ] || continue
  printf '{"request_id":%s,"error":"success","data":null}\n' "$request_id" >&6
done
"#).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = Arc::make_mut(&mut controller.config);
        config.mpv_executable = executable;
        config.audio_output = "null".to_owned();
        config.command_timeout_ms = 1_000;
        config.startup_timeout_ms = 1_000;
        let music_directory = config.data_root.join("pool-1/music");
        std::fs::create_dir_all(&music_directory).unwrap();
        let connection = rusqlite::Connection::open(&config.database_path).unwrap();
        connection.execute_batch("CREATE TABLE system_settings(key TEXT PRIMARY KEY,value_json TEXT); CREATE TABLE music_tracks(id TEXT PRIMARY KEY,storage_pool_id TEXT,relative_path TEXT,missing INTEGER); CREATE TABLE music_play_events(id TEXT PRIMARY KEY,track_id TEXT,played_at TEXT,listened_seconds REAL);").unwrap();
        for id in ["a", "b"] {
            let entry = music::tests::entry(id);
            std::fs::write(music_directory.join(format!("{id}.flac")), b"audio").unwrap();
            connection
                .execute(
                    "INSERT INTO music_tracks VALUES (?,?,?,0)",
                    rusqlite::params![entry.track_id, entry.storage_pool_id, entry.relative_path],
                )
                .unwrap();
        }
    }

    async fn start_test_music(controller: &mut Controller) {
        controller
            .handle_music_command(music::MusicCommand::Replace {
                entries: vec![music::tests::entry("a"), music::tests::entry("b")],
                expected_queue_version: 0,
                expected_session_id: None,
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn daemon_advances_to_the_next_music_process_on_eof_without_a_browser() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        prepare_music_process(&mut controller, directory.path());
        start_test_music(&mut controller).await;
        assert_eq!(controller.status.state, PlayerState::Playing);
        let first_session = controller.status.session_id.clone();
        controller
            .execute_mpv_command(json!(["emit-eof"]))
            .await
            .unwrap();
        controller.tick().await;
        assert_eq!(
            controller.status.music.current_item_id.as_deref(),
            Some("b")
        );
        assert_eq!(
            controller.status.relative_path.as_deref(),
            Some("music/b.flac")
        );
        assert_eq!(controller.status.state, PlayerState::Playing);
        assert_ne!(controller.status.session_id, first_session);
        assert!(controller.mpv.is_some());
        let saved =
            music::load_checkpoint(&music::checkpoint_path(&controller.config.state_path)).unwrap();
        assert_eq!(saved.state.current_item_id.as_deref(), Some("b"));
        controller.stop_mpv().await;
    }

    #[tokio::test]
    async fn runtime_decode_failures_skip_songs_and_stop_after_one_failed_repeat_cycle() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        prepare_music_process(&mut controller, directory.path());
        controller.status.music.repeat = music::RepeatMode::All;
        start_test_music(&mut controller).await;
        controller
            .execute_mpv_command(json!(["emit-error"]))
            .await
            .unwrap();
        controller.tick().await;
        assert_eq!(
            controller.status.music.current_item_id.as_deref(),
            Some("b")
        );
        assert_eq!(controller.status.state, PlayerState::Playing);
        controller
            .execute_mpv_command(json!(["emit-error"]))
            .await
            .unwrap();
        controller.tick().await;
        assert_eq!(controller.status.state, PlayerState::Stopped);
        assert!(controller.mpv.is_none());
        assert!(controller.retry_at.is_none());
        assert_eq!(controller.status.music.queue.len(), 2);
    }

    #[tokio::test]
    async fn a_failed_cycle_includes_startup_and_runtime_decode_failures() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        prepare_music_process(&mut controller, directory.path());
        std::fs::write(
            controller.config.data_root.join("pool-1/music/a.flac"),
            b"bad",
        )
        .unwrap();
        controller.status.music.repeat = music::RepeatMode::All;
        start_test_music(&mut controller).await;
        assert_eq!(
            controller.status.music.current_item_id.as_deref(),
            Some("b")
        );
        assert_eq!(controller.status.state, PlayerState::Playing);
        controller
            .execute_mpv_command(json!(["emit-error"]))
            .await
            .unwrap();
        controller.tick().await;
        assert_eq!(controller.status.state, PlayerState::Stopped);
        assert!(controller.mpv.is_none());
    }

    #[tokio::test]
    async fn a_successful_song_resets_the_failed_cycle_for_the_next_repeat() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        prepare_music_process(&mut controller, directory.path());
        controller.status.music.repeat = music::RepeatMode::All;
        start_test_music(&mut controller).await;
        controller
            .execute_mpv_command(json!(["emit-error"]))
            .await
            .unwrap();
        controller.tick().await;
        controller
            .execute_mpv_command(json!(["emit-eof"]))
            .await
            .unwrap();
        controller.tick().await;
        assert_eq!(
            controller.status.music.current_item_id.as_deref(),
            Some("a")
        );
        assert_eq!(controller.status.state, PlayerState::Playing);
        controller
            .execute_mpv_command(json!(["emit-error"]))
            .await
            .unwrap();
        controller.tick().await;
        assert_eq!(
            controller.status.music.current_item_id.as_deref(),
            Some("b")
        );
        assert_eq!(controller.status.state, PlayerState::Playing);
        controller.stop_mpv().await;
    }

    #[tokio::test]
    async fn a_decode_error_after_the_pool_goes_offline_pauses_instead_of_skipping() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        prepare_music_process(&mut controller, directory.path());
        start_test_music(&mut controller).await;
        std::fs::rename(
            controller.config.data_root.join("pool-1"),
            directory.path().join("offline-pool"),
        )
        .unwrap();
        controller
            .execute_mpv_command(json!(["emit-error"]))
            .await
            .unwrap();
        controller.tick().await;
        assert_eq!(
            controller.status.music.current_item_id.as_deref(),
            Some("a")
        );
        assert_eq!(controller.status.state, PlayerState::Paused);
        assert_eq!(
            controller.status.error_code,
            Some(ErrorCode::StorageUnavailable)
        );
        assert!(controller.mpv.is_none());
    }

    #[tokio::test]
    async fn output_and_storage_failures_pause_the_current_song_without_skipping() {
        for (event, code) in [
            ("emit-audio-error", ErrorCode::AudioUnavailable),
            ("emit-storage-error", ErrorCode::StorageUnavailable),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let (mut controller, _sender, _done) = test_controller(directory.path());
            prepare_music_process(&mut controller, directory.path());
            start_test_music(&mut controller).await;
            controller
                .execute_mpv_command(json!([event]))
                .await
                .unwrap();
            controller.tick().await;
            assert_eq!(
                controller.status.music.current_item_id.as_deref(),
                Some("a")
            );
            assert_eq!(controller.status.state, PlayerState::Paused);
            assert_eq!(controller.status.error_code, Some(code));
            assert!(controller.retry_at.is_none());
            assert!(controller.mpv.is_none());
        }
    }

    #[tokio::test]
    async fn an_unknown_startup_process_failure_pauses_instead_of_skipping_the_queue() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        prepare_music_process(&mut controller, directory.path());
        std::fs::write(
            controller.config.data_root.join("pool-1/music/a.flac"),
            b"crash",
        )
        .unwrap();
        start_test_music(&mut controller).await;
        assert_eq!(
            controller.status.music.current_item_id.as_deref(),
            Some("a")
        );
        assert_eq!(controller.status.state, PlayerState::Paused);
        assert_eq!(
            controller.status.error_code,
            Some(ErrorCode::PlaybackFailed)
        );
        assert!(controller.mpv.is_none());
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

    #[tokio::test]
    async fn restores_music_queue_paused_without_starting_an_audio_device() {
        let directory = tempfile::tempdir().unwrap();
        let config = test_config(directory.path());
        let mut checkpoint = MusicCheckpoint::default();
        checkpoint.state.queue.push(music::tests::entry("a"));
        checkpoint.state.current_item_id = Some("a".to_owned());
        checkpoint.state.position_seconds = 13.0;
        music::persist_checkpoint(&music::checkpoint_path(&config.state_path), &checkpoint)
            .unwrap();
        let handle = ControllerHandle::start(config).await.unwrap();
        let restored = handle.status().unwrap();
        assert_eq!(restored.owner, Some(PlaybackOwner::Music));
        assert_eq!(restored.state, PlayerState::Paused);
        assert_eq!(restored.position_seconds, 13.0);
        assert_eq!(restored.music.current().unwrap().track_id, "track-a");
        assert_eq!(restored.retry_count, 0);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn disabled_tv_does_not_restore_a_saved_video_over_the_music_queue() {
        let directory = tempfile::tempdir().unwrap();
        let config = test_config(directory.path());
        let connection = rusqlite::Connection::open(&config.database_path).unwrap();
        connection
            .execute_batch("CREATE TABLE system_settings(key TEXT PRIMARY KEY,value_json TEXT);")
            .unwrap();
        connection.execute("INSERT INTO system_settings VALUES('tv_settings',?)", [r#"{"enabled":false,"videoOutput":"drm","drmConnector":null,"audioDevice":null,"hardwareDecoding":"no","updatedAt":"2026-10-30T00:00:00Z"}"#]).unwrap();
        let saved = PersistedSession {
            version: 2,
            session_id: "old-video".to_owned(),
            storage_pool_id: "pool-1".to_owned(),
            relative_path: "movie.mp4".to_owned(),
            position_seconds: 17.0,
            volume: 70.0,
            desired_paused: false,
            audio_device_id: None,
            media_file_id: None,
            selected_audio_track_id: None,
            selected_subtitle_track_id: None,
            identity: FileIdentity {
                device: 1,
                inode: 2,
                size: 3,
                modified_seconds: 4,
                modified_nanoseconds: 5,
                changed_seconds: 6,
                changed_nanoseconds: 7,
            },
            updated_at: now(),
        };
        session::persist(&config.state_path, &saved).unwrap();
        let mut checkpoint = MusicCheckpoint::default();
        checkpoint.state.queue.push(music::tests::entry("a"));
        checkpoint.state.current_item_id = Some("a".to_owned());
        music::persist_checkpoint(&music::checkpoint_path(&config.state_path), &checkpoint)
            .unwrap();
        let handle = ControllerHandle::start(config.clone()).await.unwrap();
        let status = handle.status().unwrap();
        assert_eq!(status.owner, Some(PlaybackOwner::Music));
        assert_eq!(status.state, PlayerState::Paused);
        assert_ne!(status.session_id.as_deref(), Some("old-video"));
        assert!(!config.state_path.exists());
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn stale_queue_edits_and_unconfirmed_takeovers_do_not_change_playback() {
        use crate::music::MusicCommand;
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        controller.status.music.queue_version = 2;
        let error = controller
            .handle_music_command(MusicCommand::Append {
                entries: vec![music::tests::entry("a")],
                expected_queue_version: 1,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SessionConflict);
        assert!(controller.status.music.queue.is_empty());
        controller.status.owner = Some(PlaybackOwner::Video);
        controller.status.session_id = Some("movie-session".to_owned());
        controller.desired = Some(DesiredSession {
            session_id: "movie-session".to_owned(),
            storage_pool_id: "pool-1".to_owned(),
            relative_path: "film.mp4".to_owned(),
            position_seconds: 22.0,
            volume: 80.0,
            paused: false,
            audio_device_id: None,
            media_file_id: None,
            identity: None,
        });
        let error = controller
            .handle_music_command(MusicCommand::Replace {
                entries: vec![music::tests::entry("a")],
                expected_queue_version: 2,
                expected_session_id: None,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SessionConflict);
        assert_eq!(controller.status.owner, Some(PlaybackOwner::Video));
        assert!(controller.status.music.queue.is_empty());
        assert!(controller.assert_takeover(Some("old-session")).is_err());
        assert!(controller.assert_takeover(Some("movie-session")).is_ok());
    }

    #[tokio::test]
    async fn tv_stop_cannot_stop_a_music_session_even_with_a_matching_id() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        controller.status.owner = Some(PlaybackOwner::Music);
        controller.status.session_id = Some("music-session".to_owned());
        let error = controller
            .handle_command(Command::StopVideo {
                session_id: "music-session".to_owned(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SessionConflict);
        assert_eq!(controller.status.owner, Some(PlaybackOwner::Music));
    }

    #[test]
    fn music_output_failure_pauses_without_retrying_or_clearing_the_queue() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        controller.status.owner = Some(PlaybackOwner::Music);
        controller.status.music.queue.push(music::tests::entry("a"));
        controller.status.music.current_item_id = Some("a".to_owned());
        controller.schedule_recovery(VodError::unavailable(
            ErrorCode::AudioUnavailable,
            "Speaker disconnected",
        ));
        assert_eq!(controller.status.state, PlayerState::Paused);
        assert!(controller.retry_at.is_none());
        assert_eq!(controller.status.music.queue.len(), 1);
        assert!(controller.status.effective_audio_device_id.is_none());
    }

    #[tokio::test]
    async fn a_late_confirmed_video_start_cannot_replace_a_newer_video_session() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        controller.status.owner = Some(PlaybackOwner::Video);
        controller.status.session_id = Some("newer-video".to_owned());
        controller.desired = Some(DesiredSession {
            session_id: "newer-video".to_owned(),
            storage_pool_id: "pool-1".to_owned(),
            relative_path: "newer.mp4".to_owned(),
            position_seconds: 8.0,
            volume: 80.0,
            paused: false,
            audio_device_id: None,
            media_file_id: None,
            identity: None,
        });
        let error = controller
            .handle_command(Command::Play {
                storage_pool_id: "pool-1".to_owned(),
                relative_path: "requested.mp4".to_owned(),
                start_position_seconds: None,
                audio_device_id: None,
                media_file_id: None,
                expected_session_id: Some("replaced-music".to_owned()),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SessionConflict);
        assert_eq!(
            controller.desired.as_ref().unwrap().relative_path,
            "newer.mp4"
        );
        assert_eq!(controller.status.session_id.as_deref(), Some("newer-video"));

        controller.status.owner = Some(PlaybackOwner::Music);
        let error = controller
            .handle_music_command(music::MusicCommand::Resume {
                expected_queue_version: 0,
                expected_session_id: Some("replaced-video".to_owned()),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SessionConflict);
        assert_eq!(controller.status.session_id.as_deref(), Some("newer-video"));
    }

    #[tokio::test]
    async fn removing_a_paused_current_song_keeps_the_next_song_paused_and_owned() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        controller.status.owner = Some(PlaybackOwner::Music);
        controller.status.state = PlayerState::Paused;
        controller.status.session_id = Some("current-a".to_owned());
        controller.status.music.queue = vec![music::tests::entry("a"), music::tests::entry("b")];
        controller.status.music.current_item_id = Some("a".to_owned());
        controller.desired = Some(DesiredSession {
            session_id: "current-a".to_owned(),
            storage_pool_id: "pool-1".to_owned(),
            relative_path: "music/a.flac".to_owned(),
            position_seconds: 12.0,
            volume: 100.0,
            paused: true,
            audio_device_id: None,
            media_file_id: None,
            identity: None,
        });
        let status = controller
            .handle_music_command(music::MusicCommand::Remove {
                item_id: "a".to_owned(),
                expected_queue_version: 0,
            })
            .await
            .unwrap();
        assert_eq!(status.music.current_item_id.as_deref(), Some("b"));
        assert_eq!(status.state, PlayerState::Paused);
        assert_eq!(status.relative_path.as_deref(), Some("music/b.flac"));
        assert_eq!(status.duration_seconds, Some(30.0));
        assert_eq!(status.position_seconds, 0.0);
        assert_ne!(status.session_id.as_deref(), Some("current-a"));
        let desired = controller.desired.as_ref().unwrap();
        assert!(desired.paused);
        assert_eq!(desired.relative_path, "music/b.flac");
        let error = controller
            .handle_command(Command::Play {
                storage_pool_id: "pool-1".to_owned(),
                relative_path: "movie.mp4".to_owned(),
                start_position_seconds: None,
                audio_device_id: None,
                media_file_id: None,
                expected_session_id: None,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SessionConflict);
    }

    #[test]
    fn successful_music_output_start_excludes_device_startup_time_from_listening() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        controller.status.owner = Some(PlaybackOwner::Music);
        controller.status.state = PlayerState::Starting;
        controller.music_last_tick = Instant::now() - Duration::from_secs(20);
        controller.music_checkpoint.listened_seconds = 10.0;
        controller.finish_start(false);
        assert_eq!(controller.status.state, PlayerState::Playing);
        assert!(controller.music_last_tick.elapsed() < Duration::from_secs(1));
        assert_eq!(controller.music_checkpoint.listened_seconds, 10.0);
    }

    #[test]
    fn music_default_output_resolves_current_system_settings_without_changing_the_preference() {
        let directory = tempfile::tempdir().unwrap();
        let config = test_config(directory.path());
        let connection = rusqlite::Connection::open(&config.database_path).unwrap();
        connection
            .execute_batch("CREATE TABLE system_settings(key TEXT PRIMARY KEY,value_json TEXT);")
            .unwrap();
        connection
            .execute(
                "INSERT INTO system_settings VALUES('bluetooth_settings',?)",
                [r#"{"defaultAudioDeviceId":"bluetooth:adapter-hci0/11:22:33:44:55:66","receiveEnabled":false}"#],
            )
            .unwrap();
        assert_eq!(
            config.music_audio_device_id(None).unwrap().as_deref(),
            Some("bluetooth:adapter-hci0/11:22:33:44:55:66")
        );
        let explicit = "bluetooth:adapter-hci1/AA:BB:CC:DD:EE:FF";
        assert_eq!(
            config
                .music_audio_device_id(Some(explicit))
                .unwrap()
                .as_deref(),
            Some(explicit)
        );
        connection
            .execute(
                "UPDATE system_settings SET value_json = ? WHERE key = 'bluetooth_settings'",
                [r#"{"defaultAudioDeviceId":null}"#],
            )
            .unwrap();
        assert!(config.music_audio_device_id(None).unwrap().is_none());
        connection
            .execute(
                "UPDATE system_settings SET value_json = ? WHERE key = 'bluetooth_settings'",
                [r#"{"defaultAudioDeviceId":"invalid"}"#],
            )
            .unwrap();
        assert!(config.music_audio_device_id(None).is_err());
    }

    #[tokio::test]
    async fn history_is_not_submitted_to_sqlite_before_its_checkpoint_is_durable() {
        let directory = tempfile::tempdir().unwrap();
        let (mut controller, _sender, _done) = test_controller(directory.path());
        let blocked = directory.path().join("blocked-state-directory");
        std::fs::write(&blocked, b"not a directory").unwrap();
        Arc::make_mut(&mut controller.config).state_path = blocked.join("session.json");
        controller
            .music_checkpoint
            .pending_events
            .push(music::PlayEvent {
                id: "pending".to_owned(),
                track_id: "track-a".to_owned(),
                played_at: now(),
                listened_seconds: 20.0,
            });
        controller.flush_music_history().await;
        assert!(controller.music_history_flush.is_none());
        assert_eq!(controller.music_checkpoint.pending_events.len(), 1);
        assert!(!controller.config.database_path.exists());
    }
}
