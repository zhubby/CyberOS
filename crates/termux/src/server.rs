use std::collections::HashSet;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use nix::unistd::{Gid, Uid, chown};
use serde::Serialize;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Mutex, watch};
use tokio::task::JoinSet;
use tokio::time::{interval, timeout};
use uuid::Uuid;

use crate::config::TermuxConfig;
use crate::error::{ErrorCode, TermuxError};
use crate::protocol::{
    ClientFrame, CloseResult, Command, DestroyResult, EventEnvelope, ExitPayload, MAX_FRAME_BYTES,
    MAX_OUTPUT_BYTES, OpenResult, Request, ResponseEnvelope, UNKNOWN_REQUEST_ID,
};
use crate::pty;
use crate::tmux::TmuxManager;

const MAX_CONNECTIONS: usize = 64;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const INPUT_TIMEOUT: Duration = Duration::from_secs(5);
const REAPER_INTERVAL: Duration = Duration::from_secs(60);

pub struct TermuxServer {
    config: TermuxConfig,
    state: Arc<ServerState>,
}

struct ServerState {
    tmux: TmuxManager,
    attachments: Mutex<HashSet<String>>,
}

impl TermuxServer {
    pub fn new(config: TermuxConfig) -> Self {
        let tmux = TmuxManager::new(
            config.tmux_socket_path.clone(),
            config.account.clone(),
            config.max_sessions,
        );
        Self {
            config,
            state: Arc::new(ServerState {
                tmux,
                attachments: Mutex::new(HashSet::new()),
            }),
        }
    }

    pub async fn run(self) -> Result<(), TermuxError> {
        self.state.tmux.ensure_available().await?;
        if let Some(parent) = self.config.tmux_socket_path.parent() {
            fs::create_dir_all(parent).await?;
            fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
        }
        let listener = bind_socket(
            &self.config.socket_path,
            self.config.account.uid,
            self.config.account.gid,
        )
        .await?;
        tracing::info!(socket = %self.config.socket_path.display(), "termux listening");

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let mut connections = JoinSet::new();
        let mut reaper = interval(REAPER_INTERVAL);
        reaper.tick().await;

        loop {
            tokio::select! {
                result = listener.accept() => {
                    let (mut stream, _) = result?;
                    if connections.len() >= MAX_CONNECTIONS {
                        let response = ResponseEnvelope::failure(
                            UNKNOWN_REQUEST_ID.to_owned(),
                            TermuxError::unavailable("Termux connection limit reached"),
                        );
                        let _ = write_json(&mut stream, &response).await;
                        continue;
                    }
                    let state = Arc::clone(&self.state);
                    let config = self.config.clone();
                    let shutdown = shutdown_rx.clone();
                    connections.spawn(async move {
                        if let Err(error) = handle_connection(stream, state, config, shutdown).await {
                            tracing::warn!(code = ?error.code, message = %error.message, "termux connection failed");
                        }
                    });
                }
                result = connections.join_next(), if !connections.is_empty() => {
                    if let Some(Err(error)) = result {
                        tracing::warn!(message = %error, "termux connection task failed");
                    }
                }
                _ = reaper.tick() => {
                    match self.state.tmux.reap_expired(self.config.idle_timeout_ms).await {
                        Ok(reaped) => {
                            for session in reaped {
                                tracing::info!(session, "reaped idle termux session");
                            }
                        }
                        Err(error) => {
                            tracing::warn!(code = ?error.code, message = %error.message, "unable to reap termux sessions");
                        }
                    }
                }
                result = shutdown_signal() => {
                    result?;
                    break;
                }
            }
        }

        let _ = shutdown_tx.send(true);
        drop(listener);
        while let Some(result) = connections.join_next().await {
            if let Err(error) = result {
                tracing::warn!(message = %error, "termux task failed during shutdown");
            }
        }
        remove_socket(&self.config.socket_path).await?;
        Ok(())
    }
}

async fn bind_socket(path: &Path, uid: u32, gid: u32) -> Result<UnixListener, TermuxError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_socket() => match UnixStream::connect(path).await {
            Ok(_) => {
                return Err(TermuxError::conflict(
                    "Termux socket is already owned by a running daemon",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                fs::remove_file(path).await?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(TermuxError::unavailable(format!(
                    "Unable to verify the existing Termux socket: {error}"
                )));
            }
        },
        Ok(_) => {
            return Err(TermuxError::validation(
                "Termux socket path is occupied by a non-socket",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o660)).await?;
    chown(path, Some(Uid::from_raw(uid)), Some(Gid::from_raw(gid)))?;
    Ok(listener)
}

async fn remove_socket(path: &Path) -> Result<(), TermuxError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(path).await?,
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

async fn handle_connection(
    mut stream: UnixStream,
    state: Arc<ServerState>,
    config: TermuxConfig,
    shutdown: watch::Receiver<bool>,
) -> Result<(), TermuxError> {
    let credentials = stream.peer_cred()?;
    if credentials.uid() != config.account.uid {
        write_json(
            &mut stream,
            &ResponseEnvelope::failure(
                UNKNOWN_REQUEST_ID.to_owned(),
                TermuxError::new(403, ErrorCode::Forbidden, "Termux caller is not allowed"),
            ),
        )
        .await?;
        return Ok(());
    }

    let mut frames = FrameReader::default();
    let frame = timeout(
        Duration::from_millis(config.connect_timeout_ms),
        frames.read_next(&mut stream),
    )
    .await
    .map_err(|_| TermuxError::timeout("Timed out waiting for Termux request"))??
    .ok_or_else(|| TermuxError::protocol("Termux connection closed before request"))?;
    let request = match ClientFrame::parse(&frame).and_then(ClientFrame::into_request) {
        Ok(request) => request,
        Err(error) => {
            write_json(
                &mut stream,
                &ResponseEnvelope::failure(UNKNOWN_REQUEST_ID.to_owned(), error),
            )
            .await?;
            return Ok(());
        }
    };

    match request {
        Request::Destroy { id, payload } => {
            if payload.user != config.account.name {
                write_json(
                    &mut stream,
                    &ResponseEnvelope::failure(
                        id,
                        TermuxError::new(403, ErrorCode::Forbidden, "Terminal user is not allowed"),
                    ),
                )
                .await?;
                return Ok(());
            }
            let response = match state.tmux.destroy(&payload.session_name).await {
                Ok(()) => ResponseEnvelope::success(
                    id,
                    DestroyResult {
                        session_name: payload.session_name,
                    },
                ),
                Err(error) => ResponseEnvelope::failure(id, error),
            };
            write_json(&mut stream, &response).await?;
            Ok(())
        }
        Request::Open { id, payload } => {
            if payload.user != config.account.name {
                write_json(
                    &mut stream,
                    &ResponseEnvelope::failure(
                        id,
                        TermuxError::new(403, ErrorCode::Forbidden, "Terminal user is not allowed"),
                    ),
                )
                .await?;
                return Ok(());
            }
            let session_name = payload
                .session_name
                .unwrap_or_else(|| format!("cyberos-{}", Uuid::new_v4().simple()));
            {
                let mut attachments = state.attachments.lock().await;
                if !attachments.insert(session_name.clone()) {
                    write_json(
                        &mut stream,
                        &ResponseEnvelope::failure(
                            id,
                            TermuxError::conflict("Terminal session is already attached"),
                        ),
                    )
                    .await?;
                    return Ok(());
                }
            }
            let result = run_open_session(
                &mut stream,
                &mut frames,
                &state,
                &config,
                shutdown,
                id,
                session_name.clone(),
                payload.persistent,
                payload.cols,
                payload.rows,
            )
            .await;
            state.attachments.lock().await.remove(&session_name);
            result
        }
        Request::Close { id, .. } => {
            write_json(
                &mut stream,
                &ResponseEnvelope::failure(
                    id,
                    TermuxError::protocol("Terminal session is not open"),
                ),
            )
            .await
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_open_session(
    stream: &mut UnixStream,
    frames: &mut FrameReader,
    state: &ServerState,
    config: &TermuxConfig,
    mut shutdown: watch::Receiver<bool>,
    request_id: String,
    session_name: String,
    persistent: bool,
    cols: u16,
    rows: u16,
) -> Result<(), TermuxError> {
    if let Err(error) = state.tmux.ensure_session(&session_name, persistent).await {
        write_json(stream, &ResponseEnvelope::failure(request_id, error)).await?;
        return Ok(());
    }
    let command = state.tmux.attach_command(&session_name);
    let mut process = match pty::spawn(command, cols, rows) {
        Ok(process) => process,
        Err(error) => {
            write_json(stream, &ResponseEnvelope::failure(request_id, error)).await?;
            return Ok(());
        }
    };
    let mut lifecycle = SessionLifecycle::default();
    let result = async {
        state.tmux.mark_attached(&session_name).await?;
        let stream_id = Uuid::new_v4().to_string();
        write_json(
            stream,
            &ResponseEnvelope::success(
                request_id,
                OpenResult {
                    stream_id: stream_id.clone(),
                    user: config.account.name.clone(),
                    cwd: config.account.home.to_string_lossy().into_owned(),
                    shell: config.account.shell.to_string_lossy().into_owned(),
                },
            ),
        )
        .await?;

        let mut output = vec![0_u8; MAX_OUTPUT_BYTES];
        loop {
            tokio::select! {
                frame = frames.read_next(stream) => {
                    let Some(frame) = frame? else {
                        break;
                    };
                    match handle_session_frame(
                        &frame,
                        &stream_id,
                        &session_name,
                        &state.tmux,
                        &process.master,
                    )
                    .await
                    {
                        Ok(SessionFrameResult::Continue) => {}
                        Ok(SessionFrameResult::Close { id, destroy }) => {
                            if destroy {
                                state.tmux.destroy(&session_name).await?;
                                lifecycle.destroyed = true;
                            } else {
                                state.tmux.mark_detached(&session_name).await?;
                                lifecycle.detached = true;
                            }
                            write_json(
                                stream,
                                &ResponseEnvelope::success(id, CloseResult { closed: true }),
                            )
                            .await?;
                            break;
                        }
                        Err(error) => {
                            write_json(stream, &EventEnvelope::error(stream_id.clone(), error)).await?;
                            break;
                        }
                    }
                }
                read = pty::read_chunk(&process.master, &mut output) => {
                    match read {
                        Ok(0) => {
                            let status = process.child.wait().await?;
                            lifecycle.child_exited = true;
                            send_exit(stream, &state.tmux, &session_name, &stream_id, status).await?;
                            break;
                        }
                        Ok(count) => {
                            write_json(stream, &EventEnvelope::output(stream_id.clone(), &output[..count])).await?;
                        }
                        Err(error) if error.raw_os_error() == Some(nix::libc::EIO) => {
                            let status = process.child.wait().await?;
                            lifecycle.child_exited = true;
                            send_exit(stream, &state.tmux, &session_name, &stream_id, status).await?;
                            break;
                        }
                        Err(error) => {
                            write_json(
                                stream,
                                &EventEnvelope::error(
                                    stream_id.clone(),
                                    TermuxError::unavailable(format!("Terminal PTY read failed: {error}")),
                                ),
                            ).await?;
                            break;
                        }
                    }
                }
                status = process.child.wait() => {
                    let status = status?;
                    lifecycle.child_exited = true;
                    send_exit(stream, &state.tmux, &session_name, &stream_id, status).await?;
                    break;
                }
                result = shutdown.changed() => {
                    if result.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
            }
        }
        Ok(())
    }
    .await;

    if lifecycle.should_terminate_child() {
        pty::terminate(&mut process.child).await;
    }
    if lifecycle.should_mark_detached()
        && let Err(error) = state.tmux.mark_detached(&session_name).await
    {
        tracing::warn!(session = session_name, message = %error.message, "unable to mark termux session detached");
    }
    result
}

#[derive(Default)]
struct SessionLifecycle {
    child_exited: bool,
    destroyed: bool,
    detached: bool,
}

impl SessionLifecycle {
    fn should_terminate_child(&self) -> bool {
        !self.child_exited
    }

    fn should_mark_detached(&self) -> bool {
        !self.destroyed && !self.detached
    }
}

enum SessionFrameResult {
    Continue,
    Close { id: String, destroy: bool },
}

async fn handle_session_frame(
    frame: &[u8],
    expected_stream_id: &str,
    session_name: &str,
    tmux: &TmuxManager,
    master: &tokio::io::unix::AsyncFd<std::os::fd::OwnedFd>,
) -> Result<SessionFrameResult, TermuxError> {
    let parsed = ClientFrame::parse(frame)?;
    match parsed {
        ClientFrame::Command { .. } => match parsed.into_command()? {
            Command::Input { stream_id, data } => {
                require_stream(&stream_id, expected_stream_id)?;
                timeout(INPUT_TIMEOUT, pty::write_all(master, &data))
                    .await
                    .map_err(|_| TermuxError::timeout("Terminal input timed out"))??;
                Ok(SessionFrameResult::Continue)
            }
            Command::Resize {
                stream_id,
                cols,
                rows,
            } => {
                require_stream(&stream_id, expected_stream_id)?;
                pty::resize(master, cols, rows)?;
                tmux.resize(session_name, cols, rows).await?;
                Ok(SessionFrameResult::Continue)
            }
        },
        ClientFrame::Request { .. } => match parsed.into_request()? {
            Request::Close { id, payload } => {
                require_stream(&payload.stream_id, expected_stream_id)?;
                Ok(SessionFrameResult::Close {
                    id,
                    destroy: payload.destroy,
                })
            }
            _ => Err(TermuxError::protocol(
                "Unexpected Termux request for an open session",
            )),
        },
    }
}

fn require_stream(actual: &str, expected: &str) -> Result<(), TermuxError> {
    if actual != expected {
        return Err(TermuxError::protocol("Termux stream id does not match"));
    }
    Ok(())
}

async fn send_exit(
    stream: &mut UnixStream,
    tmux: &TmuxManager,
    session_name: &str,
    stream_id: &str,
    status: std::process::ExitStatus,
) -> Result<(), TermuxError> {
    let recoverable = tmux.has_session(session_name).await.unwrap_or(false);
    let signal = status.signal();
    let exit_code = status.code().unwrap_or_else(|| 128 + signal.unwrap_or(0));
    write_json(
        stream,
        &EventEnvelope::exit(
            stream_id.to_owned(),
            ExitPayload {
                exit_code,
                signal,
                recoverable,
            },
        ),
    )
    .await
}

#[derive(Default)]
struct FrameReader {
    buffer: Vec<u8>,
}

impl FrameReader {
    async fn read_next(&mut self, stream: &mut UnixStream) -> Result<Option<Vec<u8>>, TermuxError> {
        loop {
            if let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let mut frame = self.buffer.drain(..=newline).collect::<Vec<_>>();
                frame.pop();
                if frame.last() == Some(&b'\r') {
                    frame.pop();
                }
                if frame.is_empty() || frame.len() > MAX_FRAME_BYTES {
                    return Err(TermuxError::protocol("Invalid Termux JSONL frame size"));
                }
                return Ok(Some(frame));
            }
            if self.buffer.len() > MAX_FRAME_BYTES {
                return Err(TermuxError::new(
                    413,
                    ErrorCode::OutputTooLarge,
                    "Termux frame is too large",
                ));
            }
            let mut chunk = [0_u8; 8192];
            let count = stream.read(&mut chunk).await?;
            if count == 0 {
                if self.buffer.is_empty() {
                    return Ok(None);
                }
                return Err(TermuxError::protocol(
                    "Termux JSONL frame ended before newline",
                ));
            }
            self.buffer.extend_from_slice(&chunk[..count]);
        }
    }
}

async fn write_json<T: Serialize>(stream: &mut UnixStream, value: &T) -> Result<(), TermuxError> {
    let mut payload = serde_json::to_vec(value)
        .map_err(|_| TermuxError::new(500, ErrorCode::Internal, "Could not encode Termux frame"))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(TermuxError::new(
            500,
            ErrorCode::Internal,
            "Encoded Termux frame is too large",
        ));
    }
    payload.push(b'\n');
    timeout(WRITE_TIMEOUT, stream.write_all(&payload))
        .await
        .map_err(|_| TermuxError::timeout("Termux socket write timed out"))??;
    Ok(())
}

async fn shutdown_signal() -> Result<(), TermuxError> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn refuses_to_replace_an_active_socket() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("termux.sock");
        let listener = UnixListener::bind(&path).unwrap();

        let result = bind_socket(&path, Uid::effective().as_raw(), Gid::effective().as_raw()).await;
        let error = result.expect_err("active socket should be rejected");
        assert_eq!(error.code, ErrorCode::Conflict);
        assert!(UnixStream::connect(&path).await.is_ok());

        drop(listener);
    }

    #[tokio::test]
    async fn replaces_a_stale_socket() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("termux.sock");
        let listener = UnixListener::bind(&path).unwrap();
        drop(listener);

        let replacement = bind_socket(&path, Uid::effective().as_raw(), Gid::effective().as_raw())
            .await
            .unwrap();
        assert!(UnixStream::connect(&path).await.is_ok());

        drop(replacement);
    }

    #[test]
    fn session_cleanup_runs_exactly_when_needed() {
        let active = SessionLifecycle::default();
        assert!(active.should_terminate_child());
        assert!(active.should_mark_detached());

        let exited = SessionLifecycle {
            child_exited: true,
            ..SessionLifecycle::default()
        };
        assert!(!exited.should_terminate_child());
        assert!(exited.should_mark_detached());

        let detached = SessionLifecycle {
            detached: true,
            ..SessionLifecycle::default()
        };
        assert!(!detached.should_mark_detached());

        let destroyed = SessionLifecycle {
            destroyed: true,
            ..SessionLifecycle::default()
        };
        assert!(!destroyed.should_mark_detached());
    }

    #[tokio::test]
    async fn reads_partial_and_multiple_jsonl_frames() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let writer = tokio::spawn(async move {
            client.write_all(b"{\"one\":").await.unwrap();
            client.write_all(b"1}\n{\"two\":2}\n").await.unwrap();
        });
        let mut reader = FrameReader::default();
        assert_eq!(
            reader.read_next(&mut server).await.unwrap().unwrap(),
            b"{\"one\":1}"
        );
        assert_eq!(
            reader.read_next(&mut server).await.unwrap().unwrap(),
            b"{\"two\":2}"
        );
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_an_unterminated_frame() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        client.write_all(b"{\"one\":1}").await.unwrap();
        client.shutdown().await.unwrap();
        let mut reader = FrameReader::default();
        assert!(reader.read_next(&mut server).await.is_err());
    }
}
