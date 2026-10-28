mod proxy;

use std::collections::HashSet;
use std::env;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use nix::unistd::Uid;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use tokio::time::timeout;
use tracing_subscriber::EnvFilter;

const MAX_CONTROL_BYTES: usize = 16 * 1024;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct Config {
    runtime_root: PathBuf,
    docker_socket: PathBuf,
    allowed_uids: Vec<u32>,
    docker_compatible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlRequest {
    version: u8,
    action: String,
    #[serde(rename = "scopeId")]
    scope_id: String,
    service: String,
    capabilities: Vec<String>,
}

#[derive(Serialize)]
struct ControlResponse {
    ok: bool,
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    run(Config::from_env()).await
}

async fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(config.runtime_root.join("grants")).await?;
    fs::set_permissions(&config.runtime_root, std::fs::Permissions::from_mode(0o750)).await?;
    set_compatibility_marker(
        &config.runtime_root,
        "docker-compatible",
        config.docker_compatible,
    )
    .await?;
    set_compatibility_marker(&config.runtime_root, "systemd-compatible", false).await?;
    let control_path = config.runtime_root.join("control.sock");
    remove_stale_socket(&control_path).await?;
    let listener = UnixListener::bind(&control_path)?;
    fs::set_permissions(&control_path, std::fs::Permissions::from_mode(0o660)).await?;
    let active = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));
    if config.docker_compatible {
        for directory in existing_docker_proxy_directories(&config.runtime_root).await? {
            ensure_docker_proxy(&config, Arc::clone(&active), directory).await?;
        }
    }
    let mut tasks = JoinSet::new();
    tracing::info!(socket = %control_path.display(), "host access control listening");

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let next_config = config.clone();
                let next_active = Arc::clone(&active);
                tasks.spawn(async move {
                    if let Err(error) = handle_control(stream, next_config, next_active).await {
                        tracing::warn!(message = %error, "host access control request failed");
                    }
                });
            }
            result = tasks.join_next(), if !tasks.is_empty() => {
                if let Some(Err(error)) = result {
                    tracing::warn!(message = %error, "host access task failed");
                }
            }
            signal = tokio::signal::ctrl_c() => {
                signal?;
                break;
            }
        }
    }
    drop(listener);
    let _ = fs::remove_file(control_path).await;
    Ok(())
}

async fn handle_control(
    mut stream: UnixStream,
    config: Config,
    active: Arc<Mutex<HashSet<PathBuf>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let credentials = stream.peer_cred()?;
    if !config.allowed_uids.contains(&credentials.uid()) {
        return write_response(
            &mut stream,
            ControlResponse {
                ok: false,
                status: 403,
                error: Some("caller_not_allowed"),
            },
        )
        .await;
    }
    let mut data = Vec::new();
    timeout(CONTROL_TIMEOUT, async {
        loop {
            let mut chunk = [0_u8; 2048];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..read]);
            if data.len() > MAX_CONTROL_BYTES || data.contains(&b'\n') {
                break;
            }
        }
        Ok::<(), std::io::Error>(())
    })
    .await??;
    if data.len() > MAX_CONTROL_BYTES {
        return write_response(
            &mut stream,
            ControlResponse {
                ok: false,
                status: 413,
                error: Some("request_too_large"),
            },
        )
        .await;
    }
    if data.last() == Some(&b'\n') {
        data.pop();
    }
    let request: ControlRequest = match serde_json::from_slice(&data) {
        Ok(request) => request,
        Err(_) => {
            return write_response(
                &mut stream,
                ControlResponse {
                    ok: false,
                    status: 400,
                    error: Some("invalid_request"),
                },
            )
            .await;
        }
    };
    if request.version != 1
        || request.action != "reconcile"
        || !valid_name(&request.scope_id)
        || !valid_name(&request.service)
    {
        return write_response(
            &mut stream,
            ControlResponse {
                ok: false,
                status: 400,
                error: Some("invalid_request"),
            },
        )
        .await;
    }
    if request
        .capabilities
        .iter()
        .any(|capability| capability != "docker_metadata" && capability != "systemd_status")
    {
        return write_response(
            &mut stream,
            ControlResponse {
                ok: false,
                status: 400,
                error: Some("unknown_capability"),
            },
        )
        .await;
    }
    if request
        .capabilities
        .iter()
        .any(|capability| capability == "systemd_status")
    {
        return write_response(
            &mut stream,
            ControlResponse {
                ok: false,
                status: 503,
                error: Some("systemd_proxy_unverified"),
            },
        )
        .await;
    }
    if request
        .capabilities
        .iter()
        .any(|capability| capability == "docker_metadata")
    {
        if !config.docker_compatible {
            return write_response(
                &mut stream,
                ControlResponse {
                    ok: false,
                    status: 503,
                    error: Some("docker_proxy_unverified"),
                },
            )
            .await;
        }
        let directory = config
            .runtime_root
            .join("grants")
            .join(hash_segment(&request.scope_id))
            .join(hash_segment(&request.service));
        ensure_docker_proxy(&config, active, directory).await?;
    }
    write_response(
        &mut stream,
        ControlResponse {
            ok: true,
            status: 200,
            error: None,
        },
    )
    .await
}

async fn ensure_docker_proxy(
    config: &Config,
    active: Arc<Mutex<HashSet<PathBuf>>>,
    directory: PathBuf,
) -> std::io::Result<()> {
    fs::create_dir_all(&directory).await?;
    fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).await?;
    let socket_path = directory.join("docker.sock");
    let mut guard = active.lock().await;
    if guard.contains(&socket_path) {
        return Ok(());
    }
    remove_stale_socket(&socket_path).await?;
    let listener = UnixListener::bind(&socket_path)?;
    fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o666)).await?;
    guard.insert(socket_path.clone());
    drop(guard);
    let upstream = config.docker_socket.clone();
    tokio::spawn(async move {
        if let Err(error) = proxy::serve(listener, upstream).await {
            tracing::error!(message = %error, socket = %socket_path.display(), "docker metadata proxy stopped");
        }
    });
    Ok(())
}

async fn existing_docker_proxy_directories(runtime_root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut directories = Vec::new();
    let mut scopes = fs::read_dir(runtime_root.join("grants")).await?;
    while let Some(scope) = scopes.next_entry().await? {
        if !valid_hash_segment(&scope.file_name().to_string_lossy()) {
            continue;
        }
        let scope_metadata = fs::symlink_metadata(scope.path()).await?;
        if !scope_metadata.is_dir() || scope_metadata.file_type().is_symlink() {
            continue;
        }
        let mut services = fs::read_dir(scope.path()).await?;
        while let Some(service) = services.next_entry().await? {
            if !valid_hash_segment(&service.file_name().to_string_lossy()) {
                continue;
            }
            let service_metadata = fs::symlink_metadata(service.path()).await?;
            if !service_metadata.is_dir() || service_metadata.file_type().is_symlink() {
                continue;
            }
            let socket = service.path().join("docker.sock");
            if fs::symlink_metadata(&socket)
                .await
                .is_ok_and(|metadata| metadata.file_type().is_socket())
            {
                directories.push(service.path());
            }
        }
    }
    Ok(directories)
}

async fn write_response(
    stream: &mut UnixStream,
    response: ControlResponse,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut payload = serde_json::to_vec(&response)?;
    payload.push(b'\n');
    stream.write_all(&payload).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn remove_stale_socket(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(path).await,
        Ok(_) => Err(std::io::Error::other("socket path occupied by non-socket")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn set_compatibility_marker(root: &Path, name: &str, enabled: bool) -> std::io::Result<()> {
    let path = root.join(name);
    if enabled {
        fs::write(path, b"verified\n").await
    } else {
        match fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_hash_segment(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hash_segment(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..32].to_owned()
}

impl Config {
    fn from_env() -> Self {
        let current_uid = Uid::current().as_raw();
        let allowed_uids = env::var("CYBEROS_HOST_ACCESS_ALLOWED_UIDS")
            .ok()
            .map(|value| {
                value
                    .split(',')
                    .filter_map(|part| part.trim().parse().ok())
                    .collect()
            })
            .filter(|values: &Vec<u32>| !values.is_empty())
            .unwrap_or_else(|| vec![0, current_uid]);
        Self {
            runtime_root: env::var_os("CYBEROS_HOST_ACCESS_RUNTIME_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/run/cyberos/host-access")),
            docker_socket: env::var_os("CYBEROS_DOCKER_SOCKET")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/var/run/docker.sock")),
            allowed_uids,
            docker_compatible: env::var("CYBEROS_HOST_ACCESS_DOCKER_COMPATIBLE").as_deref()
                == Ok("1"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_segments_are_bounded() {
        assert!(valid_name("compose.service-1"));
        assert!(!valid_name("../escape"));
        assert!(!valid_name("slash/name"));
        assert_eq!(hash_segment("same"), hash_segment("same"));
        assert_ne!(hash_segment("one"), hash_segment("two"));
        assert_eq!(hash_segment("scope").len(), 32);
    }

    #[tokio::test]
    async fn restores_only_preserved_hashed_proxy_directories() {
        let temp = tempfile::Builder::new()
            .prefix("z")
            .rand_bytes(4)
            .tempdir_in("/tmp")
            .unwrap();
        let runtime_root = temp.path().to_path_buf();
        let directory = runtime_root
            .join("grants")
            .join(hash_segment("scope"))
            .join(hash_segment("service"));
        fs::create_dir_all(&directory).await.unwrap();
        let socket = directory.join("docker.sock");
        drop(UnixListener::bind(&socket).unwrap());
        fs::create_dir_all(runtime_root.join("grants/not-a-hash/service"))
            .await
            .unwrap();

        let discovered = existing_docker_proxy_directories(&runtime_root)
            .await
            .unwrap();
        assert_eq!(discovered, vec![directory.clone()]);

        let config = Config {
            runtime_root,
            docker_socket: temp.path().join("docker.sock"),
            allowed_uids: vec![],
            docker_compatible: true,
        };
        let active = Arc::new(Mutex::new(HashSet::new()));
        ensure_docker_proxy(&config, Arc::clone(&active), directory)
            .await
            .unwrap();
        let connection = UnixStream::connect(socket).await;
        assert!(connection.is_ok());
        assert_eq!(active.lock().await.len(), 1);
    }
}
