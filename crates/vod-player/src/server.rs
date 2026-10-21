use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sd_notify::NotifyState;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio::time::{interval, timeout};

use crate::config::VodPlayerConfig;
use crate::controller::ControllerHandle;
use crate::error::{ErrorCode, VodError};
use crate::protocol::{
    ErrorResponse, MAX_FRAME_BYTES, PROTOCOL_VERSION, RequestEnvelope, SuccessResponse,
};

const MAX_CONNECTIONS: usize = 32;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct VodPlayerServer {
    config: Arc<VodPlayerConfig>,
    controller: ControllerHandle,
}

#[derive(Debug, Clone, Copy)]
struct SocketIdentity {
    device: u64,
    inode: u64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

impl VodPlayerServer {
    pub async fn new(config: VodPlayerConfig) -> Result<Self, VodError> {
        let config = Arc::new(config);
        let controller = ControllerHandle::start(Arc::clone(&config)).await?;
        Ok(Self { config, controller })
    }

    pub async fn run(self) -> Result<(), VodError> {
        let (listener, identity) = bind_socket(&self.config.socket_path).await?;
        let _ = sd_notify::notify(&[NotifyState::Ready]);
        tracing::info!(socket = %self.config.socket_path.display(), "VOD player listening");
        let semaphore = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        let mut connections = JoinSet::new();
        let mut watchdog = interval(Duration::from_secs(5));
        watchdog.tick().await;
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;

        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (mut stream, _) = accepted?;
                    let Ok(permit) = Arc::clone(&semaphore).try_acquire_owned() else {
                        let error = VodError::unavailable(ErrorCode::VodPlayerUnavailable, "VOD player connection limit reached");
                        let _ = write_error(&mut stream, "unknown", &error).await;
                        continue;
                    };
                    let controller = self.controller.clone();
                    let peer_uid = self.config.peer_uid;
                    connections.spawn(async move {
                        let _permit = permit;
                        if let Err(error) = handle_connection(stream, peer_uid, controller).await {
                            tracing::warn!(code = ?error.code, "VOD player connection failed");
                        }
                    });
                }
                _ = watchdog.tick() => {
                    let _ = sd_notify::notify(&[NotifyState::Watchdog]);
                }
                _ = terminate.recv() => break,
                _ = interrupt.recv() => break,
                Some(result) = connections.join_next(), if !connections.is_empty() => {
                    if let Err(error) = result { tracing::warn!(%error, "VOD player connection task failed"); }
                }
            }
        }

        let _ = sd_notify::notify(&[NotifyState::Stopping]);
        drop(listener);
        self.controller.shutdown().await;
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        remove_socket_if_same(&self.config.socket_path, identity).await?;
        Ok(())
    }
}

async fn bind_socket(path: &Path) -> Result<(UnixListener, SocketIdentity), VodError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_socket() => match UnixStream::connect(path).await {
            Ok(_) => {
                return Err(VodError::new(
                    ErrorCode::VodPlayerUnavailable,
                    "Another VOD player instance is running",
                    409,
                ));
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                ) =>
            {
                fs::remove_file(path).await?;
            }
            Err(error) => {
                return Err(VodError::unavailable(
                    ErrorCode::VodPlayerUnavailable,
                    format!("Unable to verify VOD player socket: {error}"),
                ));
            }
        },
        Ok(_) => {
            return Err(VodError::new(
                ErrorCode::InvalidPath,
                "VOD player socket path is occupied by a non-socket",
                409,
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o660)).await?;
    let metadata = fs::symlink_metadata(path).await?;
    Ok((
        listener,
        SocketIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        },
    ))
}

async fn remove_socket_if_same(path: &Path, expected: SocketIdentity) -> Result<(), VodError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata)
            if metadata.file_type().is_socket()
                && metadata.dev() == expected.device
                && metadata.ino() == expected.inode
                && metadata.ctime() == expected.changed_seconds
                && metadata.ctime_nsec() == expected.changed_nanoseconds =>
        {
            fs::remove_file(path).await?;
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

async fn handle_connection(
    mut stream: UnixStream,
    peer_uid: u32,
    controller: ControllerHandle,
) -> Result<(), VodError> {
    let credentials = stream.peer_cred()?;
    if credentials.uid() != peer_uid {
        return write_error(
            &mut stream,
            "unknown",
            &VodError::new(
                ErrorCode::PermissionDenied,
                "VOD player caller is not allowed",
                403,
            ),
        )
        .await;
    }
    let frame = match timeout(READ_TIMEOUT, read_frame(&mut stream)).await {
        Ok(result) => result,
        Err(_) => {
            return write_error(
                &mut stream,
                "unknown",
                &VodError::new(
                    ErrorCode::CommandTimeout,
                    "Timed out waiting for VOD player request",
                    408,
                ),
            )
            .await;
        }
    };
    let frame = match frame {
        Ok(frame) => frame,
        Err(error) => return write_error(&mut stream, "unknown", &error).await,
    };
    let request = match RequestEnvelope::parse(&frame) {
        Ok(request) => request,
        Err(error) => return write_error(&mut stream, "unknown", &error).await,
    };
    match controller.execute(request.command).await {
        Ok(status) => {
            write_json(
                &mut stream,
                &SuccessResponse {
                    version: PROTOCOL_VERSION,
                    id: &request.id,
                    ok: true,
                    status: &status,
                },
            )
            .await
        }
        Err(error) => write_error(&mut stream, &request.id, &error).await,
    }
}

async fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>, VodError> {
    let mut frame = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    loop {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Err(VodError::protocol(
                "Connection closed before VOD player request",
            ));
        }
        frame.extend_from_slice(&chunk[..count]);
        if frame.len() > MAX_FRAME_BYTES {
            return Err(VodError::protocol("VOD player request exceeds 128 KiB"));
        }
        if let Some(newline) = frame.iter().position(|byte| *byte == b'\n') {
            if frame[newline + 1..]
                .iter()
                .any(|byte| !byte.is_ascii_whitespace())
            {
                return Err(VodError::protocol(
                    "Only one VOD player request is allowed per connection",
                ));
            }
            frame.truncate(newline);
            return Ok(frame);
        }
    }
}

async fn write_error(stream: &mut UnixStream, id: &str, error: &VodError) -> Result<(), VodError> {
    write_json(
        stream,
        &ErrorResponse {
            version: PROTOCOL_VERSION,
            id,
            ok: false,
            error: &error.message,
            code: error.code,
            status_code: error.status_code,
        },
    )
    .await
}

async fn write_json<T: serde::Serialize>(
    stream: &mut UnixStream,
    value: &T,
) -> Result<(), VodError> {
    let mut body =
        serde_json::to_vec(value).map_err(|error| VodError::internal(error.to_string()))?;
    body.push(b'\n');
    timeout(WRITE_TIMEOUT, stream.write_all(&body))
        .await
        .map_err(|_| {
            VodError::new(
                ErrorCode::CommandTimeout,
                "Timed out writing VOD player response",
                504,
            )
        })??;
    Ok(())
}

pub fn socket_path(path: &Path) -> PathBuf {
    path.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NasRoot;

    fn config(directory: &Path) -> VodPlayerConfig {
        VodPlayerConfig {
            enabled: true,
            socket_path: directory.join("vod-player.sock"),
            state_path: directory.join("session.json"),
            command_timeout_ms: 100,
            startup_timeout_ms: 100,
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
            nas_roots: vec![NasRoot {
                id: "root".to_owned(),
                path: directory.to_owned(),
            }],
        }
    }

    #[tokio::test]
    async fn reads_one_bounded_frame_per_connection() {
        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        writer.write_all(b"{\"version\":1}\n").await.unwrap();
        assert_eq!(read_frame(&mut reader).await.unwrap(), b"{\"version\":1}");

        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        writer.write_all(b"{}\n{}\n").await.unwrap();
        assert_eq!(
            read_frame(&mut reader).await.unwrap_err().code,
            ErrorCode::ProtocolError
        );

        let (mut writer, mut reader) = UnixStream::pair().unwrap();
        let oversized = vec![b'x'; MAX_FRAME_BYTES + 1];
        let write = tokio::spawn(async move { writer.write_all(&oversized).await });
        assert_eq!(
            read_frame(&mut reader).await.unwrap_err().code,
            ErrorCode::ProtocolError
        );
        let _ = write.await;
    }

    #[tokio::test]
    async fn refuses_non_socket_and_live_socket_paths() {
        let directory = tempfile::tempdir().unwrap();
        let occupied = directory.path().join("occupied");
        std::fs::write(&occupied, b"data").unwrap();
        assert_eq!(
            bind_socket(&occupied).await.unwrap_err().code,
            ErrorCode::InvalidPath
        );

        let socket = directory.path().join("vod-player.sock");
        let (listener, identity) = bind_socket(&socket).await.unwrap();
        assert_eq!(
            bind_socket(&socket).await.unwrap_err().code,
            ErrorCode::VodPlayerUnavailable
        );
        drop(listener);
        remove_socket_if_same(&socket, identity).await.unwrap();
    }

    #[tokio::test]
    async fn does_not_remove_a_replaced_socket() {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("vod-player.sock");
        let (first, first_identity) = bind_socket(&socket).await.unwrap();
        drop(first);
        std::fs::remove_file(&socket).unwrap();
        let (second, second_identity) = bind_socket(&socket).await.unwrap();

        remove_socket_if_same(&socket, first_identity)
            .await
            .unwrap();
        assert!(socket.exists());

        drop(second);
        remove_socket_if_same(&socket, second_identity)
            .await
            .unwrap();
        assert!(!socket.exists());
    }

    #[tokio::test]
    async fn rejects_a_peer_with_the_wrong_uid_before_parsing() {
        let directory = tempfile::tempdir().unwrap();
        let config = Arc::new(config(directory.path()));
        let controller = ControllerHandle::start(Arc::clone(&config)).await.unwrap();
        let (mut client, server) = UnixStream::pair().unwrap();
        let current_uid = nix::unistd::Uid::current().as_raw();
        let wrong_uid = if current_uid == u32::MAX {
            current_uid - 1
        } else {
            current_uid + 1
        };
        let connection = tokio::spawn(handle_connection(server, wrong_uid, controller.clone()));
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        connection.await.unwrap().unwrap();
        assert!(response.contains("PERMISSION_DENIED"));
        controller.shutdown().await;
    }
}
