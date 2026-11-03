use std::collections::VecDeque;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Mutex, watch};
use uuid::Uuid;

const MAX_FRAME: u64 = 9 * 1024 * 1024;

#[derive(Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    pub enabled: bool,
    pub input_device_id: Option<String>,
    pub max_recording_seconds: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub connected: bool,
}

pub struct Recording {
    pub id: String,
    pub device_id: String,
    pub wav: Vec<u8>,
    pub created: Instant,
}

pub struct State {
    pub config: Configuration,
    pub connected: bool,
    pub protocol: String,
    pub error: Option<String>,
    pub capture_id: Option<String>,
    pub generation: u64,
    pub recordings: VecDeque<Recording>,
    pub playing: bool,
    pub playback_cancel: watch::Sender<u64>,
    pub configured_at: Instant,
}
pub type Shared = Arc<Mutex<State>>;

impl State {
    fn expire_recordings(&mut self) {
        self.recordings
            .retain(|recording| recording.created.elapsed() < Duration::from_secs(300));
    }
    pub fn interrupt(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.playback_cancel
            .send_modify(|generation| *generation += 1);
    }
    pub fn begin_capture(&mut self) -> Option<String> {
        self.expire_recordings();
        self.interrupt();
        if self.capture_id.is_some() || self.recordings.len() >= 2 {
            self.error = Some("Voice channel busy".into());
            return None;
        }
        let id = Uuid::new_v4().to_string();
        self.capture_id = Some(id.clone());
        self.error = None;
        Some(id)
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    Status,
    Devices,
    Configure {
        config: Configuration,
    },
    Recording {
        id: String,
    },
    Ack {
        id: String,
    },
    Play {
        wav: String,
        device: String,
        volume: u8,
        generation: u64,
    },
    Stop,
}

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let socket_path =
        std::env::var("CYBEROS_AUDIO_SOCKET").unwrap_or_else(|_| "/run/cyberos/audiod.sock".into());
    let listener = bind_socket(&socket_path).await?;
    let socket_inode = std::fs::symlink_metadata(&socket_path)?.ino();
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
    let (playback_cancel, _) = watch::channel(0);
    let state = Arc::new(Mutex::new(State {
        config: Configuration {
            max_recording_seconds: 30,
            ..Default::default()
        },
        connected: false,
        protocol: "disabled".into(),
        error: None,
        capture_id: None,
        generation: 0,
        recordings: VecDeque::new(),
        playing: false,
        playback_cancel,
        configured_at: Instant::now(),
    }));
    tokio::spawn(crate::bluez::run(state.clone()));
    let _ = sd_notify::notify(&[sd_notify::NotifyState::Ready]);
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let permits = Arc::new(tokio::sync::Semaphore::new(8));
    let mut cleanup = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = cleanup.tick() => state.lock().await.expire_recordings(),
            _ = tokio::signal::ctrl_c() => break,
            _ = terminate.recv() => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                if stream.peer_cred()?.uid() != nix::unistd::getuid().as_raw() { continue; }
                let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                let shared = state.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = connection(stream, shared).await;
                });
            }
        }
    }
    state.lock().await.interrupt();
    if std::fs::symlink_metadata(&socket_path).is_ok_and(|metadata| metadata.ino() == socket_inode)
    {
        std::fs::remove_file(socket_path)?;
    }
    Ok(())
}

async fn connection(
    stream: UnixStream,
    state: Shared,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(5),
        (&mut reader)
            .take(MAX_FRAME + 1)
            .read_until(b'\n', &mut line),
    )
    .await??;
    let response = if line.len() as u64 > MAX_FRAME || !line.ends_with(b"\n") {
        Err("Invalid audio request".into())
    } else {
        match serde_json::from_slice::<Request>(&line) {
            Ok(request) => {
                let (disconnected, signal) = watch::channel(false);
                let mut operation = tokio::spawn(handle(request, state, signal));
                let mut extra = [0u8; 1];
                tokio::select! {
                    response = &mut operation => response?,
                    _ = reader.read(&mut extra) => {
                        disconnected.send_replace(true);
                        let _ = operation.await;
                        return Ok(());
                    }
                }
            }
            Err(_) => Err("Invalid audio request".into()),
        }
    };
    let value = match response {
        Ok(value) => json!({"ok":true,"result":value}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    writer
        .write_all(serde_json::to_string(&value)?.as_bytes())
        .await?;
    writer.write_all(b"\n").await?;
    Ok(())
}

async fn handle(
    request: Request,
    state: Shared,
    disconnected: watch::Receiver<bool>,
) -> Result<Value, String> {
    match request {
        Request::Status => {
            let mut current = state.lock().await;
            current.expire_recordings();
            Ok(
                json!({"available":true,"protocol":current.protocol,"connected":current.connected,
                "recordingId":current.capture_id,"generation":current.generation,
                "recordings":current.recordings.iter().map(|recording| &recording.id).collect::<Vec<_>>(),
                "playing":current.playing,"error":current.error}),
            )
        }
        Request::Devices => {
            let inputs = crate::bluez::devices().await?;
            let outputs = crate::output::devices().await?;
            Ok(json!({"inputs":inputs,"outputs":outputs}))
        }
        Request::Configure { config } => {
            if !(1..=30).contains(&config.max_recording_seconds)
                || config
                    .input_device_id
                    .as_ref()
                    .is_some_and(|id| id.len() > 256)
            {
                return Err("Invalid capture configuration".into());
            }
            if config.enabled
                && !crate::bluez::devices()
                    .await?
                    .iter()
                    .any(|device| Some(&device.id) == config.input_device_id.as_ref())
            {
                return Err("Select a paired trusted ATVV input".into());
            }
            let mut current = state.lock().await;
            if current.config != config {
                current.interrupt();
            }
            current.config = config;
            current.configured_at = Instant::now();
            Ok(json!({}))
        }
        Request::Recording { id } => {
            let mut current = state.lock().await;
            current.expire_recordings();
            let recording = current
                .recordings
                .iter()
                .find(|recording| recording.id == id)
                .ok_or("Recording expired")?;
            Ok(
                json!({"id":id,"deviceId":recording.device_id,"wav":STANDARD.encode(&recording.wav)}),
            )
        }
        Request::Ack { id } => {
            state
                .lock()
                .await
                .recordings
                .retain(|recording| recording.id != id);
            Ok(json!({}))
        }
        Request::Play {
            wav,
            device,
            volume,
            generation,
        } => {
            if volume > 100 {
                return Err("Invalid volume".into());
            }
            let bytes = STANDARD.decode(wav).map_err(|_| "Invalid speech audio")?;
            crate::output::play(state, bytes, device, volume, generation, disconnected).await?;
            Ok(json!({}))
        }
        Request::Stop => {
            state.lock().await.interrupt();
            Ok(json!({}))
        }
    }
}

async fn bind_socket(path: &str) -> Result<UnixListener, Box<dyn std::error::Error>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_socket() || metadata.uid() != nix::unistd::getuid().as_raw()
            {
                return Err("Refusing to replace audio socket path".into());
            }
            match UnixStream::connect(path).await {
                Ok(_) => return Err("Audio daemon is already running".into()),
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {}
                Err(error) => return Err(error.into()),
            }
            if std::fs::symlink_metadata(path)?.ino() != metadata.ino() {
                return Err("Audio socket changed".into());
            }
            std::fs::remove_file(path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(UnixListener::bind(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn refuses_files_and_live_sockets_but_recovers_a_stale_socket() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("regular");
        std::fs::write(&file, "preserve").unwrap();
        assert!(bind_socket(file.to_str().unwrap()).await.is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "preserve");
        let path = directory.path().join("audio.sock");
        let listener = bind_socket(path.to_str().unwrap()).await.unwrap();
        assert!(bind_socket(path.to_str().unwrap()).await.is_err());
        drop(listener);
        assert!(bind_socket(path.to_str().unwrap()).await.is_ok());
    }
}
