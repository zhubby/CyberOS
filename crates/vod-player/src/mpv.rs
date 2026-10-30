use std::collections::VecDeque;
use std::ffi::OsStr;
use std::fs::File;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nix::fcntl::{FcntlArg, FdFlag, fcntl};
use nix::sys::signal::{Signal, kill};
use nix::sys::socket::{AddressFamily, SockFlag, SockType, socketpair};
use nix::unistd::Pid;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};

use crate::config::VodPlayerConfig;
use crate::error::{ErrorCode, VodError};
use crate::protocol::{Capabilities, HardwareDecode, MAX_FRAME_BYTES};
use crate::storage::OpenedMedia;

const MPV_IPC_FD: RawFd = 3;
const MPV_MEDIA_FD: RawFd = 4;
const CHILD_FD_DUPLICATE_MINIMUM: RawFd = 200;
const TEXT_FILE_BUSY_RETRIES: usize = 5;
const TEXT_FILE_BUSY_RETRY_DELAY: Duration = Duration::from_millis(10);
const TV_INPUT_CONFIG_PATH: &str = "/usr/share/cyberos/mpv-input.conf";

pub struct CapabilityProbe {
    pub capabilities: Capabilities,
    pub error: Option<VodError>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Availability {
    Available,
    Unavailable,
    PermissionDenied,
}

impl Availability {
    fn is_available(self) -> bool {
        self == Self::Available
    }
}

#[derive(Debug)]
pub enum MpvEvent {
    FileLoaded,
    EndFile {
        reason: String,
        error: Option<String>,
    },
    Property {
        name: String,
        value: Value,
    },
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
    },
    ProtocolFailure(String),
}

#[derive(Debug)]
enum Incoming {
    Response {
        request_id: u64,
        error: String,
        data: Value,
    },
    Event(MpvEvent),
}

pub struct MpvHandle {
    writer: WriteHalf<UnixStream>,
    incoming: mpsc::Receiver<Incoming>,
    deferred: VecDeque<MpvEvent>,
    pid: Pid,
    next_request_id: u64,
    command_timeout: Duration,
    startup_timeout: Duration,
    stderr: Arc<Mutex<Vec<u8>>>,
    _media: File,
}

impl MpvHandle {
    pub async fn start(
        config: &VodPlayerConfig,
        media: OpenedMedia,
        position_seconds: f64,
        volume: f64,
        paused: bool,
        audio_device: Option<&str>,
    ) -> Result<Self, VodError> {
        Self::start_with_executable(
            config,
            media,
            position_seconds,
            volume,
            paused,
            audio_device,
            config.mpv_executable.as_os_str(),
        )
        .await
    }

    async fn start_with_executable(
        config: &VodPlayerConfig,
        media: OpenedMedia,
        position_seconds: f64,
        volume: f64,
        paused: bool,
        audio_device: Option<&str>,
        executable: &OsStr,
    ) -> Result<Self, VodError> {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let socket_flags = SockFlag::SOCK_CLOEXEC;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let socket_flags = SockFlag::empty();
        let (parent, child_socket) =
            socketpair(AddressFamily::Unix, SockType::Stream, None, socket_flags)?;
        set_close_on_exec(&parent)?;
        set_close_on_exec(&child_socket)?;
        let child_ipc_source = duplicate_for_child(&child_socket)?;
        let child_media_source = duplicate_for_child(&media.file)?;
        let child_ipc_source_fd = child_ipc_source.as_raw_fd();
        let child_media_source_fd = child_media_source.as_raw_fd();
        let mut args = vec![
            "--no-config".to_owned(),
            "--load-scripts=no".to_owned(),
            "--ytdl=no".to_owned(),
            "--sub-auto=no".to_owned(),
            "--audio-file-auto=no".to_owned(),
            "--autoload-files=no".to_owned(),
            "--access-references=no".to_owned(),
            "--input-default-bindings=no".to_owned(),
            "--terminal=no".to_owned(),
            "--idle=no".to_owned(),
            format!("--ao={}", config.audio_output),
            format!("--hwdec={}", config.hwdec),
            format!("--volume={volume}"),
            format!("--start={position_seconds}"),
            format!("--input-ipc-client=fd://{MPV_IPC_FD}"),
        ];
        if config.video_output == "null" {
            args.extend([
                "--vid=no".to_owned(),
                "--vo=null".to_owned(),
                "--audio-display=no".to_owned(),
            ]);
        } else {
            args.push("--vo=gpu".to_owned());
            args.push(format!("--gpu-context={}", config.video_output));
            append_video_output_args(&mut args, config);
        }
        if paused {
            args.push("--pause".to_owned());
        }
        if let Some(device) = audio_device.or(config.audio_device.as_deref()) {
            args.push(format!("--audio-device={device}"));
        }
        args.push(format!("fdclose://{MPV_MEDIA_FD}"));

        let mut command = Command::new(executable);
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Keep every source descriptor CLOEXEC in the parent. Only these two
        // fixed descriptors survive exec in the child, so concurrent process
        // launches cannot inherit another playback session's media or IPC.
        unsafe {
            command.pre_exec(move || {
                dup2_for_exec(child_ipc_source_fd, MPV_IPC_FD)?;
                dup2_for_exec(child_media_source_fd, MPV_MEDIA_FD)?;
                Ok(())
            });
        }
        let mut text_file_busy_retries = 0;
        let mut child = loop {
            match command.spawn() {
                Ok(child) => break child,
                Err(error)
                    if error.raw_os_error() == Some(nix::libc::ETXTBSY)
                        && text_file_busy_retries < TEXT_FILE_BUSY_RETRIES =>
                {
                    text_file_busy_retries += 1;
                    sleep(TEXT_FILE_BUSY_RETRY_DELAY).await;
                }
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    return Err(VodError::new(
                        ErrorCode::PermissionDenied,
                        "Permission denied while starting mpv",
                        403,
                    ));
                }
                Err(error) => {
                    return Err(VodError::unavailable(
                        ErrorCode::MpvUnavailable,
                        format!("Unable to start mpv: {error}"),
                    ));
                }
            }
        };
        drop(child_ipc_source);
        drop(child_media_source);
        let pid = Pid::from_raw(
            child
                .id()
                .ok_or_else(|| VodError::internal("mpv did not expose a process id"))?
                as i32,
        );
        drop(child_socket);

        let stderr = Arc::new(Mutex::new(Vec::new()));
        if let Some(stderr_pipe) = child.stderr.take() {
            let buffer = Arc::clone(&stderr);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr_pipe);
                let mut chunk = vec![0; 2048];
                loop {
                    let count = match tokio::io::AsyncReadExt::read(&mut reader, &mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(count) => count,
                    };
                    let mut output = buffer.lock().expect("stderr buffer poisoned");
                    output.extend_from_slice(&chunk[..count]);
                    if output.len() > 16 * 1024 {
                        let drain = output.len() - 16 * 1024;
                        output.drain(..drain);
                    }
                }
            });
        }

        let stream = std::os::unix::net::UnixStream::from(parent);
        stream.set_nonblocking(true)?;
        let stream = UnixStream::from_std(stream)?;
        let (reader, writer) = tokio::io::split(stream);
        let (incoming_tx, incoming) = mpsc::channel(128);
        tokio::spawn(read_ipc(reader, incoming_tx.clone()));
        tokio::spawn(async move {
            let status = child.wait().await;
            let (code, signal) = match status {
                Ok(status) => (status.code(), status.signal()),
                Err(_) => (None, None),
            };
            let _ = incoming_tx
                .send(Incoming::Event(MpvEvent::Exit { code, signal }))
                .await;
        });

        let mut handle = Self {
            writer,
            incoming,
            deferred: VecDeque::new(),
            pid,
            next_request_id: 1,
            command_timeout: Duration::from_millis(config.command_timeout_ms),
            startup_timeout: Duration::from_millis(config.startup_timeout_ms),
            stderr,
            _media: media.file,
        };
        if let Err(error) = handle.wait_until_loaded().await {
            handle.shutdown().await;
            return Err(error);
        }
        if audio_device.is_some()
            && let Err(error) = handle.verify_requested_audio_output().await
        {
            handle.shutdown().await;
            return Err(error);
        }
        for (id, property) in [
            (1, "time-pos"),
            (2, "duration"),
            (3, "pause"),
            (4, "volume"),
            (5, "hwdec-current"),
            (6, "track-list"),
        ] {
            if let Err(error) = handle
                .command(json!(["observe_property", id, property]))
                .await
            {
                handle.shutdown().await;
                return Err(error);
            }
        }
        Ok(handle)
    }

    pub(crate) async fn verify_requested_audio_output(&mut self) -> Result<(), VodError> {
        let tracks = self
            .command(json!(["get_property", "track-list"]))
            .await
            .map_err(bluetooth_audio_unavailable)?;
        if !has_selected_audio_track(&tracks) {
            return Ok(());
        }
        let output = self
            .command(json!(["get_property", "audio-out-params"]))
            .await
            .map_err(bluetooth_audio_unavailable)?;
        if output.is_object() {
            Ok(())
        } else {
            Err(VodError::unavailable(
                ErrorCode::AudioUnavailable,
                "Bluetooth audio device did not open",
            ))
        }
    }

    pub async fn command(&mut self, command: Value) -> Result<Value, VodError> {
        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.saturating_add(1);
        let body = json!({ "command": command, "request_id": request_id });
        self.writer
            .write_all(
                serde_json::to_string(&body)
                    .map_err(|error| VodError::internal(error.to_string()))?
                    .as_bytes(),
            )
            .await?;
        self.writer.write_all(b"\n").await?;
        self.writer.flush().await?;
        let deadline = tokio::time::Instant::now() + self.command_timeout;
        loop {
            let incoming = timeout(
                deadline.saturating_duration_since(tokio::time::Instant::now()),
                self.incoming.recv(),
            )
            .await
            .map_err(|_| VodError::new(ErrorCode::CommandTimeout, "mpv command timed out", 504))?
            .ok_or_else(|| VodError::unavailable(ErrorCode::PlaybackFailed, "mpv IPC closed"))?;
            match incoming {
                Incoming::Response {
                    request_id: response_id,
                    error,
                    data,
                } if response_id == request_id => {
                    if error == "success" {
                        return Ok(data);
                    }
                    return Err(VodError::new(
                        ErrorCode::PlaybackFailed,
                        format!("mpv rejected command: {error}"),
                        422,
                    ));
                }
                Incoming::Response { .. } => {}
                Incoming::Event(event) => self.deferred.push_back(event),
            }
        }
    }

    pub fn drain_events(&mut self) -> Vec<MpvEvent> {
        while let Ok(incoming) = self.incoming.try_recv() {
            if let Incoming::Event(event) = incoming {
                self.deferred.push_back(event);
            }
        }
        self.deferred.drain(..).collect()
    }

    pub async fn shutdown(mut self) {
        let request_id = self.next_request_id;
        let quit = json!({ "command": ["quit"], "request_id": request_id });
        if let Ok(mut body) = serde_json::to_vec(&quit) {
            body.push(b'\n');
            let _ = self.writer.write_all(&body).await;
        }
        if self.wait_for_exit(Duration::from_secs(5)).await {
            return;
        }
        let _ = kill(self.pid, Signal::SIGTERM);
        if self.wait_for_exit(Duration::from_secs(5)).await {
            return;
        }
        let _ = kill(self.pid, Signal::SIGKILL);
        let _ = self.wait_for_exit(Duration::from_secs(2)).await;
    }

    pub fn stderr_summary(&self) -> String {
        let bytes = self.stderr.lock().expect("stderr buffer poisoned");
        sanitize_diagnostic(&String::from_utf8_lossy(&bytes))
    }

    async fn wait_until_loaded(&mut self) -> Result<(), VodError> {
        let result = timeout(self.startup_timeout, async {
            loop {
                match self.incoming.recv().await {
                    Some(Incoming::Event(MpvEvent::FileLoaded)) => return Ok(()),
                    Some(Incoming::Event(MpvEvent::EndFile { reason, error })) => {
                        return Err(classify_end_file_failure(&reason, error.as_deref()));
                    }
                    Some(Incoming::Event(MpvEvent::ProtocolFailure(message))) => {
                        return Err(VodError::unavailable(ErrorCode::PlaybackFailed, message));
                    }
                    Some(Incoming::Event(MpvEvent::Exit { .. })) | None => {
                        let diagnostic = self.stderr_summary();
                        let message = if diagnostic.is_empty() {
                            "mpv exited before loading media".to_owned()
                        } else {
                            format!("mpv exited before loading media: {diagnostic}")
                        };
                        return Err(VodError::unavailable(ErrorCode::PlaybackFailed, message));
                    }
                    Some(Incoming::Event(event)) => self.deferred.push_back(event),
                    Some(Incoming::Response { .. }) => {}
                }
            }
        })
        .await;
        match result {
            Ok(result) => result,
            Err(_) => Err(VodError::new(
                ErrorCode::CommandTimeout,
                "mpv did not load media in time",
                504,
            )),
        }
    }

    async fn wait_for_exit(&mut self, duration: Duration) -> bool {
        timeout(duration, async {
            loop {
                match self.incoming.recv().await {
                    Some(Incoming::Event(MpvEvent::Exit { .. })) | None => return,
                    Some(Incoming::Event(event)) => self.deferred.push_back(event),
                    Some(Incoming::Response { .. }) => {}
                }
            }
        })
        .await
        .is_ok()
    }
}

fn append_video_output_args(args: &mut Vec<String>, config: &VodPlayerConfig) {
    if config.video_output == "wayland" {
        args.extend([
            "--fullscreen=yes".to_owned(),
            "--border=no".to_owned(),
            "--ontop=yes".to_owned(),
            "--wayland-app-id=cyberos-vod-player".to_owned(),
            "--osd-level=1".to_owned(),
            "--osd-on-seek=bar".to_owned(),
            format!("--input-conf={TV_INPUT_CONFIG_PATH}"),
        ]);
    } else if let Some(connector) = &config.drm_connector {
        args.push(format!("--drm-connector={connector}"));
    }
}

fn has_selected_audio_track(value: &Value) -> bool {
    value.as_array().is_some_and(|tracks| {
        tracks.iter().any(|track| {
            track.get("type").and_then(Value::as_str) == Some("audio")
                && track.get("selected").and_then(Value::as_bool) == Some(true)
        })
    })
}

fn bluetooth_audio_unavailable(error: VodError) -> VodError {
    VodError::unavailable(
        ErrorCode::AudioUnavailable,
        format!("Bluetooth audio device did not open: {}", error.message),
    )
}

pub async fn probe(config: &VodPlayerConfig) -> CapabilityProbe {
    probe_with_mpv(config, false).await
}

pub async fn probe_active_outputs(config: &VodPlayerConfig) -> CapabilityProbe {
    probe_with_mpv(config, true).await
}

/// A BlueALSA PCM may stay open while a speaker disconnects. A confirmed
/// BlueZ disconnect pauses music until the user explicitly resumes it.
pub async fn bluetooth_connected(device_id: &str) -> Option<bool> {
    let device_path = bluetooth_device_path(device_id)?;
    let mut command = Command::new("busctl");
    command
        .args([
            "--system",
            "--timeout=1",
            "get-property",
            "org.bluez",
            &device_path,
            "org.bluez.Device1",
            "Connected",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = timeout(Duration::from_millis(750), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    match std::str::from_utf8(&output.stdout).ok()?.trim() {
        "b true" => Some(true),
        "b false" => Some(false),
        _ => None,
    }
}

fn bluetooth_device_path(device_id: &str) -> Option<String> {
    crate::protocol::validate_bluetooth_audio_device_id(device_id).ok()?;
    let target = device_id.strip_prefix("bluetooth:")?;
    let (adapter, address) = match target.split_once('/') {
        Some((adapter, address)) => (adapter.strip_prefix("adapter-")?, address),
        None => ("hci0", target),
    };
    if !adapter
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return None;
    }
    Some(format!(
        "/org/bluez/{adapter}/dev_{}",
        address.replace(':', "_").to_ascii_uppercase()
    ))
}

async fn probe_with_mpv(config: &VodPlayerConfig, active_process: bool) -> CapabilityProbe {
    let mpv = if active_process {
        Availability::Available
    } else {
        let mut version_command = Command::new(&config.mpv_executable);
        version_command
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        match timeout(Duration::from_secs(5), version_command.status()).await {
            Ok(Ok(status)) if status.success() => Availability::Available,
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                Availability::PermissionDenied
            }
            _ => Availability::Unavailable,
        }
    };
    let drm = if config.video_output == "drm" {
        drm_availability(config.drm_connector.as_deref())
    } else {
        Availability::Available
    };
    let bluealsa = config.video_output == "null"
        && config
            .audio_device
            .as_deref()
            .is_some_and(|device| device.starts_with("alsa/bluealsa:"));
    let audio = if config.audio_output == "alsa" && !bluealsa {
        directory_availability("/dev/snd")
    } else {
        Availability::Available
    };
    let error = availability_error(mpv, drm, audio);
    let capabilities = Capabilities {
        mpv_available: mpv.is_available(),
        drm_available: drm.is_available(),
        audio_available: audio.is_available(),
        hardware_decode: if config.hwdec == "no" {
            HardwareDecode::Software
        } else {
            HardwareDecode::Unknown
        },
        error: error.as_ref().map(|error| error.message.clone()),
    };
    CapabilityProbe {
        capabilities,
        error,
    }
}

fn availability_error(
    mpv: Availability,
    drm: Availability,
    audio: Availability,
) -> Option<VodError> {
    if [mpv, drm, audio].contains(&Availability::PermissionDenied) {
        Some(VodError::new(
            ErrorCode::PermissionDenied,
            "VOD player cannot access mpv or an output device",
            403,
        ))
    } else if !mpv.is_available() {
        Some(VodError::unavailable(
            ErrorCode::MpvUnavailable,
            "mpv is unavailable",
        ))
    } else if !drm.is_available() {
        Some(VodError::unavailable(
            ErrorCode::DrmUnavailable,
            "No connected DRM display is available",
        ))
    } else if !audio.is_available() {
        Some(VodError::unavailable(
            ErrorCode::AudioUnavailable,
            "No ALSA audio device is available",
        ))
    } else {
        None
    }
}

fn drm_availability(connector: Option<&str>) -> Availability {
    let entries = match std::fs::read_dir("/sys/class/drm") {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return Availability::PermissionDenied;
        }
        Err(_) => return Availability::Unavailable,
    };
    let mut permission_denied = false;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !connector.is_none_or(|connector| name.ends_with(connector)) {
            continue;
        }
        match std::fs::read_to_string(entry.path().join("status")) {
            Ok(status) if status.trim() == "connected" => return Availability::Available,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                permission_denied = true;
            }
            _ => {}
        }
    }
    if permission_denied {
        Availability::PermissionDenied
    } else {
        Availability::Unavailable
    }
}

fn directory_availability(path: &str) -> Availability {
    match std::fs::read_dir(path) {
        Ok(entries) => {
            if entries.into_iter().next().is_some() {
                Availability::Available
            } else {
                Availability::Unavailable
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            Availability::PermissionDenied
        }
        Err(_) => Availability::Unavailable,
    }
}

fn duplicate_for_child<F: AsFd>(fd: &F) -> Result<OwnedFd, VodError> {
    let duplicate = fcntl(fd, FcntlArg::F_DUPFD_CLOEXEC(CHILD_FD_DUPLICATE_MINIMUM))?;
    // fcntl returned a new descriptor owned by this process.
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

fn set_close_on_exec<F: AsFd>(fd: &F) -> Result<(), VodError> {
    fcntl(fd, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC))
        .map(|_| ())
        .map_err(VodError::from)
}

fn dup2_for_exec(source: RawFd, target: RawFd) -> std::io::Result<()> {
    if unsafe { nix::libc::dup2(source, target) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    // Be explicit because the child must keep these descriptors across the
    // shell/mpv exec boundary on every supported Unix implementation.
    if unsafe { nix::libc::fcntl(target, nix::libc::F_SETFD, 0) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

async fn read_ipc(reader: ReadHalf<UnixStream>, sender: mpsc::Sender<Incoming>) {
    let mut reader = reader;
    let mut pending = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    loop {
        let newline = pending.iter().position(|byte| *byte == b'\n');
        if let Some(newline) = newline {
            if newline > MAX_FRAME_BYTES {
                let _ = sender
                    .send(Incoming::Event(MpvEvent::ProtocolFailure(
                        "mpv IPC frame is too large".to_owned(),
                    )))
                    .await;
                break;
            }
            let mut frame: Vec<_> = pending.drain(..=newline).collect();
            frame.pop();
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            let line = match std::str::from_utf8(&frame) {
                Ok(line) => line,
                Err(_) => {
                    let _ = sender
                        .send(Incoming::Event(MpvEvent::ProtocolFailure(
                            "mpv returned non-UTF-8 data".to_owned(),
                        )))
                        .await;
                    continue;
                }
            };
            handle_ipc_line(line, &sender).await;
            continue;
        }
        if pending.len() > MAX_FRAME_BYTES {
            let _ = sender
                .send(Incoming::Event(MpvEvent::ProtocolFailure(
                    "mpv IPC frame is too large".to_owned(),
                )))
                .await;
            break;
        }
        match reader.read(&mut chunk).await {
            Ok(0) => {
                let _ = sender
                    .send(Incoming::Event(MpvEvent::ProtocolFailure(
                        "mpv IPC closed unexpectedly".to_owned(),
                    )))
                    .await;
                break;
            }
            Err(_) => {
                let _ = sender
                    .send(Incoming::Event(MpvEvent::ProtocolFailure(
                        "mpv IPC read failed".to_owned(),
                    )))
                    .await;
                break;
            }
            Ok(count) => pending.extend_from_slice(&chunk[..count]),
        }
    }
}

async fn handle_ipc_line(line: &str, sender: &mpsc::Sender<Incoming>) {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            let _ = sender
                .send(Incoming::Event(MpvEvent::ProtocolFailure(
                    "mpv returned invalid JSON".to_owned(),
                )))
                .await;
            return;
        }
    };
    if let Some(request_id) = value.get("request_id").and_then(Value::as_u64) {
        let _ = sender
            .send(Incoming::Response {
                request_id,
                error: value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned(),
                data: value.get("data").cloned().unwrap_or(Value::Null),
            })
            .await;
        return;
    }
    let event = match value.get("event").and_then(Value::as_str) {
        Some("file-loaded") => Some(MpvEvent::FileLoaded),
        Some("end-file") => Some(MpvEvent::EndFile {
            reason: value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned(),
            error: value
                .get("file_error")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        Some("property-change") => Some(MpvEvent::Property {
            name: value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            value: value.get("data").cloned().unwrap_or(Value::Null),
        }),
        _ => None,
    };
    if let Some(event) = event {
        let _ = sender.send(Incoming::Event(event)).await;
    }
}

pub(crate) fn sanitize_diagnostic(value: &str) -> String {
    value
        .split_whitespace()
        .map(|part| {
            let unquoted = part.trim_matches(|character: char| {
                matches!(character, '\'' | '"' | '(' | ')' | '[' | ']' | ',' | ':')
            });
            if unquoted.starts_with('/')
                || part.contains("=/")
                || part.contains("='/")
                || part.contains("=\"/")
                || part.contains("fdclose://")
            {
                "[path]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(16 * 1024)
        .collect()
}

pub(crate) fn classify_end_file_failure(reason: &str, error: Option<&str>) -> VodError {
    let raw = error
        .map(str::to_owned)
        .unwrap_or_else(|| format!("mpv ended playback: {reason}"));
    let diagnostic = sanitize_diagnostic(&raw);
    let normalized = diagnostic.to_ascii_lowercase();
    if ["audio output", "audio device", "alsa", "bluealsa"]
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        VodError::unavailable(ErrorCode::AudioUnavailable, diagnostic)
    } else if [
        "input/output error",
        "i/o error",
        "stale file handle",
        "no medium found",
        "no such file or directory",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
    {
        VodError::unavailable(ErrorCode::StorageUnavailable, diagnostic)
    } else if reason == "eof"
        || [
            "unsupported",
            "unrecognized file format",
            "codec not found",
            "decoder not found",
            "could not open codec",
            "error decoding",
            "decode error",
            "decoding failed",
            "invalid data found when processing input",
            "corrupt",
        ]
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        VodError::new(ErrorCode::UnsupportedMedia, diagnostic, 415)
    } else {
        VodError::unavailable(ErrorCode::PlaybackFailed, diagnostic)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::PathBuf;

    use crate::storage::FileIdentity;

    fn config(directory: &std::path::Path) -> VodPlayerConfig {
        VodPlayerConfig {
            enabled: true,
            mpv_executable: PathBuf::from("mpv"),
            socket_path: directory.join("vod-player.sock"),
            state_path: directory.join("session.json"),
            database_path: directory.join("cyberos.sqlite"),
            data_root: directory.join("data"),
            production: false,
            command_timeout_ms: 250,
            startup_timeout_ms: 5_000,
            checkpoint_interval_ms: 5_000,
            retry_base_delay_ms: 10,
            retry_max_delay_ms: 60,
            video_output: "drm".to_owned(),
            drm_connector: None,
            audio_output: "alsa".to_owned(),
            audio_device: None,
            hwdec: "auto-safe".to_owned(),
            user: "test".to_owned(),
            peer_uid: nix::unistd::Uid::current().as_raw(),
        }
    }

    fn write_executable(path: &std::path::Path, contents: &str) -> PathBuf {
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, contents).unwrap();
        let mut permissions = std::fs::metadata(&temporary).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&temporary, permissions).unwrap();
        std::fs::rename(&temporary, path).unwrap();
        path.to_owned()
    }

    fn fake_mpv(directory: &std::path::Path) -> PathBuf {
        let path = directory.join("fake-mpv");
        write_executable(
            &path,
            r#"#!/bin/sh
ipc_fd=
media_fd=
for argument do
  case "$argument" in
    --input-ipc-client=fd://*) ipc_fd=${argument#--input-ipc-client=fd://} ;;
    fdclose://*) media_fd=${argument#fdclose://} ;;
  esac
done
eval "exec 5<&$ipc_fd"
eval "exec 6>&$ipc_fd"
eval "content=\$(dd bs=5 count=1 <&$media_fd 2>/dev/null)"
[ "$content" = video ] || exit 9
printf '%s\n' '{"event":"file-loaded"}' >&6
while IFS= read -r line <&5; do
	case "$line" in
	  *'"quit"'*) exit 0 ;;
	  *'"no-response"'*) continue ;;
	esac
  request_id=$(printf '%s' "$line" | sed -n 's/.*"request_id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$request_id" ] || continue
  printf '%s\n' '{"event":"property-change","name":"time-pos","data":12}' >&6
  case "$line" in
    *'"pause",true'*) printf '{"request_id":%s,"error":"failure","data":null}\n' "$request_id" >&6 ;;
    *'"track-list"'*) printf '{"request_id":%s,"error":"success","data":[{"type":"audio","selected":true}]}\n' "$request_id" >&6 ;;
    *'"audio-out-params"'*) printf '{"request_id":%s,"error":"property unavailable","data":null}\n' "$request_id" >&6 ;;
    *) printf '{"request_id":%s,"error":"success","data":null}\n' "$request_id" >&6 ;;
  esac
done
"#,
        )
    }

    fn fake_mpv_without_events(directory: &std::path::Path) -> PathBuf {
        let path = directory.join("fake-mpv-without-events");
        write_executable(
            &path,
            r#"#!/bin/sh
ipc_fd=
for argument do
  case "$argument" in
    --input-ipc-client=fd://*) ipc_fd=${argument#--input-ipc-client=fd://} ;;
  esac
done
eval "exec 5<&$ipc_fd"
while IFS= read -r line <&5; do
  case "$line" in
    *'"quit"'*) exit 0 ;;
  esac
done
"#,
        )
    }

    fn media(directory: &std::path::Path) -> OpenedMedia {
        let path = directory.join("movie.mp4");
        std::fs::write(&path, b"video payload").unwrap();
        let file = File::open(path).unwrap();
        let metadata = file.metadata().unwrap();
        OpenedMedia {
            file,
            identity: FileIdentity {
                device: metadata.dev(),
                inode: metadata.ino(),
                size: metadata.len(),
                modified_seconds: metadata.mtime(),
                modified_nanoseconds: metadata.mtime_nsec(),
                changed_seconds: metadata.ctime(),
                changed_nanoseconds: metadata.ctime_nsec(),
            },
            file_name: "movie.mp4".to_owned(),
        }
    }

    #[test]
    fn redacts_paths_from_diagnostics() {
        let message = sanitize_diagnostic(
            "failed '/cyberos/data/pool-1/private/movie.mkv' source=/cyberos/data/pool-1/private path='/private/secret' fdclose://9",
        );
        assert_eq!(message, "failed [path] [path] [path] [path]");
    }

    #[test]
    fn classifies_capability_failures() {
        assert_eq!(
            availability_error(
                Availability::Available,
                Availability::Unavailable,
                Availability::Available,
            )
            .unwrap()
            .code,
            ErrorCode::DrmUnavailable
        );
        assert_eq!(
            availability_error(
                Availability::Available,
                Availability::PermissionDenied,
                Availability::Available,
            )
            .unwrap()
            .code,
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            availability_error(
                Availability::Available,
                Availability::PermissionDenied,
                Availability::Available,
            )
            .unwrap()
            .status_code,
            403
        );
    }

    #[test]
    fn classifies_transient_startup_io_separately_from_decode_failures() {
        assert!(classify_end_file_failure("error", Some("Input/output error")).retryable());
        assert_eq!(
            classify_end_file_failure("error", Some("decoder not found for codec")).code,
            ErrorCode::UnsupportedMedia
        );
        assert_eq!(
            classify_end_file_failure("eof", None).code,
            ErrorCode::UnsupportedMedia
        );
    }

    #[test]
    fn wayland_output_is_fullscreen_and_uses_the_restricted_input_map() {
        let directory = tempfile::tempdir().unwrap();
        let mut test_config = config(directory.path());
        test_config.video_output = "wayland".to_owned();
        test_config.drm_connector = Some("HDMI-A-1".to_owned());
        let mut args = Vec::new();
        append_video_output_args(&mut args, &test_config);
        assert!(args.contains(&"--fullscreen=yes".to_owned()));
        assert!(args.contains(&"--wayland-app-id=cyberos-vod-player".to_owned()));
        assert!(args.contains(&format!("--input-conf={TV_INPUT_CONFIG_PATH}")));
        assert!(
            !args
                .iter()
                .any(|argument| argument.starts_with("--drm-connector="))
        );
    }

    #[tokio::test]
    async fn fake_mpv_reads_the_inherited_media_fd_and_correlates_responses() {
        let directory = tempfile::tempdir().unwrap();
        let executable = fake_mpv(directory.path());
        let mut handle = MpvHandle::start_with_executable(
            &config(directory.path()),
            media(directory.path()),
            0.0,
            80.0,
            false,
            None,
            executable.as_os_str(),
        )
        .await
        .unwrap();
        handle
            .command(json!(["set_property", "volume", 70]))
            .await
            .unwrap();
        assert!(
            handle.drain_events().iter().any(
                |event| matches!(event, MpvEvent::Property { name, .. } if name == "time-pos")
            )
        );
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn headless_music_starts_without_a_video_context_or_display_arguments() {
        let directory = tempfile::tempdir().unwrap();
        let executable = fake_mpv(directory.path());
        let script = std::fs::read_to_string(&executable).unwrap().replace(
            "ipc_fd=\n",
            r#"video_disabled=0
null_video=0
for argument do
  case "$argument" in
    --vid=no) video_disabled=1 ;;
    --vo=null) null_video=1 ;;
    --gpu-context=*|--fullscreen=*|--drm-connector=*|--wayland-app-id=*) exit 97 ;;
  esac
done
[ "$video_disabled:$null_video" = 1:1 ] || exit 98
ipc_fd=
"#,
        );
        write_executable(&executable, &script);
        let playback_config = config(directory.path()).for_music_session(false);
        let handle = MpvHandle::start_with_executable(
            &playback_config,
            media(directory.path()),
            0.0,
            70.0,
            false,
            None,
            executable.as_os_str(),
        )
        .await
        .unwrap();
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn pure_bluetooth_music_does_not_require_drm_or_local_sound_devices() {
        let directory = tempfile::tempdir().unwrap();
        let mut playback_config = config(directory.path()).for_music_session(true);
        playback_config.audio_device =
            Some("alsa/bluealsa:DEV=AA:BB:CC:DD:EE:FF,PROFILE=a2dp".to_owned());
        let result = probe_active_outputs(&playback_config).await;
        assert!(result.error.is_none());
        assert!(result.capabilities.audio_available);
        assert!(result.capabilities.drm_available);
        assert_eq!(
            result.capabilities.hardware_decode,
            HardwareDecode::Software
        );
    }

    #[tokio::test]
    async fn fake_mpv_command_rejections_are_not_reported_as_success() {
        let directory = tempfile::tempdir().unwrap();
        let executable = fake_mpv(directory.path());
        let mut handle = MpvHandle::start_with_executable(
            &config(directory.path()),
            media(directory.path()),
            0.0,
            80.0,
            false,
            None,
            executable.as_os_str(),
        )
        .await
        .unwrap();
        let error = handle
            .command(json!(["set_property", "pause", true]))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::PlaybackFailed);
        handle.shutdown().await;
    }

    #[test]
    fn bluetooth_connection_probe_uses_a_validated_adapter_and_device_path() {
        assert_eq!(
            bluetooth_device_path("bluetooth:adapter-hci1/aa:bb:cc:dd:ee:ff").as_deref(),
            Some("/org/bluez/hci1/dev_AA_BB_CC_DD_EE_FF")
        );
        assert_eq!(
            bluetooth_device_path("bluetooth:AA:BB:CC:DD:EE:FF").as_deref(),
            Some("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF")
        );
        assert!(bluetooth_device_path("alsa/arbitrary").is_none());
        assert!(
            bluetooth_device_path("bluetooth:adapter-../../unsafe/AA:BB:CC:DD:EE:FF").is_none()
        );
    }

    #[tokio::test]
    async fn requested_audio_device_must_open_before_startup_succeeds() {
        let directory = tempfile::tempdir().unwrap();
        let executable = fake_mpv(directory.path());
        let result = MpvHandle::start_with_executable(
            &config(directory.path()),
            media(directory.path()),
            0.0,
            80.0,
            false,
            Some("alsa/bluealsa:DEV=AA:BB:CC:DD:EE:FF,PROFILE=a2dp"),
            executable.as_os_str(),
        )
        .await;
        let error = match result {
            Ok(handle) => {
                handle.shutdown().await;
                panic!("mpv unexpectedly accepted an unavailable audio output")
            }
            Err(error) => error,
        };
        assert_eq!(error.code, ErrorCode::AudioUnavailable);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn retries_text_file_busy_while_starting_mpv() {
        let directory = tempfile::tempdir().unwrap();
        let executable = fake_mpv(directory.path());
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&executable)
            .unwrap();
        let release_writer = tokio::spawn(async move {
            sleep(Duration::from_millis(25)).await;
            drop(writer);
        });

        let handle = MpvHandle::start_with_executable(
            &config(directory.path()),
            media(directory.path()),
            0.0,
            80.0,
            false,
            None,
            executable.as_os_str(),
        )
        .await
        .unwrap();

        release_writer.await.unwrap();
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn missing_command_responses_time_out_and_still_allow_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let executable = fake_mpv(directory.path());
        let mut test_config = config(directory.path());
        test_config.command_timeout_ms = 50;
        let mut handle = MpvHandle::start_with_executable(
            &test_config,
            media(directory.path()),
            0.0,
            80.0,
            false,
            None,
            executable.as_os_str(),
        )
        .await
        .unwrap();

        let error = handle.command(json!(["no-response"])).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::CommandTimeout);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn missing_file_loaded_event_times_out_and_stops_the_child() {
        let directory = tempfile::tempdir().unwrap();
        let executable = fake_mpv_without_events(directory.path());
        let mut test_config = config(directory.path());
        test_config.startup_timeout_ms = 50;
        let result = MpvHandle::start_with_executable(
            &test_config,
            media(directory.path()),
            0.0,
            80.0,
            false,
            None,
            executable.as_os_str(),
        )
        .await;
        let error = match result {
            Ok(handle) => {
                handle.shutdown().await;
                panic!("mpv unexpectedly started")
            }
            Err(error) => error,
        };
        assert_eq!(error.code, ErrorCode::CommandTimeout);
    }

    #[tokio::test]
    async fn reports_an_unexpected_ipc_disconnect() {
        let (writer, reader) = UnixStream::pair().unwrap();
        let (reader, _) = tokio::io::split(reader);
        let (sender, mut incoming) = mpsc::channel(2);
        let task = tokio::spawn(read_ipc(reader, sender));
        drop(writer);
        assert!(matches!(
            incoming.recv().await,
            Some(Incoming::Event(MpvEvent::ProtocolFailure(message)))
                if message == "mpv IPC closed unexpectedly"
        ));
        task.await.unwrap();
    }
}
