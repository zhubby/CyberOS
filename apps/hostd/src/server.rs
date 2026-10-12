use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use nix::unistd::{Gid, Group, chown};
#[cfg(test)]
use serde_json::Value;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use tokio::time::{MissedTickBehavior, interval, timeout};

use crate::command::{CommandRunner, SystemCommandRunner};
use crate::config::{ConfiguredNasRoot, HostdConfig};
use crate::error::{ErrorCode, HostdError};
use crate::protocol::{
    HostdRequest, HostdResult, MAX_FRAME_BYTES, RequestEnvelope, ResponseEnvelope,
};

const FRAME_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 64;
const UNKNOWN_REQUEST_ID: &str = "00000000-0000-0000-0000-000000000000";

pub struct HostdServer {
    config: HostdConfig,
    state: Arc<HostdState>,
}

struct HostdState {
    runner: Arc<dyn CommandRunner>,
    nas_roots: Vec<ConfiguredNasRoot>,
    shares_lock: Mutex<()>,
    storage_lock: Mutex<()>,
    docker_lock: Mutex<()>,
    network_lock: Mutex<()>,
    power_lock: Mutex<()>,
    ops_lock: Mutex<()>,
}

impl HostdServer {
    pub fn new(config: HostdConfig) -> Self {
        Self::with_runner(config, Arc::new(SystemCommandRunner))
    }

    pub fn with_runner(config: HostdConfig, runner: Arc<dyn CommandRunner>) -> Self {
        let nas_roots = config.nas_roots.clone();
        Self {
            config,
            state: Arc::new(HostdState {
                runner,
                nas_roots,
                shares_lock: Mutex::new(()),
                storage_lock: Mutex::new(()),
                docker_lock: Mutex::new(()),
                network_lock: Mutex::new(()),
                power_lock: Mutex::new(()),
                ops_lock: Mutex::new(()),
            }),
        }
    }

    pub async fn run(self) -> Result<(), HostdError> {
        if let Err(error) =
            crate::network_manager::recover_on_startup(self.state.runner.as_ref()).await
        {
            tracing::error!(code = ?error.code, message = %error.message, "could not recover unfinished Ethernet transaction");
            return Err(error);
        }
        let listener = bind_socket(&self.config.socket_path, &self.config.socket_group).await?;
        tracing::info!(socket = %self.config.socket_path.display(), "hostd listening");
        let allowed_uids = Arc::new(self.config.allowed_uids);
        let mut connections = JoinSet::new();
        let mut network_recovery = interval(Duration::from_secs(1));
        network_recovery.set_missed_tick_behavior(MissedTickBehavior::Skip);
        network_recovery.tick().await;
        loop {
            tokio::select! {
                result = listener.accept(), if connections.len() < MAX_CONNECTIONS => {
                    let (stream, _) = result?;
                    let state = Arc::clone(&self.state);
                    let allowed_uids = Arc::clone(&allowed_uids);
                    connections.spawn(async move {
                        if let Err(error) = handle_connection(stream, state, &allowed_uids).await {
                            tracing::warn!(code = ?error.code, message = %error.message, "hostd request failed");
                        }
                    });
                }
                result = connections.join_next(), if !connections.is_empty() => {
                    if let Some(Err(error)) = result {
                        tracing::warn!(message = %error, "hostd request task failed");
                    }
                }
                _ = network_recovery.tick() => {
                    let _guard = self.state.network_lock.lock().await;
                    if let Err(error) = crate::network_manager::recover_expired_transaction(self.state.runner.as_ref()).await {
                        tracing::error!(code = ?error.code, message = %error.message, "could not recover expired Ethernet transaction");
                    }
                }
                result = shutdown_signal() => {
                    result?;
                    break;
                }
            }
        }
        drop(listener);
        while let Some(result) = connections.join_next().await {
            if let Err(error) = result {
                tracing::warn!(message = %error, "hostd request task failed during shutdown");
            }
        }
        remove_socket(&self.config.socket_path).await?;
        Ok(())
    }
}

async fn bind_socket(path: &Path, group: &str) -> Result<UnixListener, HostdError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(path).await?,
        Ok(_) => {
            return Err(HostdError::validation(
                "hostd socket path is occupied by a non-socket",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o660)).await?;
    if let Some(group) =
        Group::from_name(group).map_err(|error| HostdError::unavailable(error.to_string()))?
    {
        chown(
            path,
            Some(nix::unistd::Uid::from_raw(0)),
            Some(Gid::from_raw(group.gid.as_raw())),
        )
        .map_err(|error| HostdError::unavailable(error.to_string()))?;
    }
    Ok(listener)
}

async fn remove_socket(path: &Path) -> Result<(), HostdError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_socket() => {
            fs::remove_file(path).await.map_err(Into::into)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn handle_connection(
    mut stream: UnixStream,
    state: Arc<HostdState>,
    allowed_uids: &[u32],
) -> Result<(), HostdError> {
    let credentials = stream.peer_cred()?;
    if !allowed_uids.contains(&credentials.uid()) {
        let response = ResponseEnvelope::failure(
            UNKNOWN_REQUEST_ID.to_owned(),
            HostdError::new(403, ErrorCode::Forbidden, "hostd caller is not allowed"),
        );
        write_response(&mut stream, &response).await?;
        return Ok(());
    }

    let frame = match read_frame(&mut stream).await {
        Ok(frame) => frame,
        Err(error) => {
            write_response(
                &mut stream,
                &ResponseEnvelope::failure(UNKNOWN_REQUEST_ID.to_owned(), error),
            )
            .await?;
            return Ok(());
        }
    };
    let request = match RequestEnvelope::parse(&frame) {
        Ok(request) => request,
        Err(error) => {
            write_response(
                &mut stream,
                &ResponseEnvelope::failure(UNKNOWN_REQUEST_ID.to_owned(), error),
            )
            .await?;
            return Ok(());
        }
    };
    let request_id = request.id.clone();
    let response = match dispatch(request, &state).await {
        Ok(result) => match serde_json::to_value(result) {
            Ok(result) => ResponseEnvelope::success(request_id, result),
            Err(error) => ResponseEnvelope::failure(
                request_id,
                HostdError::new(
                    500,
                    ErrorCode::Internal,
                    format!("Could not encode hostd result: {error}"),
                ),
            ),
        },
        Err(error) => ResponseEnvelope::failure(request_id, error),
    };
    write_response(&mut stream, &response).await
}

async fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>, HostdError> {
    let mut data = Vec::new();
    timeout(FRAME_TIMEOUT, async {
        loop {
            let mut chunk = [0_u8; 8192];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..read]);
            if data.len() > MAX_FRAME_BYTES + 1 {
                return Err(HostdError::new(
                    413,
                    ErrorCode::ProtocolError,
                    "hostd request frame is too large",
                ));
            }
        }
        Ok::<(), HostdError>(())
    })
    .await
    .map_err(|_| HostdError::new(408, ErrorCode::Timeout, "hostd request frame timed out"))??;

    if !data.ends_with(b"\n") {
        return Err(HostdError::new(
            400,
            ErrorCode::ProtocolError,
            "hostd request must end with a newline",
        ));
    }
    data.pop();
    if data.ends_with(b"\r") {
        data.pop();
    }
    if data.is_empty() || data.contains(&b'\n') || data.len() > MAX_FRAME_BYTES {
        return Err(HostdError::new(
            400,
            ErrorCode::ProtocolError,
            "hostd accepts exactly one JSONL request frame",
        ));
    }
    Ok(data)
}

async fn write_response(
    stream: &mut UnixStream,
    response: &ResponseEnvelope,
) -> Result<(), HostdError> {
    let mut payload = serde_json::to_vec(response).map_err(|_| {
        HostdError::new(500, ErrorCode::Internal, "Could not encode hostd response")
    })?;
    if payload.len() > MAX_FRAME_BYTES {
        payload = serde_json::to_vec(&ResponseEnvelope::failure(
            response.id.clone(),
            HostdError::new(
                502,
                ErrorCode::OutputTooLarge,
                "hostd response is too large",
            ),
        ))
        .map_err(|_| {
            HostdError::new(500, ErrorCode::Internal, "Could not encode hostd response")
        })?;
    }
    payload.push(b'\n');
    timeout(RESPONSE_TIMEOUT, async {
        stream.write_all(&payload).await?;
        stream.shutdown().await?;
        Ok::<(), HostdError>(())
    })
    .await
    .map_err(|_| HostdError::new(504, ErrorCode::Timeout, "hostd response timed out"))??;
    Ok(())
}

async fn dispatch(request: RequestEnvelope, state: &HostdState) -> Result<HostdResult, HostdError> {
    match request.into_contract()? {
        HostdRequest::SharesApply(request) => {
            let _guard = state.shares_lock.lock().await;
            crate::shares::apply(request, state.runner.as_ref(), &state.nas_roots)
                .await
                .map(HostdResult::SharesApply)
        }
        HostdRequest::StorageCommand(request) => {
            crate::storage::command(request, state.runner.as_ref())
                .await
                .map(HostdResult::StorageCommand)
        }
        HostdRequest::StorageOperation(request) => {
            let _guard = state.storage_lock.lock().await;
            crate::storage::operation(request, state.runner.as_ref())
                .await
                .map(HostdResult::StorageOperation)
        }
        HostdRequest::DockerDaemon(request @ crate::docker_daemon::DockerRequest::Read) => {
            crate::docker_daemon::handle(request, state.runner.as_ref())
                .await
                .map(HostdResult::DockerDaemon)
        }
        HostdRequest::DockerDaemon(request) => {
            let _guard = state.docker_lock.lock().await;
            crate::docker_daemon::handle(request, state.runner.as_ref())
                .await
                .map(HostdResult::DockerDaemon)
        }
        HostdRequest::NetworkManager(request @ crate::network_manager::NetworkRequest::Ping) => {
            crate::network_manager::handle(request, state.runner.as_ref())
                .await
                .map(HostdResult::NetworkManager)
        }
        HostdRequest::NetworkManager(request) => {
            let _guard = state.network_lock.lock().await;
            crate::network_manager::handle(request, state.runner.as_ref())
                .await
                .map(HostdResult::NetworkManager)
        }
        HostdRequest::SystemPower(request) => {
            let _guard = state.power_lock.lock().await;
            crate::power::command(request, state.runner.as_ref())
                .await
                .map(HostdResult::SystemPower)
        }
        HostdRequest::SystemOps(request) => {
            let _guard = state.ops_lock.lock().await;
            crate::ops::command(request, state.runner.as_ref())
                .await
                .map(HostdResult::SystemOps)
        }
    }
}

async fn shutdown_signal() -> Result<(), HostdError> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate())?;
        let mut interrupt = signal(SignalKind::interrupt())?;
        tokio::select! {
            _ = terminate.recv() => {},
            _ = interrupt.recv() => {},
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
    use async_trait::async_trait;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    #[derive(Default)]
    struct FakeRunner {
        active: AtomicUsize,
        max_active: AtomicUsize,
        delay_commands: bool,
    }

    #[async_trait]
    impl CommandRunner for FakeRunner {
        async fn run(
            &self,
            _command: &str,
            args: &[String],
            _input: Option<&[u8]>,
            _command_timeout: Duration,
            _output_limit: usize,
        ) -> Result<crate::command::CommandOutput, HostdError> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            if self.delay_commands {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
            let stdout = if args
                .windows(2)
                .any(|window| window == ["--fields", "RUNNING"])
            {
                "running\n".to_owned()
            } else {
                String::new()
            };
            Ok(crate::command::CommandOutput {
                stdout,
                stderr: String::new(),
                success: true,
            })
        }
    }

    fn test_state(runner: Arc<dyn CommandRunner>) -> Arc<HostdState> {
        Arc::new(HostdState {
            runner,
            nas_roots: Vec::new(),
            shares_lock: Mutex::new(()),
            storage_lock: Mutex::new(()),
            docker_lock: Mutex::new(()),
            network_lock: Mutex::new(()),
            power_lock: Mutex::new(()),
            ops_lock: Mutex::new(()),
        })
    }

    async fn send_request(path: &Path, frame: &[u8]) -> Value {
        let mut client = UnixStream::connect(path).await.unwrap();
        let _ = client.write_all(frame).await;
        let _ = client.shutdown().await;
        let mut response = Vec::new();
        match client.read_to_end(&mut response).await {
            Ok(_) => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::ConnectionReset && !response.is_empty() =>
            {
                // Linux can reset a denied socket after sending the response without reading its request.
            }
            Err(error) => panic!("hostd response read failed: {error}"),
        }
        serde_json::from_slice(&response).unwrap()
    }

    async fn exchange(frame: &[u8], allowed_uids: Vec<u32>) -> Value {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("hostd.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let state = test_state(Arc::new(FakeRunner::default()));
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handle_connection(stream, state, &allowed_uids)
                .await
                .unwrap();
        });
        let response = send_request(&path, frame).await;
        server.await.unwrap();
        response
    }

    #[tokio::test]
    async fn accepts_exactly_one_newline_terminated_frame() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let writer = tokio::spawn(async move {
            client.write_all(b"{}\n").await.unwrap();
            client.shutdown().await.unwrap();
        });
        assert_eq!(read_frame(&mut server).await.unwrap(), b"{}");
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_multiple_frames() {
        let (mut client, mut server) = UnixStream::pair().unwrap();
        let writer = tokio::spawn(async move {
            client.write_all(b"{}\n{}\n").await.unwrap();
            client.shutdown().await.unwrap();
        });
        assert!(read_frame(&mut server).await.is_err());
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn serves_an_allowed_peer_over_a_unix_socket() {
        let request_id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        let frame = format!(
            "{{\"version\":1,\"id\":\"{request_id}\",\"operation\":\"network.manager\",\"payload\":{{\"action\":\"ping\"}}}}\n"
        );
        let response = exchange(
            &frame.into_bytes(),
            vec![nix::unistd::Uid::current().as_raw()],
        )
        .await;

        assert_eq!(response["id"], request_id);
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["ready"], true);
    }

    #[tokio::test]
    async fn rejects_a_disallowed_peer_before_reading_a_request() {
        let current_uid = nix::unistd::Uid::current().as_raw();
        let response = exchange(b"ignored\n", vec![current_uid ^ 1]).await;

        assert_eq!(response["id"], UNKNOWN_REQUEST_ID);
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["status"], 403);
        assert_eq!(response["error"]["code"], "forbidden");
    }

    #[tokio::test]
    async fn returns_structured_errors_for_malformed_and_unknown_requests() {
        let allowed = vec![nix::unistd::Uid::current().as_raw()];
        let malformed = exchange(b"{]\n", allowed.clone()).await;
        assert_eq!(malformed["id"], UNKNOWN_REQUEST_ID);
        assert_eq!(malformed["error"]["status"], 400);
        assert_eq!(malformed["error"]["code"], "protocol_error");

        let request_id = "67e55044-10b1-426f-9247-bb680e5fe0c8";
        let frame = format!(
            "{{\"version\":1,\"id\":\"{request_id}\",\"operation\":\"unknown\",\"payload\":{{}}}}\n"
        );
        let unknown = exchange(frame.as_bytes(), allowed).await;
        assert_eq!(unknown["id"], request_id);
        assert_eq!(unknown["error"]["status"], 404);
        assert_eq!(unknown["error"]["code"], "not_found");
    }

    #[tokio::test]
    async fn rejects_oversized_frames_with_a_structured_error() {
        let mut frame = vec![b'x'; MAX_FRAME_BYTES + 2];
        frame.push(b'\n');
        let response = exchange(&frame, vec![nix::unistd::Uid::current().as_raw()]).await;

        assert_eq!(response["id"], UNKNOWN_REQUEST_ID);
        assert_eq!(response["error"]["status"], 413);
        assert_eq!(response["error"]["code"], "protocol_error");
    }

    #[tokio::test]
    async fn serializes_concurrent_mutations_within_a_domain() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("hostd.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let runner = Arc::new(FakeRunner {
            delay_commands: true,
            ..FakeRunner::default()
        });
        let state = test_state(runner.clone());
        let allowed_uids = Arc::new(vec![nix::unistd::Uid::current().as_raw()]);
        let server = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                let state = Arc::clone(&state);
                let allowed_uids = Arc::clone(&allowed_uids);
                connections.spawn(async move {
                    handle_connection(stream, state, &allowed_uids)
                        .await
                        .unwrap();
                });
            }
            while let Some(result) = connections.join_next().await {
                result.unwrap();
            }
        });
        let first = "{\"version\":1,\"id\":\"67e55044-10b1-426f-9247-bb680e5fe0c8\",\"operation\":\"network.manager\",\"payload\":{\"action\":\"radio\",\"input\":{\"enabled\":true,\"confirmed\":false}}}\n";
        let second = "{\"version\":1,\"id\":\"56e55044-10b1-426f-9247-bb680e5fe0c8\",\"operation\":\"network.manager\",\"payload\":{\"action\":\"radio\",\"input\":{\"enabled\":true,\"confirmed\":false}}}\n";
        let (first_response, second_response) = tokio::join!(
            send_request(&path, first.as_bytes()),
            send_request(&path, second.as_bytes())
        );
        server.await.unwrap();

        assert_eq!(first_response["ok"], true);
        assert_eq!(second_response["ok"], true);
        assert_eq!(runner.max_active.load(Ordering::SeqCst), 1);
    }
}
